// What a tree's history shows its write holders: the log of a folder or a
// file, a push opened, and a file's two versions with their patch. Internal to
// Files, which checks what the caller may do before any of this runs.
import {
  dossierError,
  type EventSeq,
  type LogLine,
  type PushFile,
  type PushNumber,
  type TreeId,
} from '@dossier/contracts'
import { createTwoFilesPatch, diffLines } from 'diff'
import { Clock, Effect } from 'effect'

import type { Caller } from './caller.ts'
import type { NodeRow, PushRow, TreeRow, VersionRow } from './rows.ts'
import { getBlob } from './blob-keys.ts'

/** 50 lines a page of history. */
export const LOG_PAGE = 50
const MiB = 1024 * 1024
/** A file is shown as text up to this size. */
export const TEXT_BYTES = MiB
/** A push's detail counts the lines of this many text files. */
const COUNTED_FILES = 100
/** Text by its name, whatever type it was pushed with. */
const TEXT_NAME =
  /\.(html?|md|markdown|csv|tsv|txt|svg|js|mjs|cjs|ts|css|json|xml|ya?ml|toml|ini)$/i
const DAY = 86_400_000

const LOGGED = `('push', 'delete', 'restore', 'move', 'withdrawal')`

/**
 * Where the node `x` stood when its version `v` was written: a push's files
 * are counted where they were then, never where a later move took them.
 */
const PATH_THEN = `coalesce((select pa.old_path from path_aliases pa
    where pa.node_id = x.id and pa.moved_at_seq > v.authored_seq
    order by pa.moved_at_seq limit 1), x.path)`

/**
 * A version `v` the push `v.push_id` wrote itself, at its own sequence: a
 * restore or a move's rewrite keeps the push of the content it copies, at a
 * later sequence.
 */
const OWN_SEQ = `v.authored_seq = coalesce((select pp.authored_seq from pushes pp
    where pp.id = v.push_id), (select min(v3.authored_seq) from node_versions v3
    where v3.push_id = v.push_id))`

/** Event types written by people's data, which always name the writer. */
const DATA_EVENTS = new Set(['submission', 'entry', 'withdrawal', 'data_write'])

/** Whether a version's content is shown as text, by its type or its name. */
export const isText = (name: string, version: VersionRow | null): boolean => {
  if (version === null || version.state !== 'live') return true
  if ((version.size ?? 0) > TEXT_BYTES) return false
  if (version.jsonValue !== null) return true
  const type = (version.contentType ?? '').split(';')[0]?.trim() ?? ''
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/javascript' ||
    type === 'image/svg+xml' ||
    type.endsWith('+xml') ||
    TEXT_NAME.test(name)
  )
}

/** SQL that holds when `column` is the path `?N` or lies below it. */
const underParam = (column: string, n: number) =>
  `(?${n} = '' or ${column} = ?${n} or substr(${column}, 1, length(?${n}) + 1) = ?${n} || '/')`

export interface HistoryDeps {
  readonly DB: D1Database
  readonly BLOBS: R2Bucket
}

const unavailable = (error: unknown) => {
  console.error('A history read failed', error)
  return dossierError('unavailable')
}

