import type {
  AgentKeyId,
  AuthoredSeq,
  EventSeq,
  EventType,
  NodeId,
  Person,
  PersonId,
  SessionId,
  TreeId,
  WorkspaceId,
} from '@dossier/contracts'
import { Clock, Context, Effect, Layer } from 'effect'

import { matching } from '../hub/match.ts'
import type { Subscriber } from '../hub/tree-hub.ts'
import { Access } from './access.ts'
import { Background } from './background.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller, type Caller } from './caller.ts'
import { visibleEvents, type EventRef } from './event-visibility.ts'

/** Whose watching sockets a change closes, so they reconnect and are checked again. */
export type CloseSockets =
  | { readonly people: readonly PersonId[] }
  | { readonly all: true }

/** One committed change, as every consumer after a commit reads it. */
export interface Committed {
  readonly treeId: TreeId
  /** The last event of the change. */
  readonly seq: EventSeq
  readonly authoredSeq: AuthoredSeq
  readonly events: readonly {
    readonly seq: EventSeq
    readonly type: EventType
    readonly path: string
  }[]
  readonly close: CloseSockets | null
}

/** The trees whose sockets an access change reaches. */
export type InvalidationScope =
  | { readonly trees: readonly TreeId[] }
  | { readonly workspace: WorkspaceId }

export interface ChangeFeedService {
  /**
   * Tells whoever follows the tree, never delaying or failing the change:
   * the sockets it closes first, then a bare hint to each socket whose caller
   * may read what changed now.
   */
  readonly published: (c: Committed) => Effect.Effect<void, never, Background>
  /**
   * The one way to close watching sockets after access was lost outside a
   * tree change (memberships, teams, roles, a workspace suspended or deleted,
   * an account deleted). Call it once the change has committed.
   */
  readonly invalidate: (i: {
    readonly scope: InvalidationScope
    readonly close: CloseSockets
  }) => Effect.Effect<void, never, Background>
}

export class ChangeFeed extends Context.Tag('ChangeFeed')<
  ChangeFeed,
  ChangeFeedService
>() {}

const logged = (what: string, detail: Record<string, unknown>) =>
  Effect.catchAllCause((cause) =>
    Effect.sync(() => {
      console.error(what, { ...detail, cause: String(cause) })
    }),
  )

