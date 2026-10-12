// A page exported as one file: the composed page with everything it
// references that the exporter may read inlined, the base libraries it uses,
// the page client in export mode and a snapshot of the data the exporter
// may read. Everything is read on the server, from D1, R2 and the base
// layer; nothing asks a content host. The planning is @dossier/html's.
//
// Opened from disk a module cannot import another by a relative URL, so
// each module the page loads is named `dossier-export/<tree path>` (or
// `dossier-export/base/<path>` for the base layer's) and the file's import
// map maps each name to its data: URL.
import { getBlob } from './blob-keys.ts'
import {
  contentOrigin,
  dossierError,
  linkFor,
  type DossierError,
  type LinkRef,
  type ReadResult,
  type Sha256,
  type TreeId,
} from '@dossier/contracts'
import type { ExportData, Me, PageBootstrap } from '@dossier/contracts/bridge'
import {
  analyze,
  exportRefs,
  injectedTags,
  isRelativeUrl,
  planExport,
  rewriteImports,
  type CssRef,
  type ExportAsset,
  type ExportPlan,
  type ExportRef,
  type ExportSheet,
  type ExportTarget,
  cssRefs,
} from '@dossier/html'
import { Clock, Context, Effect } from 'effect'

import type { AccessService } from './access.ts'
import { BaseLayer, type BaseLayerService } from './base-layer.ts'
import { CurrentCaller } from './caller.ts'
import type { DataService } from './data.ts'
import { jsAnalysisOf } from './lookup.ts'
import type { NodeRow, VersionRow } from './rows.ts'
import {
  linkPathOf,
  type Resolved,
  type TreeRef,
  type TreeStoreService,
} from './tree-store.ts'

/** A page as one file, streamed: what the export route answers. */
export interface ExportServed {
  readonly kind: 'export'
  readonly html: ReadableStream<Uint8Array>
  /** Tree paths of the media kept as links instead of inlined. */
  readonly linked: readonly string[]
  /** The name the download is saved as: 'plan.html'. */
  readonly filename: string
}

/** The most a stylesheet may be to be inlined; a larger one stays a link. */
const SHEET_BYTES = 2 * 1024 * 1024
/** The most a diff's patch is read to find the languages it shows. */
const DIFF_BYTES = 1024 * 1024
/** How many modules one export follows. */
const MAX_MODULES = 1000
/** How deep stylesheets import each other. */
const MAX_SHEET_DEPTH = 8

/** The base layer's files in an exported page are named under this. */
export const EXPORT_BASE = 'dossier-export/base'
const EXPORT_PREFIX = 'dossier-export/'

const MEDIA = /^(image|video|audio)\//

/** A module file a page imports as JSON, by its type or its name. */
const isJsonModule = (reached: {
  readonly asked: string
  readonly version: VersionRow
}): boolean =>
  /\.json$/i.test(reached.asked) ||
  (reached.version.contentType ?? '').split(';')[0]?.trim() ===
    'application/json'

/** The fragment of a located URL's query and fragment, or undefined. */
const fragmentOf = (suffix: string): string | undefined => {
  const at = suffix.indexOf('#')
  return at < 0 || at === suffix.length - 1 ? undefined : suffix.slice(at)
}

/** How many stylesheets one export reads. */
const MAX_SHEETS = 200

const folderOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

/** A tree path as a bare module name, each segment percent-encoded. */
const moduleName = (path: string): string =>
  EXPORT_PREFIX + path.split('/').map(encodeURIComponent).join('/')

/** What a resolved reference reaches in the tree or the base layer. */
type Reached =
  | {
      readonly kind: 'tree'
      readonly node: NodeRow
      readonly version: VersionRow
      /** The tree path the browser would have asked for. */
      readonly asked: string
    }
  | { readonly kind: 'base'; readonly path: string }
  /** A tree path the exporter cannot read, or that holds nothing. */
  | { readonly kind: 'missing'; readonly asked: TreeRef }

/** Where a URL in the page points. */
type Located =
  | {
      readonly kind: 'tree'
      readonly ref: TreeRef
      /** The query and fragment as written. */
      readonly suffix: string
    }
  | { readonly kind: 'base'; readonly path: string }
  | { readonly kind: 'elsewhere' }

