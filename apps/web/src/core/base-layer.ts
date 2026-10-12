// The base layer: Dossier's own files under /_/base/<version>/ (the shell,
// the page client, the base layout and the base components). This build's
// version is in Static Assets; each deploy also copies its files into R2
// under base/<version>/, so a page opened before a deploy keeps loading the
// version it started with.
import { dossierError, type DossierError } from '@dossier/contracts'
import { analyze, tagOf, type Source } from '@dossier/html'
import { Context, Effect, Layer } from 'effect'

import { Bindings } from './bindings.ts'

declare const __BASE_MANIFEST__: BaseManifest | undefined

export interface BaseManifest {
  /** 12 hex characters in a deployed build. */
  readonly version: string
  /** '_layout.html', 'client.js', '_components/dossier-copy.js', … */
  readonly files: Readonly<
    Record<string, { readonly type: string; readonly size: number }>
  >
}

export interface BaseFile {
  readonly body: ReadableStream<Uint8Array>
  readonly type: string
  readonly size: number
}

export interface BaseLayerService {
  readonly version: string
  /** A `_` path the base layer answers, such as '_components/dossier-copy.js'. */
  readonly has: (path: string) => boolean
  /** Tag → '_components/<tag>.js'. */
  readonly components: () => Readonly<Record<string, string>>
  /** '/_/base/<version>/<path>': root-relative, so it stays on the page's host. */
  readonly url: (path: string) => string
  /** _layout.html with its analysis, read once per isolate. */
  readonly layout: () => Effect.Effect<Source, DossierError<'unavailable'>>
  /** An older version's file, from R2 base/<version>/<path>. */
  readonly file: (
    version: string,
    path: string,
  ) => Effect.Effect<BaseFile | null, DossierError<'unavailable'>>
}

export class BaseLayer extends Context.Tag('BaseLayer')<
  BaseLayer,
  BaseLayerService
>() {}

/** The R2 key of a base-layer file. */
export const baseKey = (version: string, path: string): string =>
  `base/${version}/${path}`

/** The marker a finished copy of a version writes last. */
export const BASE_COMPLETE = '.complete'

const VERSION = /^[0-9a-f]{12}$/

/** A path inside a version: plain names, no `.` or `..`, no empty segment. */
const isBasePath = (path: string): boolean =>
  path !== '' &&
  !path.startsWith('.') &&
  path
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')

const unavailable = (error: unknown) => {
  console.error('The base layer could not be read', error)
  return dossierError('unavailable')
}

/** The parts every adapter shares, over one manifest. */
const fromManifest = (manifest: BaseManifest) => {
  const components: Record<string, string> = {}
  for (const path of Object.keys(manifest.files)) {
    if (!path.startsWith('_components/')) continue
    const tag = tagOf(path)
    if (tag !== null) components[tag] = path
  }
  const frozen = Object.freeze(components)
  return {
    version: manifest.version,
    has: (path: string) =>
      path.startsWith('_') && Object.hasOwn(manifest.files, path),
    components: () => frozen,
    url: (path: string) => `/_/base/${manifest.version}/${path}`,
  }
}

const sourceOf = (text: string): Source => ({
  source: text,
  analysis: analyze(text),
  folder: '',
})

/** This build's manifest, as the build defined it. */
const builtManifest = (): BaseManifest => {
  if (typeof __BASE_MANIFEST__ !== 'object' || __BASE_MANIFEST__ === null) {
    throw new Error('The build defined no base-layer manifest')
  }
  return __BASE_MANIFEST__
}

export const BaseLayerLive: Layer.Layer<BaseLayer, never, Bindings> =
  Layer.effect(
    BaseLayer,
    Effect.gen(function* () {
      const { ASSETS, BLOBS } = yield* Bindings
      const manifest = builtManifest()
      const shared = fromManifest(manifest)
      let layout: Promise<Source> | null = null

      const readLayout = async (): Promise<Source> => {
        const response = await ASSETS.fetch(
          new Request(`https://assets.invalid${shared.url('_layout.html')}`),
        )
        if (!response.ok) {
          throw new Error(`The base layout answered ${response.status}`)
        }
        return sourceOf(await response.text())
      }

      return {
        ...shared,
        layout: () =>
          Effect.tryPromise({
            try: () => {
              layout ??= readLayout().catch((error: unknown) => {
                layout = null
                throw error
              })
              return layout
            },
            catch: unavailable,
          }),
        file: (version, path) =>
          !VERSION.test(version) || !isBasePath(path)
            ? Effect.succeed(null)
            : Effect.tryPromise({
                try: () => BLOBS.get(baseKey(version, path)),
                catch: unavailable,
              }).pipe(
                Effect.map((object) =>
                  object === null
                    ? null
                    : {
                        body: object.body,
                        type:
                          object.httpMetadata?.contentType ??
                          'application/octet-stream',
                        size: object.size,
                      },
                ),
              ),
      } satisfies BaseLayerService
    }),
  )

/**
 * A base layer from a manifest and the text of its files, for tests. Older
 * versions are never held.
 */
export const BaseLayerFrom = (
  manifest: BaseManifest,
  sources: Readonly<Record<string, string>>,
): Layer.Layer<BaseLayer> => {
  const shared = fromManifest(manifest)
  return Layer.succeed(BaseLayer, {
    ...shared,
    layout: () => {
      const text = sources['_layout.html']
      return text === undefined
        ? Effect.fail(dossierError('unavailable'))
        : Effect.succeed(sourceOf(text))
    },
    file: () => Effect.succeed(null),
  })
}
