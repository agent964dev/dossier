// The `_` lookup: where a page's layouts, theme, components and other `_`
// files come from. Every `_` file at the page's folder or above is reachable;
// the closest answers a request made from the page. Internal to the core:
// TreeStore, Pages, Files and Access import it, and it imports neither
// TreeStore nor Access, reading the node and version tables directly.
import type { AuthoredSeq, Sha256, TreeId } from '@dossier/contracts'
import {
  analyze,
  ANALYZER_VERSION,
  tagOf,
  type HtmlAnalysis,
} from '@dossier/html'
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { Clock, Effect } from 'effect'

import { db, schema } from '../db/client.ts'
import { BaseLayer } from './base-layer.ts'
import { Bindings } from './bindings.ts'
import type { NodeRow, VersionRow } from './rows.ts'

export type KitFound =
  | {
      readonly kind: 'tree'
      readonly node: NodeRow
      readonly version: VersionRow
    }
  | { readonly kind: 'base'; readonly path: string }

export interface LayoutLink {
  readonly node: NodeRow
  readonly version: VersionRow
  /** The folder the layout sits in. */
  readonly folder: string
  readonly complete: boolean
  readonly analysis: HtmlAnalysis
}

export type KitComponent = {
  readonly from: 'tree' | 'base'
  /** The tree path, or the base layer's path. */
  readonly path: string
}

export interface KitItem {
  /** Relative to the folder it comes from: '_layout.html', '_components/acme-card.js'. */
  readonly path: string
  /** That folder ('' for the root), or null for the base layer. */
  readonly from: string | null
  /** 'doc': _components/<tag>.md. */
  readonly kind: 'layout' | 'theme' | 'component' | 'doc' | 'file'
  readonly tag: string | null
  /** Null for base-layer items. */
  readonly version: VersionRow | null
}

const joinPath = (folder: string, name: string): string =>
  folder === '' ? name : `${folder}/${name}`

const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

/** A folder and every folder above it, closest first: 'a/b' → ['a/b', 'a', '']. */
export const foldersUp = (folder: string): readonly string[] => {
  const out: string[] = []
  let at = folder
  for (;;) {
    out.push(at)
    if (at === '') return out
    at = parentOf(at)
  }
}

/**
 * The folder before the first segment that starts with '_', and the rest:
 * 'guides/_components/acme-card.js' → { from: 'guides', rest:
 * '_components/acme-card.js' } · 'plan.html' → null.
 */
export const underscoreSplit = (
  path: string,
): { readonly from: string; readonly rest: string } | null => {
  const segments = path.split('/')
  const at = segments.findIndex((segment) => segment.startsWith('_'))
  if (at < 0) return null
  return {
    from: segments.slice(0, at).join('/'),
    rest: segments.slice(at).join('/'),
  }
}

/**
 * The condition, over `nodes` joined to `node_versions`, for the authored
 * files whose path matches `paths` as they stood at a sequence (null: now):
 * per path, the newest version at or before it, when that one is live.
 */
const authoredWhere = (
  treeId: TreeId,
  paths: SQL,
  at: AuthoredSeq | null,
): SQL => {
  const n = schema.nodes
  const v = schema.nodeVersions
  const file = sql`${n.treeId} = ${treeId} and ${n.kind} = 'file' and ${n.origin} = 'authored' and ${paths}`
  if (at === null) {
    return sql`${file} and ${n.deletedAt} is null
      and ${v.id} = ${n.currentVersionId} and ${v.state} = 'live'`
  }
  return sql`${file} and ${v.authoredSeq} <= ${at} and ${v.state} = 'live'
    and not exists (
      select 1 from node_versions v2 join nodes n2 on n2.id = v2.node_id
      where n2.tree_id = ${treeId} and n2.path = ${n.path}
        and n2.kind = 'file' and n2.origin = 'authored'
        and v2.authored_seq <= ${at}
        and (v2.authored_seq > ${v.authoredSeq}
          or (v2.authored_seq = ${v.authoredSeq} and v2.revision > ${v.revision})))`
}

/**
 * The one query condition for the authored files at given paths at a
 * sequence (at null: now), which lookupUnderscore, layoutChain and kitAt use.
 */
