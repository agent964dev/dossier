// What every page carries after a delete, a move or a restore: the rows a
// push would write, with flags that belong to the versions. A version that
// stands keeps the flags recorded when it was pushed, under its new paths
// after a move; what nothing recorded is evaluated as that version's author,
// never as the person deleting, moving or restoring.
import type { PersonId, SessionId, TreeId } from '@dossier/contracts'
import type { HtmlAnalysis } from '@dossier/html'
import { sql } from 'drizzle-orm'
import { Effect } from 'effect'

import { db, schema } from '../db/client.ts'
import type { AccessService } from './access.ts'
import { CurrentCaller, type Caller } from './caller.ts'
import { pageNeedsOf, type PageNeed, type PageNeedRow } from './page-needs.ts'
import { ancestorPaths } from './rows.ts'
import type { TreeStoreService } from './tree-store.ts'

/** An HTML file of the tree as the change leaves it. */
export interface HtmlAfter {
  /** Its tree path after the change. */
  readonly path: string
  readonly analysis: HtmlAnalysis
  /** Whose version it holds: the person who pushed that content. */
  readonly author: PersonId
  /**
   * Its path before the change when it keeps the rows recorded for its
   * content (a version that stands, or one whose links a move rewrote);
   * null when the change gives it content nothing recorded.
   */
  readonly was: string | null
}

export type NodeKindAfter = 'page' | 'file' | 'folder' | 'data'

interface Recorded {
  readonly page: string
  readonly need: string
  readonly kind: PageNeed['kind']
  readonly host: string
  readonly reads: number
  readonly responds: number
}

const keyOf = (r: {
  readonly page: string
  readonly need: string
  readonly kind: string
  readonly host: string
}) => `${r.page}\u0000${r.need}\u0000${r.kind}\u0000${r.host}`

/** What a page carries per need and kind, whichever file names it. */
const carried = (
  rows: readonly {
    readonly page: string
    readonly need: string
    readonly kind: string
    readonly reads: boolean
    readonly responds: boolean
  }[],
) => {
  const out = new Map<string, { reads: boolean; responds: boolean }>()
  for (const r of rows) {
    const key = `${r.page}\u0000${r.need}\u0000${r.kind}`
    const was = out.get(key)
    out.set(key, {
      reads: r.reads || (was?.reads ?? false),
      responds: r.responds || (was?.responds ?? false),
    })
  }
  return out
}

/**
 * The page_needs rows of the tree after the change, and whether they take
 * from what a shared page carried (then every socket on the tree closes).
 * `oldOf` maps a path after the change to the path it had before (a move),
 * and `newOf` the other way;
 * paths the change brings back are read by their nearest live folder.
 */
export const neededAfter = (deps: {
  readonly DB: D1Database
  readonly access: AccessService
  readonly store: TreeStoreService
  readonly treeId: TreeId
  readonly files: readonly HtmlAfter[]
  readonly kindAt: (path: string) => NodeKindAfter | null
  readonly oldOf: (path: string) => string
  /** The other way: a path before the change to the path it has after. */
  readonly newOf: (path: string) => string
  readonly requestId: string
}) =>
  Effect.gen(function* () {
    const { DB, access, store, treeId } = deps
    const query = <A>(run: () => Promise<A>) => Effect.promise(run)
    const before = (yield* query(() =>
      DB.prepare(
        `select page_path as page, need_path as need, kind, host_path as host,
           reads, responds
         from page_needs where tree_id = ?`,
      )
        .bind(treeId)
        .all<Recorded>(),
    )).results
    const recorded = new Map(before.map((r) => [keyOf(r), r]))

    const callers = new Map<PersonId, Caller | null>()
    const callerOf = (author: PersonId) =>
      Effect.gen(function* () {
        if (callers.has(author)) return callers.get(author) ?? null
        const person = yield* query(() =>
          DB.prepare('select id, email, name, image from "user" where id = ?')
            .bind(author)
            .first<{
              id: PersonId
              email: string
              name: string
              image: string | null
            }>(),
        )
        const who: Caller | null =
          person === null
            ? null
            : {
                person,
                via: { kind: 'browser', sessionId: '' as SessionId },
                requestId: deps.requestId,
              }
        callers.set(author, who)
        return who
      })
    const readable = new Map<PersonId, ReadonlySet<string>>()
    const readableTo = (author: PersonId, who: Caller) =>
      Effect.gen(function* () {
        const kept = readable.get(author)
        if (kept !== undefined) return kept
        const by = yield* access.readableByGrants(treeId)
        const rows = yield* query(() =>
          db({ DB })
            .select({ path: schema.nodes.path })
            .from(schema.nodes)
            .where(
              sql`${schema.nodes.treeId} = ${treeId} and ${schema.nodes.deletedAt} is null and ${by.where}`,
            )
            .all(),
        )
        const found = new Set(rows.map((r) => r.path))
        readable.set(author, found)
        return found
      }).pipe(Effect.provideService(CurrentCaller, who))
    const held = new Map<string, { reads: boolean; responds: boolean }>()
    const none = { reads: false, responds: false }

    const byPath = new Map(deps.files.map((f) => [f.path, f]))
    const flagsOf = (need: PageNeed) =>
      Effect.gen(function* () {
        const host = byPath.get(need.host)
        if (host === undefined) return none
        if (host.was !== null) {
          const kept = recorded.get(
            keyOf({
              page: deps.oldOf(need.page),
              need: deps.oldOf(need.need),
              kind: need.kind,
              host: host.was,
            }),
          )
          if (kept !== undefined) {
            return { reads: kept.reads === 1, responds: kept.responds === 1 }
          }
        }
        const who = yield* callerOf(host.author)
        if (who === null) return none
        // Read before the change commits: by the paths they have now.
        const now = deps.oldOf(need.need)
        if (need.kind === 'render') {
          const set = yield* readableTo(host.author, who)
          // A file the change brings back reads as its nearest live
          // folder does.
          const reads =
            set.has(now) ||
            ancestorPaths(now)
              .slice(0, -1)
              .reverse()
              .some((p) => set.has(p))
          return { reads, responds: false }
        }
        const key = `${host.author}\u0000${now}`
        const kept = held.get(key)
        if (kept !== undefined) return kept
        const node = yield* store.nearest(treeId, now).pipe(Effect.orDie)
        let found = none
        if (node !== null) {
          const roles = yield* access
            .heldOn(node)
            .pipe(Effect.provideService(CurrentCaller, who))
          found = {
            reads:
              roles.privateCaps.has('read') ||
              (node.path === now && roles.owns),
            responds: roles.caps.has('respond'),
          }
        }
        held.set(key, found)
        return found
      })

    const needs: PageNeedRow[] = []
    for (const need of pageNeedsOf(deps.files, deps.kindAt)) {
      const flags = yield* flagsOf(need)
      needs.push({ ...need, reads: flags.reads, responds: flags.responds })
    }
    const after = carried(needs)
    const shared =
      (yield* query(() =>
        DB.prepare('select 1 as one from shares where tree_id = ? limit 1')
          .bind(treeId)
          .first(),
      )) !== null
    // What a page carried before, under the paths it has after the change.
    const narrowed =
      shared &&
      [
        ...carried(
          before.map((r) => ({
            page: deps.newOf(r.page),
            need: deps.newOf(r.need),
            kind: r.kind,
            reads: r.reads === 1,
            responds: r.responds === 1,
          })),
        ),
      ].some(([key, old]) => {
        const now = after.get(key)
        return (
          (old.reads && !(now?.reads ?? false)) ||
          (old.responds && !(now?.responds ?? false))
        )
      })
    return { needs, narrowed }
  })
