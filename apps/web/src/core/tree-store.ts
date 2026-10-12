import {
  dossierError,
  type AuthoredSeq,
  type DossierError,
  type EventSeq,
  type EventType,
  type LinkRef,
  type NodeId,
  type OpId,
  type PersonId,
  type PushId,
  type PushNumber,
  type Sha256,
  type ShareId,
  type TreeId,
  type VersionId,
} from '@dossier/contracts'
import type { JsonObject } from '@dossier/contracts/bridge'
import {
  MARKDOWN_VERSION,
  toMarkdown,
  type FormSchema,
  type HtmlAnalysis,
} from '@dossier/html'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { Clock, Context, Effect, Layer } from 'effect'

import { db, schema } from '../db/client.ts'
import {
  Access,
  type Basis,
  type Granted,
  type Membership,
  type Role,
} from './access.ts'
import type { BaseLayer } from './base-layer.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller, type Caller } from './caller.ts'
import { newId, newTreeId } from './ids.ts'
import { Limits } from './limits.ts'
import {
  analysisOf,
  lookupUnderscore,
  underscoreSplit,
  type KitFound,
} from './lookup.ts'
import type {
  MissingNode,
  NodeRow,
  TreeRow,
  VersionRow,
  WorkspaceRow,
} from './rows.ts'

/** A node a path names, as a CLI argument or a push names it. */
export type Located =
  | {
      readonly kind: 'file'
      readonly node: NodeRow
      readonly version: VersionRow
      readonly tree: TreeRow
    }
  | { readonly kind: 'folder'; readonly node: NodeRow; readonly tree: TreeRow }

/** A path inside a tree known by its ID, as a frame on its host names it. */
export interface TreeRef {
  readonly treeId: TreeId
  /** Inside the tree, without a leading or trailing slash. */
  readonly path: string
  /** A trailing slash, or the root. */
  readonly folder: boolean
}

/** What a link names. */
export type Resolved =
  | {
      readonly kind: 'page'
      readonly node: NodeRow
      readonly version: VersionRow
      readonly tree: TreeRow
      /** The link's path inside the tree, encoded: 'questions/', 'plan'. */
      readonly linkPath: string
    }
  | {
      readonly kind: 'file'
      readonly node: NodeRow
      readonly version: VersionRow
      readonly tree: TreeRow
    }
  /** A folder without index.html. */
  | { readonly kind: 'folder'; readonly node: NodeRow; readonly tree: TreeRow }
  | {
      readonly kind: 'redirect'
      readonly node: NodeRow
      readonly tree: TreeRow
      /** The link's path inside the tree, encoded. */
      readonly to: string
    }
  /**
   * A `_` path: every candidate the lookup reaches, closest first. The
   * caller takes the first it may read.
   */
  | {
      readonly kind: 'kit'
      readonly tree: TreeRow
      /** Where the path's `_` part starts; it need not exist. */
      readonly folder: string
      readonly found: readonly KitFound[]
    }

export interface FileBody {
  readonly version: VersionRow
  readonly body: ReadableStream<Uint8Array> | string
  readonly size: number
  readonly etag: string
}

export interface Entry {
  readonly name: string
  /** Inside the tree. */
  readonly path: string
  /** A folder holding index.html is a 'page'. */
  readonly kind: 'page' | 'folder' | 'attachment' | 'kit' | 'data'
  readonly node: NodeRow
  readonly size: number | null
  readonly sha256: Sha256 | null
  readonly contentType: string | null
  /** <title> from the analysis, or null. */
  readonly title: string | null
  readonly push: { readonly number: PushNumber; readonly at: number } | null
  /** Folders: pages below, for listings. */
  readonly pages: number | null
}

/** A file as a read names it: who wrote it, when, and the push behind it. */
export interface DocRow {
  readonly node: NodeRow
  readonly version: VersionRow
  /**
   * A data file's writer by email. An authored file's pusher by email to
   * members of the tree's workspace and to the pusher, by name to anyone else.
   */
  readonly by: string
  /** Data: the push the writer saw. Authored: the push that wrote it. */
  readonly push: PushNumber
  /** The parsed value of a JSON data version, else null. */
  readonly value: unknown | null
}

declare const handle: unique symbol
/** A node created in this change, named before it has a row. */
export type NodeHandle = { readonly [handle]: 'NodeHandle' }

export interface NewEvent {
  readonly type: EventType
  readonly path: string
  readonly node?: NodeRow | NodeHandle
  readonly pushId?: PushId
}

export interface NewShare {
  readonly targetKind: 'email' | 'team' | 'workspace' | 'anyone'
  readonly target: string
  readonly role: Role
}

/** Who holds a blob until its change commits. */
export type HoldKind = 'push' | 'upload' | 'restore' | 'move'

declare const versionHandle: unique symbol
/** A version written in this change, named before it has a row. */
export type VersionHandle = { readonly [versionHandle]: 'VersionHandle' }

/** A data folder or file a change creates; folders on the way come with it. */
export interface NewDataNode {
  /** Inside the tree. */
  readonly path: string
  readonly kind: 'file' | 'folder'
  /** The writer it belongs to; null for a shared file nobody owns. */
  readonly owner: PersonId | null
}

/** What every data version records beside its content. */
export interface DataProvenance {
  /** The push of the page the writer saw. */
  readonly seenPush: PushNumber
  readonly opId: OpId
}

export type NewDataVersion = DataProvenance &
  (
    | { readonly json: JsonObject }
    | {
        readonly blob: {
          readonly sha256: Sha256
          readonly size: number
          readonly contentType: string
          /** The upload's verified hold, which the change releases. */
          readonly hold: { readonly kind: 'upload'; readonly id: string }
        }
      }
  )

export interface NewOperation {
  /** The person's id. */
  readonly principal: string
  /** '<tree id>:<target folder or file path>'. */
  readonly scope: string
  readonly opId: OpId
  readonly result: VersionHandle | 'withdrawn'
}

/** A form's rules as a push stored them, by the version that holds it. */
export interface FormRow {
  readonly hostVersionId: VersionId
  readonly hostNodeId: NodeId
  readonly treeId: TreeId
  readonly targetPath: string
  readonly formKey: string
  readonly kind: 'person' | 'entries' | 'shared'
  readonly closesAt: number | null
  readonly closed: boolean
  readonly line: number
  readonly title: string | null
  readonly schema: FormSchema
}

export type OperationResult =
  | { readonly state: 'stored'; readonly version: VersionRow }
  | { readonly state: 'withdrawn' }

/** The steps of one change; nothing runs until the change commits. */
export interface ChangeSet {
  /** Fails the change if an authored file under `path` changed after `base`. */
  readonly guardHead: (path: string, base: AuthoredSeq) => void
  /** The new tree's root; the creator's write share is added with it. */
  readonly createTree: (member: Membership, name: string) => NodeHandle
  /** Makes the pushed folder's authored files match the staged manifest. */
  readonly putStaged: (
    target: Granted<'write'> | NodeHandle,
    pushId: PushId,
  ) => void
  readonly grant: (on: Granted<'share'> | NodeHandle, share: NewShare) => void
  readonly revoke: (on: Granted<'share'>, shareId: ShareId) => void
  /**
   * A data folder or file at `node.path`; folders missing on the way are
   * created as data folders nobody owns. `under` is what the writer holds.
   */
  readonly createData: (
    under: Granted<'respond' | 'write'>,
    node: NewDataNode,
  ) => NodeHandle
  /** A new version of a data file: a JSON value or an upload's bytes. */
  readonly putData: (
    node: NodeHandle | Granted<'respond' | 'write'>,
    version: NewDataVersion,
  ) => VersionHandle
  /** Merges a JSON object into the file's value as RFC 7396 says. */
  readonly mergeJson: (
    node: NodeHandle | Granted<'respond' | 'write'>,
    patch: JsonObject,
    provenance: DataProvenance,
  ) => VersionHandle
  /**
   * 'withdrawn': every version's content deleted, one content-free
   * 'withdrawn' version left, the node deleted, its operations reduced to
   * 'withdrawn', and its blobs' references counted down.
   */
  readonly markDeleted: (
    node: Granted<'withdraw-own'>,
    mode: 'withdrawn',
  ) => void
  /** Records a data write's result under its operation ID. */
  readonly operation: (op: NewOperation) => void
  /** The forms the push staged, for the versions it leaves current. */
  readonly putForms: (pushId: PushId) => void
  /** Required: a change with no event never commits. */
  readonly event: (e: NewEvent) => void
}

