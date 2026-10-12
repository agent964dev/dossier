// Deletes, restores and moves: changes in a tree's history like a push.
// Internal to Files. Each change reads the tree, plans what it does, and
// commits one batch guarded by what it read; when another change landed in
// between, it reads again, within a number of tries and a time budget.
import {
  commentsFolderIn,
  commentsFolderOf,
  dossierError,
  isCommentValue,
  isNodeName,
  isTreeName,
  linkFor,
  MAX_DEPTH,
  type AuthoredSeq,
  type DossierError,
  type EventSeq,
  type LinkRef,
  type PersonId,
  type Sha256,
  type ShareId,
  type TreeId,
  type VersionId,
} from '@dossier/contracts'
import {
  ANALYZER_VERSION,
  checkPush,
  describeProblems,
  pageFolderClash,
  rewriteForMove,
  type HtmlAnalysis,
} from '@dossier/html'
import { Clock, Data as EffectData, Effect, Exit } from 'effect'

import type { AccessService, Granted } from './access.ts'
import { CurrentCaller } from './caller.ts'
import type { ChangeFeedService } from './change-feed.ts'
import type { DataService } from './data.ts'
import type { ChangeResult, MoveResult, RestorePoint } from './files.ts'
import type { makeHistory } from './history.ts'
import { getBlob } from './blob-keys.ts'
import { newId, sha256Hex } from './ids.ts'
import { Bindings } from './bindings.ts'
import { formRowsOf } from './push.ts'
import { indexEntries, namesOf } from './search-index.ts'
import {
  neededAfter,
  type HtmlAfter,
  type NodeKindAfter,
} from './page-needs-held.ts'
import { ancestorPaths, type NodeRow, type VersionRow } from './rows.ts'
import {
  nodeOfRaw,
  type ChangeFailure,
  type NewFormRow,
  type RestorePlan,
  type TreeStoreService,
} from './tree-store.ts'

/** A batch lost to another change: plan again. */
class Retry extends EffectData.TaggedError('Retry')<{
  readonly error: ChangeFailure
}> {}

const TRIES = 4
const BUDGET_MS = 10_000

const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

const joinPath = (folder: string, name: string): string =>
  folder === '' ? name : `${folder}/${name}`

const isUnder = (path: string, prefix: string): boolean =>
  prefix === '' || path === prefix || path.startsWith(`${prefix}/`)

const sameContent = (a: VersionRow | null, b: VersionRow | null): boolean =>
  a !== null &&
  b !== null &&
  a.state === 'live' &&
  b.state === 'live' &&
  a.blobSha256 === b.blobSha256 &&
  a.jsonValue === b.jsonValue

const isPageFile = (node: { readonly path: string; readonly origin: string }) =>
  node.origin === 'authored' &&
  node.path.endsWith('.html') &&
  !node.path.split('/').some((s) => s.startsWith('_'))

export interface ChangesDeps {
  readonly DB: D1Database
  readonly BLOBS: R2Bucket
  readonly origin: URL
  readonly store: TreeStoreService
  readonly access: AccessService
  readonly data: DataService
  readonly feed: ChangeFeedService
  readonly history: ReturnType<typeof makeHistory>
  readonly bindings: Env
}

type Failure = DossierError<
  | 'not_found'
  | 'sign_in_required'
  | 'forbidden'
  | 'invalid'
  | 'conflict'
  | 'policy_rejected'
  | 'blob_reclaiming'
  | 'unavailable'
>

