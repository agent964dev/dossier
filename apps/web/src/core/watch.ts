import { dossierError, type DossierError } from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import { WATCH_HEADER, type WatchHeader } from '../hub/tree-hub.ts'
import { Access } from './access.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller } from './caller.ts'
import { TreeStore } from './tree-store.ts'

/** At most this many paths one socket follows. */
export const WATCH_PATHS = 50

export interface WatchService {
  /**
   * Checks who may follow which paths of a tree and hands the socket to the
   * tree's hub. A path the caller cannot read is left out; with none left
   * the upgrade is refused. The answer is the hub's own 101 response.
   */
  readonly accept: (i: {
    readonly request: Request
    readonly tree: string
    readonly paths: readonly string[]
  }) => Effect.Effect<
    Response,
    DossierError<'not_found' | 'sign_in_required' | 'unavailable'>,
    CurrentCaller
  >
}

export class Watch extends Context.Tag('Watch')<Watch, WatchService>() {}

export const WatchLive: Layer.Layer<
  Watch,
  never,
  Bindings | TreeStore | Access
> = Layer.effect(
  Watch,
  Effect.gen(function* () {
    const env = yield* Bindings
    const store = yield* TreeStore
    const access = yield* Access

    const accept: WatchService['accept'] = ({ request, tree, paths }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const person = caller.person
        if (
          person === null ||
          (caller.via.kind !== 'browser' && caller.via.kind !== 'agent')
        ) {
          return yield* Effect.fail(
            dossierError(
              'sign_in_required',
              'Sign in to follow changes.',
              'Sign in with Google, or send an agent key.',
            ),
          )
        }
        const notFound = dossierError(
          'not_found',
          'Nothing is here, or you cannot open it.',
          null,
          tree,
        )
        const found = yield* store.treeNamed(tree)
        if (found === null) return yield* Effect.fail(notFound)
        const treeId = found.tree.id
        const readable: (readonly [number, string])[] = []
        // No path follows the whole tree.
        const asked = paths.length === 0 ? [''] : paths.slice(0, WATCH_PATHS)
        for (const [sub, path] of asked.entries()) {
          const node = yield* store.nearest(treeId, path)
          if (node === null) continue
          const reads = yield* access
            .require('read', node)
            .pipe(Effect.isSuccess)
          if (reads) readable.push([sub, path.replace(/^\/+/, '')])
        }
        if (readable.length === 0) return yield* Effect.fail(notFound)
        const header: WatchHeader = {
          tree: treeId,
          person: person.id,
          session: caller.via.kind === 'browser' ? caller.via.sessionId : null,
          key: caller.via.kind === 'agent' ? caller.via.keyId : null,
          paths: readable,
        }
        // Only what the hub needs goes on: never the cookie or the key.
        const headers = new Headers({
          upgrade: 'websocket',
          [WATCH_HEADER]: JSON.stringify(header),
        })
        for (const name of [
          'sec-websocket-key',
          'sec-websocket-version',
          'sec-websocket-protocol',
          'sec-websocket-extensions',
        ]) {
          const value = request.headers.get(name)
          if (value !== null) headers.set(name, value)
        }
        const hub = env.TREE_HUB.get(env.TREE_HUB.idFromName(treeId))
        return yield* Effect.tryPromise({
          try: () =>
            hub.fetch(new Request(request.url, { method: 'GET', headers })),
          catch: (error) => {
            console.error('A tree hub refused a watch', {
              tree: treeId,
              error: String(error),
            })
            return dossierError('unavailable')
          },
        })
      })

    return { accept } satisfies WatchService
  }),
)