export type ChangeFailure = DossierError<
  | 'stale_head'
  | 'conflict'
  | 'blob_reclaiming'
  | 'not_mergeable'
  | 'too_large'
  | 'unavailable'
>

export interface TreeStoreService {
  readonly workspace: (name: string) => Effect.Effect<WorkspaceRow | null>
  readonly tree: (
    workspace: WorkspaceRow,
    name: string,
  ) => Effect.Effect<TreeRow | null>
  /** The node a path names: a folder, a file, or the page `path.html`. */
  readonly locate: (
    ref: LinkRef,
  ) => Effect.Effect<Located | MissingNode, DossierError<'unavailable'>>
  /**
   * What a link names, live or at an authored sequence: every file of one
   * page load then comes from the same push.
   */
  readonly resolve: (
    ref: LinkRef | TreeRef,
    at?: AuthoredSeq,
  ) => Effect.Effect<Resolved | MissingNode, DossierError<'unavailable'>>
  /** The live tree with this ID and its live workspace, or null. */
  readonly treeById: (
    treeId: TreeId,
  ) => Effect.Effect<
    { readonly tree: TreeRow; readonly workspace: WorkspaceRow } | null,
    DossierError<'unavailable'>
  >
  readonly list: (
    folder: Granted<'read'>,
    depth: 'one' | 'all',
  ) => Effect.Effect<readonly Entry[], never, CurrentCaller>
  readonly read: (
    file: Granted<'read'>,
  ) => Effect.Effect<FileBody, DossierError<'not_found'>>
  /** Rebuilt from the bytes when no analysis of this analyzer exists. */
  readonly analysis: (sha256: Sha256) => Effect.Effect<HtmlAnalysis | null>
  /**
   * A page's generated agent version, by its blob: stored for this converter
   * version, or generated from the page's bytes and stored.
   */
  readonly markdown: (
    sha256: Sha256,
  ) => Effect.Effect<string, DossierError<'unavailable'>>
  /** Every file below the folder the caller can read, at any depth, by path. */
  readonly docs: (
    folder: Granted<'read'>,
    opts: { readonly origin: 'data' | 'any' },
  ) => Effect.Effect<readonly DocRow[], never, CurrentCaller>
  /**
   * Holds a blob before its bytes are written, so a purge leaves it alone.
   * The hold counts for a commit only once `confirmHold` verifies it.
   */
  readonly holdBlob: (
    holder: { readonly kind: HoldKind; readonly id: string },
    sha256: Sha256,
    size: number,
  ) => Effect.Effect<void, DossierError<'blob_reclaiming'>>
  /** The bytes are in R2 and match their hash and size. */
  readonly confirmHold: (
    holder: { readonly kind: HoldKind; readonly id: string },
    sha256: Sha256,
    size: number,
  ) => Effect.Effect<void>
  /** Lets go of a hold whose bytes never arrived; a verified one stays. */
  readonly dropHold: (
    holder: { readonly kind: HoldKind; readonly id: string },
    sha256: Sha256,
  ) => Effect.Effect<void>
  /** Lets go of a hold whose change will not commit, verified or not. */
  readonly releaseHold: (
    holder: { readonly kind: HoldKind; readonly id: string },
    sha256: Sha256,
  ) => Effect.Effect<void>
  /**
   * A file's version: authored, as it stood at a sequence; without one, or
   * for a data file, live now.
   */
  readonly fileAt: (
    treeId: TreeId,
    path: string,
    at?: AuthoredSeq,
  ) => Effect.Effect<
    { readonly node: NodeRow; readonly version: VersionRow } | null,
    DossierError<'unavailable'>
  >
  /** The forms a page or layout version holds, or that send to a target. */
  readonly forms: (
    q:
      | { readonly hostVersionId: VersionId }
      | { readonly treeId: TreeId; readonly target: string },
  ) => Effect.Effect<readonly FormRow[], DossierError<'unavailable'>>
  /** What an operation ID stored, if anything. */
  readonly operationResult: (key: {
    readonly principal: string
    readonly scope: string
    readonly opId: OpId
  }) => Effect.Effect<OperationResult | null, DossierError<'unavailable'>>
  /** One D1 batch: the change and its events, or nothing. */
  readonly change: <A, E>(
    treeId: TreeId | null,
    plan: (cs: ChangeSet) => Effect.Effect<A, E>,
  ) => Effect.Effect<
    A & {
      readonly seq: EventSeq
      readonly authoredSeq: AuthoredSeq
      readonly treeId: TreeId
    },
    E | ChangeFailure,
    CurrentCaller
  >
}

export class TreeStore extends Context.Tag('TreeStore')<
  TreeStore,
  TreeStoreService
>() {}

/** The R2 key of a blob's bytes. */
export const blobKey = (sha256: string): string => `blobs/${sha256}`

/** The R2 key of a page's generated agent version, never a visible file. */
export const markdownKey = (sha256: string): string =>
  `derived/markdown/${MARKDOWN_VERSION}/${sha256}.md`

const unavailable = (error: unknown) => {
  console.error('A tree read failed', error)
  return dossierError('unavailable')
}

/**
 * SQL that holds when `column` is the path `prefix` or lies below it. The
 * prefix appears four times, so a bound prefix needs four binds.
 */
const under = (column: string, prefix: string): string =>
  `(${prefix} = '' or ${column} = ${prefix} or substr(${column}, 1, length(${prefix}) + 1) = ${prefix} || '/')`

const isKitPath = (path: string): boolean =>
  path.split('/').some((segment) => segment.startsWith('_'))

interface Statement {
  readonly sql: string
  readonly binds: readonly unknown[]
}

interface HandleValue {
  readonly handle: true
  readonly id: NodeId
}

const isHandle = (value: unknown): value is NodeHandle =>
  typeof value === 'object' &&
  value !== null &&
  (value as Partial<HandleValue>).handle === true

const handleId = (h: NodeHandle): NodeId => (h as unknown as HandleValue).id

const makeHandle = (id: NodeId): NodeHandle =>
  ({ handle: true, id }) satisfies HandleValue as unknown as NodeHandle

interface VersionValue {
  readonly version: true
  readonly id: VersionId
  readonly nodeId: NodeId
}

const makeVersionHandle = (id: VersionId, nodeId: NodeId): VersionHandle =>
  ({
    version: true,
    id,
    nodeId,
  }) satisfies VersionValue as unknown as VersionHandle

const versionOfHandle = (h: VersionHandle): VersionValue =>
  h as unknown as VersionValue

const parentPath = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

/** The caller's key or session is still what Access saw. */
const callerLive = (caller: Caller, now: number): Statement => {
  switch (caller.via.kind) {
    case 'agent':
      return {
        sql: `exists (select 1 from agent_keys where id = ? and revoked_at is null
                and read_only = ? and scope_node_id is ?)`,
        binds: [
          caller.via.keyId,
          caller.via.readOnly ? 1 : 0,
          caller.via.scope,
        ],
      }
    case 'browser':
      return {
        sql: 'exists (select 1 from "session" where id = ? and expires_at > ?)',
        binds: [caller.via.sessionId, now],
      }
    default:
      return { sql: '0', binds: [] }
  }
}

const basisHolds = (basis: Basis, personId: string): Statement => {
  switch (basis.kind) {
    case 'share': {
      const extra =
        basis.targetKind === 'email'
          ? ' and s.target = (select lower(email) from "user" where id = ?)'
          : basis.targetKind === 'workspace'
            ? ' and exists (select 1 from workspace_members m where m.workspace_id = s.target and m.user_id = ?)'
            : ''
      return {
        sql: `exists (select 1 from shares s where s.id = ? and s.role = ?${extra})`,
        binds: [basis.shareId, basis.role, ...(extra === '' ? [] : [personId])],
      }
    }
    case 'admin':
      return {
        sql: `exists (select 1 from workspace_members where workspace_id = ?
                and user_id = ? and role = 'admin')`,
        binds: [basis.workspaceId, basis.userId],
      }
    case 'member':
      return {
        sql: `exists (select 1 from workspace_members m join workspaces w on w.id = m.workspace_id
                where m.workspace_id = ? and m.user_id = ? and w.deleted_at is null)`,
        binds: [basis.workspaceId, basis.userId],
      }
    // Reach gives read only, which no change rests on.
    case 'reach':
      return { sql: '0', binds: [] }
    case 'owner':
      return {
        sql: `exists (select 1 from nodes where id = ? and owner_id = ?
                and deleted_at is null)`,
        binds: [basis.nodeId, basis.userId],
      }
  }
}

