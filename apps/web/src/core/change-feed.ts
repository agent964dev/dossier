import type {
  AuthoredSeq,
  EventSeq,
  EventType,
  PersonId,
  TreeId,
  WorkspaceId,
} from '@dossier/contracts'
import { sql } from 'drizzle-orm'
import { Clock, Context, Effect, Layer } from 'effect'

import { db } from '../db/client.ts'

import type { Subscriber } from '../hub/tree-hub.ts'
import { Background } from './background.ts'
import type { WebhookMessage } from './webhooks.ts'
import { Bindings } from './bindings.ts'
import {
  callersCte,
  visibleEventSql,
  type CallerRef,
} from './event-visibility.ts'

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

/**
 * The Queue message a commit sends: its events' range. Null for a change
 * that wrote no event.
 */
export const webhookMessageOf = (c: Committed): WebhookMessage | null => {
  if (c.events.length === 0) return null
  const seqs = c.events.map((e) => e.seq)
  return {
    kind: 'events',
    treeId: c.treeId,
    fromSeq: Math.min(...seqs) as EventSeq,
    toSeq: Math.max(...seqs) as EventSeq,
  }
}

const logged = (what: string, detail: Record<string, unknown>) =>
  Effect.catchAllCause((cause) =>
    Effect.sync(() => {
      console.error(what, { ...detail, cause: String(cause) })
    }),
  )

/** The tree hubs: closes, then hints addressed socket by socket. */
export const ChangeFeedLive: Layer.Layer<ChangeFeed, never, Bindings> =
  Layer.effect(
    ChangeFeed,
    Effect.gen(function* () {
      const env = yield* Bindings
      const { DB } = env
      const hubOf = (treeId: TreeId) =>
        env.TREE_HUB.get(env.TREE_HUB.idFromName(treeId))
      const query = <A>(run: () => Promise<A>) =>
        Effect.tryPromise(run).pipe(Effect.orDie)

      const database = db(env)

      /**
       * Each distinct caller behind the sockets, as it stands now: a visitor,
       * a live session, or an unrevoked key of a person. One query for all.
       */
      const callersNow = (
        callers: readonly Pick<Subscriber, 'person' | 'session' | 'key'>[],
      ) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const rows = (yield* query(() =>
            database.all(sql`select c.key as i, lower(u.email) as email,
              (select k.scope_node_id from agent_keys k
                 where k.id = json_extract(c.value, '$.key')) as scope,
              case
                when json_extract(c.value, '$.person') is null then 1
                when u.id is null then 0
                when json_extract(c.value, '$.session') is not null then exists (
                  select 1 from "session" ss where ss.id = json_extract(c.value, '$.session')
                    and ss.user_id = u.id and ss.expires_at > ${now})
                when json_extract(c.value, '$.key') is not null then exists (
                  select 1 from agent_keys k where k.id = json_extract(c.value, '$.key')
                    and k.user_id = u.id and k.revoked_at is null)
                else 0 end as ok
            from json_each(${JSON.stringify(callers)}) c
              left join "user" u on u.id = json_extract(c.value, '$.person')`),
          )) as {
            i: number
            email: string | null
            scope: string | null
            ok: number
          }[]
          return rows
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
          const fanOut = Effect.gen(function* () {
            const tree = yield* query(() =>
              DB.prepare(
                `select t.workspace_id as workspaceId,
                 (t.deleted_at is null and w.deleted_at is null
                   and w.suspended_at is null) as live
               from trees t join workspaces w on w.id = t.workspace_id where t.id = ?`,
              )
                .bind(c.treeId)
                .first<{ workspaceId: string; live: number }>(),
            )
            if (tree === null || tree.live !== 1) {
              yield* query(() => hub.drop(subscribers.map((s) => s.id)))
              return
            }
            const keyOf = (s: Subscriber) => `${s.person}|${s.session}|${s.key}`
            const distinct = [
              ...new Map(subscribers.map((s) => [keyOf(s), s])).values(),
            ]
            const now = yield* callersNow(
              distinct.map((s) => ({
                person: s.person,
                session: s.session,
                key: s.key,
              })),
            )
            const index = new Map<string, number>()
            const refs: CallerRef[] = []
            const refused: string[] = []
            distinct.forEach((s, n) => {
              const row = now.find((r) => r.i === n)
              if (row === undefined || row.ok !== 1) return
              index.set(keyOf(s), refs.length)
              refs.push({
                person: s.person,
                email: row.email,
                scope: row.scope,
              })
            })
            const subs: { c: number; id: string; sub: number; path: string }[] =
              []
            for (const s of subscribers) {
              const who = index.get(keyOf(s))
              if (who === undefined) {
                refused.push(s.id)
                continue
              }
              for (const [sub, path] of s.paths)
                subs.push({ c: who, id: s.id, sub, path })
            }
            if (refused.length > 0) yield* query(() => hub.drop(refused))
            if (subs.length === 0) return
            const seqs = c.events.map((e) => e.seq)
            const hints = (yield* query(() =>
              database.all(sql`/* watch hints */ with ${callersCte(c.treeId, tree.workspaceId, refs)},
              subs as (select json_extract(value, '$.c') as c,
                  json_extract(value, '$.id') as id,
                  json_extract(value, '$.sub') as sub,
                  json_extract(value, '$.path') as path
                from json_each(${JSON.stringify(subs)}))
              select distinct subs.id as id, subs.sub as sub
              from subs join cs on cs.i = subs.c
                join events e on e.tree_id = ${c.treeId}
                  and e.seq between ${Math.min(...seqs)} and ${Math.max(...seqs)}
              where ${visibleEventSql(c.treeId, tree.workspaceId, sql`subs.path`)}`),
            )) as { id: string; sub: number }[]
            if (hints.length > 0) yield* query(() => hub.notify(hints))
          })
          // A fan-out that cannot finish closes the tree's sockets: their
          // clients poll until they reconnect, rather than wait in silence.
          yield* fanOut.pipe(
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                console.error('A change fan-out failed; closing its sockets', {
                  tree: c.treeId,
                  seq: c.seq,
                  cause: String(cause),
                })
                yield* query(() => hub.close({ all: true }))
              }),
            ),
          )
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

      /**
       * The webhook Queue hears of the commit. A message lost here is found
       * by the next sweep.
       */
      const enqueue = (c: Committed) =>
        Effect.gen(function* () {
          const message = webhookMessageOf(c)
          const queue = env.WEBHOOKS
          if (message === null || queue === undefined) return
          yield* Effect.tryPromise(() => queue.send(message))
        })

      return {
        published: (c) =>
          Effect.flatMap(Background, (background) =>
            Effect.zipRight(
              background.run(
                address(c).pipe(
                  logged('A change hint was lost', {
                    tree: c.treeId,
                    seq: c.seq,
                  }),
                ),
              ),
              background.run(
                enqueue(c).pipe(
                  logged('A webhook message was not queued', {
                    tree: c.treeId,
                    seq: c.seq,
                  }),
                ),
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

/**
 * Tests: records what was published and invalidated, in order, and the
 * Queue message each commit would send.
 */
export const ChangeFeedRecorder = (): {
  readonly layer: Layer.Layer<ChangeFeed>
  readonly published: () => readonly Committed[]
  readonly queued: () => readonly WebhookMessage[]
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
    queued: () =>
      seen.flatMap((c) => {
        const message = webhookMessageOf(c)
        return message === null ? [] : [message]
      }),
    invalidated: () => [...closed],
  }
}
