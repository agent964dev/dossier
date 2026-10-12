// The base layer: Dossier's own files under /_/base/<version>/ (the shell,
// the page client, the base layout, the base components and the libraries
// pages load when they use their markup). This build's version is in Static
// Assets; each deploy also copies its files into R2 under base/<version>/, so
// a page opened before a deploy keeps loading the version it started with.
import {
  dossierError,
  type BaseLibraries,
  type DossierError,
} from '@dossier/contracts'
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
  /** The build's libraries.json: each library's and component's files. */
  readonly libraries: BaseLibraries
}

export interface BaseFile {
  readonly body: ReadableStream<Uint8Array>
  readonly type: string
  readonly size: number
}

export interface BaseLayerService {
  readonly version: string
  /** Where each library's and base component's files are in this version. */
  readonly libraries: BaseLibraries
  /** A `_` path the base layer answers, such as '_components/dossier-copy.js'. */
  readonly has: (path: string) => boolean
  /** Tag → '_components/<tag>.js'; export builds are not components. */
  readonly components: () => Readonly<Record<string, string>>
  /** '/_/base/<version>/<path>': root-relative, so it stays on the page's host. */
  readonly url: (path: string) => string
  /** _layout.html with its analysis, read once per isolate. */
  readonly layout: () => Effect.Effect<Source, DossierError<'unavailable'>>
  /**
   * The text of one of this version's files, such as
   * '_components/dossier-copy.md'; null when the version holds no such file.
   */
  readonly read: (
    path: string,
  ) => Effect.Effect<string | null, DossierError<'unavailable'>>
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

// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\\]/

/** A path inside a version: plain names, no `.` or `..`, no empty segment. */
const isBasePath = (path: string): boolean =>
  path !== '' &&
  !path.startsWith('.') &&
  path
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        !CONTROL.test(segment),
    )

/**
 * A request's path segments after the version, each percent-decoded, as the
 * file path they name; null when one does not decode or decodes to a
 * separator, a dot segment, or a control character.
 */
export const basePathOf = (segments: readonly string[]): string | null => {
  const names: string[] = []
  for (const segment of segments) {
    let name: string
    try {
      name = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (name.includes('/')) return null
    names.push(name)
  }
  const path = names.join('/')
  return isBasePath(path) ? path : null
}

/** A single-file build Phase 15 inlines into exports, never a component. */
const EXPORT_BUILD = /\.export\.js$/

const unavailable = (error: unknown) => {
  console.error('The base layer could not be read', error)
  return dossierError('unavailable')
}

/** The parts every adapter shares, over one manifest. */
const fromManifest = (manifest: BaseManifest) => {
  const components: Record<string, string> = {}
  for (const path of Object.keys(manifest.files)) {
    if (!path.startsWith('_components/') || EXPORT_BUILD.test(path)) continue
    const tag = tagOf(path)
    if (tag !== null) components[tag] = path
  }
  const frozen = Object.freeze(components)
  return {
    version: manifest.version,
    libraries: manifest.libraries,
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

      /** A current-version file's text from Static Assets. */
      const textOf = async (path: string): Promise<string> => {
        const response = await ASSETS.fetch(
          new Request(`https://assets.invalid${shared.url(path)}`),
        )
        if (!response.ok) {
          throw new Error(
            `The base layer's ${path} answered ${response.status}`,
          )
        }
        return response.text()
      }

      const readLayout = async (): Promise<Source> =>
        sourceOf(await textOf('_layout.html'))

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
        read: (path) =>
          !Object.hasOwn(manifest.files, path)
            ? Effect.succeed(null)
            : Effect.tryPromise({
                try: () => textOf(path),
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
 * versions are never held; a file the manifest lists without a text reads as
 * null.
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
    read: (path) =>
      Effect.succeed(
        Object.hasOwn(manifest.files, path) ? (sources[path] ?? null) : null,
      ),
    file: () => Effect.succeed(null),
  })
}