export interface ExporterDeps {
  readonly store: TreeStoreService
  readonly access: AccessService
  readonly data: DataService
  readonly bindings: Pick<Env, 'BLOBS' | 'DB'>
  readonly context: Context.Context<
    BaseLayer | import('./bindings.ts').Bindings
  >
  readonly origin: URL
  readonly contentHost: string
  readonly treeRefOf: (treeId: TreeId, linkPath: string) => TreeRef | null
  readonly kitChoice: (
    kit: Extract<Resolved, { readonly kind: 'kit' }>,
    needs: 'read' | 'write',
  ) => Effect.Effect<
    | Extract<
        Extract<Resolved, { readonly kind: 'kit' }>['found'][number],
        { readonly kind: 'tree' }
      >
    | { readonly kind: 'base'; readonly path: string }
    | null,
    DossierError<'unavailable'>,
    import('./caller.ts').CurrentCaller
  >
  /** The agent version a link gives the caller. */
  readonly read: (
    ref: LinkRef,
  ) => Effect.Effect<
    ReadResult,
    DossierError<'not_found' | 'sign_in_required' | 'unavailable'>,
    import('./caller.ts').CurrentCaller
  >
}

export interface ExportPageInput {
  readonly ref: LinkRef
  readonly tree: {
    readonly id: TreeId
    readonly workspace: string
    readonly name: string
  }
  readonly page: Extract<Resolved, { readonly kind: 'page' }>
  readonly granted: import('./access.ts').Granted<'read'>
  readonly role: Me['role']
  /** The composed page, as a frame serves it. */
  readonly html: string
}

const unavailable = (error: unknown) => {
  console.error('An export read failed', error)
  return dossierError('unavailable')
}

/** The name an export is saved as. */
export const exportFilename = (path: string, treeName: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name !== 'index.html')
    return name.endsWith('.html') ? name : `${name}.html`
  const folder = folderOf(path)
  return `${folder === '' ? treeName : folder.slice(folder.lastIndexOf('/') + 1)}.html`
}

/**
 * A stream of the plan's pieces: text, and files from R2 as base64. Each
 * read of the body reads a file only until it has a whole base64 group to
 * give (or the file ends), so a slow reader holds R2 back; cancelling the
 * body cancels the file's read, one R2 had not answered yet included.
 */
export const exportStream = (
  plan: ExportPlan,
  blobs: Pick<Env, 'BLOBS' | 'DB'>,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  const list = [...plan.pieces]
  let at = 0
  let file: ReadableStreamDefaultReader<Uint8Array> | null = null
  // Bytes of the file not yet encoded: base64 goes in 3-byte groups, so each
  // chunk encodes on its own.
  let carry = new Uint8Array(0)
  let cancelled = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (file !== null) {
        // Reads on until a whole base64 group can go out, or the file ends.
        for (;;) {
          const { done, value } = await file.read()
          if (done) {
            file = null
            const rest = carry
            carry = new Uint8Array(0)
            if (rest.length > 0) {
              controller.enqueue(encoder.encode(base64(rest)))
              return
            }
            // Nothing left of it to write: on to the next piece.
            break
          }
          const bytes = new Uint8Array(carry.length + value.length)
          bytes.set(carry)
          bytes.set(value, carry.length)
          const whole = bytes.length - (bytes.length % 3)
          carry = bytes.slice(whole)
          if (whole > 0) {
            controller.enqueue(encoder.encode(base64(bytes.subarray(0, whole))))
            return
          }
        }
      }
      const piece = list[at++]
      if (piece === undefined) {
        controller.close()
        return
      }
      if (piece.kind === 'text') {
        controller.enqueue(encoder.encode(piece.text))
        return
      }
      const object = await getBlob(blobs, piece.sha256)
      // Cancelled while R2 answered: the body it gave is never read.
      if (cancelled) {
        await object?.body.cancel()
        return
      }
      if (object === null) {
        console.error('A blob is missing from R2', { sha256: piece.sha256 })
        controller.error(new Error('A file of the export is missing'))
        return
      }
      file = object.body.getReader()
      controller.enqueue(encoder.encode(`data:${piece.type};base64,`))
    },
    async cancel(reason) {
      cancelled = true
      await file?.cancel(reason)
      file = null
    },
  })
}

