// What a link gives an agent, and what `dossier read` prints: a page's agent
// version (its companion, or the Markdown generated at push, with the pointer
// line), a folder's listing with the kit for write holders, a data folder's
// files with who wrote each, or a file. Pages.read and the link route's agent
// branch both answer from here, so they return the same text.
import {
  dossierError,
  type AuthoredSeq,
  type DocWire,
  type DossierError,
  type ErrorCode,
  type KitItemWire,
  type LinkRef,
  type Pointer,
  type PushNumber,
  type ReadResult,
  type Sha256,
  type TreeId,
} from '@dossier/contracts'
import {
  companionOf,
  resolveFormAction,
  themeVariables,
  type HtmlAnalysis,
} from '@dossier/html'
import { sql } from 'drizzle-orm'
import { Clock, Context, Effect } from 'effect'

import { db, schema } from '../db/client.ts'
import type { AccessService } from './access.ts'
import { BaseLayer } from './base-layer.ts'
import type { Bindings } from './bindings.ts'
import type { CurrentCaller } from './caller.ts'
import { entryWire, type FilesService } from './files.ts'
import { composedLayouts, type KitFound, type KitItem } from './lookup.ts'
import type { MissingNode, NodeRow, VersionRow } from './rows.ts'
import {
  blobKey,
  linkPathOf,
  type DocRow,
  type Entry,
  type Resolved,
  type TreeRef,
  type TreeStoreService,
} from './tree-store.ts'

export type AgentType = 'text/markdown' | 'application/json'

/** What the link route answers an agent with; the edge renders it. */
export type AgentServed =
  | { readonly kind: 'agent'; readonly body: string; readonly type: AgentType }
  | {
      readonly kind: 'file'
      readonly body: ReadableStream<Uint8Array>
      readonly size: number
      readonly etag: string
      readonly contentType: string
      readonly range: null
      readonly download: true
      readonly cache: 'private'
    }

type ReadError = DossierError<'not_found' | 'sign_in_required' | 'unavailable'>

/** Text files an agent gets as text, up to this size. */
const TEXT_LIMIT = 1024 * 1024
const TEXT_EXTENSIONS = ['.md', '.json', '.csv', '.svg']

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** '10 Oct', or '10 Oct 2025' outside the current year; UTC. */
export const shortDate = (at: number, now: number): string => {
  const date = new Date(at)
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
  return date.getUTCFullYear() === new Date(now).getUTCFullYear()
    ? day
    : `${day} ${date.getUTCFullYear()}`
}

