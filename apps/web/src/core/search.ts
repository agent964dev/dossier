// Search over titles and paths, or the contents of pages, returning exactly
// what the caller can read. Every statement ANDs the one read rule
// (Access.readable) for its tree, and every result is checked again with
// Access.require before it is returned. A page's companion is searched
// only for someone who reads the companion itself.
import {
  dossierError,
  linkFor,
  SEARCH_MAX_LENGTH,
  SEARCH_MAX_OFFSET,
  SEARCH_PAGE_SIZE,
  type DossierError,
  type NodeId,
  type SearchMode,
  type TreeId,
} from '@dossier/contracts'
import { normalizeSearchText, searchNameOf } from '@dossier/html'
import { sql, type SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { Context, Effect, Layer } from 'effect'

import { Access } from './access.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller } from './caller.ts'
import { Config } from './config.ts'
import type { NodeRow } from './rows.ts'
import { nodeOfRaw } from './tree-store.ts'

export interface SearchResult {
  readonly kind: 'page' | 'folder' | 'attachment'
  readonly node: NodeRow
  /** The page's title, or the folder's or file's name. */
  readonly title: string
  readonly workspace: string
  readonly tree: string
  readonly link: string
  /** Content mode only. */
  readonly snippet:
    | readonly { readonly text: string; readonly match: boolean }[]
    | null
}

export interface SearchPage {
  readonly query: string
  readonly mode: SearchMode
  readonly results: readonly SearchResult[]
  /** The offset of the next page; null on the last. */
  readonly next: number | null
}

export interface SearchService {
  readonly query: (i: {
    readonly text: string
    readonly mode: SearchMode
    readonly offset: number
  }) => Effect.Effect<
    SearchPage,
    DossierError<'sign_in_required' | 'invalid'>,
    CurrentCaller
  >
}

export class Search extends Context.Tag('Search')<Search, SearchService>() {}

/** The most words of a query that count. */
const MAX_TERMS = 8
/**
 * Statements per D1 batch: each holds the read rule (tens of kilobytes),
 * so a batch stays well under a megabyte; batches run a few at a time.
 */
const BATCH = 10
/** Where FTS5 marks the matched words in a snippet: private-use characters. */
const MARK_OPEN = '\uE000'
const MARK_CLOSE = '\uE001'

/**
 * The words of a query as FTS5 reads them: each quoted, its quotes doubled,
 * and matched as a prefix. Words with no letter or digit match nothing in
 * the index, so they are left out.
 */
export const searchTerms = (query: string): readonly string[] =>
  query
    .split(' ')
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, MAX_TERMS)
    .map((word) => `"${word.replaceAll('"', '""')}"*`)

/** Every term, in any of these columns. */
const matchOf = (columns: readonly string[], terms: readonly string[]) =>
  `{${columns.join(' ')}} : (${terms.join(' AND ')})`

/** A snippet as text parts, the matched words marked. */
export const snippetParts = (
  snippet: string | null,
): { text: string; match: boolean }[] | null => {
  if (snippet === null || snippet.trim() === '') return null
  const parts: { text: string; match: boolean }[] = []
  let rest = snippet
  while (rest !== '') {
    const open = rest.indexOf(MARK_OPEN)
    if (open < 0) {
      parts.push({ text: rest, match: false })
      break
    }
    if (open > 0) parts.push({ text: rest.slice(0, open), match: false })
    const close = rest.indexOf(MARK_CLOSE, open + 1)
    const end = close < 0 ? rest.length : close
    const text = rest.slice(open + 1, end)
    if (text !== '') parts.push({ text, match: true })
    rest = close < 0 ? '' : rest.slice(close + 1)
  }
  // Two runs of one kind side by side read as one.
  return parts.reduce<{ text: string; match: boolean }[]>((out, part) => {
    const last = out[out.length - 1]
    if (last !== undefined && last.match === part.match) {
      out[out.length - 1] = { ...last, text: last.text + part.text }
    } else out.push(part)
    return out
  }, [])
}

/** `like` text that matches itself literally: `%`, `_` and `\` escaped. */
const likeText = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

interface TreeRowOf {
  readonly id: TreeId
  readonly name: string
  readonly workspace: string
}

/** A page a statement found, with how it was found. */
interface Found {
  readonly node: NodeRow
  readonly title: string
  readonly rank: number
  readonly snippet: string | null
  /** Found through the page's companion: its read is checked too. */
  readonly companion: NodeId | null
}

const dialect = new SQLiteSyncDialect()
const compiled = (query: SQL) => dialect.sqlToQuery(query)

