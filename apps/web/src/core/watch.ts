import {
  commentsFolderIn,
  pageOfCommentsFolder,
  dossierError,
  type DossierError,
  type TreeId,
} from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import {
  SOCKET_HEADER,
  WATCH_HEADER,
  type WatchHeader,
} from '../hub/tree-hub.ts'
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
   * the upgrade is refused. The hub holds the socket closed to hints until
   * access is checked once more, so a revocation landing meanwhile either
   * fails that check or closes the socket it finds. The answer is the hub's
   * own 101 response.
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

    /** The asked paths the caller may read now, as `[sub, tree path]`. */
    const readablePaths = (treeId: TreeId, asked: readonly string[]) =>
      Effect.gen(function* () {
        const out: (readonly [number, string])[] = []
        for (const [sub, path] of asked.entries()) {
          let node = yield* store.nearest(treeId, path)
          // Whoever reads a page reads its comments, the folder made by the
          // first comment or not yet.
          const comments = commentsFolderIn(path)
          if (
            comments !== null &&
            (node === null || node.path.length < comments.length)
          ) {
            const page = yield* store.nearest(
              treeId,
              pageOfCommentsFolder(comments)!,
            )
            if (page?.path === pageOfCommentsFolder(comments)) node = page
          }
          if (node === null) continue
          const reads = yield* access
            .require('read', node)
            .pipe(Effect.isSuccess)
          if (reads) out.push([sub, path.replace(/^\/+/, '')])
        }
        return out
      })

    const accept: WatchService['accept'] = ({ request, tree, paths }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const person = caller.person
        const via = caller.via.kind
        if (
          via !== 'browser' &&
          via !== 'agent' &&
          !(via === 'visitor' && person === null)
        ) {
          return yield* Effect.fail(
            dossierError(
              'sign_in_required',
              'Sign in to follow changes.',
              'Sign in with Google, or send an agent key.',
            ),
          )
        }
        // A visitor is asked to sign in, a person is told nothing is here.
        const refused =
          person === null
            ? dossierError(
                'sign_in_required',
                'Sign in to follow changes here.',
                'Sign in with Google.',
              )
            : dossierError(
                'not_found',
                'Nothing is here, or you cannot open it.',
                null,
                tree,
              )
        const found = yield* store.treeNamed(tree)
        if (found === null) return yield* Effect.fail(refused)
        const treeId = found.tree.id
        // No path follows the whole tree.
        const asked = paths.length === 0 ? [''] : paths.slice(0, WATCH_PATHS)
        const readable = yield* readablePaths(treeId, asked)
        if (readable.length === 0) return yield* Effect.fail(refused)
        const header: WatchHeader = {
          tree: treeId,
          person: person?.id ?? null,
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
        const call = <A>(run: () => Promise<A>) =>
          Effect.tryPromise({
            try: run,
            catch: (error) => {
              console.error('A tree hub refused a watch', {
                tree: treeId,
                error: String(error),
              })
              return dossierError('unavailable')
            },
          })
        const held = yield* call(() =>
          hub.fetch(new Request(request.url, { method: 'GET', headers })),
        )
        const id = held.headers.get(SOCKET_HEADER)
        if (held.status !== 101 || held.webSocket === null || id === null) {
          return held
        }
        // Checked again with the socket held: a revocation that committed
        // after the first check is seen here, and one that commits later
        // closes the socket the hub already holds.
        const again = yield* readablePaths(treeId, asked)
        const same =
          again.length === readable.length &&
          again.every(([sub], n) => readable[n]?.[0] === sub)
        if (!same || !(yield* call(() => hub.admit(id)))) {
          yield* call(() => hub.drop([id]))
          return yield* Effect.fail(refused)
        }
        return new Response(null, { status: 101, webSocket: held.webSocket })
      })

    return { accept } satisfies WatchService
  }),
)