/** '12 Oct 2026, 14:20 UTC'. */
export const longDate = (at: number): string => {
  const date = new Date(at)
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hh}:${mm} UTC`
}

/** '512 bytes', '2.1 KB', '2.1 MB': decimal units, as people read sizes. */
export const sizeText = (bytes: number): string => {
  if (bytes < 1000) return bytes === 1 ? '1 byte' : `${bytes} bytes`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** 'PDF', 'PNG', … from the name; 'File' when it has no extension. */
export const typeLabel = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot <= 0 || dot === name.length - 1
    ? 'File'
    : name.slice(dot + 1).toUpperCase()
}

/** 'Data: answers/ (3 files), decisions.json (1 file) · Comments: 2'. */
export const pointerLine = (pointer: Pointer): string => {
  const files = (n: number) => (n === 1 ? '1 file' : `${n} files`)
  const data =
    pointer.data.length === 0
      ? 'none'
      : pointer.data.map((d) => `${d.path} (${files(d.files)})`).join(', ')
  return `Data: ${data} · Comments: ${pointer.comments}`
}

const withPointer = (text: string, pointer: Pointer): string =>
  `${text.replace(/\s+$/, '')}\n\n${pointerLine(pointer)}\n`

const lastName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const isTextFile = (name: string, contentType: string, size: number) =>
  size <= TEXT_LIMIT &&
  (contentType.toLowerCase().startsWith('text/') ||
    TEXT_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)))

/** A folder as its listing reads: '# acme/', '# acme/guides/'. */
const folderTitle = (tree: string, path: string) =>
  `${tree}/${path === '' ? '' : `${path}/`}`

const entryLine = (entry: Entry, now: number): string => {
  const shown = entry.node.kind === 'folder' ? `${entry.name}/` : entry.name
  switch (entry.kind) {
    case 'page': {
      const parts = [
        ...(entry.title === null || entry.title === '' ? [] : [entry.title]),
        shown,
        ...(entry.push === null
          ? []
          : [`push ${entry.push.number}, ${shortDate(entry.push.at, now)}`]),
      ]
      return `- ${parts.join(' · ')}`
    }
    case 'folder': {
      const pages = entry.pages ?? 0
      return `- ${shown} · ${pages === 1 ? '1 page' : `${pages} pages`}`
    }
    default:
      return entry.node.kind === 'folder'
        ? `- ${shown}`
        : `- ${shown} · ${typeLabel(entry.name)}, ${sizeText(entry.size ?? 0)}`
  }
}

const KIT_ORDER: readonly KitItemWire['kind'][] = [
  'layout',
  'theme',
  'component',
  'doc',
  'file',
]

/**
 * The kit as a folder's text lists it: the closest folder first and the base
 * layer last, each folder's layout, theme, components and other files in
 * that order.
 */
const kitLines = (tree: string, items: readonly KitItemWire[]): string[] => {
  const tags = new Set(
    items.filter((i) => i.kind === 'component').map((i) => i.tag),
  )
  const folders = [...new Set(items.map((item) => item.from))]
  const ordered = [...items].sort(
    (a, b) =>
      folders.indexOf(a.from) - folders.indexOf(b.from) ||
      KIT_ORDER.indexOf(a.kind) - KIT_ORDER.indexOf(b.kind),
  )
  const lines: string[] = []
  for (const item of ordered) {
    // A component's documentation is shown with the component.
    if (item.kind === 'doc' && tags.has(item.tag)) continue
    const from =
      item.from === null ? 'base layer' : `from ${folderTitle(tree, item.from)}`
    if (item.kind === 'component') {
      lines.push(
        item.from === null
          ? `- <${item.tag}> base layer`
          : `- <${item.tag}> ${item.path} (${from})`,
      )
      if (item.doc !== null && item.doc.trim() !== '') {
        for (const line of item.doc.replace(/\s+$/, '').split('\n')) {
          lines.push(line === '' ? '' : `  ${line}`)
        }
      }
      continue
    }
    const sets =
      item.kind === 'theme' && item.variables.length > 0
        ? ` · sets ${item.variables.join(', ')}`
        : ''
    lines.push(
      item.from === null
        ? `- ${item.path} (base layer)${sets}`
        : `- ${item.path} (${from})${sets}`,
    )
  }
  return lines
}

/** A folder's text: what it holds by section, then the kit for write holders. */
export const folderText = (i: {
  readonly tree: string
  readonly path: string
  readonly entries: readonly Entry[]
  readonly kit: readonly KitItemWire[] | null
  readonly now: number
}): string => {
  const shown = i.entries.filter((entry) => entry.kind !== 'kit')
  if (shown.length === 0) return 'Nothing here yet.\n'
  const sections: [string, Entry['kind'][]][] = [
    ['Pages', ['page']],
    ['Folders', ['folder']],
    ['Files', ['attachment']],
    ['Data', ['data']],
  ]
  const out = [`# ${folderTitle(i.tree, i.path)}`]
  for (const [title, kinds] of sections) {
    const rows = shown.filter((entry) => kinds.includes(entry.kind))
    if (rows.length === 0) continue
    out.push('', title, ...rows.map((entry) => entryLine(entry, i.now)))
  }
  if (i.kit !== null && i.kit.length > 0) {
    out.push('', 'Kit', ...kitLines(i.tree, i.kit))
  }
  return `${out.join('\n')}\n`
}

