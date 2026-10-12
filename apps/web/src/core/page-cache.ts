// Composed pages, cached under what they are made of. The key holds nothing
// about the viewer, so one entry serves everyone; a push anywhere in the tree
// moves its sequence and so the key of every page in it.
import type { AuthoredSeq, TreeId } from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

export interface ComposedKey {
  /** The content host the request came to. */
  readonly host: string
  readonly treeId: TreeId
  readonly seq: AuthoredSeq
  /** The page file's path in the tree. */
  readonly path: string
  /** `${COMPOSER_VERSION}.${ANALYZER_VERSION}`. */
  readonly composer: string
  /** BaseLayer.version. */
  readonly base: string
}

/** https://<host>/_/compose-cache/<treeId>/<seq>/<composer>/<base>/<path> */
export const composedKeyUrl = (key: ComposedKey): string =>
  `https://${key.host}/_/compose-cache/${key.treeId}/${key.seq}/` +
  `${encodeURIComponent(key.composer)}/${encodeURIComponent(key.base)}/` +
  key.path.split('/').map(encodeURIComponent).join('/')

export interface PageCacheService {
  readonly get: (key: ComposedKey) => Effect.Effect<string | null>
  readonly put: (key: ComposedKey, html: string) => Effect.Effect<void>
}

export class PageCache extends Context.Tag('PageCache')<
  PageCache,
  PageCacheService
>() {}

/** How long an entry may live; its key never names other content. */
const MAX_AGE = 86_400

/** The Cache API; a failure is logged and read as a miss. */
export const PageCacheLive: Layer.Layer<PageCache> = Layer.sync(
  PageCache,
  () => {
    // Workers' own CacheStorage, whose `default` the DOM's type lacks.
    const cache = (): Cache | null =>
      typeof caches === 'undefined'
        ? null
        : (caches as unknown as { readonly default: Cache }).default
    return {
      get: (key) =>
        Effect.promise(async () => {
          try {
            const hit = await cache()?.match(composedKeyUrl(key))
            return hit === undefined ? null : await hit.text()
          } catch (error) {
            console.error('The composed-page cache could not be read', error)
            return null
          }
        }),
      put: (key, html) =>
        Effect.promise(async () => {
          try {
            await cache()?.put(
              composedKeyUrl(key),
              new Response(html, {
                headers: {
                  'content-type': 'text/html; charset=utf-8',
                  'cache-control': `max-age=${MAX_AGE}`,
                },
              }),
            )
          } catch (error) {
            console.error('The composed-page cache could not be written', error)
          }
        }),
    } satisfies PageCacheService
  },
)

/** A map that records every key it is asked for, for tests. */
export const PageCacheMemory = (): {
  readonly layer: Layer.Layer<PageCache>
  readonly keys: () => readonly ComposedKey[]
  readonly entries: () => ReadonlyMap<string, string>
} => {
  const entries = new Map<string, string>()
  const keys: ComposedKey[] = []
  return {
    layer: Layer.succeed(PageCache, {
      get: (key) =>
        Effect.sync(() => {
          keys.push(key)
          return entries.get(composedKeyUrl(key)) ?? null
        }),
      put: (key, html) =>
        Effect.sync(() => {
          entries.set(composedKeyUrl(key), html)
        }),
    }),
    keys: () => keys,
    entries: () => entries,
  }
}