/** Every basis that gave an action still holds, with its role. */
const everyBasis = (bases: readonly Basis[], personId: string): Statement => {
  if (bases.length === 0) return { sql: '0', binds: [] }
  const parts = bases.map((b) => basisHolds(b, personId))
  return {
    sql: parts.map((p) => `(${p.sql})`).join(' and '),
    binds: parts.flatMap((p) => p.binds),
  }
}

/** Only a person's browser or a key that reaches everything and writes. */
const createsTrees = (caller: Caller): Statement =>
  caller.via.kind === 'agent'
    ? {
        sql: `exists (select 1 from agent_keys where id = ? and revoked_at is null
                and scope_node_id is null and read_only = 0)`,
        binds: [caller.via.keyId],
      }
    : { sql: caller.via.kind === 'browser' ? '1' : '0', binds: [] }

const allOf = (parts: readonly Statement[]): Statement =>
  parts.length === 0
    ? { sql: '1', binds: [] }
    : {
        sql: parts.map((p) => `(${p.sql})`).join(' and '),
        binds: parts.flatMap((p) => p.binds),
      }

/** A guard row; its CHECK constraint fails the batch when `ok` is not 1. */
const guardRow = (
  guardId: string,
  reason: 'head' | 'basis' | 'blob' | 'state' | 'mergeable' | 'size',
  condition: Statement,
): Statement => ({
  sql: `insert into change_guards (id, reason, ok)
        select ?, '${reason}', coalesce((${condition.sql}), 0)`,
  binds: [guardId, ...condition.binds],
})

/** What a failed batch means for the person who asked. */
const failureOf = (error: unknown): ChangeFailure => {
  const text = String(error instanceof Error ? error.message : error)
  if (text.includes('change_guard_head')) {
    return dossierError(
      'stale_head',
      'Someone pushed to this path while this change was being made.',
      'Pull the path, then push again, or push with --force.',
    )
  }
  if (text.includes('change_guard_mergeable')) {
    return dossierError(
      'not_mergeable',
      'This file does not hold a JSON object, so values cannot be merged into it.',
      'Replace the whole file instead.',
    )
  }
  if (text.includes('change_guard_size')) {
    return dossierError(
      'too_large',
      'This would make the data file larger than a data file may be.',
      'A super admin can raise it.',
    )
  }
  if (text.includes('change_guard_blob')) {
    return dossierError(
      'blob_reclaiming',
      'A file of this change is being cleaned up. Upload it again shortly.',
      'Push again in a minute.',
    )
  }
  if (
    text.includes('change_guard_basis') ||
    text.includes('change_guard_state') ||
    text.includes('UNIQUE constraint failed')
  ) {
    return dossierError(
      'conflict',
      'Something changed while this change was being made, so nothing was applied.',
      'Try again.',
    )
  }
  console.error('A tree change failed', error)
  return dossierError('unavailable')
}