/** A data folder's text: each file with who wrote it, when, and the push they saw. */
export const dataText = (i: {
  readonly folder: string
  readonly files: readonly DocWire[]
}): string => {
  const name = i.folder === '' ? '' : `${lastName(i.folder)}/`
  const count = i.files.length === 1 ? '1 file' : `${i.files.length} files`
  const out = [`# ${name} (${count})`]
  for (const file of i.files) {
    const rel =
      i.folder === '' ? file.path : file.path.slice(i.folder.length + 1)
    out.push(
      '',
      `## ${rel}`,
      `${file.by} · ${longDate(Date.parse(file.at))} · push ${file.push}`,
    )
    if (file.data !== null) {
      const body =
        typeof file.data === 'string'
          ? file.data
          : JSON.stringify(file.data, null, 2)
      out.push('', '```json', body, '```')
    }
  }
  return `${out.join('\n')}\n`
}

const docWire = (row: DocRow): DocWire => ({
  path: row.node.path,
  data: row.value,
  by: row.by,
  at: new Date(row.version.createdAt).toISOString(),
  push: row.push,
})

type Target =
  | Extract<Resolved, { readonly kind: 'page' }>
  | Extract<Resolved, { readonly kind: 'folder' }>
  | Extract<Resolved, { readonly kind: 'file' }>

interface Companion {
  readonly path: string
  readonly version: VersionRow
}

/** Whether the frame's handle may open a file at the frame's sequence. */
export type Opens = (file: {
  readonly node: NodeRow
  readonly version: VersionRow
}) => Effect.Effect<boolean, DossierError<'unavailable'>, CurrentCaller>

export interface ReaderDeps {
  readonly store: TreeStoreService
  readonly access: AccessService
  readonly files: FilesService
  readonly bindings: Pick<Env, 'DB' | 'BLOBS'>
  readonly context: Context.Context<Bindings | BaseLayer>
  readonly treeRefOf: (treeId: TreeId, linkPath: string) => TreeRef | null
  readonly kitChoice: (
    kit: Extract<Resolved, { readonly kind: 'kit' }>,
    needs: 'read',
  ) => Effect.Effect<
    KitFound | null,
    DossierError<'unavailable'>,
    CurrentCaller
  >
  readonly linkOf: (workspace: string, tree: string, linkPath: string) => string
}

/** A denial names only the path that was asked. */
const asAsked = <A, C extends ErrorCode, R>(
  path: string,
  effect: Effect.Effect<A, DossierError<C>, R>,
): Effect.Effect<A, DossierError<C>, R> =>
  Effect.mapError(effect, (error) =>
    error.code === 'unavailable'
      ? error
      : dossierError(error.code, error.message, error.fix, path),
  )

const notFound = (path: string | null) =>
  dossierError(
    'not_found',
    'Nothing is here, or you cannot open it.',
    'Check the path, or ask someone who can open it to share it with you.',
    path,
  )

/** Reading never asks for more than read, so forbidden reads as not found. */
const readOnly = <A, R>(
  effect: Effect.Effect<
    A,
    DossierError<
      'not_found' | 'sign_in_required' | 'forbidden' | 'unavailable'
    >,
    R
  >,
): Effect.Effect<A, ReadError, R> =>
  Effect.catchIf(
    effect,
    (error): error is DossierError<'forbidden'> => error.code === 'forbidden',
    (error) => Effect.fail(notFound(error.path)),
  ) as Effect.Effect<A, ReadError, R>

/** A read's text as the agent answer it is served as. */
const agentOf = (result: ReadResult): AgentServed => ({
  kind: 'agent',
  body: result.text ?? '',
  type:
    result.kind === 'page'
      ? result.type
      : result.kind === 'file'
        ? 'application/json'
        : 'text/markdown',
})