export const makeHistory = (deps: HistoryDeps) => {
  const { DB, BLOBS } = deps
  const query = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: unavailable })

  /** A version's content as text, or null when it is not text. */
  const textOf = (name: string, version: VersionRow | null) =>
    Effect.gen(function* () {
      if (version === null || version.state !== 'live') return ''
      if (!isText(name, version)) return null
      if (version.jsonValue !== null) {
        try {
          return `${JSON.stringify(JSON.parse(version.jsonValue), null, 2)}\n`
        } catch {
          return version.jsonValue
        }
      }
      const sha = version.blobSha256
      if (sha === null) return ''
      const object = yield* query(() => getBlob({ DB, BLOBS }, sha))
      if (object === null) return null
      const bytes = yield* query(() => object.arrayBuffer())
      if (bytes.byteLength > TEXT_BYTES) return null
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return null
      }
    })

  /** Whether the caller sees authors by email in this tree's workspace. */
  const isMember = (caller: Caller, tree: TreeRow) =>
    Effect.map(
      query(() =>
        DB.prepare(
          `select 1 as one from workspace_members
           where workspace_id = ? and user_id = ?`,
        )
          .bind(tree.workspaceId, caller.person?.id ?? '')
          .first(),
      ),
      (row) => row !== null,
    )

  /** By email to members and to the person themselves, by name otherwise. */
  const byOf = (
    caller: Caller,
    member: boolean,
    actor: { id: string | null; email: string | null; name: string | null },
    data = false,
  ): string | null =>
    actor.id === null
      ? null
      : data || member || caller.person?.id === actor.id
        ? actor.email
        : actor.name

  /**
   * The log at or below a folder, or of a file, newest first: events whose
   * path lies there, whose node lies there now, and pushes that changed a
   * file there. `node` is the folder or file asked about.
   */
  const log = (i: {
    readonly caller: Caller
    readonly tree: TreeRow
    readonly node: NodeRow
    readonly cursor: string | null
    readonly retentionDays: number
  }) =>
    Effect.gen(function* () {
      const before =
        i.cursor === null
          ? null
          : /^\d+$/.test(i.cursor)
            ? Number(i.cursor)
            : null
      if (i.cursor !== null && before === null) {
        return yield* Effect.fail(
          dossierError(
            'invalid',
            'This cursor is not one the history gave you.',
            'Start again without a cursor.',
          ),
        )
      }
      const now = yield* Clock.currentTimeMillis
      const cutoff = now - i.retentionDays * DAY
      const folder = i.node.kind === 'folder'
      // ?1 tree · ?2 the path asked about · ?3 the node · ?4 before · ?5 cutoff
      const inside = folder
        ? `(${underParam('e.path', 2)}
            or exists (select 1 from nodes x where x.id = e.node_id
              and ${underParam('x.path', 2)}))`
        : `(e.path = ?2 or e.node_id = ?3)`
      const changedHere = folder
        ? `(select count(*) from node_versions v join nodes x on x.id = v.node_id
             where v.push_id = e.push_id and ${OWN_SEQ}
               and ${underParam(PATH_THEN, 2)})`
        : `(select count(*) from node_versions v where v.push_id = e.push_id
             and ${OWN_SEQ} and v.node_id = ?3)`
      const rows = yield* query(() =>
        DB.prepare(
          `select e.seq, e.type, e.path, e.node_id as nodeId, e.created_at as at,
             e.actor_id as actorId, e.detail, u.email, u.name,
             p.number, p.message, p.path as pushPath, ${changedHere} as files,
             (n.id is not null and n.deleted_at is not null and n.deleted_at > ?5
               and (n.kind = 'folder' or (select v.state from node_versions v
                      where v.id = n.current_version_id) = 'deleted')) as restorable,
             case when e.type = 'delete' then (select lp.number || ' ' || coalesce(lp.message, '')
               from nodes x join node_versions lv on lv.id = (select l2.id from node_versions l2
                   where l2.node_id = x.id and l2.state = 'live' and l2.created_at <= e.created_at
                   order by l2.revision desc limit 1)
                 join pushes lp on lp.id = lv.push_id
               where x.tree_id = e.tree_id
                 and (e.path = '' or x.path = e.path or substr(x.path, 1, length(e.path) + 1) = e.path || '/')
               order by lp.number desc limit 1) end as deletedFrom,
             case when e.type = 'delete' then (select count(*) from node_versions dv
               join nodes x on x.id = dv.node_id
               where dv.tree_id = e.tree_id and dv.state = 'deleted'
                 and dv.created_at = e.created_at and (e.path = '' or x.path = e.path or substr(x.path, 1, length(e.path) + 1) = e.path || '/')) end as deletedFiles
           from events e
             left join "user" u on u.id = e.actor_id
             left join pushes p on p.id = e.push_id
             left join nodes n on n.id = e.node_id
           where e.tree_id = ?1 and e.type in ${LOGGED}
             and (?4 is null or e.seq < ?4)
             and (case when e.type = 'push'
               then (${changedHere} > 0 or ${folder ? underParam('p.path', 2) : '0'})
               else ${inside} end)
           order by e.seq desc
           limit ${LOG_PAGE + 1}`,
        )
          .bind(i.tree.id, i.node.path, i.node.id, before, cutoff)
          .all<{
            seq: number
            type: LogLine['kind']
            path: string
            nodeId: string | null
            at: number
            actorId: string | null
            detail: string | null
            email: string | null
            name: string | null
            number: number | null
            message: string | null
            pushPath: string | null
            files: number
            restorable: number
            deletedFrom: string | null
            deletedFiles: number | null
          }>(),
      )
      const member = yield* isMember(i.caller, i.tree)
      const page = rows.results.slice(0, LOG_PAGE)
      const lines = page.map((row): LogLine => ({
        kind: row.type,
        seq: row.seq as EventSeq,
        at: new Date(row.at).toISOString(),
        by: byOf(
          i.caller,
          member,
          { id: row.actorId, email: row.email, name: row.name },
          DATA_EVENTS.has(row.type),
        ),
        path: row.path,
        push:
          row.type === 'push' && row.number !== null
            ? {
                number: row.number as PushNumber,
                message: row.message,
                files: row.files,
              }
            : // A deletion names the push its content came from.
              row.type === 'delete' && row.deletedFrom !== null
              ? {
                  number: Number.parseInt(row.deletedFrom, 10) as PushNumber,
                  message:
                    row.deletedFrom.slice(row.deletedFrom.indexOf(' ') + 1) ||
                    null,
                  files: row.deletedFiles ?? 0,
                }
              : null,
        to: row.type === 'move' || row.type === 'restore' ? row.detail : null,
        restorable: row.type === 'delete' && row.restorable === 1,
      }))
      const more = rows.results.length > LOG_PAGE
      return {
        lines,
        /** Each line's node, when it names one: for what a line may show. */
        nodes: page.map((row) => row.nodeId),
        next: more ? String(page.at(-1)?.seq ?? '') : null,
      }
    })

  /** A committed push of the tree by its number, or null. */
  const pushOf = (treeId: TreeId, number: number) =>
    Effect.map(
      query(() =>
        DB.prepare(
          `select * from pushes where tree_id = ? and number = ?
             and state = 'committed'`,
        )
          .bind(treeId, number)
          .first<Record<string, unknown>>(),
      ),
      (row): PushRow | null =>
        row === null
          ? null
          : ({
              id: row.id,
              workspaceId: row.workspace_id,
              treeName: row.tree_name,
              treeId: row.tree_id,
              path: row.path,
              baseSeq: row.base_seq,
              number: row.number,
              authoredSeq: row.authored_seq,
              message: row.message,
              force: row.force === 1,
              authorId: row.author_id,
              keyId: row.key_id,
              state: row.state,
              fileCount: row.file_count,
              byteCount: row.byte_count,
              createdAt: row.created_at,
              expiresAt: row.expires_at,
              committedAt: row.committed_at,
              sharesJson: row.shares_json,
            } as PushRow),
    )

  /**
   * The authored sequence a push took effect at: recorded at commit, or for
   * an older push the sequence of the versions it wrote.
   */
  const seqOfPush = (push: PushRow) =>
    push.authoredSeq !== null
      ? Effect.succeed(push.authoredSeq)
      : Effect.map(
          query(() =>
            DB.prepare(
              'select min(authored_seq) as seq from node_versions where push_id = ?',
            )
              .bind(push.id)
              .first<{ seq: number | null }>(),
          ),
          (row) => row?.seq ?? 0,
        )

  /** The version before this one of its node, by revision. */
  const previousOf = (version: VersionRow, live = false) =>
    Effect.map(
      query(() =>
        DB.prepare(
          `select * from node_versions where node_id = ? and revision < ?
             ${live ? "and state = 'live'" : ''}
           order by revision desc limit 1`,
        )
          .bind(version.nodeId, version.revision)
          .first<Record<string, unknown>>(),
      ),
      (row) => (row === null ? null : versionOfRaw(row)),
    )

  const counts = (before: string, after: string) => {
    let added = 0
    let removed = 0
    for (const part of diffLines(before, after)) {
      if (part.added) added += part.count ?? 0
      else if (part.removed) removed += part.count ?? 0
    }
    return { added, removed }
  }

  const lineCount = (text: string) =>
    text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

  /** The files a push changed at or below a folder, or the one file. */
  const pushDetail = (i: {
    readonly caller: Caller
    readonly tree: TreeRow
    readonly node: NodeRow
    readonly push: PushRow
  }) =>
    Effect.gen(function* () {
      const folder = i.node.kind === 'folder'
      const rows = yield* query(() =>
        DB.prepare(
          `select * from (select v.*, ${PATH_THEN} as nodePath, x.name as nodeName
             from node_versions v join nodes x on x.id = v.node_id
             where v.push_id = ?1 and ${OWN_SEQ}
               and ${folder ? underParam(PATH_THEN, 2) : 'x.id = ?3'})
           order by nodePath`,
        )
          .bind(
            ...(folder ? [i.push.id, i.node.path] : [i.push.id, '', i.node.id]),
          )
          .all<Record<string, unknown>>(),
      )
      const files: PushFile[] = []
      let counted = 0
      for (const row of rows.results) {
        const version = versionOfRaw(row)
        const path = row.nodePath as string
        const name = row.nodeName as string
        const previous = yield* previousOf(version)
        const change: PushFile['change'] =
          version.state !== 'live'
            ? 'deleted'
            : previous === null || previous.state !== 'live'
              ? 'added'
              : 'changed'
        const shown = change === 'deleted' ? previous : version
        const text =
          isText(name, shown) &&
          (change !== 'changed' || isText(name, previous))
        if (!text || counted >= COUNTED_FILES) {
          files.push({
            path,
            change,
            text,
            added: null,
            removed: null,
            lines: null,
          })
          continue
        }
        counted += 1
        const after = yield* textOf(name, change === 'deleted' ? null : version)
        const before = yield* textOf(name, change === 'added' ? null : previous)
        if (after === null || before === null) {
          files.push({
            path,
            change,
            text: false,
            added: null,
            removed: null,
            lines: null,
          })
          continue
        }
        const { added, removed } = counts(before, after)
        files.push({
          path,
          change,
          text: true,
          added,
          removed,
          lines: lineCount(change === 'deleted' ? before : after),
        })
      }
      const author = yield* query(() =>
        DB.prepare('select id, email, name from "user" where id = ?')
          .bind(i.push.authorId)
          .first<{ id: string; email: string; name: string }>(),
      )
      const member = yield* isMember(i.caller, i.tree)
      return {
        push: i.push,
        by:
          byOf(i.caller, member, {
            id: author?.id ?? null,
            email: author?.email ?? null,
            name: author?.name ?? null,
          }) ?? '',
        files,
      }
    })

  /** The newest push that changed something at or below a folder, then. */
  const latestPushUnder = (node: NodeRow) =>
    Effect.map(
      query(() =>
        DB.prepare(
          `select p.number from pushes p where p.tree_id = ?1 and p.state = 'committed'
             and exists (select 1 from node_versions v join nodes x on x.id = v.node_id
               where v.push_id = p.id and ${OWN_SEQ} and ${underParam(PATH_THEN, 2)})
           order by p.number desc limit 1`,
        )
          .bind(node.treeId, node.path)
          .first<{ number: number }>(),
      ),
      (row) => (row === null ? null : (row.number as PushNumber)),
    )

  /** The newest version of a node at or before an authored sequence. */
  const versionAtSeq = (nodeId: string, seq: number) =>
    Effect.map(
      query(() =>
        DB.prepare(
          `select * from node_versions where node_id = ? and authored_seq <= ?
           order by authored_seq desc, revision desc limit 1`,
        )
          .bind(nodeId, seq)
          .first<Record<string, unknown>>(),
      ),
      (row) => (row === null ? null : versionOfRaw(row)),
    )

  /** The newest version of a node created at or before a time. */
  const versionAtTime = (nodeId: string, at: number) =>
    Effect.map(
      query(() =>
        DB.prepare(
          `select * from node_versions where node_id = ? and created_at <= ?
           order by revision desc limit 1`,
        )
          .bind(nodeId, at)
          .first<Record<string, unknown>>(),
      ),
      (row) => (row === null ? null : versionOfRaw(row)),
    )

  /** "push 11", "deleted", or the version's number when no push wrote it. */
  const labelOf = (version: VersionRow | null) =>
    Effect.gen(function* () {
      if (version === null) return null
      if (version.state !== 'live') return 'deleted'
      if (version.pushId === null) return `version ${version.revision}`
      const row = yield* query(() =>
        DB.prepare('select number from pushes where id = ?')
          .bind(version.pushId)
          .first<{ number: number | null }>(),
      )
      return row?.number === null || row === null
        ? `version ${version.revision}`
        : `push ${row.number}`
    })

  /** A unified patch of two texts, as `git diff` heads it. */
  const patchOf = (path: string, before: string, after: string) =>
    createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after).replace(
      /^=+\n/,
      '',
    )

  /** One file's two versions, their texts and their patch. */
  const fileDiff = (i: {
    readonly node: NodeRow
    readonly from: VersionRow | null
    readonly to: VersionRow | null
  }) =>
    Effect.gen(function* () {
      const from = yield* labelOf(i.from)
      const to = yield* labelOf(i.to)
      const name = i.node.name
      const both = isText(name, i.from) && isText(name, i.to)
      const before = both ? yield* textOf(name, i.from) : null
      const after = both ? yield* textOf(name, i.to) : null
      if (before === null || after === null) {
        return {
          path: i.node.path,
          from,
          to,
          binary: true,
          before: null,
          after: null,
          patch: null,
        }
      }
      return {
        path: i.node.path,
        from,
        to,
        binary: false,
        before: i.from === null || i.from.state !== 'live' ? null : before,
        after: i.to === null || i.to.state !== 'live' ? null : after,
        patch: before === after ? '' : patchOf(i.node.path, before, after),
      }
    })

  /**
   * Every file at or below a folder whose version differs between two
   * sequences (`to` null: now), as one patch of the text files among them.
   */
  const folderDiff = (i: {
    readonly node: NodeRow
    readonly from: number
    readonly to: number | null
  }) =>
    Effect.gen(function* () {
      const rows = yield* query(() =>
        DB.prepare(
          `select n.* from nodes n where n.tree_id = ?1 and n.kind = 'file'
             and n.origin = 'authored' and ${underParam('n.path', 2)}
             and exists (select 1 from node_versions v where v.node_id = n.id
               and v.authored_seq > ?3 and (?4 is null or v.authored_seq <= ?4))
           order by n.path`,
        )
          // Either way round: the files changed between the two.
          .bind(
            i.node.treeId,
            i.node.path,
            i.to === null ? i.from : Math.min(i.from, i.to),
            i.to === null ? null : Math.max(i.from, i.to),
          )
          .all<Record<string, unknown>>(),
      )
      const parts: string[] = []
      let shown = 0
      let left = 0
      for (const [index, row] of rows.results.entries()) {
        const node = nodeOfRow(row)
        const before = yield* versionAtSeq(node.id, i.from)
        const after =
          i.to === null
            ? yield* current(node)
            : yield* versionAtSeq(node.id, i.to)
        const live = (v: VersionRow | null) =>
          v !== null && v.state === 'live' ? v : null
        if (
          live(before)?.id === live(after)?.id ||
          (live(before)?.blobSha256 ?? null) ===
            (live(after)?.blobSha256 ?? null)
        ) {
          continue
        }
        if (shown >= COUNTED_FILES) {
          left = rows.results.length - index
          break
        }
        shown += 1
        const diff = yield* fileDiff({
          node,
          from: live(before),
          to: live(after),
        })
        parts.push(
          diff.binary
            ? `Binary file ${node.path} changed\n`
            : (diff.patch ?? ''),
        )
      }
      if (left > 0) {
        parts.push(
          `${left} more changed ${left === 1 ? 'file is' : 'files are'} not shown; diff them one at a time.\n`,
        )
      }
      return parts.join('')
    })

  const current = (node: NodeRow) =>
    node.currentVersionId === null
      ? Effect.succeed(null)
      : Effect.map(
          query(() =>
            DB.prepare('select * from node_versions where id = ?')
              .bind(node.currentVersionId)
              .first<Record<string, unknown>>(),
          ),
          (row) => (row === null ? null : versionOfRaw(row)),
        )

  return {
    log,
    pushOf,
    seqOfPush,
    latestPushUnder,
    pushDetail,
    versionAtSeq,
    versionAtTime,
    fileDiff,
    folderDiff,
    current,
    previousOf,
  }
}

/** A node_versions row read with plain SQL, as Drizzle would give it. */
export const versionOfRaw = (row: Record<string, unknown>): VersionRow =>
  ({
    id: row.id,
    nodeId: row.node_id,
    treeId: row.tree_id,
    revision: row.revision,
    authoredSeq: row.authored_seq,
    state: row.state,
    blobSha256: row.blob_sha256,
    jsonValue: row.json_value,
    size: row.size,
    contentType: row.content_type,
    authorId: row.author_id,
    keyId: row.key_id,
    pushId: row.push_id,
    seenPushNumber: row.seen_push_number,
    opId: row.op_id,
    createdAt: row.created_at,
  }) as VersionRow

/** A nodes row read with plain SQL. */
const nodeOfRow = (row: Record<string, unknown>): NodeRow =>
  ({
    id: row.id,
    treeId: row.tree_id,
    parentId: row.parent_id,
    name: row.name,
    path: row.path,
    depth: row.depth,
    kind: row.kind,
    origin: row.origin,
    ownerId: row.owner_id,
    currentVersionId: row.current_version_id,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    underscoreFrom: row.underscore_from ?? null,
  }) as NodeRow
