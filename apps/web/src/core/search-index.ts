// The search index's side of a change: the text stored beside each blob,
// and the entries a change hands `cs.indexPages`, with every text they join
// already stored. Internal to the core.
import type { Sha256, TreeId } from '@dossier/contracts'
import {
  normalizeSearchText,
  searchNameOf,
  SEARCH_TEXT_VERSION,
  searchEntries,
  searchText,
  type PageFacts,
  type SearchEntry,
  type SearchText,
  type TreeView,
} from '@dossier/html'
import { Clock, Effect } from 'effect'

import { getBlob } from './blob-keys.ts'
import { Bindings } from './bindings.ts'
import { analysisOf } from './lookup.ts'

/** Pages are read as HTML, companions as text. */
export type SearchTextKind = 'html' | 'text'

/** Where each kind's text is stored in `analyses`. */
export const SEARCH_ANALYZER: Readonly<Record<SearchTextKind, string>> = {
  html: 'search',
  text: 'search-text',
}

/** Files larger than this keep only their title. */
export const SEARCH_SOURCE_MAX_BYTES = 1_048_576

/** The files whose text search keeps beside their blob, by name. */
export const searchKindOf = (path: string): SearchTextKind | null => {
  const lower = path.toLowerCase()
  if (lower.endsWith('.html')) return 'html'
  return /\.(md|markdown|txt|json)$/.test(lower) ? 'text' : null
}

/**
 * The search text of a blob, as stored for this version, or read from its
 * bytes and stored. A file over 1 MiB keeps its page title and no text.
 * Null when the bytes are missing.
 */
export const searchTextOf = (sha256: Sha256, kind: SearchTextKind) =>
  Effect.gen(function* () {
    const { DB, BLOBS } = yield* Bindings
    const read = <A>(run: () => Promise<A>) =>
      Effect.tryPromise(run).pipe(
        Effect.tapError((error) =>
          Effect.logError('A search text read failed', error),
        ),
        Effect.orDie,
      )
    const analyzer = SEARCH_ANALYZER[kind]
    const stored = yield* read(() =>
      DB.prepare(
        'select json from analyses where sha256 = ? and analyzer = ? and version = ?',
      )
        .bind(sha256, analyzer, SEARCH_TEXT_VERSION)
        .first<{ json: string }>(),
    )
    if (stored !== null) return JSON.parse(stored.json) as SearchText
    const object = yield* read(() => getBlob({ DB, BLOBS }, sha256))
    if (object === null) return null
    let result: SearchText
    if (object.size > SEARCH_SOURCE_MAX_BYTES) {
      yield* read(() => object.body.cancel())
      const title =
        kind === 'html' ? ((yield* analysisOf(sha256))?.title ?? null) : null
      const shown =
        title === null ? null : title.replace(/\s+/g, ' ').trim() || null
      result = {
        title: shown,
        titleSearch: shown === null ? null : normalizeSearchText(shown),
        body: '',
      }
    } else {
      result = searchText(yield* read(() => object.text()), kind)
    }
    const at = yield* Clock.currentTimeMillis
    yield* read(() =>
      DB.prepare(
        `insert into analyses (sha256, analyzer, version, json, created_at)
         values (?, ?, ?, ?, ?) on conflict do nothing`,
      )
        .bind(sha256, analyzer, SEARCH_TEXT_VERSION, JSON.stringify(result), at)
        .run(),
    )
    return result
  })

/**
 * What a change gives the index, with the texts each entry joins stored:
 * the page's version's as HTML, its companion's as text. `shaAt` names the
 * blob a path holds after the change; a path it does not know is read
 * live, at `wasAt(path)`, its path before the change.
 */