export const makeReader = (deps: ReaderDeps) => {
  const { store, access, files, bindings, context } = deps
  const { DB, BLOBS } = bindings
  const base = Context.get(context, BaseLayer)

  const query = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (error) => {
        console.error('A read failed', error)
        return dossierError('unavailable')
      },
    })

  /** Missing and unreadable answer alike. */
  const denied = (missing: MissingNode) =>
    readOnly(access.require('read', missing)).pipe(
      Effect.zipRight(Effect.die(new Error('Access granted a missing node'))),
    )

  /** What a reference names for reading, redirects followed, read checked. */
  const target = (ref: LinkRef) =>
    Effect.gen(function* () {
      let resolved: Resolved | MissingNode = yield* store.resolve(ref)
      const missing = (treeId: TreeId | null): MissingNode => ({
        missing: true,
        treeId,
        path: ref.path,
      })
      // A link's redirects (the folder's slash, `.html`) lead to what it names.
      for (let hop = 0; hop < 2; hop += 1) {
        if ('missing' in resolved || resolved.kind !== 'redirect') break
        yield* readOnly(access.require('read', resolved.node))
        const next = deps.treeRefOf(resolved.tree.id, resolved.to)
        resolved =
          next === null ? missing(resolved.tree.id) : yield* store.resolve(next)
      }
      if ('missing' in resolved) return yield* denied(resolved)
      if (resolved.kind === 'redirect') {
        return yield* denied(missing(resolved.tree.id))
      }
      if (resolved.kind === 'kit') {
        // A `_` path reads as the tree's own file the lookup gives the caller.
        const chosen = yield* deps.kitChoice(resolved, 'read')
        if (chosen === null || chosen.kind === 'base') {
          return yield* denied(missing(resolved.tree.id))
        }
        return {
          kind: 'file',
          node: chosen.node,
          version: chosen.version,
          tree: resolved.tree,
        } satisfies Target
      }
      yield* readOnly(access.require('read', resolved.node))
      return resolved satisfies Target
    })

  const pushNumberOf = (version: VersionRow) =>
    version.pushId === null
      ? Effect.succeed(0 as PushNumber)
      : query(() =>
          DB.prepare('select number from pushes where id = ?')
            .bind(version.pushId)
            .first<{ number: number | null }>(),
        ).pipe(Effect.map((row) => (row?.number ?? 0) as PushNumber))

  /** A file's text: a data version's JSON, or the blob's bytes as text. */
  const textOf = (version: VersionRow) =>
    Effect.gen(function* () {
      if (version.blobSha256 === null) return version.jsonValue ?? ''
      const sha = version.blobSha256
      const object = yield* query(() => BLOBS.get(blobKey(sha)))
      if (object === null) {
        console.error('A blob is missing from R2', { sha256: sha })
        return yield* Effect.fail(dossierError('unavailable'))
      }
      return yield* query(() => object.text())
    })

  /** Files the caller can read at `path` exactly, or below the folder `path/`. */
  const countReadable = (
    treeId: TreeId,
    where: { readonly file: string } | { readonly below: string },
    origin: 'data' | 'any',
  ) =>
    Effect.gen(function* () {
      const readable = yield* access.readable(treeId)
      const n = schema.nodes
      const at =
        'file' in where
          ? sql`${n.path} = ${where.file}`
          : sql`substr(${n.path}, 1, length(${where.below}) + 1) = ${`${where.below}/`}`
      const rows = yield* query(() =>
        db(bindings)
          .select({ count: sql<number>`count(*)` })
          .from(n)
          .where(
            sql`${n.treeId} = ${treeId} and ${n.deletedAt} is null and ${n.kind} = 'file'
              and ${origin === 'data' ? sql`${n.origin} = 'data'` : sql`1`}
              and ${at} and ${readable.where}`,
          )
          .all(),
      )
      return Number(rows[0]?.count ?? 0)
    })

  /**
   * Where else an agent looks from a page: its forms' data and its comments,
   * with the layouts composed into it at `at`.
   */
  const pointerOf = (
    page: Extract<Target, { readonly kind: 'page' }>,
    analysis: HtmlAnalysis | null,
    at: AuthoredSeq,
  ) =>
    Effect.gen(function* () {
      const sources: { path: string; analysis: HtmlAnalysis }[] = []
      if (analysis !== null) {
        sources.push({ path: page.node.path, analysis })
        const layouts = yield* composedLayouts({
          treeId: page.tree.id,
          page: { node: page.node, version: page.version, analysis },
          at,
        }).pipe(Effect.provide(context))
        for (const layout of layouts) {
          sources.push({ path: layout.node.path, analysis: layout.analysis })
        }
      }
      const targets = new Map<string, { file: string } | { below: string }>()
      for (const source of sources) {
        for (const form of source.analysis.forms) {
          if (form.action === null) continue
          const found = resolveFormAction(source.path, form.action)
          if ('problem' in found) continue
          const shown =
            found.kind === 'folder' ? `${found.target}/` : found.target
          if (targets.has(shown)) continue
          targets.set(
            shown,
            found.kind === 'folder'
              ? { below: found.target }
              : { file: found.target },
          )
        }
      }
      const data: { path: string; files: number }[] = []
      for (const [path, where] of targets) {
        data.push({
          path,
          files: yield* countReadable(page.tree.id, where, 'data'),
        })
      }
      const comments = yield* countReadable(
        page.tree.id,
        { below: `${page.node.path.replace(/\.html$/, '')}.comments` },
        'any',
      )
      return { data, comments } satisfies Pointer
    })

  /** Where a page's companion may be: the named one, then the same-name .md. */
  const companionPaths = (
    page: Extract<Target, { readonly kind: 'page' }>,
    analysis: HtmlAnalysis | null,
  ): string[] => {
    const named =
      analysis === null ? null : companionOf(page.node.path, analysis)
    const same = page.node.path.replace(/\.html$/, '.md')
    return [named, same].filter(
      (path): path is string => path !== null && path !== page.node.path,
    )
  }

  /** The page's companion the caller can read: the named one, else the same-name .md. */
  const companionFor = (
    ref: LinkRef,
    page: Extract<Target, { readonly kind: 'page' }>,
    analysis: HtmlAnalysis | null,
  ) =>
    Effect.gen(function* () {
      for (const path of companionPaths(page, analysis)) {
        const located = yield* store.locate({
          workspace: ref.workspace,
          tree: ref.tree,
          path,
          folder: false,
        })
        if ('missing' in located || located.kind !== 'file') continue
        if (located.node.path !== path) continue
        const readable = yield* access
          .require('read', located.node)
          .pipe(Effect.isSuccess)
        if (!readable) continue
        return { path, version: located.version } satisfies Companion
      }
      return null
    })

  /**
   * The page's companion as the tree was at `at`, for a frame pinned there.
   * One the caller cannot read is skipped, as a live read skips it; one the
   * caller reads but the handle may not open at `at` refuses the whole read,
   * so the page never silently answers with other text.
   */
  const companionAt = (
    page: Extract<Target, { readonly kind: 'page' }>,
    analysis: HtmlAnalysis | null,
    at: AuthoredSeq,
    opens: Opens,
  ) =>
    Effect.gen(function* () {
      for (const path of companionPaths(page, analysis)) {
        const found = yield* store.resolve(
          { treeId: page.tree.id, path, folder: false },
          at,
        )
        if ('missing' in found || found.kind !== 'file') continue
        if (found.node.path !== path) continue
        const readable = yield* access
          .require('read', found.node)
          .pipe(Effect.isSuccess)
        if (!readable) continue
        if (!(yield* opens(found))) {
          return yield* Effect.fail(notFound(page.node.path))
        }
        return { path, version: found.version } satisfies Companion
      }
      return null
    })

  /**
   * A page's agent version for its version in `page`, with the layouts and
   * companion `findCompanion` finds as the tree was at `at`.
   */
  const pageResult = (
    ref: LinkRef,
    page: Extract<Target, { readonly kind: 'page' }>,
    at: AuthoredSeq,
    findCompanion: (
      analysis: HtmlAnalysis | null,
    ) => Effect.Effect<Companion | null, ReadError, CurrentCaller>,
  ) =>
    Effect.gen(function* () {
      const sha = page.version.blobSha256 as Sha256 | null
      const analysis = sha === null ? null : yield* store.analysis(sha)
      const pointer = yield* pointerOf(page, analysis, at)
      const push = yield* pushNumberOf(page.version)
      const located = {
        path: page.node.path,
        link: deps.linkOf(ref.workspace, ref.tree, page.linkPath),
        push,
        pointer,
      }
      const companion = yield* findCompanion(analysis)
      if (companion !== null) {
        const text = yield* textOf(companion.version)
        const json = companion.path.toLowerCase().endsWith('.json')
        return {
          kind: 'page',
          ...located,
          source: 'companion',
          companion: companion.path,
          type: json ? 'application/json' : 'text/markdown',
          // JSON is returned as it was pushed; the pointer is only a field.
          text: json ? text : withPointer(text, pointer),
        } satisfies ReadResult
      }
      if (sha === null) return yield* Effect.fail(dossierError('unavailable'))
      const generated = yield* store.markdown(sha)
      return {
        kind: 'page',
        ...located,
        source: 'generated',
        companion: null,
        type: 'text/markdown',
        text: withPointer(generated, pointer),
      } satisfies ReadResult
    })

  /** A component's documentation: the tree's `<tag>.md`, else the base layer's. */
  const docOf = (item: KitItem, docs: ReadonlyMap<string, VersionRow>) =>
    Effect.gen(function* () {
      if (item.kind !== 'component' || item.tag === null) return null
      const doc = docs.get(item.tag)
      if (doc !== undefined) return yield* textOf(doc)
      if (item.from !== null) return null
      return yield* base.read(item.path.replace(/\.js$/, '.md'))
    })

  const kitWire = (items: readonly KitItem[]) =>
    Effect.gen(function* () {
      const docs = new Map<string, VersionRow>()
      for (const item of items) {
        if (item.kind === 'doc' && item.tag !== null && item.version !== null) {
          if (!docs.has(item.tag)) docs.set(item.tag, item.version)
        }
      }
      const out: KitItemWire[] = []
      for (const item of items) {
        out.push({
          path: item.path,
          from: item.from,
          kind: item.kind,
          tag: item.tag,
          doc: yield* docOf(item, docs),
          variables:
            item.kind === 'theme' && item.version !== null
              ? [...themeVariables(yield* textOf(item.version))]
              : [],
        })
      }
      return out
    })

  const folderResult = (
    ref: LinkRef,
    folder: Extract<Target, { readonly kind: 'folder' }>,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const folderRef: LinkRef = {
        workspace: ref.workspace,
        tree: ref.tree,
        path: folder.node.path,
        folder: true,
      }
      const link = deps.linkOf(
        ref.workspace,
        ref.tree,
        linkPathOf(folder.node.path, true),
      )
      if (folder.node.origin === 'data') {
        const granted = yield* readOnly(access.require('read', folder.node))
        const rows = yield* store.docs(granted, { origin: 'data' })
        const docs = rows.map(docWire)
        return {
          kind: 'data',
          path: folder.node.path,
          link,
          files: docs,
          text: dataText({ folder: folder.node.path, files: docs }),
        } satisfies ReadResult
      }
      const listing = yield* files.ls({ ref: folderRef, depth: 'one' })
      const writer = listing.roles.caps.has('write')
      // A key that may not see history lists no kit, whatever its role.
      const kit = writer
        ? yield* files.kit(folderRef).pipe(
            Effect.flatMap((found) => kitWire(found.items)),
            Effect.catchIf(
              (error) => error.code === 'forbidden',
              () => Effect.succeed(null),
            ),
          ) as Effect.Effect<
            readonly KitItemWire[] | null,
            ReadError,
            CurrentCaller
          >
        : null
      return {
        kind: 'folder',
        path: folder.node.path,
        link,
        entries: listing.entries.map(entryWire),
        kit,
        text: folderText({
          tree: ref.tree,
          path: folder.node.path,
          entries: listing.entries,
          kit,
          now,
        }),
      } satisfies ReadResult
    })

  const fileResult = (
    ref: LinkRef,
    file: Extract<Target, { readonly kind: 'file' }>,
  ) =>
    Effect.gen(function* () {
      const link = deps.linkOf(
        ref.workspace,
        ref.tree,
        linkPathOf(file.node.path, false),
      )
      const contentType =
        file.version.contentType ??
        (file.node.origin === 'data'
          ? 'application/json'
          : 'application/octet-stream')
      const size = file.version.size ?? 0
      if (file.node.origin === 'data') {
        const json = file.version.jsonValue ?? 'null'
        return {
          kind: 'file',
          path: file.node.path,
          link,
          text: json,
          contentType,
          size,
          doc: yield* dataDoc(file.node, file.version),
        } satisfies ReadResult
      }
      const text = isTextFile(file.node.name, contentType, size)
        ? yield* textOf(file.version)
        : null
      return {
        kind: 'file',
        path: file.node.path,
        link,
        text,
        contentType,
        size,
        doc: null,
      } satisfies ReadResult
    })

  /** A data file as a read names it: its writer by email, and the push they saw. */
  const dataDoc = (node: NodeRow, version: VersionRow) =>
    Effect.gen(function* () {
      const writer = yield* query(() =>
        DB.prepare('select email from "user" where id = ?')
          .bind(version.authorId)
          .first<{ email: string }>(),
      )
      let data: unknown = null
      try {
        data = version.jsonValue === null ? null : JSON.parse(version.jsonValue)
      } catch {
        data = null
      }
      return {
        path: node.path,
        data,
        by: writer?.email ?? '',
        at: new Date(version.createdAt).toISOString(),
        push: (version.seenPushNumber ?? 0) as PushNumber,
      } satisfies DocWire
    })

  const resultOf = (
    ref: LinkRef,
    t: Target,
  ): Effect.Effect<ReadResult, ReadError, CurrentCaller> => {
    switch (t.kind) {
      case 'page':
        return pageResult(ref, t, t.tree.authoredSeq as AuthoredSeq, (found) =>
          companionFor(ref, t, found),
        )
      case 'folder':
        return folderResult(ref, t)
      case 'file':
        return fileResult(ref, t)
    }
  }

  const read = (
    ref: LinkRef,
  ): Effect.Effect<ReadResult, ReadError, CurrentCaller> =>
    asAsked(
      ref.path,
      Effect.flatMap(target(ref), (t) => resultOf(ref, t)),
    )

  /** The link route's answer to an agent: the read's text, or a file's bytes. */
  const served = (
    ref: LinkRef,
  ): Effect.Effect<AgentServed, ReadError, CurrentCaller> =>
    asAsked(
      ref.path,
      Effect.gen(function* () {
        const t = yield* target(ref)
        if (t.kind === 'file' && t.node.origin !== 'data') {
          const sha = t.version.blobSha256
          const object =
            sha === null ? null : yield* query(() => BLOBS.get(blobKey(sha)))
          if (sha === null || object === null) {
            console.error('A blob is missing from R2', { sha256: sha })
            return yield* Effect.fail(dossierError('unavailable'))
          }
          return {
            kind: 'file',
            body: object.body,
            size: object.size,
            etag: sha,
            contentType: 'application/octet-stream',
            range: null,
            download: true,
            cache: 'private',
          } satisfies AgentServed
        }
        return agentOf(yield* resultOf(ref, t))
      }),
    )

  /**
   * The frame's answer to a request for the agent version, once the frame
   * has checked the handle may open what it resolved at `at`: a page's text
   * for that version, with its companion as the tree was then (which `opens`
   * must also allow), or a folder's text now. A listing of what the caller
   * reads now recovers nothing replaced, so a folder needs no sequence, only
   * to still exist.
   */
  const servedAt = (i: {
    readonly tree: { readonly workspace: string; readonly name: string }
    readonly target:
      | Extract<Target, { readonly kind: 'page' }>
      | Extract<Target, { readonly kind: 'folder' }>
    readonly at: AuthoredSeq
    readonly opens: Opens
  }): Effect.Effect<AgentServed, ReadError, CurrentCaller> =>
    Effect.gen(function* () {
      const found = i.target
      const ref: LinkRef = {
        workspace: i.tree.workspace,
        tree: i.tree.name,
        path: found.node.path,
        folder: found.kind === 'folder',
      }
      if (found.kind === 'page') {
        return agentOf(
          yield* pageResult(ref, found, i.at, (analysis) =>
            companionAt(found, analysis, i.at, i.opens),
          ),
        )
      }
      if (found.node.deletedAt !== null) {
        return yield* Effect.fail(notFound(found.node.path))
      }
      yield* readOnly(access.require('read', found.node))
      return agentOf(yield* folderResult(ref, found))
    })

  return { read, served, servedAt }
}
