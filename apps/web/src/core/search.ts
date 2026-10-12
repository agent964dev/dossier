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
  /** The path and version the index row was read at. */
  readonly path: string
  readonly version: string
  readonly title: string
  /** Where the words matched: see tierOf. */
  readonly tier: number
  readonly snippet: string | null
  /** Found with this companion's words: its read is checked too. */
  readonly companion: { readonly id: NodeId; readonly version: string } | null
}

/** Code-point order: the same for every caller and locale. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

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

    /**
     * Where the words matched, from the page's own title, path and text
     * alone: 0 all in the title, 1 in the title and path, 2 in the page,
     * 3 only with its companion. Results are ordered by it and then by
     * place, never by statistics of other documents, so nothing the caller
     * cannot read moves what they see.
     */
    const tierOf = (words: readonly string[]) => {
      const all = (column: SQL) =>
        sql.join(
          words.map((word) => sql`instr(lower(${column}), ${word}) > 0`),
          sql` and `,
        )
      return sql`case when ${all(sql`sdoc.search_title`)} then 0
          when ${all(sql`sdoc.search_title || ' ' || sdoc.search_path`)} then 1
          when ${all(sql`sdoc.search_title || ' ' || sdoc.search_body`)} then 2
          else 3 end`
    }

    /** What every page statement selects: the row as indexed, and where. */
    const found = (words: readonly string[], extra: SQL, own = false) =>
      sql`nodes.*, sdoc.title as found_title, sdoc.path as found_path,
            sdoc.version_id as found_version,
            snippet(search_pages, 2, ${MARK_OPEN}, ${MARK_CLOSE}, '…', 16) as found_snippet,
            ${own ? sql`min(${tierOf(words)}, 2)` : tierOf(words)} as found_tier${extra}`

    const fromIndex = sql`from search_pages
          join search_docs sdoc on sdoc.id = search_pages.rowid
          join nodes on nodes.id = sdoc.node_id
          join trees stree on stree.id = sdoc.tree_id and stree.deleted_at is null
          join workspaces sws on sws.id = stree.workspace_id
            and sws.deleted_at is null and sws.suspended_at is null`

    /** The companion `column` names is live as indexed and read by the rule. */
    const readsCompanion = (column: 'companion' | 'fallback', where: SQL) =>
      sql`exists (select 1 from nodes
              where nodes.id = sdoc.${sql.raw(`${column}_node_id`)}
                and nodes.deleted_at is null
                and nodes.current_version_id = sdoc.${sql.raw(`${column}_version_id`)}
                and (${where}))`

    /** Pages whose own title, path or text holds every term. */
    const pagesStatement = (
      treeId: TreeId,
      where: SQL,
      match: string,
      words: readonly string[],
      limit: number,
    ) =>
      sql`select ${found(words, sql``, true)}
          ${fromIndex}
          where search_pages match ${match} and sdoc.tree_id = ${treeId}
            and ${indexedPage}
            and (${where})
          order by found_tier, nodes.path limit ${limit}`

    /**
     * Pages where every term is in the page or the companion its agent
     * version gives this caller: the named companion when they read it,
     * else the same-name `.md` when they read that.
     */
    const companionStatement = (
      column: 'companion' | 'fallback',
      treeId: TreeId,
      where: SQL,
      match: string,
      words: readonly string[],
      limit: number,
    ) =>
      sql`select ${found(
        words,
        sql`, snippet(search_pages, ${column === 'companion' ? 3 : 4}, ${MARK_OPEN}, ${MARK_CLOSE}, '…', 16) as found_companion_snippet,
            sdoc.${sql.raw(`${column}_node_id`)} as found_companion,
            sdoc.${sql.raw(`${column}_version_id`)} as found_companion_version`,
      )}
          ${fromIndex}
          where search_pages match ${match} and sdoc.tree_id = ${treeId}
            and ${indexedPage}
            and (${where})
            and sdoc.${sql.raw(`${column}_node_id`)} is not null
            and ${readsCompanion(column, where)}
            ${
              column === 'fallback'
                ? sql`and (sdoc.companion_node_id is null
                    or not ${readsCompanion('companion', where)})`
                : sql``
            }
          order by found_tier, nodes.path limit ${limit}`

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

    /** Statements in batches of BATCH, a few batches at a time. */
    const batched = (
      queries: readonly { readonly sql: string; readonly params: unknown[] }[],
    ) => {
      const chunks: (typeof queries)[] = []
      for (let at = 0; at < queries.length; at += BATCH) {
        chunks.push(queries.slice(at, at + BATCH))
      }
      return Effect.map(
        Effect.forEach(
          chunks,
          (chunk) =>
            read(() =>
              DB.batch(chunk.map((q) => DB.prepare(q.sql).bind(...q.params))),
            ),
          { concurrency: 4 },
        ),
        (results) =>
          results
            .flat()
            .map((r) => (r.results ?? []) as Record<string, unknown>[]),
      )
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
        // The words as the tier compares them with the stored text.
        const lowered = words
          .filter((word) => /[\p{L}\p{N}]/u.test(word))
          .map((word) => word.toLowerCase())
        const pageMatch = matchOf(
          content
            ? ['search_title', 'search_body']
            : ['search_title', 'search_path'],
          terms,
        )
        const withMatch = (column: 'search_companion' | 'search_fallback') =>
          matchOf(['search_title', 'search_body', column], terms)
        type Kind = 'pages' | 'companion' | 'fallback' | 'names'
        const statements: {
          readonly kind: Kind
          readonly tree: TreeRowOf
          readonly query: { sql: string; params: unknown[] }
        }[] = []
        for (const { tree, where } of rules) {
          statements.push({
            kind: 'pages',
            tree,
            query: compiled(
              pagesStatement(tree.id, where, pageMatch, lowered, limit),
            ),
          })
          if (content) {
            for (const column of ['companion', 'fallback'] as const) {
              statements.push({
                kind: column,
                tree,
                query: compiled(
                  companionStatement(
                    column,
                    tree.id,
                    where,
                    withMatch(`search_${column}`),
                    lowered,
                    limit,
                  ),
                ),
              })
            }
          } else {
            statements.push({
              kind: 'names',
              tree,
              query: compiled(namesStatement(tree.id, where, words, limit)),
            })
          }
        }
        const answers = yield* batched(statements.map((s) => s.query))

        // Every way each page was found; folders and attachments by name.
        const pages = new Map<string, { tree: TreeRowOf; found: Found[] }>()
        const names: {
          tree: TreeRowOf
          node: NodeRow
          kind: 'folder' | 'attachment'
        }[] = []
        statements.forEach((statement, n) => {
          for (const row of answers[n] ?? []) {
            const node = nodeOfRaw(row)
            if (statement.kind === 'names') {
              names.push({
                tree: statement.tree,
                node,
                kind: node.kind === 'folder' ? 'folder' : 'attachment',
              })
              continue
            }
            const own =
              typeof row.found_snippet === 'string' ? row.found_snippet : null
            const other =
              typeof row.found_companion_snippet === 'string'
                ? row.found_companion_snippet
                : null
            const entry: Found = {
              node,
              path: String(row.found_path),
              version: String(row.found_version),
              title: String(row.found_title ?? node.name),
              tier: Number(row.found_tier ?? 3),
              // The page's own words when they hold a match, else the
              // companion's, which this caller reads.
              snippet:
                own !== null && own.includes(MARK_OPEN) ? own : (other ?? own),
              companion:
                statement.kind === 'pages'
                  ? null
                  : {
                      id: row.found_companion as NodeId,
                      version: String(row.found_companion_version),
                    },
            }
            const kept = pages.get(node.id)
            if (kept === undefined) {
              pages.set(node.id, { tree: statement.tree, found: [entry] })
            } else kept.found.push(entry)
          }
        })

        // Each candidate checked again now, against the rule as it stands:
        // still live at the path and version found, the companion too, or
        // it is dropped before anything is counted or paged.
        const byTree = new Map<TreeId, { tree: TreeRowOf; ids: Set<string> }>()
        const want = (tree: TreeRowOf, id: string) => {
          const entry = byTree.get(tree.id) ?? { tree, ids: new Set() }
          entry.ids.add(id)
          byTree.set(tree.id, entry)
        }
        for (const { tree, found: list } of pages.values()) {
          for (const f of list) {
            want(tree, f.node.id)
            if (f.companion !== null) want(tree, f.companion.id)
          }
        }
        for (const { tree, node } of names) want(tree, node.id)
        const checks = yield* Effect.forEach(
          [...byTree.values()],
          ({ tree, ids }) =>
            Effect.map(access.readable(tree.id), (r) =>
              compiled(sql`select nodes.* from nodes
                where nodes.id in (select value from json_each(${JSON.stringify([...ids])}))
                  and nodes.tree_id = ${tree.id} and nodes.deleted_at is null
                  and (${r.where})`),
            ),
          { concurrency: 8 },
        )
        const fresh = new Map<string, NodeRow>()
        for (const rows of yield* batched(checks)) {
          for (const row of rows) {
            const node = nodeOfRaw(row)
            fresh.set(node.id, node)
          }
        }
        const holds = (f: Found) => {
          const page = fresh.get(f.node.id)
          if (
            page === undefined ||
            page.path !== f.path ||
            page.currentVersionId !== f.version
          ) {
            return false
          }
          if (f.companion === null) return true
          return (
            fresh.get(f.companion.id)?.currentVersionId === f.companion.version
          )
        }

        type Candidate =
          | {
              kind: 'page'
              tree: TreeRowOf
              node: NodeRow
              found: Found
            }
          | { kind: 'folder' | 'attachment'; tree: TreeRowOf; node: NodeRow }
        const place = (c: { tree: TreeRowOf; node: NodeRow }) =>
          `${c.tree.workspace}/${c.tree.name}/${c.node.path}`
        const pageCandidates: Candidate[] = []
        for (const { tree, found: list } of pages.values()) {
          const best = list
            .filter(holds)
            .sort(
              (a, b) => a.tier - b.tier || (a.companion === null ? -1 : 1),
            )[0]
          if (best === undefined) continue
          pageCandidates.push({
            kind: 'page',
            tree,
            node: fresh.get(best.node.id)!,
            found: best,
          })
        }
        const tierOf_ = (c: Candidate) => (c.kind === 'page' ? c.found.tier : 9)
        pageCandidates.sort(
          (a, b) => tierOf_(a) - tierOf_(b) || compare(place(a), place(b)),
        )
        const byName = (a: { node: NodeRow }, b: { node: NodeRow }) =>
          compare(a.node.name.toLowerCase(), b.node.name.toLowerCase()) ||
          compare(a.node.path, b.node.path)
        const nameCandidates = (kind: 'folder' | 'attachment') =>
          names
            .filter((n) => n.kind === kind)
            .flatMap((n): Candidate[] => {
              const now = fresh.get(n.node.id)
              return now === undefined || now.path !== n.node.path
                ? []
                : [{ kind, tree: n.tree, node: now }]
            })
            .sort(byName)
        const all: Candidate[] = [
          ...pageCandidates,
          ...nameCandidates('folder'),
          ...nameCandidates('attachment'),
        ]
        const window = all.slice(i.offset, i.offset + SEARCH_PAGE_SIZE)
        const more =
          all.length > i.offset + SEARCH_PAGE_SIZE &&
          i.offset + SEARCH_PAGE_SIZE <= SEARCH_MAX_OFFSET

        const reads = (node: NodeRow) =>
          access.require('read', node).pipe(Effect.isSuccess)
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

        // And each one shown passes the point check: listing, point checks
        // and search agree.
        const results: SearchResult[] = []
        for (const candidate of window) {
          if (!(yield* reads(candidate.node))) continue
          if (candidate.kind !== 'page') {
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
          const companion = candidate.found.companion
          if (companion !== null) {
            const node = fresh.get(companion.id)
            if (node === undefined || !(yield* reads(node))) continue
          }
          results.push({
            kind: 'page',
            node: candidate.node,
            title: candidate.found.title,
            workspace: candidate.tree.workspace,
            tree: candidate.tree.name,
            link: link(candidate.tree, candidate.node, 'page'),
            snippet: content ? snippetParts(candidate.found.snippet) : null,
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