export const indexEntries = (i: {
  readonly treeId: TreeId
  readonly changed: readonly string[]
  readonly removed: readonly string[]
  readonly pages: readonly PageFacts[]
  readonly kindAt: TreeView['kindAt']
  readonly shaAt?: ReadonlyMap<string, Sha256 | null>
  readonly wasAt?: (path: string) => string
}) =>
  Effect.gen(function* () {
    const { DB } = yield* Bindings
    const entries = searchEntries(i)
    const wanted: { path: string; kind: SearchTextKind }[] = []
    for (const entry of entries) {
      if ('drop' in entry) continue
      wanted.push({ path: entry.path, kind: 'html' })
      if (entry.companion !== null) {
        wanted.push({ path: entry.companion, kind: 'text' })
      }
      if (entry.fallback !== null) {
        wanted.push({ path: entry.fallback, kind: 'text' })
      }
    }
    const known = i.shaAt ?? new Map<string, Sha256 | null>()
    const was = i.wasAt ?? ((path: string) => path)
    const unknown = [
      ...new Set(wanted.filter((w) => !known.has(w.path)).map((w) => w.path)),
    ]
    const live = new Map<string, Sha256>()
    for (let at = 0; at < unknown.length; at += 200) {
      const chunk = unknown.slice(at, at + 200)
      const rows = yield* Effect.tryPromise(() =>
        DB.prepare(
          `select n.path, v.blob_sha256 as sha from json_each(?2) j
           join nodes n on n.tree_id = ?1 and n.path = j.value
             and n.deleted_at is null and n.origin = 'authored' and n.kind = 'file'
           join node_versions v on v.id = n.current_version_id
           where v.blob_sha256 is not null`,
        )
          .bind(i.treeId, JSON.stringify(chunk.map(was)))
          .all<{ path: string; sha: Sha256 }>(),
      ).pipe(Effect.orDie)
      const back = new Map(chunk.map((path) => [was(path), path]))
      for (const row of rows.results) {
        const path = back.get(row.path)
        if (path !== undefined) live.set(path, row.sha)
      }
    }
    const needed = new Map<string, { sha: Sha256; kind: SearchTextKind }>()
    for (const w of wanted) {
      const sha = known.has(w.path) ? known.get(w.path) : live.get(w.path)
      if (sha === undefined || sha === null) continue
      needed.set(`${SEARCH_ANALYZER[w.kind]}:${sha}`, { sha, kind: w.kind })
    }
    // The texts already stored, read together; the rest are made now.
    const asked = [...needed.values()].map(({ sha, kind }) => ({
      sha,
      analyzer: SEARCH_ANALYZER[kind],
    }))
    for (let at = 0; at < asked.length; at += 200) {
      const rows = yield* Effect.tryPromise(() =>
        DB.prepare(
          `select a.analyzer || ':' || a.sha256 as key from json_each(?1) j
           join analyses a on a.sha256 = json_extract(j.value, '$.sha')
             and a.analyzer = json_extract(j.value, '$.analyzer')
             and a.version = ?2`,
        )
          .bind(JSON.stringify(asked.slice(at, at + 200)), SEARCH_TEXT_VERSION)
          .all<{ key: string }>(),
      ).pipe(Effect.orDie)
      for (const row of rows.results) needed.delete(row.key)
    }
    for (const { sha, kind } of needed.values()) {
      yield* searchTextOf(sha, kind)
    }
    return entries
  })

/**
 * How search compares the names of these nodes and every folder above
 * them: the nodes a change created or renamed.
 */
export const namesOf = (
  paths: readonly string[],
): { readonly path: string; readonly name: string }[] => {
  const all = new Set<string>()
  for (const path of paths) {
    const segments = path.split('/')
    for (let depth = 1; depth <= segments.length; depth += 1) {
      all.add(segments.slice(0, depth).join('/'))
    }
  }
  return [...all]
    .filter((path) => path !== '')
    .sort()
    .map((path) => ({
      path,
      name: searchNameOf(path.slice(path.lastIndexOf('/') + 1)),
    }))
}

export type { SearchEntry }