/** The tree hubs: closes, then hints addressed socket by socket. */
export const ChangeFeedLive: Layer.Layer<ChangeFeed, never, Bindings | Access> =
  Layer.effect(
    ChangeFeed,
    Effect.gen(function* () {
      const env = yield* Bindings
      const access = yield* Access
      const { DB } = env
      const hubOf = (treeId: TreeId) =>
        env.TREE_HUB.get(env.TREE_HUB.idFromName(treeId))
      const query = <A>(run: () => Promise<A>) =>
        Effect.tryPromise(run).pipe(Effect.orDie)

      /** The caller a socket now stands for, or null when it may not go on. */
      const callerOf = (s: Subscriber) =>
        Effect.gen(function* () {
          const requestId = `hub:${s.id}`
          if (s.person === null) {
            return {
              person: null,
              via: { kind: 'visitor', anonSessionId: null },
              requestId,
            } satisfies Caller as Caller
          }
          const now = yield* Clock.currentTimeMillis
          const person = yield* query(() =>
            DB.prepare('select id, email, name, image from "user" where id = ?')
              .bind(s.person)
              .first<Person>(),
          )
          if (person === null) return null
          if (s.session !== null) {
            const live = yield* query(() =>
              DB.prepare(
                `select 1 as one from "session" where id = ? and user_id = ?
                 and expires_at > ?`,
              )
                .bind(s.session, s.person, now)
                .first(),
            )
            if (live === null) return null
            return {
              person,
              via: { kind: 'browser', sessionId: s.session as SessionId },
              requestId,
            } satisfies Caller as Caller
          }
          if (s.key === null) return null
          const key = yield* query(() =>
            DB.prepare(
              `select scope_node_id as scope, read_only as readOnly from agent_keys
             where id = ? and user_id = ? and revoked_at is null`,
            )
              .bind(s.key, s.person)
              .first<{ scope: string | null; readOnly: number }>(),
          )
          if (key === null) return null
          return {
            person,
            via: {
              kind: 'agent',
              keyId: s.key as AgentKeyId,
              scope: key.scope as NodeId | null,
              readOnly: key.readOnly === 1,
            },
            requestId,
          } satisfies Caller as Caller
        })

      const address = (c: Committed) =>
        Effect.gen(function* () {
          const hub = hubOf(c.treeId)
          // Access is lost before anything else is said.
          if (c.close !== null) {
            const close = c.close
            yield* query(() => hub.close(close))
          }
          // RPC loosens the tuple types; the hub returns Subscribers.
          const subscribers = (yield* query(() =>
            hub.subscribers(),
          )) as unknown as readonly Subscriber[]
          if (subscribers.length === 0) return
          const seqs = c.events.map((e) => e.seq)
          const rows = (yield* query(() =>
            DB.prepare(
              `select seq, type, path, node_id as nodeId, push_id as pushId
             from events where tree_id = ? and seq between ? and ?`,
            )
              .bind(c.treeId, Math.min(...seqs), Math.max(...seqs))
              .all<EventRef>(),
          )).results
          const hints: { id: string; sub: number }[] = []
          const refused: string[] = []
          const byCaller = new Map<string, Subscriber[]>()
          for (const s of subscribers) {
            const who = `${s.person}|${s.session}|${s.key}`
            byCaller.set(who, [...(byCaller.get(who) ?? []), s])
          }
          for (const group of byCaller.values()) {
            const caller = yield* callerOf(group[0]!)
            if (caller === null) {
              refused.push(...group.map((s) => s.id))
              continue
            }
            const visible = yield* visibleEvents(
              DB,
              access,
              c.treeId,
              rows,
            ).pipe(Effect.provideService(CurrentCaller, caller))
            const paths = [...visible.values()].flat()
            if (paths.length === 0) continue
            for (const s of group) {
              for (const sub of matching(s.paths, paths)) {
                hints.push({ id: s.id, sub })
              }
            }
          }
          if (refused.length > 0) yield* query(() => hub.drop(refused))
          if (hints.length > 0) yield* query(() => hub.notify(hints))
        })

      const treesOf = (scope: InvalidationScope) =>
        'trees' in scope
          ? Effect.succeed(scope.trees)
          : Effect.map(
              query(() =>
                DB.prepare('select id from trees where workspace_id = ?')
                  .bind(scope.workspace)
                  .all<{ id: TreeId }>(),
              ),
              (rows) => rows.results.map((r) => r.id),
            )

      return {
        published: (c) =>
          Effect.flatMap(Background, (background) =>
            background.run(
              address(c).pipe(
                logged('A change hint was lost', {
                  tree: c.treeId,
                  seq: c.seq,
                }),
              ),
            ),
          ),
        invalidate: ({ scope, close }) =>
          Effect.flatMap(Background, (background) =>
            background.run(
              Effect.gen(function* () {
                const trees = yield* treesOf(scope)
                yield* Effect.forEach(
                  trees,
                  (treeId) => query(() => hubOf(treeId).close(close)),
                  { concurrency: 8, discard: true },
                )
              }).pipe(logged('Closing watching sockets failed', { scope })),
            ),
          ),
      } satisfies ChangeFeedService
    }),
  )

/** Tests: records what was published and invalidated, in order. */
export const ChangeFeedRecorder = (): {
  readonly layer: Layer.Layer<ChangeFeed>
  readonly published: () => readonly Committed[]
  readonly invalidated: () => readonly {
    readonly scope: InvalidationScope
    readonly close: CloseSockets
  }[]
} => {
  const seen: Committed[] = []
  const closed: { scope: InvalidationScope; close: CloseSockets }[] = []
  return {
    layer: Layer.succeed(ChangeFeed, {
      published: (c) =>
        Effect.flatMap(Background, (background) =>
          background.run(Effect.sync(() => void seen.push(c))),
        ),
      invalidate: (i) =>
        Effect.flatMap(Background, (background) =>
          background.run(Effect.sync(() => void closed.push(i))),
        ),
    }),
    published: () => [...seen],
    invalidated: () => [...closed],
  }
}