export const makeChanges = (deps: ChangesDeps) => {
  const { DB, BLOBS, store, access, history } = deps
  const query = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (error) => {
        console.error('A change read failed', error)
        return dossierError('unavailable')
      },
    })

  /** Missing and unreadable answer alike. */
  const denied = (missing: {
    readonly treeId: TreeId | null
    readonly path: string
  }) =>
    access
      .require('read', { missing: true, ...missing })
      .pipe(
        Effect.zipRight(Effect.die(new Error('Access granted a missing node'))),
      )

  /** A committed batch, or Retry when another change got there first. */
  const committing = <A>(
    run: Effect.Effect<A, ChangeFailure, CurrentCaller | Background>,
  ) =>
    run.pipe(
      Effect.catchAll((error): Effect.Effect<never, ChangeFailure | Retry> =>
        error.code === 'stale_head' || error.code === 'conflict'
          ? Effect.fail(new Retry({ error }))
          : Effect.fail(error),
      ),
    )

  /** Plans and commits again while other changes keep moving the tree. */
  const retrying = <A, E, R>(once: Effect.Effect<A, E | Retry, R>) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      for (let tried = 0; ; tried += 1) {
        const outcome = yield* Effect.either(once)
        if (outcome._tag === 'Right') return outcome.right
        const error = outcome.left
        if (!(error instanceof Retry)) return yield* Effect.fail(error as E)
        const now = yield* Clock.currentTimeMillis
        if (tried + 1 >= TRIES || now - started > BUDGET_MS) {
          return yield* Effect.fail(
            dossierError(
              'conflict',
              'Other changes kept coming in, so nothing was applied.',
              'Try again.',
            ) as E,
          )
        }
        yield* Effect.sleep(20 * 2 ** tried)
      }
    })

  const linkOf = (ws: string, tree: string, node: NodeRow) =>
    linkFor(deps.origin, {
      workspace: ws,
      tree,
      path: node.path,
      kind:
        node.kind === 'folder'
          ? 'folder'
          : node.origin === 'authored' && node.path.endsWith('.html')
            ? 'page'
            : 'file',
    })

  /** Every live node of the tree, as kinds a page's needs read. */
  const liveNodes = (treeId: TreeId) =>
    Effect.map(
      query(() =>
        DB.prepare(
          'select * from nodes where tree_id = ? and deleted_at is null',
        )
          .bind(treeId)
          .all<Record<string, unknown>>(),
      ),
      (rows) => rows.results.map(nodeOfRaw),
    )

  const kindOf = (node: NodeRow): NodeKindAfter =>
    node.origin === 'data'
      ? 'data'
      : node.kind === 'folder'
        ? 'folder'
        : node.path.endsWith('.html')
          ? 'page'
          : 'file'

  /** The live authored HTML files, with their analyses and authors. */
  const htmlFiles = (treeId: TreeId) =>
    Effect.gen(function* () {
      const rows = yield* query(() =>
        DB.prepare(
          `select n.*, v.blob_sha256 as sha, v.author_id as author,
             v.id as versionId, v.content_type as type, a.json
           from nodes n join node_versions v on v.id = n.current_version_id
             left join analyses a on a.sha256 = v.blob_sha256
               and a.analyzer = 'html' and a.version = ?2
           where n.tree_id = ?1 and n.deleted_at is null and n.kind = 'file'
             and n.origin = 'authored' and v.state = 'live'
             and n.path like '%.html'`,
        )
          .bind(treeId, ANALYZER_VERSION)
          .all<
            Record<string, unknown> & {
              sha: Sha256
              author: PersonId
              versionId: VersionId
              type: string | null
              json: string | null
            }
          >(),
      )
      const out: {
        readonly node: NodeRow
        readonly sha: Sha256
        readonly author: PersonId
        readonly versionId: VersionId
        readonly type: string
        readonly analysis: HtmlAnalysis
      }[] = []
      for (const row of rows.results) {
        const analysis =
          row.json === null
            ? yield* store.analysis(row.sha)
            : (JSON.parse(row.json) as HtmlAnalysis)
        if (analysis === null) continue
        out.push({
          node: nodeOfRaw(row),
          sha: row.sha,
          author: row.author,
          versionId: row.versionId,
          type: row.type ?? 'text/html; charset=utf-8',
          analysis,
        })
      }
      return out
    })

  const requestId = Effect.map(CurrentCaller, (c) => c.requestId)

  /** The search entries of a change, with their texts stored. */
  const indexing = (i: Parameters<typeof indexEntries>[0]) =>
    indexEntries(i).pipe(Effect.provideService(Bindings, deps.bindings))

  // ---------------------------------------------------------------- rm

  const rm = (i: { readonly ref: LinkRef }) =>
    retrying(
      Effect.gen(function* () {
        const located = yield* store.locate(i.ref)
        if ('missing' in located) return yield* denied(located)
        const { node, tree } = located
        const ws = i.ref.workspace
        // A comment stays in its thread: a write holder's delete blanks it.
        if (
          located.kind === 'file' &&
          node.origin === 'data' &&
          commentsFolderIn(node.path) !== null &&
          isCommentValue(parseJson(located.version.jsonValue))
        ) {
          yield* deps.data.deleteComment({ treeId: tree.id, path: node.path })
          const now = yield* store.treeById(tree.id)
          return {
            path: node.path,
            link: linkOf(ws, i.ref.tree, node),
            seq: (now?.tree.eventSeq ?? tree.eventSeq) as EventSeq,
            changed: [node.path],
          } satisfies ChangeResult
        }
        const granted =
          node.origin === 'data'
            ? yield* access.require('delete-data', node)
            : yield* access.require('write', node)
        const live = yield* liveNodes(tree.id)
        const gone = (n: NodeRow) =>
          n.id === node.id || isUnder(n.path, node.path)
        const changed = live
          .filter((n) => n.kind === 'file' && gone(n))
          .map((n) => n.path)
          .sort()
        // What pages carry, and what search holds, change only with
        // authored files.
        const authored = node.origin === 'authored'
        const left = live.filter((n) => !gone(n))
        const kinds = new Map(left.map((n) => [n.path, kindOf(n)]))
        const standing =
          authored && node.depth > 0
            ? (yield* htmlFiles(tree.id)).filter((f) => !gone(f.node))
            : []
        const needs = authored
          ? node.depth === 0
            ? { needs: [], narrowed: true }
            : yield* neededAfter({
                DB,
                access,
                store,
                treeId: tree.id,
                files: standing.map((f): HtmlAfter => ({
                  path: f.node.path,
                  analysis: f.analysis,
                  author: f.author,
                  was: f.node.path,
                })),
                kindAt: (p) => kinds.get(p) ?? null,
                oldOf: (p) => p,
                newOf: (p) => p,
                requestId: yield* requestId,
              })
          : null
        // The pages it deletes leave search, and pages whose companion it
        // deletes are indexed again without it.
        const search = authored
          ? yield* indexing({
              treeId: tree.id,
              changed: [],
              removed: changed,
              pages: standing.map((f) => ({
                path: f.node.path,
                alternate: f.analysis.alternate,
              })),
              kindAt: (p) => kinds.get(p) ?? null,
            })
          : []
        const committed = yield* committing(
          store.change(tree.id, (cs) =>
            Effect.sync(() => {
              if (needs !== null) {
                cs.guardHead('', tree.authoredSeq as AuthoredSeq)
              }
              cs.markDeleted(granted, 'deleted')
              if (needs !== null) cs.putPageNeeds(needs.needs, needs.narrowed)
              cs.indexPages(search)
              cs.event({ type: 'delete', path: node.path, node: granted })
              return {}
            }),
          ),
        )
        return {
          path: node.path,
          link: linkOf(ws, i.ref.tree, node),
          seq: committed.seq,
          changed,
        } satisfies ChangeResult
      }),
    )

  // ---------------------------------------------------------------- restore

  const restore = (i: { readonly ref: LinkRef; readonly to: RestorePoint }) =>
    retrying(
      Effect.gen(function* () {
        const located = yield* store.locate(i.ref, { deleted: true })
        if ('missing' in located) return yield* denied(located)
        const { node, tree } = located
        const granted = yield* access.require('write', node)
        const ws = i.ref.workspace
        // The point: just after push N, or a time.
        let seq: number | null = null
        let time: number
        let label: string
        if ('push' in i.to) {
          const push = yield* history.pushOf(tree.id, i.to.push)
          if (push === null) {
            return yield* Effect.fail(
              dossierError(
                'invalid',
                `There is no push ${i.to.push} in ${tree.name}.`,
                `See the pushes with dossier log ${ws}/${tree.name}.`,
              ),
            )
          }
          seq = yield* history.seqOfPush(push)
          time = push.committedAt ?? push.createdAt
          label = `push ${i.to.push}`
        } else {
          time = i.to.at
          label = new Date(i.to.at).toISOString()
        }
        const at = (n: NodeRow) =>
          seq !== null && n.origin === 'authored'
            ? history.versionAtSeq(n.id, seq)
            : history.versionAtTime(n.id, time)
        if (tree.deletedAt !== null && node.depth !== 0) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `${tree.name} is deleted.`,
              `Restore the whole tree first: dossier restore ${ws}/${tree.name}/ --to <push>.`,
            ),
          )
        }
        if (tree.deletedAt !== null) {
          const workspace = yield* store.workspace(ws)
          const taken =
            workspace === null ? null : yield* store.tree(workspace, tree.name)
          if (taken !== null) {
            return yield* Effect.fail(
              dossierError(
                'conflict',
                `A newer ${tree.name} is there now. Move it first.`,
                `Move it with dossier mv ${ws}/${tree.name} ${ws}/<new name>.`,
              ),
            )
          }
        }
        // Every node at or below it, deleted ones included.
        const below = yield* query(() =>
          DB.prepare(
            `select * from nodes where tree_id = ?1 and (id = ?2 or ?3 = ''
               or path = ?3 or substr(path, 1, length(?3) + 1) = ?3 || '/')`,
          )
            .bind(tree.id, node.id, node.path)
            .all<Record<string, unknown>>(),
        ).pipe(Effect.map((r) => r.results.map(nodeOfRaw)))
        const current = new Map<string, VersionRow | null>()
        const versionNow = (n: NodeRow) =>
          Effect.gen(function* () {
            if (current.has(n.id)) return current.get(n.id) ?? null
            const v = yield* history.current(n)
            current.set(n.id, v)
            return v
          })
        const revive: { node: NodeRow; from: VersionRow }[] = []
        const remove: NodeRow[] = []
        // People's data: what a write holder deleted after the point comes
        // back; data written since stays as it is.
        const reviveData = (n: NodeRow) =>
          Effect.gen(function* () {
            if (
              n.kind !== 'file' ||
              n.deletedAt === null ||
              n.deletedAt <= time
            )
              return
            const pv = yield* at(n)
            if (pv === null || pv.state !== 'live') return
            const now = yield* versionNow(n)
            if (now?.state === 'deleted') revive.push({ node: n, from: pv })
          })
        const notThere = () =>
          dossierError(
            'invalid',
            `${node.path === '' ? `${tree.name}/` : node.path} did not exist at ${label}.`,
            `See its history with dossier log ${ws}/${tree.name}/${node.path}.`,
          )
        if (node.kind === 'file') {
          const pv = yield* at(node)
          if (pv === null || pv.state !== 'live') {
            // A newer file holds the path the older one had then.
            const older = yield* query(() =>
              DB.prepare(
                `select * from nodes where tree_id = ? and path = ? and id <> ?
                   and deleted_at is not null order by deleted_at desc`,
              )
                .bind(tree.id, node.path, node.id)
                .all<Record<string, unknown>>(),
            )
            for (const row of older.results) {
              const then = yield* at(nodeOfRaw(row))
              if (then !== null && then.state === 'live') {
                return yield* Effect.fail(
                  dossierError(
                    'conflict',
                    `A newer ${node.path} is there now. Move it first.`,
                    'Move it with dossier mv, then restore again.',
                  ),
                )
              }
            }
            return yield* Effect.fail(notThere())
          }
          if (
            !(
              node.deletedAt === null &&
              sameContent(yield* versionNow(node), pv)
            )
          ) {
            revive.push({ node, from: pv })
          }
          // A page's comments went with it, and come back with it.
          if (isPageFile(node)) {
            const folder = commentsFolderOf(node.path).slice(0, -1)
            const comments = yield* query(() =>
              DB.prepare(
                `select * from nodes where tree_id = ?1 and origin = 'data'
                   and (path = ?2 or substr(path, 1, length(?2) + 1) = ?2 || '/')`,
              )
                .bind(tree.id, folder)
                .all<Record<string, unknown>>(),
            ).pipe(Effect.map((r) => r.results.map(nodeOfRaw)))
            below.push(...comments)
            for (const n of comments) yield* reviveData(n)
          }
        } else {
          for (const n of below) {
            if (n.kind !== 'file') continue
            const pv = yield* at(n)
            const then = pv !== null && pv.state === 'live'
            if (n.origin === 'authored') {
              if (then) {
                if (
                  !(
                    n.deletedAt === null &&
                    sameContent(yield* versionNow(n), pv)
                  )
                ) {
                  revive.push({ node: n, from: pv })
                }
              } else if (n.deletedAt === null) {
                remove.push(n)
              }
              continue
            }
            yield* reviveData(n)
          }
        }
        const removed = new Set(remove.map((n) => n.id))
        const allLive = yield* liveNodes(tree.id)
        // The comments of the pages it removes go with them, so a later
        // page at the same path starts with none.
        const retired = new Set(
          allLive
            .filter((n) =>
              remove.some(
                (r) =>
                  isPageFile(r) &&
                  n.origin === 'data' &&
                  isUnder(n.path, commentsFolderOf(r.path).slice(0, -1)),
              ),
            )
            .map((n) => n.id),
        )
        const retire = allLive.filter((n) => retired.has(n.id))
        const live = allLive.filter((n) => !retired.has(n.id))
        const liveAt = new Map(live.map((n) => [n.path, n]))
        // A deleted node comes back only where nothing else lives now,
        // even a newer file the point did not hold.
        for (const r of revive) {
          if (r.node.deletedAt === null) continue
          const there = liveAt.get(r.node.path)
          if (there !== undefined && there.id !== r.node.id) {
            return yield* Effect.fail(
              dossierError(
                'conflict',
                `A newer ${r.node.path} is there now. Move it first.`,
                `Move it with dossier mv, then restore again.`,
              ),
            )
          }
        }
        // The folders the revived files sit in, up to a live one.
        const byId = new Map<string, NodeRow>(below.map((n) => [n.id, n]))
        const above = yield* query(() =>
          DB.prepare(
            `with recursive up(id, parent) as (
               select id, parent_id from nodes where id = ?1
               union all select n.id, n.parent_id from nodes n join up on n.id = up.parent)
             select n.* from nodes n join up on up.id = n.id`,
          )
            .bind(node.id)
            .all<Record<string, unknown>>(),
        )
        for (const row of above.results) {
          const n = nodeOfRaw(row)
          if (!byId.has(n.id)) byId.set(n.id, n)
        }
        const folders = new Map<string, NodeRow>()
        for (const r of revive) {
          let parent =
            r.node.parentId === null ? undefined : byId.get(r.node.parentId)
          while (parent !== undefined && parent.deletedAt !== null) {
            if (!folders.has(parent.id)) {
              const there = liveAt.get(parent.path)
              if (there !== undefined && there.id !== parent.id) {
                return yield* Effect.fail(
                  dossierError(
                    'conflict',
                    `A newer ${parent.path === '' ? `${tree.name}/` : `${parent.path}/`} is there now. Move it first.`,
                    'Move it with dossier mv, then restore again.',
                  ),
                )
              }
              folders.set(parent.id, parent)
            }
            parent =
              parent.parentId === null ? undefined : byId.get(parent.parentId)
          }
        }
        // Authored folders left with no live file below are deleted, as a
        // push leaves them.
        const filesAfter = new Set([
          ...live
            .filter((n) => n.kind === 'file' && !removed.has(n.id))
            .map((n) => n.path),
          ...revive.map((r) => r.node.path),
        ])
        // A revived a/b.html and a live a/b/index.html would be one page,
        // either way round.
        for (const r of revive) {
          if (r.node.kind !== 'file') continue
          const pageClash = pageFolderClash(r.node.path, (p) =>
            filesAfter.has(p),
          )
          if (pageClash === null) continue
          const other =
            pageClash.file === r.node.path ? pageClash.index : pageClash.file
          return yield* Effect.fail(
            dossierError(
              'conflict',
              `${other} is the page ${pageClash.page} now. Move it first.`,
              'Move it with dossier mv, then restore again.',
            ),
          )
        }
        const hasFile = (path: string) =>
          [...filesAfter].some((p) => isUnder(p, path) && p !== path)
        const empty = below.filter(
          (n) =>
            n.kind === 'folder' &&
            n.origin === 'authored' &&
            n.depth > 0 &&
            (n.deletedAt === null || folders.has(n.id)) &&
            !hasFile(n.path),
        )
        if (
          node.kind === 'folder' &&
          node.depth > 0 &&
          empty.some((n) => n.id === node.id)
        ) {
          return yield* Effect.fail(notThere())
        }
        const changed = [
          ...revive.map((r) => r.node.path),
          ...remove.map((n) => n.path),
        ].sort()
        if (
          revive.length === 0 &&
          remove.length === 0 &&
          folders.size === 0 &&
          tree.deletedAt === null
        ) {
          return {
            path: node.path,
            link: linkOf(ws, tree.name, node),
            seq: tree.eventSeq as EventSeq,
            changed: [],
          } satisfies ChangeResult
        }
        // What pages carry afterwards: a page given older content is read
        // as that content's author.
        const revivedIds = new Map(revive.map((r) => [r.node.id, r]))
        const standing = (yield* htmlFiles(tree.id)).filter(
          (f) => !removed.has(f.node.id) && !revivedIds.has(f.node.id),
        )
        const files: HtmlAfter[] = standing.map((f) => ({
          path: f.node.path,
          analysis: f.analysis,
          author: f.author,
          was: f.node.path,
        }))
        const forms: { node: NodeRow; rows: NewFormRow[] }[] = []
        for (const r of revive) {
          if (!isPageFile(r.node) && !r.node.path.endsWith('.html')) continue
          if (r.node.origin !== 'authored') continue
          const sha = r.from.blobSha256
          const analysis =
            sha === null ? null : yield* store.analysis(sha as Sha256)
          if (analysis === null) continue
          // Its forms send where its content says from where it stands now.
          forms.push({
            node: r.node,
            rows: formRowsOf([{ path: r.node.path, analysis }]).map((f) => ({
              target: f.target,
              key: f.key,
              kind: f.kind,
              closesAt: f.closesAt,
              closed: f.closed,
              line: f.line,
              title: f.title,
              schema: f.schema,
            })),
          })
          files.push({
            path: r.node.path,
            analysis,
            author: r.from.authorId as PersonId,
            was: null,
          })
        }
        const kinds = new Map<string, NodeKindAfter>()
        for (const n of live)
          if (!removed.has(n.id)) kinds.set(n.path, kindOf(n))
        for (const f of folders.values()) kinds.set(f.path, kindOf(f))
        for (const r of revive) kinds.set(r.node.path, kindOf(r.node))
        for (const f of empty) kinds.delete(f.path)
        const needs = yield* neededAfter({
          DB,
          access,
          store,
          treeId: tree.id,
          files,
          kindAt: (p) => kinds.get(p) ?? null,
          oldOf: (p) => p,
          newOf: (p) => p,
          requestId: yield* requestId,
        })
        // Revived pages, and pages whose companion came back or went, are
        // indexed with what they hold after the restore; removed ones leave.
        const search = yield* indexing({
          treeId: tree.id,
          changed: revive
            .filter((r) => r.node.origin === 'authored')
            .map((r) => r.node.path),
          removed: remove.map((n) => n.path),
          pages: files.map((f) => ({
            path: f.path,
            alternate: f.analysis.alternate,
          })),
          kindAt: (p) => kinds.get(p) ?? null,
          shaAt: new Map(
            revive
              .filter((r) => r.node.origin === 'authored')
              .map((r) => [r.node.path, r.from.blobSha256 as Sha256 | null]),
          ),
        })
        const plan: RestorePlan = {
          revive,
          remove,
          folders: [...folders.values()],
          empty: empty.filter((n) => n.deletedAt === null || folders.has(n.id)),
          retire,
          tree: tree.deletedAt !== null,
          forms,
        }
        const committed = yield* committing(
          store.change(tree.id, (cs) =>
            Effect.sync(() => {
              cs.guardHead('', tree.authoredSeq as AuthoredSeq)
              cs.restore(granted, plan)
              cs.putPageNeeds(needs.needs, needs.narrowed)
              cs.indexPages(search)
              cs.indexNames(
                namesOf(
                  revive
                    .filter((r) => r.node.origin === 'authored')
                    .map((r) => r.node.path),
                ),
              )
              cs.event({
                type: 'restore',
                path: node.path,
                node: granted,
                detail: label,
              })
              return {}
            }),
          ),
        )
        return {
          path: node.path,
          link: linkOf(ws, tree.name, node),
          seq: committed.seq,
          changed,
        } satisfies ChangeResult
      }),
    )

  // ---------------------------------------------------------------- mv

  const invalid = (message: string, fix: string | null = null) =>
    Effect.fail(dossierError('invalid', message, fix))

  /** Whether a relative URL of the file could name a path across the move. */
  const crosses = (
    analysis: HtmlAnalysis,
    filePath: string,
    from: string,
  ): boolean => {
    const folder = parentOf(filePath)
    const base = `https://tree.invalid/${folder === '' ? '' : `${folder.split('/').map(encodeURIComponent).join('/')}/`}`
    const inside = isUnder(filePath, from)
    for (const url of analysis.urls) {
      if (!url.relative || url.underscore) continue
      for (const value of url.requests) {
        let target: URL
        try {
          target = new URL(value, base)
        } catch {
          continue
        }
        if (target.origin !== 'https://tree.invalid') continue
        let path: string
        try {
          path = decodeURIComponent(target.pathname.slice(1)).replace(/\/$/, '')
        } catch {
          continue
        }
        const named = [path, `${path}.html`, `${path}/index.html`].some((p) =>
          isUnder(p, from),
        )
        if (inside ? !named : named) return true
      }
    }
    return false
  }

  const mv = (i: { readonly from: LinkRef; readonly to: LinkRef }) =>
    Effect.gen(function* () {
      const sameTree =
        i.from.workspace === i.to.workspace && i.from.tree === i.to.tree
      if (i.from.path === '') {
        if (sameTree) {
          return yield* invalid(
            `${i.from.workspace}/${i.from.tree} is already there.`,
          )
        }
        if (i.to.path !== '') {
          return yield* invalid(
            'A tree moves to a workspace and a name, never into a folder.',
            `Run dossier mv ${i.from.workspace}/${i.from.tree} <workspace>/<name>.`,
          )
        }
        return yield* moveTree({
          tree: i.from,
          to: { workspace: i.to.workspace, tree: i.to.tree },
        })
      }
      if (!sameTree) {
        return yield* invalid(
          'A move stays in its tree.',
          `Move the whole tree with dossier mv ${i.from.workspace}/${i.from.tree} <workspace>/<name>.`,
        )
      }
      return yield* retrying(moveOnce(i))
    })

  const moveOnce = (i: { readonly from: LinkRef; readonly to: LinkRef }) =>
    Effect.gen(function* () {
      const located = yield* store.locate(i.from)
      if ('missing' in located) return yield* denied(located)
      const { node, tree } = located
      // Nothing about a source is answered to someone who cannot write it.
      const granted = yield* access.require('write', node)
      const ws = i.from.workspace
      const display = (path: string) => `${ws}/${tree.name}/${path}`
      if (node.depth === 0) {
        return yield* invalid(`${ws}/${tree.name} is the tree's root.`)
      }
      const live = yield* liveNodes(tree.id)
      const liveAt = new Map(live.map((n) => [n.path, n]))
      // As mv does: into a folder that is there (a file into the folder a
      // trailing slash names), else to the path. A page link names its
      // .html file.
      const into =
        i.to.folder &&
        (node.kind === 'file' || liveAt.get(i.to.path)?.kind === 'folder')
      let dest = into ? joinPath(i.to.path, node.name) : i.to.path
      if (
        node.kind === 'file' &&
        node.path === `${i.from.path}.html` &&
        !dest.endsWith('.html')
      ) {
        dest = `${dest}.html`
      }
      const segments = dest.split('/')
      if (
        dest === '' ||
        segments.length > MAX_DEPTH ||
        !segments.every(isNodeName)
      ) {
        return yield* invalid(`"${i.to.path}" is not a path a node may have.`)
      }
      if (dest === node.path) {
        return yield* invalid(`${display(node.path)} is already there.`)
      }
      if (node.kind === 'folder' && isUnder(dest, node.path)) {
        return yield* invalid('A folder cannot move into itself.')
      }
      // A page's comments folder holds only comments.
      if (commentsFolderIn(dest) !== null) {
        return yield* invalid(
          "A page's comments folder holds only its comments.",
          'Choose a path outside it.',
        )
      }
      if (node.origin === 'data') {
        return yield* invalid(
          "Data files move with their page's folder.",
          'Move the folder that holds them.',
        )
      }
      // The deepest folder on the way that exists, and the ones to make. The
      // caller must write it before anything about the destination is
      // answered: then whatever is there is theirs to read.
      const ways = ancestorPaths(parentOf(dest))
      let nearest = liveAt.get('')
      let inTheWay: NodeRow | null = null
      const make: string[] = []
      for (const p of ways) {
        const there = liveAt.get(p)
        if (there === undefined) {
          make.push(p)
          continue
        }
        if (there.kind !== 'folder') {
          inTheWay = there
          break
        }
        if (make.length === 0) nearest = there
      }
      if (nearest === undefined) return yield* denied(located.node)
      const destination = yield* access.require('write', nearest).pipe(
        // The same answer whether or not something is there.
        Effect.mapError((error) =>
          error.code === 'not_found'
            ? dossierError('not_found', error.message, error.fix, i.to.path)
            : error,
        ),
      )
      if (inTheWay !== null) {
        return yield* invalid(
          `${display(inTheWay.path)} is a file, so nothing can move inside it.`,
        )
      }
      const dataHere = (path: string) =>
        ancestorPaths(path).some(
          (p) => p !== '' && liveAt.get(p)?.origin === 'data',
        )
      if (dataHere(node.path) || dataHere(dest)) {
        return yield* invalid(
          "Data files move with their page's folder.",
          'Move the folder that holds them.',
        )
      }
      if (liveAt.has(dest)) {
        return yield* Effect.fail(
          dossierError(
            'conflict',
            `${display(dest)} is taken.`,
            'Move or delete what is there first.',
          ),
        )
      }
      // A page and a folder of one name may not sit side by side.
      const clash =
        node.kind === 'file' && dest.endsWith('.html')
          ? liveAt.get(dest.slice(0, -'.html'.length))?.kind === 'folder'
          : node.kind === 'folder' && liveAt.has(`${dest}.html`)
      if (clash) {
        return yield* Effect.fail(
          dossierError(
            'policy_rejected',
            node.kind === 'folder'
              ? `${display(`${dest}.html`)} is a page, so a folder named ${segments.at(-1)} cannot sit beside it.`
              : `${display(dest.slice(0, -'.html'.length))}/ is a folder, so a page of that name cannot sit beside it.`,
            'Choose another name.',
          ),
        )
      }
      // A page's comments go with it.
      const comments =
        node.kind === 'file' && isPageFile(node)
          ? liveAt.get(commentsFolderOf(node.path).slice(0, -1))
          : undefined
      const commentsTo =
        comments === undefined ? null : commentsFolderOf(dest).slice(0, -1)
      if (commentsTo !== null && liveAt.has(commentsTo)) {
        return yield* Effect.fail(
          dossierError(
            'conflict',
            `${display(commentsTo)} is taken.`,
            'Move or delete what is there first.',
          ),
        )
      }
      const commentsGranted =
        comments === undefined ? null : yield* access.require('write', comments)
      const moves = (path: string) =>
        isUnder(path, node.path) ||
        (comments !== undefined && isUnder(path, comments.path))
      const newOf = (path: string) =>
        isUnder(path, node.path)
          ? dest + path.slice(node.path.length)
          : comments !== undefined &&
              commentsTo !== null &&
              isUnder(path, comments.path)
            ? commentsTo + path.slice(comments.path.length)
            : path
      const oldOf = (path: string) =>
        isUnder(path, dest)
          ? node.path + path.slice(dest.length)
          : comments !== undefined &&
              commentsTo !== null &&
              isUnder(path, commentsTo)
            ? comments.path + path.slice(commentsTo.length)
            : path
      // a/b.html and a/b/index.html would be one page: none may come of
      // the move, anywhere in the tree it leaves.
      const filesAfter = new Set(
        live
          .filter((n) => n.kind === 'file')
          .map((n) => (moves(n.path) ? newOf(n.path) : n.path)),
      )
      for (const n of live) {
        if (n.kind !== 'file' || !moves(n.path)) continue
        const pageClash = pageFolderClash(newOf(n.path), (p) =>
          filesAfter.has(p),
        )
        if (pageClash !== null) {
          return yield* Effect.fail(
            dossierError(
              'policy_rejected',
              `${display(pageClash.file)} and ${display(pageClash.index)} would both be the page ${display(pageClash.page)}.`,
              'Choose another name.',
            ),
          )
        }
      }
      // Kinds as the new paths make them: a file renamed to `.html` is a
      // page (or a layout) from the move on, and a page renamed to `.txt`
      // is not.
      const kindsAfter = new Map<string, NodeKindAfter>()
      for (const n of live) {
        const after = newOf(n.path)
        kindsAfter.set(after, kindOf({ ...n, path: after }))
      }
      for (const p of make) kindsAfter.set(p, 'folder')
      // Files a rename makes pages or layouts: what their content declares
      // where they will stand, by the version's author, as a push of them
      // there would record it. The push's page rules apply to them.
      const becoming: {
        readonly path: string
        readonly author: PersonId
        readonly analysis: HtmlAnalysis | null
      }[] = []
      for (const n of live) {
        const after = newOf(n.path)
        if (
          n.kind !== 'file' ||
          n.origin !== 'authored' ||
          n.path.endsWith('.html') ||
          !after.endsWith('.html')
        ) {
          continue
        }
        const row = yield* query(() =>
          DB.prepare(
            `select blob_sha256 as sha, author_id as author from node_versions
             where id = ?`,
          )
            .bind(n.currentVersionId)
            .first<{ sha: Sha256 | null; author: PersonId }>(),
        )
        if (row === null) continue
        const analysis =
          row.sha === null ? null : yield* store.analysis(row.sha)
        becoming.push({ path: after, author: row.author, analysis })
      }
      const asPages = becoming.flatMap((b) =>
        b.analysis === null ? [] : [{ path: b.path, analysis: b.analysis }],
      )
      const pageCheck = checkPush(
        asPages,
        { kindAt: (p) => kindsAfter.get(p) ?? null, componentAt: () => true },
        { warnFor: new Set() },
      )
      if (pageCheck.problems.length > 0) {
        const described = describeProblems(pageCheck.problems)
        return yield* Effect.fail(
          dossierError(
            'policy_rejected',
            described.message,
            described.fix,
            described.path,
          ),
        )
      }
      // Its forms, by its version, with targets read from where it will be.
      const becomingForms = formRowsOf(asPages).map((f): NewFormRow => ({
        target: f.target,
        key: f.key,
        kind: f.kind,
        closesAt: f.closesAt,
        closed: f.closed,
        line: f.line,
        title: f.title,
        schema: f.schema,
      }))
      // Relative links in authored HTML that cross the move follow it.
      const kinds = new Map(live.map((n) => [n.path, kindOf(n)]))
      const html = yield* htmlFiles(tree.id)
      const rewrites: {
        file: (typeof html)[number]
        text: string
        sha: Sha256
        size: number
      }[] = []
      for (const file of html) {
        if (!crosses(file.analysis, file.node.path, node.path)) continue
        const object = yield* query(() => getBlob({ DB, BLOBS }, file.sha))
        if (object === null) continue
        const source = yield* query(() => object.text())
        const text = rewriteForMove(source, file.analysis, {
          filePathBefore: file.node.path,
          filePathAfter: newOf(file.node.path),
          from: node.path,
          to: dest,
          kindAt: (p) => kinds.get(p) ?? null,
        })
        if (text === null) continue
        const bytes = new TextEncoder().encode(text)
        rewrites.push({
          file,
          text,
          sha: (yield* Effect.promise(() => sha256Hex(text))) as Sha256,
          size: bytes.byteLength,
        })
      }
      // Every file whose links would change must be the caller's to change.
      const grants: Granted<'write'>[] = []
      const refused: NodeRow[] = []
      for (const r of rewrites) {
        const ok = yield* access
          .require('write', r.file.node)
          .pipe(Effect.option)
        if (ok._tag === 'Some') grants.push(ok.value)
        else refused.push(r.file.node)
      }
      if (refused.length > 0) {
        const named: string[] = []
        for (const n of refused) {
          if (yield* access.require('read', n).pipe(Effect.isSuccess)) {
            named.push(n.path)
          }
        }
        return yield* Effect.fail(
          dossierError(
            'forbidden',
            `This move would change links in files you cannot change${named.length === 0 ? '' : `: ${named.join(', ')}`}.`,
            'Ask someone who can change them to move it.',
            null,
          ),
        )
      }
      // The rewritten files' bytes are held before they are written.
      const hold = { kind: 'move' as const, id: newId() }
      const held: Sha256[] = []
      const release = Effect.forEach(
        held,
        (sha) => store.releaseHold(hold, sha),
        { discard: true },
      )
      const analyses = new Map<string, HtmlAnalysis>()
      // Every way out but the commit lets go of what it held.
      const committed = yield* Effect.gen(function* () {
        for (const r of rewrites) {
          const key = yield* store.holdBlob(hold, r.sha, r.size)
          held.push(r.sha)
          yield* query(() =>
            BLOBS.put(key, r.text, {
              sha256: r.sha,
              httpMetadata: { contentType: r.file.type },
            }),
          )
          yield* store.confirmHold(hold, r.sha, r.size)
          const analysis = yield* store.analysis(r.sha)
          if (analysis !== null) analyses.set(r.file.node.id, analysis)
        }
        const files: HtmlAfter[] = [
          ...html.map((f) => ({
            path: newOf(f.node.path),
            analysis: analyses.get(f.node.id) ?? f.analysis,
            author: f.author,
            was: f.node.path,
          })),
          // Nothing was recorded for these: evaluated as their author.
          ...becoming.flatMap((b) =>
            b.analysis === null
              ? []
              : [
                  {
                    path: b.path,
                    analysis: b.analysis,
                    author: b.author,
                    was: null,
                  },
                ],
          ),
        ]
        const needs = yield* neededAfter({
          DB,
          access,
          store,
          treeId: tree.id,
          files,
          kindAt: (p) => kindsAfter.get(p) ?? null,
          oldOf,
          newOf,
          requestId: yield* requestId,
        })
        // Search follows: what moved is indexed at its new path (and leaves
        // its old one), and so is every file whose links were rewritten.
        const moved = live
          .filter((n) => n.kind === 'file' && isUnder(n.path, node.path))
          .map((n) => n.path)
        const search = yield* indexing({
          treeId: tree.id,
          changed: [
            ...moved.map(newOf),
            ...rewrites.map((r) => newOf(r.file.node.path)),
          ],
          removed: moved,
          pages: [
            ...files.map((f) => ({
              path: f.path,
              alternate: f.analysis.alternate,
            })),
            // Those `files` lacks: no analysis to carry anything.
            ...becoming
              .filter((b) => b.analysis === null)
              .map((b) => ({ path: b.path, alternate: null })),
          ],
          kindAt: (p) => kindsAfter.get(p) ?? null,
          shaAt: new Map(
            rewrites.map((r) => [
              newOf(r.file.node.path),
              r.sha as Sha256 | null,
            ]),
          ),
          wasAt: oldOf,
        })
        return yield* committing(
          store.change(tree.id, (cs) =>
            Effect.sync(() => {
              cs.guardHead('', tree.authoredSeq as AuthoredSeq)
              // The write on the destination, as the check saw it.
              cs.holds(destination)
              cs.move(granted, dest, make, undefined, becomingForms)
              if (
                comments !== undefined &&
                commentsGranted !== null &&
                commentsTo !== null
              ) {
                const was = comments.name
                const now = commentsTo.slice(commentsTo.lastIndexOf('/') + 1)
                cs.move(
                  commentsGranted,
                  commentsTo,
                  [],
                  was === now ? undefined : { from: was, to: now },
                )
              }
              rewrites.forEach((r, n) =>
                cs.putVersion(grants[n]!, {
                  sha256: r.sha,
                  size: r.size,
                  contentType: r.file.type,
                  hold,
                  previous: r.file.versionId,
                }),
              )
              cs.putPageNeeds(needs.needs, needs.narrowed)
              cs.indexPages(search)
              cs.indexNames(namesOf([dest]))
              cs.event({
                type: 'move',
                path: node.path,
                node: granted,
                detail: dest,
              })
              return {}
            }),
          ),
        )
      }).pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? release : Effect.void)),
      )
      // Shares on a folder reach what lies below it by path: what moved out
      // of one is no longer read through it.
      yield* deps.feed.invalidate({
        scope: { trees: [tree.id] },
        close: { all: true },
      })
      const moved = { ...node, path: dest }
      return {
        from: display(node.path),
        to: display(dest),
        link: linkOf(ws, tree.name, moved),
        seq: committed.seq,
        rewritten: rewrites.map((r) => newOf(r.file.node.path)).sort(),
        revokedTeamShares: [],
      } satisfies MoveResult
    })

  // ---------------------------------------------------------------- moveTree

  const moveTree = (i: {
    readonly tree: LinkRef
    readonly to: { readonly workspace: string; readonly tree: string }
  }) =>
    retrying(
      Effect.gen(function* () {
        const located = yield* store.locate({
          ...i.tree,
          path: '',
          folder: true,
        })
        if ('missing' in located) return yield* denied(located)
        const { node: root, tree } = located
        const granted = yield* access.require('write', root)
        if (!isTreeName(i.to.tree)) {
          return yield* invalid(
            `"${i.to.tree}" is not a tree name.`,
            'Use lowercase letters, digits and hyphens.',
          )
        }
        const target = yield* store.workspace(i.to.workspace)
        const membership = yield* access.member(target)
        const sameWorkspace = membership.workspace.id === tree.workspaceId
        if (sameWorkspace && i.to.tree === tree.name) {
          return yield* invalid(
            `${i.tree.workspace}/${tree.name} is already there.`,
          )
        }
        if ((yield* store.tree(membership.workspace, i.to.tree)) !== null) {
          return yield* Effect.fail(
            dossierError(
              'conflict',
              `${i.to.workspace} already has a tree named ${i.to.tree}.`,
              'Choose another name.',
            ),
          )
        }
        // Teams belong to their workspace: their shares stay behind.
        const teamShares = sameWorkspace
          ? []
          : (yield* query(() =>
              DB.prepare(
                `select s.id as shareId, t.name as team from shares s
                   join teams t on t.id = s.target
                 where s.tree_id = ? and s.target_kind = 'team'`,
              )
                .bind(tree.id)
                .all<{ shareId: ShareId; team: string }>(),
            )).results
        const revokes: { granted: Granted<'share'>; shareId: ShareId }[] = []
        for (const share of teamShares) {
          const node = yield* query(() =>
            DB.prepare(
              'select n.* from shares s join nodes n on n.id = s.node_id where s.id = ?',
            )
              .bind(share.shareId)
              .first<Record<string, unknown>>(),
          )
          if (node === null) continue
          revokes.push({
            granted: yield* access.require('share', nodeOfRaw(node)),
            shareId: share.shareId,
          })
        }
        const committed = yield* committing(
          store.change(tree.id, (cs) =>
            Effect.sync(() => {
              cs.moveTree(granted, membership, i.to.tree, {
                workspaceId: tree.workspaceId,
                name: tree.name,
              })
              for (const r of revokes) cs.revoke(r.granted, r.shareId)
              if (revokes.length > 0) cs.event({ type: 'share', path: '' })
              cs.event({
                type: 'move',
                path: '',
                node: granted,
                detail: `${i.to.workspace}/${i.to.tree}`,
              })
              return {}
            }),
          ),
        )
        // The source's admins and members lose what the tree gave them.
        yield* deps.feed.invalidate({
          scope: { trees: [tree.id] },
          close: { all: true },
        })
        return {
          from: `${i.tree.workspace}/${tree.name}`,
          to: `${i.to.workspace}/${i.to.tree}`,
          link: linkOf(i.to.workspace, i.to.tree, root),
          seq: committed.seq,
          rewritten: [],
          revokedTeamShares: [...new Set(teamShares.map((s) => s.team))].sort(),
        } satisfies MoveResult
      }),
    )

  return { rm, restore, mv, moveTree } as {
    readonly rm: (i: {
      readonly ref: LinkRef
    }) => Effect.Effect<ChangeResult, Failure, CurrentCaller | Background>
    readonly restore: (i: {
      readonly ref: LinkRef
      readonly to: RestorePoint
    }) => Effect.Effect<ChangeResult, Failure, CurrentCaller | Background>
    readonly mv: (i: {
      readonly from: LinkRef
      readonly to: LinkRef
    }) => Effect.Effect<MoveResult, Failure, CurrentCaller | Background>
    readonly moveTree: (i: {
      readonly tree: LinkRef
      readonly to: { readonly workspace: string; readonly tree: string }
    }) => Effect.Effect<MoveResult, Failure, CurrentCaller | Background>
  }
}

const parseJson = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

type Background = import('./background.ts').Background