/** Folders before files, then by path. */
const byListingOrder = (a: Entry, b: Entry) =>
  (a.node.kind === 'folder' ? 0 : 1) - (b.node.kind === 'folder' ? 0 : 1) ||
  (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** The statements that make a pushed folder match its staged manifest. */
const stagedWrites = (i: {
  readonly treeId: TreeId
  readonly pushId: PushId
  readonly now: number
  readonly authorId: string
  readonly keyId: string | null
}): Statement[] => {
  // ?1 tree · ?2 push · ?3 now · ?4 author · ?5 key
  const binds = [i.treeId, i.pushId, i.now, i.authorId, i.keyId]
  const pushed = '(select path from pushes where id = ?2)'
  const seq = '(select authored_seq from trees where id = ?1)'
  const revision =
    'coalesce((select max(v.revision) from node_versions v where v.node_id = n.id), 0) + 1'
  const versionColumns = `id, node_id, tree_id, revision, authored_seq, state, blob_sha256,
    json_value, size, content_type, author_id, key_id, push_id, seen_push_number, op_id, created_at`
  const nodeColumns = `id, tree_id, parent_id, name, path, depth, kind, origin, owner_id,
    current_version_id, created_at, deleted_at`
  const parent = `(select p.id from nodes p where p.tree_id = ?1 and p.path = f.parent_path
    and p.deleted_at is null)`
  const freePath = `not exists (select 1 from nodes n where n.tree_id = ?1 and n.path = f.path
    and n.deleted_at is null)`
  const folders: Statement[] = []
  // An INSERT … SELECT does not see its own rows, so each depth is its own.
  for (let depth = 1; depth <= 32; depth += 1) {
    folders.push({
      sql: `insert into nodes (${nodeColumns})
            select lower(hex(randomblob(16))), ?1, ${parent}, f.name, f.path, f.depth,
              'folder', 'authored', null, null, ?3, null
            from push_folders f where f.push_id = ?2 and f.depth = ?6 and ${freePath}`,
      binds: [...binds, depth],
    })
  }
  const statements: Statement[] = [
    // Authored files under the path that the folder no longer holds.
    {
      sql: `insert into node_versions (${versionColumns})
            select lower(hex(randomblob(16))), n.id, ?1, ${revision}, ${seq}, 'deleted',
              null, null, null, null, ?4, ?5, ?2, null, null, ?3
            from nodes n
            where n.tree_id = ?1 and n.deleted_at is null and n.kind = 'file'
              and n.origin = 'authored' and ${under('n.path', pushed)}
              and not exists (select 1 from push_files f where f.push_id = ?2 and f.path = n.path)`,
      binds,
    },
    {
      sql: `update nodes set deleted_at = ?3, current_version_id =
              (select v.id from node_versions v where v.node_id = nodes.id
                 and v.push_id = ?2 and v.state = 'deleted')
            where tree_id = ?1 and id in
              (select node_id from node_versions where push_id = ?2 and state = 'deleted')`,
      binds,
    },
    // Authored folders left with no live file below them.
    {
      sql: `update nodes set deleted_at = ?3
            where tree_id = ?1 and deleted_at is null and kind = 'folder'
              and origin = 'authored' and depth > 0 and ${under('path', pushed)}
              and path not in (select path from push_folders where push_id = ?2)
              and not exists (select 1 from nodes c where c.tree_id = ?1
                and c.deleted_at is null and c.kind = 'file'
                and substr(c.path, 1, length(nodes.path) + 1) = nodes.path || '/')`,
      binds,
    },
    ...folders,
    {
      sql: `insert into nodes (${nodeColumns})
            select lower(hex(randomblob(16))), ?1, ${parent}, f.name, f.path, f.depth,
              'file', 'authored', null, null, ?3, null
            from push_files f where f.push_id = ?2 and ${freePath}`,
      binds,
    },
    // Unchanged files get no version.
    {
      sql: `insert into node_versions (${versionColumns})
            select lower(hex(randomblob(16))), n.id, ?1, ${revision}, ${seq}, 'live',
              f.sha256, null, (select b.size from blobs b where b.sha256 = f.sha256),
              f.content_type, ?4, ?5, ?2, null, null, ?3
            from push_files f join nodes n on n.tree_id = ?1 and n.path = f.path
              and n.deleted_at is null and n.kind = 'file' and n.origin = 'authored'
            where f.push_id = ?2 and not exists (select 1 from node_versions cv
              where cv.id = n.current_version_id and cv.state = 'live'
                and cv.blob_sha256 = f.sha256)`,
      binds,
    },
    {
      sql: `update nodes set current_version_id =
              (select v.id from node_versions v where v.node_id = nodes.id
                 and v.push_id = ?2 and v.state = 'live')
            where tree_id = ?1 and id in
              (select node_id from node_versions where push_id = ?2 and state = 'live')`,
      binds,
    },
    {
      sql: `update blobs set ref_count = ref_count +
              (select count(*) from node_versions v where v.push_id = ?2
                 and v.blob_sha256 = blobs.sha256)
            where sha256 in (select blob_sha256 from node_versions
              where tree_id = ?1 and push_id = ?2 and blob_sha256 is not null)`,
      binds,
    },
    {
      sql: `delete from blob_holds where holder_kind = 'push' and holder_id = ?2`,
      binds,
    },
    {
      sql: `update pushes set state = 'committed', tree_id = ?1, committed_at = ?3,
              number = (select push_count from trees where id = ?1)
            where id = ?2`,
      binds,
    },
  ]
  // A statement takes exactly as many binds as its highest ?N.
  return statements.map((s) => ({
    ...s,
    binds: s.binds.slice(0, highestParam(s.sql)),
  }))
}

const NODE_COLUMNS = `id, tree_id, parent_id, name, path, depth, kind, origin, owner_id,
  current_version_id, created_at, deleted_at`
const VERSION_COLUMNS = `id, node_id, tree_id, revision, authored_seq, state, blob_sha256,
  json_value, size, content_type, author_id, key_id, push_id, seen_push_number, op_id,
  created_at`
/** The next revision of the node bound as ?2. */
const NEXT_REVISION =
  'coalesce((select max(r.revision) from node_versions r where r.node_id = ?2), 0) + 1'

/** A live data file. */
const liveDataFile = (nodeId: NodeId): Statement => ({
  sql: `exists (select 1 from nodes where id = ? and deleted_at is null
          and kind = 'file' and origin = 'data')`,
  binds: [nodeId],
})

const highestParam = (text: string): number => {
  let max = 0
  for (const match of text.matchAll(/\?(\d+)/g)) {
    max = Math.max(max, Number(match[1]))
  }
  return max
}

const joinPath = (folder: string, name: string) =>
  folder === '' ? name : `${folder}/${name}`

/** A page file's path as its link names it: 'a/index.html' → 'a/', 'a/b.html' → 'a/b'. */
const pageLinkPath = (path: string): string => {
  if (path === 'index.html') return ''
  if (path.endsWith('/index.html'))
    return `${path.slice(0, -'index.html'.length)}`
  return path.endsWith('.html') ? path.slice(0, -'.html'.length) : path
}

/**
 * A tree path in the link's encoded form, with a trailing slash for a
 * folder: ('a b/c', true) → 'a%20b/c/'.
 */
export const linkPathOf = (path: string, folder: boolean): string => {
  const bare = path.endsWith('/') ? path.slice(0, -1) : path
  if (bare === '') return ''
  const encoded = bare.split('/').map(encodeURIComponent).join('/')
  return folder || path.endsWith('/') ? `${encoded}/` : encoded
}

export const TreeStoreLive: Layer.Layer<
  TreeStore,
  never,
  Bindings | Access | BaseLayer | Limits
> = Layer.effect(
  TreeStore,
  Effect.gen(function* () {
    const context = yield* Effect.context<Bindings | BaseLayer>()
    const bindings = yield* Bindings
    const access = yield* Access
    const limits = yield* Limits
    const { DB, BLOBS } = bindings
    const database = db(bindings)

    const read = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: unavailable })

    const workspace = (name: string) =>
      read(() =>
        database
          .select()
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.name, name),
              isNull(schema.workspaces.deletedAt),
            ),
          )
          .get(),
      ).pipe(
        Effect.map((row) => (row ?? null) as WorkspaceRow | null),
        Effect.orDie,
      )

    const tree = (ws: WorkspaceRow, name: string) =>
      read(() =>
        database
          .select()
          .from(schema.trees)
          .where(
            and(
              eq(schema.trees.workspaceId, ws.id),
              eq(schema.trees.name, name),
              isNull(schema.trees.deletedAt),
            ),
          )
          .get(),
      ).pipe(
        Effect.map((row) => (row ?? null) as TreeRow | null),
        Effect.orDie,
      )

    const liveNode = (treeId: TreeId, path: string) =>
      read(() =>
        database
          .select()
          .from(schema.nodes)
          .where(
            and(
              eq(schema.nodes.treeId, treeId),
              eq(schema.nodes.path, path),
              isNull(schema.nodes.deletedAt),
            ),
          )
          .get(),
      ).pipe(Effect.map((row) => (row ?? null) as NodeRow | null))

    /** The node's current version, when it is live. */
    const versionOf = (node: NodeRow) => {
      const id = node.currentVersionId
      return id === null
        ? Effect.succeed(null)
        : read(() =>
            database
              .select()
              .from(schema.nodeVersions)
              .where(eq(schema.nodeVersions.id, id))
              .get(),
          ).pipe(
            Effect.map((row) =>
              row === undefined || row.state !== 'live'
                ? null
                : (row as VersionRow),
            ),
          )
    }

    const locate = (ref: LinkRef) =>
      Effect.gen(function* () {
        const missing = (treeId: TreeId | null): MissingNode => ({
          missing: true,
          treeId,
          path: ref.path,
        })
        const ws = yield* workspace(ref.workspace)
        if (ws === null) return missing(null)
        const found = yield* tree(ws, ref.tree)
        if (found === null) return missing(null)
        // `a/b` names the folder a/b, the file a/b, or the page a/b.html.
        const candidates =
          ref.folder || ref.path === ''
            ? [ref.path]
            : [ref.path, `${ref.path}.html`]
        for (const path of candidates) {
          const node = yield* liveNode(found.id, path)
          if (node === null) continue
          if (node.kind === 'folder') {
            return { kind: 'folder', node, tree: found } satisfies Located
          }
          if (ref.folder) continue
          const version = yield* versionOf(node)
          if (version === null) continue
          return {
            kind: 'file',
            node,
            version,
            tree: found,
          } satisfies Located
        }
        return missing(found.id)
      })

    const treeById = (treeId: TreeId) =>
      read(() =>
        database
          .select({ tree: schema.trees, workspace: schema.workspaces })
          .from(schema.trees)
          .innerJoin(
            schema.workspaces,
            eq(schema.workspaces.id, schema.trees.workspaceId),
          )
          .where(
            and(
              eq(schema.trees.id, treeId),
              isNull(schema.trees.deletedAt),
              isNull(schema.workspaces.deletedAt),
            ),
          )
          .get(),
      ).pipe(
        Effect.map((row) =>
          row === undefined
            ? null
            : {
                tree: row.tree as TreeRow,
                workspace: row.workspace as WorkspaceRow,
              },
        ),
      )

    /** A live file now: authored or data. */
    const liveFile = (treeId: TreeId, path: string) =>
      Effect.gen(function* () {
        const node = yield* liveNode(treeId, path)
        if (node === null || node.kind !== 'file') return null
        const version = yield* versionOf(node)
        return version === null ? null : { node, version }
      })

    /**
     * An authored file as it stood at a sequence, or any file live now
     * without one. People's data has no sequence: at any sequence, a data
     * file is read as it is now.
     */
    const fileAt = (treeId: TreeId, path: string, at?: AuthoredSeq) =>
      Effect.gen(function* () {
        if (at === undefined) return yield* liveFile(treeId, path)
        const authored = yield* authoredFileAt(treeId, path, at)
        if (authored !== null) return authored
        const live = yield* liveFile(treeId, path)
        return live !== null && live.node.origin === 'data' ? live : null
      })

    const authoredFileAt = (treeId: TreeId, path: string, at: AuthoredSeq) =>
      Effect.gen(function* () {
        const row = yield* read(() =>
          database
            .select({ node: schema.nodes, version: schema.nodeVersions })
            .from(schema.nodeVersions)
            .innerJoin(
              schema.nodes,
              eq(schema.nodes.id, schema.nodeVersions.nodeId),
            )
            .where(
              and(
                eq(schema.nodes.treeId, treeId),
                eq(schema.nodes.path, path),
                eq(schema.nodes.kind, 'file'),
                eq(schema.nodes.origin, 'authored'),
                sql`${schema.nodeVersions.authoredSeq} <= ${at}`,
              ),
            )
            .orderBy(
              sql`${schema.nodeVersions.authoredSeq} desc`,
              sql`${schema.nodeVersions.revision} desc`,
            )
            .limit(1)
            .get(),
        )
        if (row === undefined || row.version.state !== 'live') return null
        return {
          node: row.node as NodeRow,
          version: row.version as VersionRow,
        }
      })

    /**
     * A folder now, or at a sequence: the folder's node, when it holds a
     * file live at that sequence (the root always exists).
     */
    const folderAt = (treeId: TreeId, path: string, at?: AuthoredSeq) =>
      Effect.gen(function* () {
        if (at === undefined) {
          const node = yield* liveNode(treeId, path)
          return node !== null && node.kind === 'folder' ? node : null
        }
        const node = yield* read(() =>
          database
            .select()
            .from(schema.nodes)
            .where(
              and(
                eq(schema.nodes.treeId, treeId),
                eq(schema.nodes.path, path),
                eq(schema.nodes.kind, 'folder'),
              ),
            )
            .orderBy(
              sql`${schema.nodes.deletedAt} is not null`,
              sql`${schema.nodes.createdAt} desc`,
            )
            .limit(1)
            .get(),
        )
        if (node === undefined) return null
        if (path === '') return node as NodeRow
        const held = yield* read(() =>
          DB.prepare(
            `select 1 as held from nodes n
               where n.tree_id = ?1 and n.kind = 'file' and n.origin = 'authored'
                 and substr(n.path, 1, length(?2) + 1) = ?2 || '/'
                 and (select v.state from node_versions v
                        where v.node_id = n.id and v.authored_seq <= ?3
                        order by v.authored_seq desc, v.revision desc limit 1) = 'live'
               limit 1`,
          )
            .bind(treeId, path, at)
            .first<{ held: number }>(),
        )
        return held === null ? null : (node as NodeRow)
      })

    const resolve = (ref: LinkRef | TreeRef, at?: AuthoredSeq) =>
      Effect.gen(function* () {
        let found: TreeRow | null
        if ('treeId' in ref) {
          found = (yield* treeById(ref.treeId))?.tree ?? null
        } else {
          const ws = yield* workspace(ref.workspace)
          found = ws === null ? null : yield* tree(ws, ref.tree)
        }
        const missing = (): MissingNode => ({
          missing: true,
          treeId: found?.id ?? null,
          path: ref.path,
        })
        if (found === null) return missing()
        const t = found
        // A `_` path is answered by the closest `_` file the lookup reaches.
        const split = underscoreSplit(ref.path)
        if (split !== null) {
          const candidates = yield* lookupUnderscore({
            treeId: t.id,
            folder: split.from,
            rest: split.rest,
            at: at ?? (t.authoredSeq as AuthoredSeq),
          }).pipe(Effect.provide(context))
          return {
            kind: 'kit',
            tree: t,
            folder: split.from,
            found: candidates,
          } satisfies Resolved
        }
        const asked = linkPathOf(ref.path, ref.folder || ref.path === '')
        const page = (file: { node: NodeRow; version: VersionRow }) => {
          const linkPath = linkPathOf(pageLinkPath(file.node.path), false)
          return linkPath === asked
            ? ({
                kind: 'page',
                ...file,
                tree: t,
                linkPath,
              } satisfies Resolved)
            : ({
                kind: 'redirect',
                node: file.node,
                tree: t,
                to: linkPath,
              } satisfies Resolved)
        }
        if (ref.folder || ref.path === '') {
          const folder = yield* folderAt(t.id, ref.path, at)
          if (folder === null) return missing()
          const index = yield* fileAt(
            t.id,
            joinPath(ref.path, 'index.html'),
            at,
          )
          if (index !== null && index.node.origin === 'authored') {
            return page(index)
          }
          return { kind: 'folder', node: folder, tree: t } satisfies Resolved
        }
        const html = yield* fileAt(t.id, `${ref.path}.html`, at)
        // People's data is never a page, whatever its name.
        if (html !== null && html.node.origin === 'authored') return page(html)
        const folder = yield* folderAt(t.id, ref.path, at)
        if (folder !== null) {
          return {
            kind: 'redirect',
            node: folder,
            tree: t,
            to: linkPathOf(ref.path, true),
          } satisfies Resolved
        }
        const file = yield* fileAt(t.id, ref.path, at)
        if (file === null) return missing()
        if (
          file.node.origin === 'authored' &&
          file.node.name.endsWith('.html')
        ) {
          return page(file)
        }
        return { kind: 'file', ...file, tree: t } satisfies Resolved
      })

    const analysis = (sha256: Sha256) =>
      analysisOf(sha256).pipe(Effect.provide(context))

    const markdown = (sha256: Sha256) =>
      Effect.gen(function* () {
        const stored = yield* read(() => BLOBS.get(markdownKey(sha256)))
        if (stored !== null) return yield* read(() => stored.text())
        const page = yield* read(() => BLOBS.get(blobKey(sha256)))
        if (page === null) {
          console.error('A blob is missing from R2', { sha256 })
          return yield* Effect.fail(dossierError('unavailable'))
        }
        const source = yield* read(() => page.text())
        const text = yield* Effect.try({
          try: () => toMarkdown(source),
          catch: unavailable,
        })
        yield* read(() =>
          BLOBS.put(markdownKey(sha256), text, {
            httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
          }),
        )
        return text
      })

    const docs = (
      folder: Granted<'read'>,
      opts: { readonly origin: 'data' | 'any' },
    ) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const readable = yield* access.readable(folder.treeId)
        const n = schema.nodes
        const below =
          folder.path === ''
            ? sql`${n.depth} > 0`
            : sql`substr(${n.path}, 1, length(${folder.path}) + 1) = ${`${folder.path}/`}`
        const origin =
          opts.origin === 'data' ? sql`${n.origin} = 'data'` : sql`1`
        // Members of the tree's workspace see who pushed by email.
        const member = sql`exists (select 1 from workspace_members m
          join trees t on t.workspace_id = m.workspace_id
          where t.id = ${folder.treeId} and m.user_id = ${caller.person?.id ?? ''})`
        const rows = yield* read(() =>
          database
            .select({
              node: schema.nodes,
              version: schema.nodeVersions,
              email: schema.user.email,
              name: schema.user.name,
              pushNumber: schema.pushes.number,
              member: sql<number>`${member}`,
            })
            .from(schema.nodes)
            .innerJoin(
              schema.nodeVersions,
              eq(schema.nodeVersions.id, schema.nodes.currentVersionId),
            )
            .innerJoin(
              schema.user,
              eq(schema.user.id, schema.nodeVersions.authorId),
            )
            .leftJoin(
              schema.pushes,
              eq(schema.pushes.id, schema.nodeVersions.pushId),
            )
            .where(
              and(
                eq(n.treeId, folder.treeId),
                isNull(n.deletedAt),
                eq(n.kind, 'file'),
                eq(schema.nodeVersions.state, 'live'),
                below,
                origin,
                readable.where,
              ),
            )
            .orderBy(n.path)
            .all(),
        ).pipe(Effect.orDie)
        return rows.map((row): DocRow => {
          const node = row.node as NodeRow
          const version = row.version as VersionRow
          const data = node.origin === 'data'
          const named =
            data ||
            row.member === 1 ||
            (caller.person !== null && caller.person.id === version.authorId)
          let value: unknown | null = null
          if (data && version.jsonValue !== null) {
            try {
              value = JSON.parse(version.jsonValue)
            } catch {
              value = null
            }
          }
          return {
            node,
            version,
            by: named ? row.email : row.name,
            push: ((data ? version.seenPushNumber : row.pushNumber) ??
              0) as PushNumber,
            value,
          }
        })
      })

    const holdBlob = (
      holder: { readonly kind: HoldKind; readonly id: string },
      sha256: Sha256,
      size: number,
    ) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const results = yield* read(() =>
          DB.batch([
            DB.prepare(
              `insert into blobs (sha256, size, ref_count, state, first_seen_at)
                 values (?, ?, 0, 'live', ?) on conflict do nothing`,
            ).bind(sha256, size, at),
            DB.prepare(
              `insert into blob_holds (holder_kind, holder_id, sha256, verified, created_at)
                 select ?, ?, ?, 0, ? where exists
                   (select 1 from blobs where sha256 = ? and state = 'live')
                 on conflict do nothing`,
            ).bind(holder.kind, holder.id, sha256, at, sha256),
            DB.prepare('select state from blobs where sha256 = ?').bind(sha256),
          ]),
        ).pipe(Effect.orDie)
        const state = (results[2]?.results[0] as { state?: string } | undefined)
          ?.state
        if (state !== 'live') {
          return yield* Effect.fail(
            dossierError(
              'blob_reclaiming',
              'This file is being cleaned up. Upload it again shortly.',
              'Push again in a minute.',
            ),
          )
        }
      })

    const confirmHold = (
      holder: { readonly kind: HoldKind; readonly id: string },
      sha256: Sha256,
      size: number,
    ) =>
      read(() =>
        DB.batch([
          // Verified bytes fix the blob's size, whatever row came first.
          DB.prepare('update blobs set size = ? where sha256 = ?').bind(
            size,
            sha256,
          ),
          DB.prepare(
            `update blob_holds set verified = 1
               where holder_kind = ? and holder_id = ? and sha256 = ?`,
          ).bind(holder.kind, holder.id, sha256),
        ]),
      ).pipe(Effect.asVoid, Effect.orDie)

    const dropHold = (
      holder: { readonly kind: HoldKind; readonly id: string },
      sha256: Sha256,
    ) =>
      read(() =>
        DB.prepare(
          `delete from blob_holds where holder_kind = ? and holder_id = ?
               and sha256 = ? and verified = 0`,
        )
          .bind(holder.kind, holder.id, sha256)
          .run(),
      ).pipe(Effect.asVoid, Effect.orDie)

    const releaseHold = (
      holder: { readonly kind: HoldKind; readonly id: string },
      sha256: Sha256,
    ) =>
      read(() =>
        DB.prepare(
          `delete from blob_holds where holder_kind = ? and holder_id = ?
               and sha256 = ?`,
        )
          .bind(holder.kind, holder.id, sha256)
          .run(),
      ).pipe(Effect.asVoid, Effect.orDie)

    const forms: TreeStoreService['forms'] = (q) =>
      Effect.gen(function* () {
        const f = schema.forms
        const rows = yield* read(() =>
          database
            .select()
            .from(f)
            .where(
              'hostVersionId' in q
                ? eq(f.hostVersionId, q.hostVersionId)
                : and(eq(f.treeId, q.treeId), eq(f.targetPath, q.target)),
            )
            .orderBy(f.line)
            .all(),
        )
        return rows.map((row): FormRow => ({
          hostVersionId: row.hostVersionId as VersionId,
          hostNodeId: row.hostNodeId as NodeId,
          treeId: row.treeId as TreeId,
          targetPath: row.targetPath,
          formKey: row.formKey,
          kind: row.kind as FormRow['kind'],
          closesAt: row.closesAt,
          closed: row.closed,
          line: row.line,
          title: row.title,
          schema: JSON.parse(row.schemaJson) as FormSchema,
        }))
      })

    const operationResult: TreeStoreService['operationResult'] = (key) =>
      Effect.gen(function* () {
        const row = yield* read(() =>
          DB.prepare(
            `select result_state as state, result_version_id as versionId
             from operations where principal = ? and scope = ? and op_id = ?`,
          )
            .bind(key.principal, key.scope, key.opId)
            .first<{
              state: 'stored' | 'withdrawn'
              versionId: string | null
            }>(),
        )
        if (row === null) return null
        if (row.state === 'withdrawn' || row.versionId === null) {
          return { state: 'withdrawn' } satisfies OperationResult
        }
        const versionId = row.versionId
        const version = yield* read(() =>
          database
            .select()
            .from(schema.nodeVersions)
            .where(eq(schema.nodeVersions.id, versionId))
            .get(),
        )
        return version === undefined
          ? ({ state: 'withdrawn' } satisfies OperationResult)
          : ({
              state: 'stored',
              version: version as VersionRow,
            } satisfies OperationResult)
      })

    const list = (folder: Granted<'read'>, depth: 'one' | 'all') =>
      Effect.gen(function* () {
        const readable = yield* access.readable(folder.treeId)
        const below =
          folder.path === ''
            ? sql`${schema.nodes.depth} > 0`
            : sql`substr(${schema.nodes.path}, 1, length(${folder.path}) + 1) = ${`${folder.path}/`}`
        const rows = yield* read(() =>
          database
            .select({
              node: schema.nodes,
              sha256: schema.nodeVersions.blobSha256,
              size: schema.nodeVersions.size,
              contentType: schema.nodeVersions.contentType,
              pushNumber: schema.pushes.number,
              pushAt: schema.pushes.committedAt,
              // Any analyzer's title: a new analyzer reads titles alike.
              title: sql<string | null>`(select json_extract(a.json, '$.title')
                  from analyses a where a.sha256 = ${schema.nodeVersions.blobSha256}
                  and a.analyzer = 'html' order by a.version desc limit 1)`,
            })
            .from(schema.nodes)
            .leftJoin(
              schema.nodeVersions,
              eq(schema.nodeVersions.id, schema.nodes.currentVersionId),
            )
            .leftJoin(
              schema.pushes,
              eq(schema.pushes.id, schema.nodeVersions.pushId),
            )
            .where(
              and(
                eq(schema.nodes.treeId, folder.treeId),
                isNull(schema.nodes.deletedAt),
                below,
                readable.where,
              ),
            )
            .all(),
        ).pipe(Effect.orDie)
        const files = new Set(
          rows.filter((r) => r.node.kind === 'file').map((r) => r.node.path),
        )
        const entries = rows.map((row): Entry => {
          const node = row.node as NodeRow
          const isFile = node.kind === 'file'
          const kind: Entry['kind'] =
            node.origin === 'data'
              ? 'data'
              : isKitPath(node.path)
                ? 'kit'
                : isFile
                  ? node.name.endsWith('.html')
                    ? 'page'
                    : 'attachment'
                  : files.has(`${node.path}/index.html`)
                    ? 'page'
                    : 'folder'
          return {
            name: node.name,
            path: node.path,
            kind,
            node,
            size: isFile ? row.size : null,
            sha256: isFile ? (row.sha256 as Sha256 | null) : null,
            contentType: isFile ? row.contentType : null,
            title: row.title ?? null,
            push:
              row.pushNumber === null || row.pushAt === null
                ? null
                : { number: row.pushNumber as PushNumber, at: row.pushAt },
            pages: null,
          }
        })
        if (depth === 'all') return entries.sort(byListingOrder)
        return entries
          .filter((entry) => entry.node.depth === folder.depth + 1)
          .map((entry): Entry => {
            if (entry.node.kind !== 'folder') return entry
            const prefix = `${entry.path}/`
            const inside = entries.filter((e) => e.path.startsWith(prefix))
            const latest = inside.reduce<Entry['push']>(
              (best, e) =>
                e.push !== null &&
                (best === null || e.push.number > best.number)
                  ? e.push
                  : best,
              null,
            )
            const index = entries.find(
              (e) => e.path === `${entry.path}/index.html`,
            )
            return {
              ...entry,
              push: latest,
              title: index?.title ?? null,
              // `_` files are the kit, never pages.
              pages: inside.filter(
                (e) => e.node.kind === 'file' && e.kind === 'page',
              ).length,
            }
          })
          .sort(byListingOrder)
      })

    const readFile = (file: Granted<'read'>) =>
      Effect.gen(function* () {
        const gone = dossierError(
          'not_found',
          'Nothing is here, or you cannot open it.',
          null,
          file.path,
        )
        const version = yield* versionOf(file).pipe(Effect.orDie)
        const sha = version?.blobSha256 ?? null
        // A JSON data file's value lives in D1, not in a blob.
        if (version !== null && sha === null && version.jsonValue !== null) {
          return {
            version,
            body: version.jsonValue,
            size: new TextEncoder().encode(version.jsonValue).length,
            etag: `v-${version.id}`,
          } satisfies FileBody
        }
        if (version === null || sha === null) {
          return yield* Effect.fail(gone)
        }
        const object = yield* read(() => BLOBS.get(blobKey(sha))).pipe(
          Effect.orDie,
        )
        if (object === null) {
          console.error('A blob is missing from R2', { sha256: sha })
          return yield* Effect.fail(gone)
        }
        return {
          version,
          body: object.body,
          size: object.size,
          etag: sha,
        } satisfies FileBody
      })

    const change = <A, E>(
      startTree: TreeId | null,
      plan: (cs: ChangeSet) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const person = caller.person
        if (person === null) {
          return yield* Effect.die(new Error('a change needs a person'))
        }
        const now = yield* Clock.currentTimeMillis
        const { dataFileBytes } = yield* limits.current()
        const guardId = newId()
        const keyId = caller.via.kind === 'agent' ? caller.via.keyId : null
        let treeId = startTree
        const tid = (): TreeId => {
          if (treeId === null) throw new Error('the change has no tree yet')
          return treeId
        }
        const creates: Statement[] = []
        const writes: Statement[] = []
        const heads: Statement[] = []
        const blobGuards: Statement[] = []
        const stateGuards: Statement[] = []
        /** Checked after the writes: the tree came out as the change meant. */
        const outcomes: Statement[] = []
        const bases: Statement[] = []
        /** Data checks made before any write: a JSON object, a size. */
        const dataGuards: {
          readonly reason: 'mergeable' | 'size'
          readonly condition: Statement
        }[] = []
        const events: NewEvent[] = []
        let authored = 0
        let pushCount = 0

        const cs: ChangeSet = {
          guardHead: (path, base) => {
            heads.push({
              sql: `not exists (select 1 from node_versions v join nodes n on n.id = v.node_id
                        where v.tree_id = ? and n.origin = 'authored' and v.authored_seq > ?
                          and ${under('n.path', '?')})`,
              binds: [tid(), base, path, path, path, path],
            })
          },

          createTree: (member, name) => {
            if (treeId !== null) {
              throw new Error('createTree in a change that has its tree')
            }
            const id = newTreeId()
            const rootId = newId() as NodeId
            treeId = id
            creates.push(
              {
                sql: `insert into trees (id, workspace_id, name, root_node_id, created_by,
                          authored_seq, event_seq, push_count, created_at, deleted_at)
                        values (?, ?, ?, ?, ?, 0, 0, 0, ?, null)`,
                binds: [id, member.workspace.id, name, rootId, person.id, now],
              },
              {
                sql: `insert into nodes (id, tree_id, parent_id, name, path, depth, kind,
                          origin, owner_id, current_version_id, created_at, deleted_at)
                        values (?, ?, null, '', '', 0, 'folder', 'authored', null, null, ?, null)`,
                binds: [rootId, id, now],
              },
              {
                sql: `insert into shares (id, tree_id, node_id, target_kind, target, role,
                          created_by, created_at)
                        values (?, ?, ?, 'email', ?, 'write', ?, ?)`,
                binds: [
                  newId(),
                  id,
                  rootId,
                  person.email.toLowerCase(),
                  person.id,
                  now,
                ],
              },
            )
            bases.push(
              everyBasis([member.basis], person.id),
              createsTrees(caller),
            )
            return makeHandle(rootId)
          },

          putStaged: (target, pushId) => {
            const t = tid()
            authored += 1
            pushCount += 1
            if (!isHandle(target)) {
              bases.push(everyBasis(target.basis, person.id))
              stateGuards.push({
                sql: 'exists (select 1 from nodes where id = ? and deleted_at is null)',
                binds: [target.id],
              })
            }
            stateGuards.push({
              sql: `exists (select 1 from pushes where id = ? and state = 'staged'
                        and expires_at > ?)`,
              binds: [pushId, now],
            })
            blobGuards.push({
              sql: `not exists (select 1 from push_files f where f.push_id = ? and (
                        not exists (select 1 from blobs b where b.sha256 = f.sha256
                                      and b.state = 'live')
                        or (not exists (select 1 from blob_holds h where h.holder_kind = 'push'
                                          and h.holder_id = f.push_id and h.sha256 = f.sha256
                                          and h.verified = 1)
                            and not exists (select 1 from node_versions v
                                              where v.tree_id = ? and v.blob_sha256 = f.sha256))))`,
              binds: [pushId, t],
            })
            outcomes.push(
              {
                // Every staged file is live at its path with its bytes.
                sql: `not exists (select 1 from push_files f where f.push_id = ?
                          and not exists (select 1 from nodes n
                            join node_versions v on v.id = n.current_version_id
                            where n.tree_id = ? and n.path = f.path and n.deleted_at is null
                              and n.kind = 'file' and v.state = 'live'
                              and v.blob_sha256 = f.sha256))`,
                binds: [pushId, t],
              },
              {
                sql: `not exists (select 1 from push_folders f where f.push_id = ?
                          and not exists (select 1 from nodes n where n.tree_id = ?
                            and n.path = f.path and n.deleted_at is null
                            and n.kind = 'folder'))`,
                binds: [pushId, t],
              },
              {
                // Nothing live sits under a file or a deleted folder.
                sql: `not exists (select 1 from nodes c join nodes p on p.id = c.parent_id
                          where c.tree_id = ? and c.deleted_at is null
                            and (p.kind <> 'folder' or p.deleted_at is not null))`,
                binds: [t],
              },
            )
            writes.push(
              ...stagedWrites({
                treeId: t,
                pushId,
                now,
                authorId: person.id,
                keyId,
              }),
            )
          },

          grant: (on, share) => {
            const t = tid()
            const nodeId = isHandle(on) ? handleId(on) : on.id
            if (!isHandle(on)) bases.push(everyBasis(on.basis, person.id))
            writes.push({
              sql: `insert into shares (id, tree_id, node_id, target_kind, target, role,
                        created_by, created_at)
                      values (?, ?, ?, ?, ?, ?, ?, ?)
                      on conflict (node_id, target_kind, target) do update set role = excluded.role`,
              binds: [
                newId(),
                t,
                nodeId,
                share.targetKind,
                share.target,
                share.role,
                person.id,
                now,
              ],
            })
          },

          revoke: (on, shareId) => {
            bases.push(everyBasis(on.basis, person.id))
            writes.push({
              sql: 'delete from shares where id = ? and node_id = ?',
              binds: [shareId, on.id],
            })
          },

          createData: (holder, node) => {
            const t = tid()
            bases.push(everyBasis(holder.basis, person.id))
            const id = newId() as NodeId
            const segments = node.path.split('/')
            // Folders on the way, each only where nothing lives yet.
            for (let depth = 1; depth < segments.length; depth += 1) {
              const path = segments.slice(0, depth).join('/')
              writes.push({
                sql: `insert into nodes (${NODE_COLUMNS})
                      select lower(hex(randomblob(16))), ?1,
                        (select p.id from nodes p where p.tree_id = ?1 and p.path = ?2
                           and p.deleted_at is null),
                        ?3, ?4, ?5, 'folder', 'data', null, null, ?6, null
                      where not exists (select 1 from nodes n where n.tree_id = ?1
                        and n.path = ?4 and n.deleted_at is null)`,
                binds: [
                  t,
                  parentPath(path),
                  segments[depth - 1],
                  path,
                  depth,
                  now,
                ],
              })
            }
            writes.push({
              sql: `insert into nodes (${NODE_COLUMNS})
                    values (?1, ?2,
                      (select p.id from nodes p where p.tree_id = ?2 and p.path = ?3
                         and p.deleted_at is null),
                      ?4, ?5, ?6, ?7, 'data', ?8, null, ?9, null)`,
              binds: [
                id,
                t,
                parentPath(node.path),
                segments[segments.length - 1],
                node.path,
                segments.length,
                node.kind,
                node.owner,
                now,
              ],
            })
            // It sits in a live folder, as the path says.
            outcomes.push({
              sql: `exists (select 1 from nodes n join nodes p on p.id = n.parent_id
                      where n.id = ? and n.deleted_at is null and p.kind = 'folder'
                        and p.deleted_at is null)`,
              binds: [id],
            })
            return makeHandle(id)
          },

          putData: (target, version) => {
            const t = tid()
            const nodeId = isHandle(target) ? handleId(target) : target.id
            if (!isHandle(target)) {
              bases.push(everyBasis(target.basis, person.id))
              stateGuards.push(liveDataFile(nodeId))
            }
            const versionId = newId() as VersionId
            if ('json' in version) {
              const text = JSON.stringify(version.json)
              dataGuards.push({
                reason: 'size',
                condition: {
                  sql: 'length(cast(json(?) as blob)) <= ?',
                  binds: [text, dataFileBytes],
                },
              })
              writes.push({
                sql: `insert into node_versions (${VERSION_COLUMNS})
                      select ?1, ?2, ?3, ${NEXT_REVISION}, null, 'live', null, json(?4),
                        length(cast(json(?4) as blob)), 'application/json', ?5, ?6, null,
                        ?7, ?8, ?9`,
                binds: [
                  versionId,
                  nodeId,
                  t,
                  text,
                  person.id,
                  keyId,
                  version.seenPush,
                  version.opId,
                  now,
                ],
              })
            } else {
              const { blob } = version
              blobGuards.push({
                sql: `exists (select 1 from blobs where sha256 = ? and state = 'live')
                      and exists (select 1 from blob_holds where holder_kind = ?
                        and holder_id = ? and sha256 = ? and verified = 1)`,
                binds: [blob.sha256, blob.hold.kind, blob.hold.id, blob.sha256],
              })
              writes.push(
                {
                  sql: `insert into node_versions (${VERSION_COLUMNS})
                        select ?1, ?2, ?3, ${NEXT_REVISION}, null, 'live', ?4, null,
                          (select size from blobs where sha256 = ?4), ?5, ?6, ?7, null,
                          ?8, ?9, ?10`,
                  binds: [
                    versionId,
                    nodeId,
                    t,
                    blob.sha256,
                    blob.contentType,
                    person.id,
                    keyId,
                    version.seenPush,
                    version.opId,
                    now,
                  ],
                },
                {
                  sql: 'update blobs set ref_count = ref_count + 1 where sha256 = ?',
                  binds: [blob.sha256],
                },
                {
                  sql: `delete from blob_holds where holder_kind = ? and holder_id = ?
                          and sha256 = ?`,
                  binds: [blob.hold.kind, blob.hold.id, blob.sha256],
                },
              )
            }
            writes.push({
              sql: 'update nodes set current_version_id = ? where id = ?',
              binds: [versionId, nodeId],
            })
            return makeVersionHandle(versionId, nodeId)
          },

          mergeJson: (target, patch, provenance) => {
            const t = tid()
            const nodeId = isHandle(target) ? handleId(target) : target.id
            if (!isHandle(target)) {
              bases.push(everyBasis(target.basis, person.id))
              stateGuards.push(liveDataFile(nodeId))
            }
            const current = `(select v.json_value from nodes n
              join node_versions v on v.id = n.current_version_id
              where n.id = ? and v.state = 'live')`
            const text = JSON.stringify(patch)
            dataGuards.push(
              {
                reason: 'mergeable',
                condition: {
                  sql: `json_type(${current}) = 'object' and json_type(json(?)) = 'object'`,
                  binds: [nodeId, text],
                },
              },
              {
                reason: 'size',
                condition: {
                  sql: `length(cast(json_patch(${current}, json(?)) as blob)) <= ?`,
                  binds: [nodeId, text, dataFileBytes],
                },
              },
            )
            const versionId = newId() as VersionId
            writes.push(
              {
                sql: `insert into node_versions (${VERSION_COLUMNS})
                      select ?1, ?2, ?3, ${NEXT_REVISION}, null, 'live', null, merged,
                        length(cast(merged as blob)), 'application/json', ?5, ?6, null,
                        ?7, ?8, ?9
                      from (select json_patch((select v.json_value from nodes n
                          join node_versions v on v.id = n.current_version_id
                          where n.id = ?2 and v.state = 'live'), json(?4)) as merged)`,
                binds: [
                  versionId,
                  nodeId,
                  t,
                  text,
                  person.id,
                  keyId,
                  provenance.seenPush,
                  provenance.opId,
                  now,
                ],
              },
              {
                sql: 'update nodes set current_version_id = ? where id = ?',
                binds: [versionId, nodeId],
              },
            )
            return makeVersionHandle(versionId, nodeId)
          },

          markDeleted: (node, mode) => {
            const t = tid()
            if (mode !== 'withdrawn') throw new Error(`no ${mode} mode yet`)
            bases.push(everyBasis(node.basis, person.id))
            stateGuards.push(liveDataFile(node.id))
            const versionId = newId() as VersionId
            writes.push(
              {
                // The bytes of uploads lose this file's references; a purge
                // reclaims what nothing else holds.
                sql: `update blobs set ref_count = ref_count -
                        (select count(*) from node_versions v where v.node_id = ?1
                           and v.blob_sha256 = blobs.sha256)
                      where sha256 in (select blob_sha256 from node_versions
                        where node_id = ?1 and blob_sha256 is not null)`,
                binds: [node.id],
              },
              {
                sql: 'delete from node_versions where node_id = ?',
                binds: [node.id],
              },
              {
                sql: `insert into node_versions (${VERSION_COLUMNS})
                      values (?1, ?2, ?3, 1, null, 'withdrawn', null, null, null, null,
                        ?4, ?5, null, null, null, ?6)`,
                binds: [versionId, node.id, t, person.id, keyId, now],
              },
              {
                sql: `update nodes set deleted_at = ?, current_version_id = ?
                      where id = ?`,
                binds: [now, versionId, node.id],
              },
              {
                sql: `update operations set result_state = 'withdrawn',
                        result_version_id = null
                      where result_node_id = ?`,
                binds: [node.id],
              },
            )
          },

          operation: (op) => {
            const result =
              op.result === 'withdrawn' ? null : versionOfHandle(op.result)
            writes.push({
              sql: `insert into operations (principal, scope, op_id, result_node_id,
                      result_version_id, result_state, created_at)
                    values (?, ?, ?, ?, ?, ?, ?)`,
              binds: [
                op.principal,
                op.scope,
                op.opId,
                result?.nodeId ?? null,
                result?.id ?? null,
                result === null ? 'withdrawn' : 'stored',
                now,
              ],
            })
          },

          putForms: (pushId) => {
            const t = tid()
            writes.push({
              sql: `insert into forms (host_version_id, host_node_id, tree_id, target_path,
                      form_key, kind, closes_at, closed, line, title, schema_json)
                    select n.current_version_id, n.id, ?1, f.target_path, f.form_key, f.kind,
                      f.closes_at, f.closed, f.line, f.title, f.schema_json
                    from push_forms f join nodes n on n.tree_id = ?1 and n.path = f.path
                      and n.deleted_at is null and n.kind = 'file' and n.origin = 'authored'
                      and n.current_version_id is not null
                    where f.push_id = ?2
                    on conflict do nothing`,
              binds: [t, pushId],
            })
          },

          event: (e) => {
            events.push(e)
          },
        }

        const result = yield* plan(cs)
        if (events.length === 0) {
          return yield* Effect.die(new Error('a change without an event'))
        }
        const t = tid()
        const statements: Statement[] = [
          ...creates,
          // Each guard row has its own id, so a change may hold several of
          // one kind; they all share the change's prefix.
          ...heads.map((g, i) => guardRow(`${guardId}:head${i}`, 'head', g)),
          guardRow(
            `${guardId}:basis`,
            'basis',
            allOf([callerLive(caller, now), ...bases]),
          ),
          ...(blobGuards.length === 0
            ? []
            : [guardRow(`${guardId}:blob`, 'blob', allOf(blobGuards))]),
          ...(stateGuards.length === 0
            ? []
            : [guardRow(`${guardId}:state`, 'state', allOf(stateGuards))]),
          ...dataGuards.map((g, i) =>
            guardRow(`${guardId}:${g.reason}${i}`, g.reason, g.condition),
          ),
          {
            sql: `update trees set authored_seq = authored_seq + ?, event_seq = event_seq + ?,
                      push_count = push_count + ? where id = ?`,
            binds: [authored, events.length, pushCount, t],
          },
          ...writes,
          ...(outcomes.length === 0
            ? []
            : [guardRow(`${guardId}:after`, 'state', allOf(outcomes))]),
          ...events.map((e, i) => ({
            sql: `insert into events (tree_id, seq, type, node_id, path, actor_id, push_id,
                      created_at)
                    values (?1, (select event_seq from trees where id = ?1) - ?2, ?3,
                      coalesce(?4, (select id from nodes where tree_id = ?1 and path = ?5
                                      and deleted_at is null)),
                      ?5, ?6, ?7, ?8)`,
            binds: [
              t,
              events.length - 1 - i,
              e.type,
              e.node === undefined
                ? null
                : isHandle(e.node)
                  ? handleId(e.node)
                  : e.node.id,
              e.path,
              person.id,
              e.pushId ?? null,
              now,
            ],
          })),
          {
            sql: 'delete from change_guards where substr(id, 1, ?) = ?',
            binds: [guardId.length + 1, `${guardId}:`],
          },
          {
            sql: `select authored_seq as authoredSeq, event_seq as eventSeq
                    from trees where id = ?`,
            binds: [t],
          },
        ]
        const results = yield* Effect.tryPromise({
          try: () =>
            DB.batch(statements.map((s) => DB.prepare(s.sql).bind(...s.binds))),
          catch: failureOf,
        })
        const last = results[results.length - 1]?.results[0] as
          | { authoredSeq: number; eventSeq: number }
          | undefined
        if (last === undefined) {
          return yield* Effect.die(new Error('the change read nothing back'))
        }
        // One line per event, naming who, what and which node; no secrets.
        events.forEach((e, i) => {
          console.log(
            JSON.stringify({
              message: 'tree event',
              tree: t,
              seq: last.eventSeq - (events.length - 1 - i),
              type: e.type,
              path: e.path,
              actor: person.id,
              key: keyId,
              push: e.pushId ?? null,
              requestId: caller.requestId,
            }),
          )
        })
        return {
          ...result,
          seq: last.eventSeq as EventSeq,
          authoredSeq: last.authoredSeq as AuthoredSeq,
          treeId: t,
        }
      })

    return {
      workspace,
      tree,
      locate,
      resolve,
      treeById,
      list,
      read: readFile,
      analysis,
      markdown,
      docs,
      holdBlob,
      confirmHold,
      dropHold,
      releaseHold,
      fileAt,
      forms,
      operationResult,
      change,
    } satisfies TreeStoreService
  }),
)
