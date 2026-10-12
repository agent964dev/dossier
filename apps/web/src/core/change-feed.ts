import type {
  AuthoredSeq,
  EventSeq,
  EventType,
  PersonId,
  TreeId,
} from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import { Background } from './background.ts'
import { Bindings } from './bindings.ts'

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

export interface ChangeFeedService {
  /** Tells whoever follows the tree; never delays or fails the change. */
  readonly published: (c: Committed) => Effect.Effect<void, never, Background>
}

export class ChangeFeed extends Context.Tag('ChangeFeed')<
  ChangeFeed,
  ChangeFeedService
>() {}

/** The tree's hub hears of every commit; a lost hint costs one refetch. */
export const ChangeFeedLive: Layer.Layer<ChangeFeed, never, Bindings> =
  Layer.effect(
    ChangeFeed,
    Effect.map(Bindings, (env) => ({
      published: (c) =>
        Effect.flatMap(Background, (background) =>
          background.run(
            Effect.tryPromise(async () => {
              const hub = env.TREE_HUB.get(env.TREE_HUB.idFromName(c.treeId))
              await hub.changed(
                c.seq,
                c.events.map((e) => e.path),
              )
              if (c.close !== null) await hub.close(c.close)
            }).pipe(
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  console.error('A change hint was lost', {
                    tree: c.treeId,
                    seq: c.seq,
                    error: String(error.error),
                  })
                }),
              ),
            ),
          ),
        ),
    })),
  )

/** Tests: records what was published, in order. */
export const ChangeFeedRecorder = (): {
  readonly layer: Layer.Layer<ChangeFeed>
  readonly published: () => readonly Committed[]
} => {
  const seen: Committed[] = []
  return {
    layer: Layer.succeed(ChangeFeed, {
      published: (c) =>
        Effect.flatMap(Background, (background) =>
          background.run(Effect.sync(() => void seen.push(c))),
        ),
    }),
    published: () => [...seen],
  }
}