const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export const makeExporter = (deps: ExporterDeps) => {
  const { store, access, data, bindings, context } = deps
  const base: BaseLayerService = Context.get(context, BaseLayer)

  const textOf = (sha: string) =>
    Effect.tryPromise({
      try: async () => {
        const object = await getBlob(bindings, sha)
        return object === null ? null : object.text()
      },
      catch: unavailable,
    })

  /** Every library and component's live build, by path → its export build. */
  const exportBuilds = (): ReadonlyMap<string, string> => {
    const builds = new Map<string, string>()
    const { libraries, components } = base.libraries
    for (const build of [
      libraries.mermaid,
      libraries.shiki,
      libraries.katex,
      ...Object.values(components),
    ]) {
      builds.set(build.live, build.export)
    }
    return builds
  }

  const exportPage = (i: ExportPageInput) =>
    Effect.gen(function* () {
      const caller = yield* CurrentCaller
      const person = caller.person!
      const treeId = i.tree.id
      const pagePath = i.page.node.path
      const folder = folderOf(pagePath)
      const origin = contentOrigin(deps.contentHost, treeId)
      const builds = exportBuilds()

      const linkOf = (path: string, kind: 'page' | 'folder' | 'file') =>
        linkFor(deps.origin, {
          workspace: i.tree.workspace,
          tree: i.tree.name,
          path,
          kind,
        })
      /** A tree path's canonical link, a page by its link. */
      const canonical = (ref: TreeRef, suffix = '') =>
        linkOf(
          ref.path,
          ref.folder ? 'folder' : ref.path.endsWith('.html') ? 'page' : 'file',
        ) + suffix

      /** Where a URL written in a file of `from` points. */
      const locate = (url: string, from: string): Located => {
        const trimmed = url.trim()
        const baseOf = (pathname: string): Located | null => {
          const prefix = `/_/base/${base.version}/`
          return pathname.startsWith(prefix)
            ? { kind: 'base', path: decodeURI(pathname.slice(prefix.length)) }
            : null
        }
        if (isRelativeUrl(trimmed)) {
          let resolved: URL
          try {
            resolved = new URL(
              trimmed,
              `https://tree.invalid/${linkPathOf(from, true)}`,
            )
          } catch {
            return { kind: 'elsewhere' }
          }
          const ref = deps.treeRefOf(treeId, resolved.pathname.slice(1))
          return ref === null
            ? { kind: 'elsewhere' }
            : {
                kind: 'tree',
                ref,
                suffix: `${resolved.search}${resolved.hash}`,
              }
        }
        let absolute: URL
        try {
          absolute = new URL(trimmed, origin)
        } catch {
          return { kind: 'elsewhere' }
        }
        if (absolute.origin !== origin) return { kind: 'elsewhere' }
        const inBase = baseOf(absolute.pathname)
        if (inBase !== null) return inBase
        // A frame URL of this tree: its link path after the handle and push.
        const frame = /^\/_\/v\/[^/]+\/\d+\/(.*)$/.exec(absolute.pathname)
        if (frame === null) return { kind: 'elsewhere' }
        const ref = deps.treeRefOf(treeId, frame[1] ?? '')
        return ref === null
          ? { kind: 'elsewhere' }
          : { kind: 'tree', ref, suffix: `${absolute.search}${absolute.hash}` }
      }

      /** The file a tree reference reaches for the caller, live. */
      const reach = (ref: TreeRef) =>
        Effect.gen(function* () {
          let found = yield* store.resolve(ref)
          if (!('missing' in found) && found.kind === 'redirect') {
            const next = deps.treeRefOf(treeId, found.to)
            if (next === null) return { kind: 'missing', asked: ref }
            found = yield* store.resolve(next)
          }
          if ('missing' in found) return { kind: 'missing', asked: ref }
          if (found.kind === 'kit') {
            const chosen = yield* deps.kitChoice(found, 'read')
            if (chosen === null) return { kind: 'missing', asked: ref }
            if (chosen.kind === 'base')
              return { kind: 'base', path: chosen.path }
            return {
              kind: 'tree',
              node: chosen.node,
              version: chosen.version,
              asked: ref.path,
            }
          }
          if (found.kind !== 'file' && found.kind !== 'page') {
            return { kind: 'missing', asked: ref }
          }
          // People's data is never inlined: a frame serves it only as a
          // download.
          if (found.node.origin === 'data')
            return { kind: 'missing', asked: ref }
          const reads = yield* access
            .require('read', found.node)
            .pipe(Effect.isSuccess)
          if (!reads) return { kind: 'missing', asked: ref }
          return {
            kind: 'tree',
            node: found.node,
            version: found.version,
            asked: ref.path,
          }
        }) as Effect.Effect<Reached, DossierError<'unavailable'>, CurrentCaller>

      const assetOf = (
        reached: Extract<Reached, { kind: 'tree' }>,
        name?: string,
      ): ExportAsset | null => {
        const sha = reached.version.blobSha256
        if (sha === null) return null
        const type = reached.version.contentType ?? 'application/octet-stream'
        return {
          sha256: sha,
          size: reached.version.size ?? 0,
          type,
          media: MEDIA.test(type),
          link: linkOf(reached.node.path, 'file'),
          ...(name === undefined ? {} : { name }),
        }
      }

      /** Tree paths by canonical link, for the media kept as links. */
      const linkedPaths = new Map<string, string>()

      // Modules ------------------------------------------------------------

      /** The import map: each module or base file by its bare name. */
      const imports = new Map<string, { text: string; type: string }>()
      const queued = new Set<string>()

      /** A base layer file's export build by its live path, as a bare name. */
      const baseModule = (path: string) =>
        Effect.gen(function* () {
          const build = builds.get(path)
          if (build === undefined) return null
          const name = `${EXPORT_BASE}/${path}`
          if (!imports.has(name)) {
            const text = yield* base.read(build)
            if (text === null) return null
            imports.set(name, { text, type: 'text/javascript' })
          }
          return name
        })

      /** A base layer file read as text, under its bare name. */
      const baseFile = (path: string, build: string, type: string) =>
        Effect.gen(function* () {
          const name = `${EXPORT_BASE}/${path}`
          if (imports.has(name)) return
          const text = yield* base.read(build)
          if (text !== null) imports.set(name, { text, type })
        })

      /**
       * A tree module and every module it imports, rewritten to bare names;
       * its own name, or null when it is not one the caller may read.
       */
      const treeModule = (reached: Extract<Reached, { kind: 'tree' }>) =>
        Effect.gen(function* () {
          const name = moduleName(reached.asked)
          if (queued.has(name)) return name
          if (queued.size >= MAX_MODULES) return null
          queued.add(name)
          const sha = reached.version.blobSha256
          if (sha === null) return null
          const text = yield* textOf(sha)
          if (text === null) return null
          // A JSON module is its file as written, imported as JSON.
          if (isJsonModule(reached)) {
            imports.set(name, { text, type: 'application/json' })
            return name
          }
          const analysis = yield* jsAnalysisOf(sha as Sha256).pipe(
            Effect.provide(context),
          )
          const names = new Map<string, string | null>()
          for (const found of analysis?.imports ?? []) {
            if (names.has(found.specifier)) continue
            names.set(
              found.specifier,
              yield* moduleTarget(found.specifier, folderOf(reached.asked)),
            )
          }
          imports.set(name, {
            text: rewriteImports(
              text,
              analysis?.imports ?? [],
              (specifier) => names.get(specifier) ?? null,
            ),
            type: 'text/javascript',
          })
          return name
        })

      /** The bare name an import names, or null to leave it as written. */
      const moduleTarget = (
        specifier: string,
        from: string,
      ): Effect.Effect<
        string | null,
        DossierError<'unavailable'>,
        CurrentCaller
      > =>
        Effect.gen(function* () {
          // A bare specifier resolves only through the page's own map; an
          // absolute URL is followed when it is this tree's own.
          if (
            !specifier.startsWith('./') &&
            !specifier.startsWith('../') &&
            !specifier.startsWith('/') &&
            !URL.canParse(specifier)
          ) {
            return null
          }
          const located = locate(specifier, from)
          if (located.kind === 'base') return yield* baseModule(located.path)
          if (located.kind !== 'tree') return null
          const reached = yield* reach(located.ref)
          if (reached.kind === 'base') return yield* baseModule(reached.path)
          if (reached.kind !== 'tree') return null
          return yield* treeModule(reached)
        })

      // Stylesheets ----------------------------------------------------------

      /**
       * Each stylesheet's text and references, read once by the tree path it
       * was asked at; null when it is too large or holds no bytes.
       */
      const sheetFiles = new Map<
        string,
        { readonly text: string; readonly refs: readonly CssRef[] } | null
      >()
      /** What each URL in a stylesheet becomes, other than its imports. */
      const sheetUrls = new Map<string, ExportTarget | null>()
      /** How many stylesheets the export has written out so far. */
      let expanded = 0

      const sheetFile = (reached: Extract<Reached, { kind: 'tree' }>) =>
        Effect.gen(function* () {
          if (sheetFiles.has(reached.asked)) {
            return sheetFiles.get(reached.asked) ?? null
          }
          const sha = reached.version.blobSha256
          const text =
            sha === null || (reached.version.size ?? 0) > SHEET_BYTES
              ? null
              : yield* textOf(sha)
          const file = text === null ? null : { text, refs: cssRefs(text) }
          sheetFiles.set(reached.asked, file)
          return file
        })

      /**
       * A stylesheet as it is written out where it is imported: its imports
       * follow this occurrence's chain, so an import that closes a cycle on
       * it imports an empty sheet in its place, as a browser ignores the
       * cycle, and the depth counts from where it sits. A sheet past the
       * count stays its link.
       */
      const sheetOf = (
        reached: Extract<Reached, { kind: 'tree' }>,
        depth: number,
        chain: ReadonlySet<string>,
      ): Effect.Effect<
        ExportSheet | 'cycle' | null,
        DossierError<'unavailable'>,
        CurrentCaller
      > =>
        Effect.gen(function* () {
          if (chain.has(reached.asked)) return 'cycle'
          if (expanded >= MAX_SHEETS) return null
          const file = yield* sheetFile(reached)
          if (file === null) return null
          expanded += 1
          const from = folderOf(reached.asked)
          const inner = new Set([...chain, reached.asked])
          const refs: ExportSheet['refs'][number][] = []
          for (const ref of file.refs) {
            let target: ExportTarget | null
            if (ref.kind === 'import') {
              target = yield* urlTarget(
                ref.url,
                from,
                'stylesheet',
                depth + 1,
                inner,
              )
            } else {
              const key = `${from}\n${ref.url}`
              if (!sheetUrls.has(key)) {
                sheetUrls.set(key, yield* urlTarget(ref.url, from, 'image'))
              }
              target = sheetUrls.get(key) ?? null
            }
            if (target !== null) {
              refs.push({ range: ref.range, kind: ref.kind, target })
            }
          }
          return { text: file.text, refs }
        })

      // Targets --------------------------------------------------------------

      /**
       * What a URL in a file of `from` becomes: a file of the tree the caller
       * reads inlined, anything else of the tree its canonical link, a URL
       * elsewhere as written (null).
       */
      const urlTarget = (
        url: string,
        from: string,
        kind: ExportRef['kind'],
        depth = 0,
        chain: ReadonlySet<string> = new Set(),
      ): Effect.Effect<
        ExportTarget | null,
        DossierError<'unavailable'>,
        CurrentCaller
      > =>
        Effect.gen(function* () {
          if (url.startsWith('#') || url === '') return null
          // A root-relative URL outside the base layer names nothing in a
          // frame, so it is left as written.
          if (url.startsWith('/') && !url.startsWith('//')) {
            if (!url.startsWith(`/_/base/${base.version}/`)) return null
          }
          const located = locate(url, from)
          if (located.kind === 'elsewhere') return null
          if (kind === 'preload') return { kind: 'drop' }
          if (kind === 'page-link' || kind === 'frame') {
            return located.kind === 'tree'
              ? { kind: 'link', href: canonical(located.ref, located.suffix) }
              : null
          }
          const reached: Reached =
            located.kind === 'base'
              ? { kind: 'base', path: located.path }
              : yield* reach(located.ref)
          if (reached.kind === 'missing') {
            return { kind: 'link', href: canonical(reached.asked, '') }
          }
          if (reached.kind === 'base') {
            if (kind === 'module' || kind === 'component') {
              const name = yield* baseModule(reached.path)
              return name === null ? null : { kind: 'module', name }
            }
            return null
          }
          const missing: ExportTarget = {
            kind: 'link',
            href: linkOf(reached.node.path, 'file'),
          }
          const fragment =
            located.kind === 'tree' ? fragmentOf(located.suffix) : undefined
          switch (kind) {
            case 'module':
            case 'component': {
              const name = yield* treeModule(reached)
              return name === null ? missing : { kind: 'module', name }
            }
            case 'script': {
              // A classic script needs no rewriting, so its bytes stream.
              const asset = assetOf(reached)
              return asset === null
                ? missing
                : {
                    kind: 'asset',
                    asset: { ...asset, type: 'text/javascript', media: false },
                    ...(fragment === undefined ? {} : { fragment }),
                  }
            }
            case 'stylesheet': {
              if (depth > MAX_SHEET_DEPTH) return missing
              const sheet = yield* sheetOf(reached, depth, chain)
              if (sheet === 'cycle') {
                return { kind: 'text', text: '', type: 'text/css' }
              }
              return sheet === null ? missing : { kind: 'sheet', sheet }
            }
            default: {
              const asset = assetOf(reached)
              if (asset === null) return missing
              linkedPaths.set(asset.link, reached.node.path)
              return {
                kind: 'asset',
                asset,
                ...(fragment === undefined ? {} : { fragment }),
              }
            }
          }
        })

      // The composed page ------------------------------------------------------

      const html = i.html
      const analysis = analyze(html)
      const injected = injectedTags(html, analysis)
      if (injected === null) {
        console.error('A composed page holds no bootstrap', {
          treeId,
          pagePath,
        })
        return yield* Effect.fail(dossierError('unavailable'))
      }
      const live = JSON.parse(injected.bootstrap) as PageBootstrap
      const refs = exportRefs(html, analysis)
      const targets = new Map<ExportRef, ExportTarget>()
      const kit: Record<string, string> = {}
      const languages = new Set(analysis.codeLanguages)

      for (const ref of refs) {
        if (ref.kind === 'component') {
          // The tree's components, and the base layer's the page uses.
          const isBase = ref.url.startsWith('/_/base/')
          if (isBase && !live.used.includes(ref.element)) continue
          const target = yield* urlTarget(ref.url, folder, 'component')
          if (target?.kind === 'module') kit[ref.element] = target.name
          continue
        }
        if (ref.kind === 'copy') {
          const located =
            ref.url === ''
              ? ({
                  kind: 'tree',
                  ref: { treeId, path: pagePath, folder: false },
                  suffix: '',
                } as const)
              : locate(ref.url, folder)
          if (located.kind !== 'tree') continue
          const asked: LinkRef = {
            workspace: i.ref.workspace,
            tree: i.ref.tree,
            path: located.ref.path,
            folder: located.ref.folder,
          }
          const result = yield* deps.read(asked).pipe(
            Effect.catchIf(
              (e) => e.code !== 'unavailable',
              () => Effect.succeed(null),
            ),
          )
          targets.set(
            ref,
            result === null || !('text' in result) || result.text === null
              ? { kind: 'link', href: canonical(located.ref, '') }
              : { kind: 'text', text: result.text, type: 'text/markdown' },
          )
          continue
        }
        if (ref.kind === 'diff') {
          const located = locate(ref.url, folder)
          if (located.kind !== 'tree') continue
          const reached = yield* reach(located.ref)
          const asset =
            reached.kind === 'tree' ? assetOf(reached, ref.url) : null
          if (asset === null || reached.kind !== 'tree') {
            targets.set(ref, {
              kind: 'link',
              href: canonical(located.ref, located.suffix),
            })
            continue
          }
          targets.set(ref, { kind: 'asset', asset })
          // The languages the diff highlights, by its files' names.
          const names = [ref.url]
          if (
            ref.element === 'dossier-diff' &&
            /\.(patch|diff)$/i.test(ref.url)
          ) {
            const sha = reached.version.blobSha256
            if (sha !== null && (reached.version.size ?? 0) <= DIFF_BYTES) {
              const patch = (yield* textOf(sha)) ?? ''
              for (const match of patch.matchAll(
                /^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm,
              )) {
                names.push(match[1] ?? '')
              }
            }
          }
          for (const name of names) {
            const ext = /\.([A-Za-z0-9+_-]+)$/.exec(name)?.[1]?.toLowerCase()
            if (ext !== undefined) languages.add(ext)
          }
          continue
        }
        if (ref.candidates !== undefined) {
          // A srcset written whole: each candidate on its own.
          const each: (ExportTarget | null)[] = []
          for (const candidate of ref.candidates) {
            each.push(yield* urlTarget(candidate.url, folder, ref.kind))
          }
          if (each.some((target) => target !== null)) {
            targets.set(ref, { kind: 'candidates', targets: each })
          }
          continue
        }
        const target = yield* urlTarget(ref.url, folder, ref.kind)
        if (target !== null) targets.set(ref, target)
      }

      // The libraries the page uses, with the grammars and stylesheet they
      // load.
      const { libraries } = base.libraries
      for (const name of analysis.libraries) {
        yield* baseModule(libraries[name].live)
      }
      const diffUsed =
        Object.hasOwn(kit, 'dossier-diff') &&
        kit['dossier-diff']!.startsWith(EXPORT_BASE)
      if (analysis.libraries.includes('shiki') || diffUsed) {
        for (const language of languages) {
          const grammar = libraries.shiki.grammars[language]
          if (grammar !== undefined) {
            yield* baseFile(grammar.file, grammar.file, 'application/json')
          }
        }
      }
      if (analysis.libraries.includes('katex')) {
        yield* baseFile(
          libraries.katex.css,
          libraries.katex.exportCss,
          'text/css',
        )
      }

      const client = yield* base.read('client.js')
      if (client === null) {
        console.error('The base layer holds no client.js')
        return yield* Effect.fail(dossierError('unavailable'))
      }
      const snapshot = yield* data.snapshotFor(
        i.granted,
        live.forms.map((form) => form.target),
      )
      const now = yield* Clock.currentTimeMillis
      const at = new Date(now).toISOString()
      const bootstrap: PageBootstrap = {
        ...live,
        kit,
        used: live.used.filter((tag) => Object.hasOwn(kit, tag)),
        export: true,
      }
      const me: Me = { email: person.email, name: person.name, role: i.role }
      const plan = planExport({
        html,
        refs,
        targets,
        imports,
        injected: injected.range,
        bootstrap: JSON.stringify(bootstrap),
        data: (linked) =>
          JSON.stringify({
            v: 1,
            at,
            link: live.link,
            me,
            files: snapshot.files,
            comments: snapshot.comments,
            linked,
          } satisfies ExportData),
        client,
        header: { link: live.link, by: person.email, at },
      })
      if ('tooLarge' in plan) {
        const mib = Math.ceil(plan.tooLarge / (1024 * 1024))
        return yield* Effect.fail(
          dossierError(
            'too_large',
            `This page would export as ${mib} MiB, above the 50 MiB limit even with its media linked.`,
            'Open the page in Dossier, or move large scripts or stylesheets out of it.',
            i.ref.path,
          ),
        )
      }
      return {
        kind: 'export',
        html: exportStream(plan, bindings),
        linked: plan.linked.map((link) => linkedPaths.get(link) ?? link),
        filename: exportFilename(pagePath, i.tree.name),
      } satisfies ExportServed
    })

  return { exportPage }
}