export const authoredAt = (i: {
  readonly treeId: TreeId
  readonly paths: readonly string[]
  readonly at: AuthoredSeq | null
}): SQL =>
  i.paths.length === 0
    ? sql`0`
    : authoredWhere(i.treeId, inArray(schema.nodes.path, [...i.paths]), i.at)

/** The authored files a condition finds, with their versions. */
const filesWhere = (condition: SQL) =>
  Effect.gen(function* () {
    const bindings = yield* Bindings
    const rows = yield* Effect.tryPromise(() =>
      db(bindings)
        .select({ node: schema.nodes, version: schema.nodeVersions })
        .from(schema.nodes)
        .innerJoin(
          schema.nodeVersions,
          eq(schema.nodeVersions.nodeId, schema.nodes.id),
        )
        .where(and(condition))
        .all(),
    ).pipe(
      Effect.tapError((error) => Effect.logError('A kit read failed', error)),
      Effect.orDie,
    )
    return rows.map((row) => ({
      node: row.node as NodeRow,
      version: row.version as VersionRow,
    }))
  })

/**
 * The closest candidate first. Every candidate is one name below a folder on
 * the same line up to the root, so the longer path is the closer one.
 */
const closestFirst = <T extends { readonly node: NodeRow }>(
  rows: readonly T[],
): T[] => [...rows].sort((a, b) => b.node.path.length - a.node.path.length)

/**
 * The analysis of a blob, as stored for this analyzer, or built from its
 * bytes and stored. Null when the bytes are missing.
 */
export const analysisOf = (sha256: Sha256) =>
  Effect.gen(function* () {
    const { DB, BLOBS } = yield* Bindings
    const read = <A>(run: () => Promise<A>) =>
      Effect.tryPromise(run).pipe(
        Effect.tapError((error) =>
          Effect.logError('An analysis read failed', error),
        ),
        Effect.orDie,
      )
    const stored = yield* read(() =>
      DB.prepare(
        `select json from analyses where sha256 = ? and analyzer = 'html' and version = ?`,
      )
        .bind(sha256, ANALYZER_VERSION)
        .first<{ json: string }>(),
    )
    if (stored !== null) return JSON.parse(stored.json) as HtmlAnalysis
    const object = yield* read(() => BLOBS.get(`blobs/${sha256}`))
    if (object === null) return null
    const result = analyze(yield* read(() => object.text()))
    const at = yield* Clock.currentTimeMillis
    yield* read(() =>
      DB.prepare(
        `insert into analyses (sha256, analyzer, version, json, created_at)
         values (?, 'html', ?, ?, ?) on conflict do nothing`,
      )
        .bind(sha256, ANALYZER_VERSION, JSON.stringify(result), at)
        .run(),
    )
    return result
  })

/**
 * Every candidate for a `_` path asked from `folder`: the tree's files at
 * `<candidate>/<rest>` for the folder and each folder above it, closest
 * first, then the base layer's file when it has one. The folder need not
 * exist, and nothing above the tree root is read.
 */
export const lookupUnderscore = (i: {
  readonly treeId: TreeId
  readonly folder: string
  readonly rest: string
  readonly at: AuthoredSeq
}): Effect.Effect<readonly KitFound[], never, Bindings | BaseLayer> =>
  Effect.gen(function* () {
    const base = yield* BaseLayer
    const paths = foldersUp(i.folder).map((folder) => joinPath(folder, i.rest))
    const rows = yield* filesWhere(
      authoredAt({ treeId: i.treeId, paths, at: i.at }),
    )
    const found: KitFound[] = closestFirst(rows).map((row) => ({
      kind: 'tree',
      ...row,
    }))
    if (base.has(i.rest)) found.push({ kind: 'base', path: i.rest })
    return found
  })

/**
 * The tree's layouts for a page in `folder`, outermost first: the
 * `_layout.html` of the folder and each folder above it, collected closest
 * first up to the first complete document.
 */