export const SearchLive: Layer.Layer<
  Search,
  never,
  Bindings | Config | Access
> = Layer.effect(
  Search,
  Effect.gen(function* () {
    const { DB } = yield* Bindings
    const config = yield* Config
    const access = yield* Access

    const read = <A>(run: () => Promise<A>) =>
      Effect.tryPromise(run).pipe(
        Effect.tapError((error) =>
          Effect.logError('A search read failed', error),
        ),
        Effect.orDie,
      )

    const invalid = (message: string, fix: string | null) =>
      Effect.fail(dossierError('invalid', message, fix, 'q'))

    /**
     * Every live tree the caller might read something in: a superset of
     * what the read rule opens. An agent key with a scope searches only
     * its key's tree.
     */
    const treesOf = (person: { id: string; email: string }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const scope = caller.via.kind === 'agent' ? caller.via.scope : null
        const handleTree =
          caller.via.kind === 'handle' ? caller.via.treeId : null
        const rows = yield* read(() =>
          DB.prepare(
            `select t.id, t.name, w.name as workspace
               from trees t join workspaces w on w.id = t.workspace_id
               where t.deleted_at is null and w.deleted_at is null
                 and w.suspended_at is null
                 and (?3 is null or t.id = (select tree_id from nodes where id = ?3))
                 and (?4 is null or t.id = ?4)
                 and (exists (select 1 from workspace_members m
                        where m.workspace_id = w.id and m.user_id = ?1)
                   or exists (select 1 from shares s where s.tree_id = t.id
                        and (s.target_kind = 'anyone'
                          or (s.target_kind = 'email' and s.target = ?2)
                          or (s.target_kind = 'team' and s.target in (
                            select tm.team_id from team_members tm
                            where tm.user_id = ?1)))))
               order by w.name, t.name`,
          )
            .bind(person.id, person.email.toLowerCase(), scope, handleTree)
            .all<TreeRowOf>(),
        )
        return rows.results
      })

    /**
     * The row's node is the page it indexed, as it is now: live, at the
     * path and version indexed, and still a page (authored HTML outside
     * every `_` folder). A row a change has not reached yet is never read.
     */
    const indexedPage = sql`nodes.deleted_at is null
            and nodes.current_version_id = sdoc.version_id
            and nodes.path = sdoc.path and nodes.origin = 'authored'
            and nodes.kind = 'file' and nodes.underscore_from is null
            and substr(nodes.path, -5) = '.html'`

    /** Pages whose own title, path or text holds every term. */
    const pagesStatement = (
      treeId: TreeId,
      where: SQL,
      match: string,
      limit: number,
    ) =>
      sql`select nodes.*, sdoc.title as found_title,
            snippet(search_pages, 2, ${MARK_OPEN}, ${MARK_CLOSE}, '…', 16) as found_snippet,
            bm25(search_pages, 10.0, 5.0, 1.0, 0.0) as found_rank
          from search_pages
          join search_docs sdoc on sdoc.id = search_pages.rowid
          join nodes on nodes.id = sdoc.node_id
          join trees stree on stree.id = sdoc.tree_id and stree.deleted_at is null
          join workspaces sws on sws.id = stree.workspace_id
            and sws.deleted_at is null and sws.suspended_at is null
          where search_pages match ${match} and sdoc.tree_id = ${treeId}
            and ${indexedPage}
            and (${where})
          order by found_rank, nodes.path limit ${limit}`

    /**
     * Pages where every term is in the page or its companion, for a
     * caller who reads the companion as it was indexed.
     */
    const companionStatement = (
      treeId: TreeId,
      where: SQL,
      match: string,
      limit: number,
    ) =>
      sql`select nodes.*, sdoc.title as found_title,
            snippet(search_pages, -1, ${MARK_OPEN}, ${MARK_CLOSE}, '…', 16) as found_snippet,
            bm25(search_pages, 10.0, 5.0, 1.0, 1.0) as found_rank,
            sdoc.companion_node_id as found_companion
          from search_pages
          join search_docs sdoc on sdoc.id = search_pages.rowid
          join nodes on nodes.id = sdoc.node_id
          join trees stree on stree.id = sdoc.tree_id and stree.deleted_at is null
          join workspaces sws on sws.id = stree.workspace_id
            and sws.deleted_at is null and sws.suspended_at is null
          where search_pages match ${match} and sdoc.tree_id = ${treeId}
            and ${indexedPage}
            and (${where})
            and sdoc.companion_node_id is not null
            and exists (select 1 from nodes
              where nodes.id = sdoc.companion_node_id and nodes.deleted_at is null
                and nodes.current_version_id = sdoc.companion_version_id
                and (${where}))
          order by found_rank, nodes.path limit ${limit}`

    /** Folders and attachments whose name starts with the query. */
    const namesStatement = (
      treeId: TreeId,
      where: SQL,
      words: readonly string[],
      limit: number,
    ) => {
      const folded = words.map(searchNameOf)
      const [first = '', ...rest] = folded
      // Names as search compares them, or as written for a node named
      // before search kept them.
      const name = sql`coalesce(sname.name, lower(nodes.name))`
      const others = rest.map(
        (word) => sql` and ${name} like ${`%${likeText(word)}%`} escape '\\'`,
      )
      return sql`select nodes.* from nodes
          left join search_names sname on sname.node_id = nodes.id
          where nodes.tree_id = ${treeId} and nodes.deleted_at is null
            and nodes.origin = 'authored' and nodes.depth > 0
            and nodes.underscore_from is null
            and (nodes.kind = 'folder' or substr(nodes.path, -5) <> '.html')
            and ${name} like ${`${likeText(first)}%`} escape '\\'${sql.join(others, sql``)}
            and (${where})
          order by nodes.kind = 'file', nodes.name collate nocase, nodes.path
          limit ${limit}`
    }

    const query: SearchService['query'] = (i) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const person = caller.person
        if (person === null) {
          return yield* Effect.fail(
            dossierError(
              'sign_in_required',
              'Sign in to search.',
              'Sign in with Google, or run dossier login.',
              null,
            ),
          )
        }
        const text = normalizeSearchText(i.text).trim()
        if (text === '') {
          return yield* invalid('Type something to search for.', null)
        }
        if (text.length > SEARCH_MAX_LENGTH) {
          return yield* invalid(
            `A search is at most ${SEARCH_MAX_LENGTH} characters.`,
            'Search for fewer words.',
          )
        }
        if (
          !Number.isSafeInteger(i.offset) ||
          i.offset < 0 ||
          i.offset > SEARCH_MAX_OFFSET
        ) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `${i.offset} is not where a page of results starts.`,
              `Give a whole number from 0 to ${SEARCH_MAX_OFFSET}.`,
              'offset',
            ),
          )
        }
        const empty: SearchPage = {
          query: text,
          mode: i.mode,
          results: [],
          next: null,
        }
        const terms = searchTerms(text)
        if (terms.length === 0) return empty
        const words = text
          .split(' ')
          .filter((word) => word !== '')
          .slice(0, MAX_TERMS)
        const limit = i.offset + SEARCH_PAGE_SIZE + 1
        const trees = yield* treesOf(person)
        if (trees.length === 0) return empty

        // The read rule of each tree, for the caller.
        const rules = yield* Effect.forEach(
          trees,
          (tree) =>
            Effect.map(access.readable(tree.id), (r) => ({
              tree,
              where: r.where,
            })),
          { concurrency: 8 },
        )
        const content = i.mode === 'content'
        const pageMatch = matchOf(
          content
            ? ['search_title', 'search_body']
            : ['search_title', 'search_path'],
          terms,
        )
        const companionMatch = matchOf(
          ['search_title', 'search_body', 'search_companion'],
          terms,
        )
        type Kind = 'pages' | 'companion' | 'names'
        const statements: {
          readonly kind: Kind
          readonly tree: TreeRowOf
          readonly query: { sql: string; params: unknown[] }
        }[] = []
        for (const { tree, where } of rules) {
          statements.push({
            kind: 'pages',
            tree,
            query: compiled(pagesStatement(tree.id, where, pageMatch, limit)),
          })
          if (content) {
            statements.push({
              kind: 'companion',
              tree,
              query: compiled(
                companionStatement(tree.id, where, companionMatch, limit),
              ),
            })
          } else {
            statements.push({
              kind: 'names',
              tree,
              query: compiled(namesStatement(tree.id, where, words, limit)),
            })
          }
        }
        const chunks: (typeof statements)[] = []
        for (let at = 0; at < statements.length; at += BATCH) {
          chunks.push(statements.slice(at, at + BATCH))
        }
        const answers = (yield* Effect.forEach(
          chunks,
          (chunk) =>
            Effect.map(
              read(() =>
                DB.batch(
                  chunk.map((s) =>
                    DB.prepare(s.query.sql).bind(...s.query.params),
                  ),
                ),
              ),
              (results) =>
                results.map(
                  (result) =>
                    (result.results ?? []) as Record<string, unknown>[],
                ),
            ),
          { concurrency: 4 },
        )).flat()

        // Pages by rank, each once at its better rank; then folders, then
        // attachments, by name.
        const pages = new Map<string, { tree: TreeRowOf; found: Found[] }>()
        const folders: { tree: TreeRowOf; node: NodeRow }[] = []
        const files: { tree: TreeRowOf; node: NodeRow }[] = []
        statements.forEach((statement, n) => {
          for (const row of answers[n] ?? []) {
            const node = nodeOfRaw(row)
            if (statement.kind === 'names') {
              ;(node.kind === 'folder' ? folders : files).push({
                tree: statement.tree,
                node,
              })
              continue
            }
            const found: Found = {
              node,
              title: String(row.found_title ?? node.name),
              rank: Number(row.found_rank ?? 0),
              snippet:
                typeof row.found_snippet === 'string'
                  ? row.found_snippet
                  : null,
              companion:
                statement.kind === 'companion'
                  ? (row.found_companion as NodeId)
                  : null,
            }
            const kept = pages.get(node.id)
            if (kept === undefined) {
              pages.set(node.id, { tree: statement.tree, found: [found] })
            } else kept.found.push(found)
          }
        })
        const byName = (a: { node: NodeRow }, b: { node: NodeRow }): number =>
          a.node.name.localeCompare(b.node.name, undefined, {
            sensitivity: 'base',
          }) || a.node.path.localeCompare(b.node.path)
        const ranked = [...pages.values()]
          .map((page) => ({
            ...page,
            found: page.found.sort((a, b) => a.rank - b.rank),
          }))
          .sort(
            (a, b) =>
              a.found[0]!.rank - b.found[0]!.rank ||
              a.found[0]!.node.path.localeCompare(b.found[0]!.node.path),
          )
        type Candidate =
          | { kind: 'page'; tree: TreeRowOf; found: Found[] }
          | { kind: 'folder' | 'attachment'; tree: TreeRowOf; node: NodeRow }
        const all: Candidate[] = [
          ...ranked.map((p) => ({ kind: 'page' as const, ...p })),
          ...folders
            .sort(byName)
            .map((f) => ({ kind: 'folder' as const, ...f })),
          ...files
            .sort(byName)
            .map((f) => ({ kind: 'attachment' as const, ...f })),
        ]
        const window = all.slice(i.offset, i.offset + SEARCH_PAGE_SIZE)
        const more =
          all.length > i.offset + SEARCH_PAGE_SIZE &&
          i.offset + SEARCH_PAGE_SIZE <= SEARCH_MAX_OFFSET

        const readsNode = (node: NodeRow) =>
          access.require('read', node).pipe(Effect.isSuccess)
        const readsId = (id: NodeId) =>
          Effect.gen(function* () {
            const row = yield* read(() =>
              DB.prepare('select * from nodes where id = ?')
                .bind(id)
                .first<Record<string, unknown>>(),
            )
            return row !== null && (yield* readsNode(nodeOfRaw(row)))
          })
        const link = (
          tree: TreeRowOf,
          node: NodeRow,
          kind: 'page' | 'folder' | 'file',
        ) =>
          linkFor(config.origin, {
            workspace: tree.workspace,
            tree: tree.name,
            path: node.path,
            kind,
          })

        // Every result is one the point check grants: listing, point
        // checks and search agree.
        const results: SearchResult[] = []
        for (const candidate of window) {
          if (candidate.kind !== 'page') {
            if (!(yield* readsNode(candidate.node))) continue
            results.push({
              kind: candidate.kind,
              node: candidate.node,
              title: candidate.node.name,
              workspace: candidate.tree.workspace,
              tree: candidate.tree.name,
              link: link(
                candidate.tree,
                candidate.node,
                candidate.kind === 'folder' ? 'folder' : 'file',
              ),
              snippet: null,
            })
            continue
          }
          const page = candidate.found[0]!.node
          if (!(yield* readsNode(page))) continue
          let chosen: Found | null = null
          for (const found of candidate.found) {
            if (found.companion === null || (yield* readsId(found.companion))) {
              chosen = found
              break
            }
          }
          if (chosen === null) continue
          results.push({
            kind: 'page',
            node: page,
            title: chosen.title,
            workspace: candidate.tree.workspace,
            tree: candidate.tree.name,
            link: link(candidate.tree, page, 'page'),
            snippet: content ? snippetParts(chosen.snippet) : null,
          })
        }
        return {
          query: text,
          mode: i.mode,
          results,
          next: more ? i.offset + SEARCH_PAGE_SIZE : null,
        } satisfies SearchPage
      })

    return { query } satisfies SearchService
  }),
)