export const layoutChain = (i: {
  readonly treeId: TreeId
  readonly folder: string
  readonly at: AuthoredSeq
}): Effect.Effect<readonly LayoutLink[], never, Bindings> =>
  Effect.gen(function* () {
    const folders = foldersUp(i.folder)
    const rows = yield* filesWhere(
      authoredAt({
        treeId: i.treeId,
        paths: folders.map((folder) => joinPath(folder, '_layout.html')),
        at: i.at,
      }),
    )
    const chain: LayoutLink[] = []
    for (const row of closestFirst(rows)) {
      const sha = row.version.blobSha256
      const analysis = sha === null ? null : yield* analysisOf(sha as Sha256)
      if (analysis === null) continue
      chain.push({
        ...row,
        folder: parentOf(row.node.path),
        complete: analysis.complete,
        analysis,
      })
      if (analysis.complete) break
    }
    return chain.reverse()
  })

/**
 * The tree layouts composed into a page: none for a complete page, else the
 * layout chain of its folder. Every rule that asks which layouts make up a
 * page calls this, never layoutChain directly.
 */
export const composedLayouts = (i: {
  readonly treeId: TreeId
  readonly page: {
    readonly node: NodeRow
    readonly version: VersionRow
    readonly analysis: HtmlAnalysis
  }
  readonly at: AuthoredSeq
}): Effect.Effect<readonly LayoutLink[], never, Bindings> =>
  i.page.analysis.complete
    ? Effect.succeed([])
    : layoutChain({
        treeId: i.treeId,
        folder: parentOf(i.page.node.path),
        at: i.at,
      })

const kindOf = (rest: string): Pick<KitItem, 'kind' | 'tag'> => {
  if (rest === '_layout.html') return { kind: 'layout', tag: null }
  if (rest === '_theme.css') return { kind: 'theme', tag: null }
  const component = rest.startsWith('_components/') ? tagOf(rest) : null
  if (component !== null) return { kind: 'component', tag: component }
  const doc = /^_components\/([^/]+)\.md$/.exec(rest)?.[1]
  if (doc !== undefined && tagOf(`_components/${doc}.js`) !== null) {
    return { kind: 'doc', tag: doc }
  }
  return { kind: 'file', tag: null }
}

/**
 * Every `_` file reachable at `folder`: the tree's, closest per path, then
 * the base layer's that no tree file of the same path hides.
 */
export const kitAt = (i: {
  readonly treeId: TreeId
  readonly folder: string
  readonly at?: AuthoredSeq
}): Effect.Effect<readonly KitItem[], never, Bindings | BaseLayer> =>
  Effect.gen(function* () {
    const base = yield* BaseLayer
    const folders = foldersUp(i.folder)
    const rows = yield* filesWhere(
      authoredWhere(
        i.treeId,
        inArray(schema.nodes.underscoreFrom, [...folders]),
        i.at ?? null,
      ),
    )
    const items: KitItem[] = []
    const seen = new Set<string>()
    // The folders are all on one line up to the root: the longer is closer.
    const ordered = [...rows].sort(
      (a, b) =>
        (b.node.underscoreFrom ?? '').length -
          (a.node.underscoreFrom ?? '').length ||
        (a.node.path < b.node.path ? -1 : a.node.path > b.node.path ? 1 : 0),
    )
    for (const row of ordered) {
      const split = underscoreSplit(row.node.path)
      if (split === null || seen.has(split.rest)) continue
      seen.add(split.rest)
      items.push({
        path: split.rest,
        from: split.from,
        ...kindOf(split.rest),
        version: row.version,
      })
    }
    const basePaths = [
      ...(base.has('_layout.html') ? ['_layout.html'] : []),
      ...Object.values(base.components()).sort(),
    ]
    for (const path of basePaths) {
      if (seen.has(path)) continue
      seen.add(path)
      items.push({ path, from: null, ...kindOf(path), version: null })
    }
    return items
  })

/**
 * Each component tag available, closest folder first, then each base
 * component whose tag no tree component takes. Pure.
 */
export const kitMap = (
  items: readonly KitItem[],
): Readonly<Record<string, KitComponent>> => {
  const map: Record<string, KitComponent> = {}
  for (const item of items) {
    if (item.kind !== 'component' || item.tag === null || item.from === null) {
      continue
    }
    map[item.tag] ??= { from: 'tree', path: joinPath(item.from, item.path) }
  }
  for (const item of items) {
    if (item.kind !== 'component' || item.tag === null || item.from !== null) {
      continue
    }
    map[item.tag] ??= { from: 'base', path: item.path }
  }
  return map
}
