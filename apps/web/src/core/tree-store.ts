import {
  commentsFolderIn,
  commentsFolderOf,
  dossierError,
  type AuthoredSeq,
  type EventsResponse,
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
import type { CommentEntry, JsonObject } from '@dossier/contracts/bridge'
import {
  MARKDOWN_VERSION,
  toMarkdown,
  type FormSchema,
  type HtmlAnalysis,
} from '@dossier/html'
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import { Clock, Context, Effect, Layer } from 'effect'

import { db, schema } from '../db/client.ts'
import {
  Access,
  type Action,
  type Basis,
  type Granted,
  type Membership,
  type Role,
} from './access.ts'
import type { Background } from './background.ts'
import type { BaseLayer } from './base-layer.ts'
import { Bindings } from './bindings.ts'
import { ChangeFeed, type CloseSockets, type Committed } from './change-feed.ts'
import { makeSystemStore, SystemJob, type SystemStore } from './system-store.ts'
import { CurrentCaller, type Caller } from './caller.ts'
import { openCursor, sealCursor } from './cursors.ts'
import { callerRefOf, callersCte, visibleEventSql } from './event-visibility.ts'
import { newId, newTreeId } from './ids.ts'
import { bytesText, Limits } from './limits.ts'
import type { PageNeedRow } from './page-needs.ts'
import {
  analysisOf,
  authoredFileAt as lookupFileAt,
  lookupUnderscore,
  pathAtSql,
  underscoreSplit,
  type KitFound,
} from './lookup.ts'
import {
  ancestorPaths,
  type MissingNode,
  type NodeRow,
  type TreeRow,
  type VersionRow,
  type WorkspaceRow,
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
      /**
       * The file's tree path at the sequence asked: where it stood then,
       * which differs from `node.path` when it has moved since.
       */
      readonly path?: string
    }
  | {
      readonly kind: 'file'
      readonly node: NodeRow
      readonly version: VersionRow
      readonly tree: TreeRow
      readonly path?: string
    }
  /** A folder without index.html. */
  | { readonly kind: 'folder'; readonly node: NodeRow; readonly tree: TreeRow }
  | {
      readonly kind: 'redirect'
      readonly node: NodeRow
      readonly tree: TreeRow
      /** The link's path inside the tree, encoded. */
      readonly to: string
      /**
       * A tree that moved to another workspace or name: where its link is
       * now. Absent for a redirect inside the tree as it was asked.
       */
      readonly place?: { readonly workspace: string; readonly tree: string }
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
  /** A move's new path; a restore's point, "push 9" or an ISO time. */
  readonly detail?: string
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

/** What a restore makes of each node, as Files read the tree. */
export interface RestorePlan {
  /** Files given back the content of an earlier version, live again. */
  readonly revive: readonly {
    readonly node: NodeRow
    readonly from: VersionRow
  }[]
  /** Live files the point did not hold, deleted. */
  readonly remove: readonly NodeRow[]
  /** Deleted folders the revived files sit in, live again. */
  readonly folders: readonly NodeRow[]
  /** Authored folders the change leaves with no live file below, deleted. */
  readonly empty: readonly NodeRow[]
  /** A deleted tree, live again with its root. */
  readonly tree: boolean
  /**
   * The forms of each page or layout brought back, as its content declares
   * them where it stands now.
   */
  readonly forms: readonly {
    readonly node: NodeRow
    readonly rows: readonly NewFormRow[]
  }[]
}

/** A form as a push stages it, by the file that holds it. */
export interface NewFormRow {
  readonly target: string
  readonly key: string
  readonly kind: string
  readonly closesAt: number | null
  readonly closed: number
  readonly line: number
  readonly title: string | null
  readonly schema: string
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
  /**
   * Makes the pushed folder's authored files match the staged manifest, and
   * names the pushed folder, new or existing, for steps after it.
   */
  readonly putStaged: (
    target: Granted<'write'> | NodeHandle,
    pushId: PushId,
  ) => NodeHandle
  /**
   * A share on the node, or a new role for the target's share there. A role
   * changed in place closes the target's sockets like a revoke.
   */
  readonly grant: (on: Granted<'share'> | NodeHandle, share: NewShare) => void
  /**
   * Also records whose watching sockets close after the commit: the person
   * an email share names, or every socket on the tree for any other share.
   */
  readonly revoke: (on: Granted<'share'>, shareId: ShareId) => void
  /**
   * Removes whatever share the target holds on the node when the batch
   * runs, closing sockets as `revoke` does: a share another change made
   * since it was read goes too.
   */
  readonly revokeTarget: (
    on: Granted<'share'>,
    target: Omit<NewShare, 'role'>,
  ) => void
  /**
   * A data folder or file at `node.path`; folders missing on the way are
   * created as data folders nobody owns. `under` is what the writer holds.
   */
  readonly createData: (
    under: Granted<'respond' | 'write' | 'comment'>,
    node: NewDataNode,
  ) => NodeHandle
  /** A new version of a data file: a JSON value or an upload's bytes. */
  readonly putData: (
    node: NodeHandle | Granted<'respond' | 'write'>,
    version: NewDataVersion,
  ) => VersionHandle
  /**
   * Merges a JSON object into the file's value as RFC 7396 says. A writer
   * revises their own comment through `withdraw-own`, its ownership.
   */
  readonly mergeJson: (
    node: NodeHandle | Granted<'respond' | 'write' | 'withdraw-own'>,
    patch: JsonObject,
    provenance: DataProvenance,
  ) => VersionHandle
  /**
   * Deletes the content of every earlier version of a comment entry, leaves
   * one live version holding `blanked` (its text '' and no mentions), and
   * deletes the comment's mentions rows; the node and its path stay, so its
   * thread still holds together.
   */
  readonly blank: (
    comment: Granted<'withdraw-own' | 'delete-data'>,
    blanked: CommentEntry,
  ) => VersionHandle
  /**
   * A 'mention' event at `path` and the mentions row keyed by that event's
   * seq, for a comment on the page the grant is on.
   */
  readonly mention: (
    page: Granted<'comment'>,
    m: {
      readonly comment: NodeHandle | NodeRow
      readonly email: string
      readonly path: string
      /** Holds while the person still reads the page, checked in the batch. */
      readonly reads: Statement
    },
  ) => void
  /** Fails the change unless what the grant rests on still holds. */
  readonly holds: (granted: Granted<Action>) => void
  /**
   * Fails the change unless the comment still holds its text: a revision
   * never brings back a comment deleted since it was read.
   */
  readonly guardCommentText: (comment: NodeRow) => void
  /**
   * 'withdrawn': every version's content deleted, one content-free
   * 'withdrawn' version left, the node deleted, its operations reduced to
   * 'withdrawn', and its blobs' references counted down. A folder of the
   * writer's goes only when the change leaves it empty.
   *
   * 'deleted': a write holder's delete, a change in history like a push. A
   * 'deleted' version for the file, or for every live file below a folder,
   * and every node below the folder deleted with it; all earlier versions
   * stay, so it can be restored until the purge. The tree root takes the
   * tree with it.
   */
  readonly markDeleted: (
    node: Granted<'write' | 'delete-data' | 'withdraw-own'>,
    mode: 'withdrawn' | 'deleted',
  ) => void
  /**
   * Makes files and folders match an earlier point: new versions holding
   * the content of the versions given, deleted nodes live again, and files
   * the point did not hold deleted. Copies no bytes. Fails the change when
   * anything it read has changed, or a version it copies is gone.
   */
  readonly restore: (node: Granted<'write'>, plan: RestorePlan) => void
  /**
   * The only writer of nodes.path: the node and everything below it move to
   * `to`, a path alias kept for each, and form targets inside follow.
   * `folders`: the folders on the way to create first, outermost first.
   */
  readonly move: (
    node: Granted<'write'>,
    to: string,
    folders: readonly string[],
    /**
     * A page's comments folder renamed with its page: the thread paths its
     * entries name (`replyTo`, `resolves`, `reopens`) follow.
     */
    refs?: { readonly from: string; readonly to: string },
  ) => void
  /**
   * A new authored version of an existing file, as a move's rewritten
   * links make: its forms rows are the previous version's, and the hold
   * on its bytes goes with the commit.
   */
  readonly putVersion: (
    file: Granted<'write'>,
    version: {
      readonly sha256: Sha256
      readonly size: number
      readonly contentType: string
      readonly hold: { readonly kind: 'move'; readonly id: string }
      /** The version it replaces, which must still be current. */
      readonly previous: VersionId
    },
  ) => void
  /** The tree to another workspace or name; its old link stays as an alias. */
  readonly moveTree: (
    root: Granted<'write'>,
    to: Membership,
    name: string,
    /** Where the tree was when the move read it; it must still be there. */
    was: { readonly workspaceId: string; readonly name: string },
  ) => void
  /**
   * Fails the change if any live answer of `owner` in the folder `own`,
   * other than `except`, names one of `files` (relative to `own`): an
   * upload a withdrawal takes must be one no answer still names.
   */
  readonly guardUnnamed: (i: {
    readonly owner: PersonId
    readonly own: string
    readonly files: readonly string[]
    readonly except: NodeId
  }) => void
  /** Records a data write's result under its operation ID. */
  readonly operation: (op: NewOperation) => void
  /** The forms the push staged, for the versions it leaves current. */
  readonly putForms: (pushId: PushId) => void
  /** What every page of the tree carries now, replacing what was there. */
  readonly putPageNeeds: (
    needs: readonly PageNeedRow[],
    /** Takes from what a shared page carried: close every socket. */
    narrowed?: boolean,
  ) => void
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
  /**
   * The node a path names: a folder, a file, or the page `path.html`. With
   * `deleted`, for history and restore only: the newest deleted node at the
   * path when no live one holds it, and a deleted tree by its name when no
   * live tree has it.
   */
  readonly locate: (
    ref: LinkRef,
    opts?: { readonly deleted?: boolean },
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
  /** A node by its ID, live or deleted, or null. */
  readonly nodeById: (
    id: NodeId,
  ) => Effect.Effect<NodeRow | null, DossierError<'unavailable'>>
  /** The deepest live node at or above a tree path, or null. */
  readonly nearest: (
    treeId: TreeId,
    path: string,
  ) => Effect.Effect<NodeRow | null, DossierError<'unavailable'>>
  /** A live tree by its ID or as '<workspace>/<tree>', or null. */
  readonly treeNamed: (
    tree: string,
  ) => Effect.Effect<
    { readonly tree: TreeRow; readonly workspace: WorkspaceRow } | null,
    DossierError<'unavailable'>
  >
  /**
   * One D1 batch: the change and its events, or nothing. Once committed, the
   * change is published to whoever follows the tree, in the background.
   */
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
    CurrentCaller | Background
  >
  /**
   * What removes rows and bytes. Only a job the Worker runs itself holds a
   * SystemJob; no request does.
   */
  readonly system: Effect.Effect<SystemStore, never, SystemJob>
  /**
   * The tree's events after a cursor that the caller may read now, with a
   * cursor that moves past those it may not.
   */
  readonly events: (i: {
    readonly tree: string
    /** A cursor this route or a view gave; null for the cursor now. */
    readonly after: string | null
    readonly path: string | null
  }) => Effect.Effect<
    EventsResponse,
    DossierError<'not_found' | 'sign_in_required' | 'invalid' | 'unavailable'>,
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

export interface Statement {
  readonly sql: string
  readonly binds: readonly unknown[]
  /** Reads the statement's rows once the batch has run. */
  readonly rows?: (rows: readonly unknown[]) => void
}

/** At most this many events a page of the events route. */
const EVENTS_PAGE = 500

/** Event types written by people's data, which always name the writer. */
const DATA_EVENTS: ReadonlySet<string> = new Set([
  'submission',
  'entry',
  'withdrawal',
  'data_write',
])

const TREE_ID = /^[a-z0-9]{20}$/

interface HandleValue {
  readonly handle: true
  readonly id: NodeId
  /** The live folder a staged push lands in, which the change itself writes. */
  readonly pushed?: PushId
}

const isHandle = (value: unknown): value is NodeHandle =>
  typeof value === 'object' &&
  value !== null &&
  (value as Partial<HandleValue>).handle === true

const handleId = (h: NodeHandle): NodeId => (h as unknown as HandleValue).id

const makeHandle = (id: NodeId): NodeHandle =>
  ({ handle: true, id }) satisfies HandleValue as unknown as NodeHandle

/** The folder a push lands in, new or existing, read when the batch runs. */
const pushedHandle = (pushId: PushId): NodeHandle =>
  ({
    handle: true,
    id: '' as NodeId,
    pushed: pushId,
  }) satisfies HandleValue as unknown as NodeHandle

/** SQL for a node's id: a known id, or the folder a push lands in. */
const nodeIdSql = (on: NodeRow | NodeHandle, treeId: string): Statement => {
  if (!isHandle(on)) return { sql: '?', binds: [on.id] }
  const value = on as unknown as HandleValue
  return value.pushed === undefined
    ? { sql: '?', binds: [value.id] }
    : {
        sql: `(select n.id from nodes n join pushes p on p.id = ?
                where n.tree_id = ? and n.path = p.path and n.deleted_at is null
                  and n.kind = 'folder')`,
        binds: [value.pushed, treeId],
      }
}

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

/** The share's tree is in a workspace neither suspended nor deleted. */
const SHARE_WORKSPACE_OPEN = `exists (select 1 from trees t join workspaces w on w.id = t.workspace_id
  where t.id = s.tree_id and w.deleted_at is null and w.suspended_at is null)`

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
        sql: `exists (select 1 from shares s where s.id = ? and s.role = ?${extra}
                and ${SHARE_WORKSPACE_OPEN})`,
        binds: [basis.shareId, basis.role, ...(extra === '' ? [] : [personId])],
      }
    }
    case 'admin':
      return {
        sql: `exists (select 1 from workspace_members m join workspaces w on w.id = m.workspace_id
                where m.workspace_id = ? and m.user_id = ? and m.role = 'admin'
                  and w.deleted_at is null and w.suspended_at is null)`,
        binds: [basis.workspaceId, basis.userId],
      }
    case 'member':
      return {
        sql: `exists (select 1 from workspace_members m join workspaces w on w.id = m.workspace_id
                where m.workspace_id = ? and m.user_id = ? and w.deleted_at is null
                  and w.suspended_at is null)`,
        binds: [basis.workspaceId, basis.userId],
      }
    // A team share reaches its members while they stay in the team and the
    // workspace.
    case 'team-member':
      return {
        sql: `exists (select 1 from team_members tm join teams t on t.id = tm.team_id
                join workspace_members m on m.workspace_id = t.workspace_id
                  and m.user_id = tm.user_id
                where tm.team_id = ? and tm.user_id = ? and t.workspace_id = ?)`,
        binds: [basis.teamId, basis.userId, basis.workspaceId],
      }
    // Reach and what is carried give read only, which no change rests on.
    case 'reach':
    case 'carried':
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
  reason:
    | 'head'
    | 'basis'
    | 'blob'
    | 'state'
    | 'mergeable'
    | 'size'
    | 'storage',
  condition: Statement,
): Statement => ({
  sql: `insert into change_guards (id, reason, ok)
        select ?, '${reason}', coalesce((${condition.sql}), 0)`,
  binds: [guardId, ...condition.binds],
})

/** What a failed batch means for the person who asked. */
/** What a change says when a data file would pass its limit. */
export const DATA_FILE_TOO_LARGE =
  'This would make the data file larger than a data file may be.'

/** What a failed batch means for the person who asked. */
const failureOf = (error: unknown, storageBytes: number): ChangeFailure => {
  const text = String(error instanceof Error ? error.message : error)
  if (text.includes('change_guard_storage')) {
    return dossierError(
      'too_large',
      `This workspace has reached its ${bytesText(storageBytes)} storage limit. A super admin can raise it.`,
      null,
    )
  }
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
      DATA_FILE_TOO_LARGE,
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
              number = (select push_count from trees where id = ?1),
              authored_seq = (select authored_seq from trees where id = ?1)
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

/** A nodes row read with plain SQL, as Drizzle would give it. */
export const nodeOfRaw = (row: Record<string, unknown>): NodeRow =>
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
  Bindings | Access | BaseLayer | Limits | ChangeFeed
> = Layer.effect(
  TreeStore,
  Effect.gen(function* () {
    const context = yield* Effect.context<Bindings | BaseLayer>()
    const bindings = yield* Bindings
    const access = yield* Access
    const limits = yield* Limits
    const feed = yield* ChangeFeed
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

    const locate = (ref: LinkRef, opts: { readonly deleted?: boolean } = {}) =>
      Effect.gen(function* () {
        const missing = (treeId: TreeId | null): MissingNode => ({
          missing: true,
          treeId,
          path: ref.path,
        })
        const ws = yield* workspace(ref.workspace)
        if (ws === null) return missing(null)
        const found =
          (yield* tree(ws, ref.tree)) ??
          (opts.deleted === true ? yield* deletedTree(ws, ref.tree) : null)
        if (found === null) return missing(null)
        // A deleted tree's nodes are all deleted: only history reaches them.
        if (found.deletedAt !== null || opts.deleted === true) {
          const live =
            found.deletedAt === null ? yield* locateLive(ref, found) : null
          if (live !== null) return live
          return (yield* locateDeleted(ref, found)) ?? missing(found.id)
        }
        return (yield* locateLive(ref, found)) ?? missing(found.id)
      })

    /** The newest deleted tree of a name in a workspace. */
    const deletedTree = (ws: WorkspaceRow, name: string) =>
      read(() =>
        database
          .select()
          .from(schema.trees)
          .where(
            and(
              eq(schema.trees.workspaceId, ws.id),
              eq(schema.trees.name, name),
              sql`${schema.trees.deletedAt} is not null`,
            ),
          )
          .orderBy(sql`${schema.trees.deletedAt} desc`)
          .limit(1)
          .get(),
      ).pipe(
        Effect.map((row) => (row ?? null) as TreeRow | null),
        Effect.orDie,
      )

    /** The newest deleted node a path names, as locate reads a path. */
    const locateDeleted = (ref: LinkRef, found: TreeRow) =>
      Effect.gen(function* () {
        const candidates =
          ref.folder || ref.path === ''
            ? [ref.path]
            : [ref.path, `${ref.path}.html`]
        for (const path of candidates) {
          const node = yield* read(() =>
            database
              .select()
              .from(schema.nodes)
              .where(
                and(
                  eq(schema.nodes.treeId, found.id),
                  eq(schema.nodes.path, path),
                  sql`${schema.nodes.deletedAt} is not null`,
                ),
              )
              .orderBy(sql`${schema.nodes.deletedAt} desc`)
              .limit(1)
              .get(),
          )
          if (node === undefined) continue
          const row = node as NodeRow
          if (row.kind === 'folder') {
            return { kind: 'folder', node: row, tree: found } satisfies Located
          }
          if (ref.folder) continue
          const id = row.currentVersionId
          const version =
            id === null
              ? undefined
              : yield* read(() =>
                  database
                    .select()
                    .from(schema.nodeVersions)
                    .where(eq(schema.nodeVersions.id, id))
                    .get(),
                )
          if (version === undefined) continue
          return {
            kind: 'file',
            node: row,
            version: version as VersionRow,
            tree: found,
          } satisfies Located
        }
        return null
      })

    const locateLive = (ref: LinkRef, found: TreeRow) =>
      Effect.gen(function* () {
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
        return null
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
      Effect.map(fileThen(treeId, path, at), (found) =>
        found === null ? null : { node: found.node, version: found.version },
      )

    /** As fileAt, with the file's path at the sequence. */
    const fileThen = (treeId: TreeId, path: string, at?: AuthoredSeq) =>
      Effect.gen(function* () {
        const live = () =>
          Effect.map(liveFile(treeId, path), (found) =>
            found === null ? null : { ...found, path: found.node.path },
          )
        if (at === undefined) return yield* live()
        const authored = yield* lookupFileAt({ treeId, path, at }).pipe(
          Effect.provide(context),
        )
        if (authored !== null) return authored
        const now = yield* live()
        return now !== null && now.node.origin === 'data' ? now : null
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
        const n = schema.nodes
        // The folder that stood at the path then, by its path then.
        const then = pathAtSql(sql`${n.id}`, sql`${n.path}`, at)
        const node = yield* read(() =>
          database
            .select()
            .from(n)
            .where(
              and(
                eq(n.treeId, treeId),
                eq(n.kind, 'folder'),
                sql`(${n.path} = ${path} or ${n.id} in (select pa.node_id
                  from path_aliases pa where pa.tree_id = ${treeId}
                    and pa.old_path = ${path} and pa.moved_at_seq > ${at}))`,
                sql`${then} = ${path}`,
              ),
            )
            .orderBy(sql`${n.deletedAt} is not null`, sql`${n.createdAt} desc`)
            .limit(1)
            .get(),
        )
        if (node === undefined) return null
        if (path === '') return node as NodeRow
        // A file that stood below it then, live at that sequence.
        const thenFile = pathAtSql(sql`f.id`, sql`f.path`, at)
        const below = (p: SQL) =>
          sql`substr(${p}, 1, length(${path}) + 1) = ${`${path}/`}`
        const held = yield* read(() =>
          database.all<{ held: number }>(
            sql`select 1 as held from nodes f
              where f.tree_id = ${treeId} and f.kind = 'file' and f.origin = 'authored'
                and (${below(sql`f.path`)} or f.id in (select pa.node_id
                  from path_aliases pa where pa.tree_id = ${treeId}
                    and pa.moved_at_seq > ${at} and ${below(sql`pa.old_path`)}))
                and ${below(thenFile)}
                and (select v.state from node_versions v
                       where v.node_id = f.id and v.authored_seq <= ${at}
                       order by v.authored_seq desc, v.revision desc limit 1) = 'live'
              limit 1`,
          ),
        )
        return held.length === 0 ? null : (node as NodeRow)
      })

    const resolve = (ref: LinkRef | TreeRef, at?: AuthoredSeq) =>
      Effect.gen(function* () {
        let found: TreeRow | null
        if ('treeId' in ref) {
          found = (yield* treeById(ref.treeId))?.tree ?? null
        } else {
          const ws = yield* workspace(ref.workspace)
          found = ws === null ? null : yield* tree(ws, ref.tree)
          // An old link of a tree that moved: the same path where it is now.
          if (found === null && at === undefined) {
            const moved = yield* movedTree(ref.workspace, ref.tree)
            if (moved !== null) {
              return {
                kind: 'redirect',
                node: moved.root,
                tree: moved.tree,
                to: linkPathOf(ref.path, ref.folder || ref.path === ''),
                place: moved.place,
              } satisfies Resolved
            }
          }
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
        // The file's path at the sequence asked decides its link there.
        const page = (file: {
          node: NodeRow
          version: VersionRow
          path: string
        }) => {
          const linkPath = linkPathOf(pageLinkPath(file.path), false)
          return linkPath === asked
            ? ({
                kind: 'page',
                node: file.node,
                version: file.version,
                path: file.path,
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
        const answer = yield* Effect.gen(function* () {
          if (ref.folder || ref.path === '') {
            const folder = yield* folderAt(t.id, ref.path, at)
            if (folder === null) return missing()
            const index = yield* fileThen(
              t.id,
              joinPath(ref.path, 'index.html'),
              at,
            )
            if (index !== null && index.node.origin === 'authored') {
              return page(index)
            }
            return { kind: 'folder', node: folder, tree: t } satisfies Resolved
          }
          const html = yield* fileThen(t.id, `${ref.path}.html`, at)
          // People's data is never a page, whatever its name.
          if (html !== null && html.node.origin === 'authored') {
            return page(html)
          }
          const folder = yield* folderAt(t.id, ref.path, at)
          if (folder !== null) {
            return {
              kind: 'redirect',
              node: folder,
              tree: t,
              to: linkPathOf(ref.path, true),
            } satisfies Resolved
          }
          const file = yield* fileThen(t.id, ref.path, at)
          if (file === null) return missing()
          if (
            file.node.origin === 'authored' &&
            file.node.name.endsWith('.html')
          ) {
            return page(file)
          }
          return {
            kind: 'file',
            node: file.node,
            version: file.version,
            path: file.path,
            tree: t,
          } satisfies Resolved
        })
        // Now, a path a move left leads to where its node is; a live node
        // at the path always wins, and a pinned sequence never redirects.
        if (!('missing' in answer) || at !== undefined) return answer
        return (yield* movedFrom(t, ref)) ?? answer
      })

    /**
     * Where a node that left this path lives now: the newest move away from
     * the path (or, for a page link, its `.html` file) whose node is live.
     */
    const movedFrom = (t: TreeRow, ref: LinkRef | TreeRef) =>
      Effect.gen(function* () {
        const candidates =
          ref.folder || ref.path === ''
            ? [ref.path]
            : [`${ref.path}.html`, ref.path]
        for (const path of candidates) {
          const row = yield* read(() =>
            DB.prepare(
              `select n.* from path_aliases pa join nodes n on n.id = pa.node_id
               where pa.tree_id = ? and pa.old_path = ? and n.deleted_at is null
               order by pa.moved_at_seq desc limit 1`,
            )
              .bind(t.id, path)
              .first<Record<string, unknown>>(),
          )
          if (row === null) continue
          const node = nodeOfRaw(row)
          const to =
            node.kind === 'folder'
              ? linkPathOf(node.path, true)
              : node.origin === 'authored' && node.name.endsWith('.html')
                ? linkPathOf(pageLinkPath(node.path), false)
                : linkPathOf(node.path, false)
          return { kind: 'redirect', node, tree: t, to } satisfies Resolved
        }
        return null
      })

    /**
     * A tree that moved to another workspace or name, by its old link: its
     * root as it is now, and where its link went.
     */
    const movedTree = (workspaceName: string, treeName: string) =>
      Effect.gen(function* () {
        const row = yield* read(() =>
          DB.prepare(
            `select t.id as treeId, w.name as workspace, t.name as tree
             from tree_aliases a join trees t on t.id = a.tree_id
               join workspaces w on w.id = t.workspace_id
             where a.workspace_name = ? and a.tree_name = ?
               and t.deleted_at is null and w.deleted_at is null`,
          )
            .bind(workspaceName, treeName)
            .first<{ treeId: TreeId; workspace: string; tree: string }>(),
        )
        if (row === null) return null
        const found = yield* treeById(row.treeId)
        if (found === null) return null
        const root = yield* liveNode(found.tree.id, '')
        return root === null
          ? null
          : {
              tree: found.tree,
              root,
              place: { workspace: row.workspace, tree: row.tree },
            }
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
        const { dataFileBytes, storageBytes } = yield* limits.current()
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
        /** That each person mentioned still reads the page. */
        const mentionGuards: Statement[] = []
        /** Mentions rows, each keyed by the seq of the event at `event`. */
        const mentioned: {
          readonly event: number
          readonly commentId: string
          readonly pageId: NodeId
          readonly email: string
        }[] = []
        /** Whose sockets the revoked shares close, as the batch read them. */
        const closing: (CloseSockets | null)[] = []
        let authored = 0
        /** A step changed authored files: the sequence moves once. */
        let authoredTouched = false
        let pushCount = 0
        /** The change stores new bytes, so the workspace's storage counts. */
        let grows = false

        /** Nothing live sits under a file or a deleted folder. */
        const liveUnderLive = (t: TreeId): Statement => ({
          sql: `not exists (select 1 from nodes c join nodes p on p.id = c.parent_id
                  where c.tree_id = ? and c.deleted_at is null
                    and (p.kind <> 'folder' or p.deleted_at is not null))`,
          binds: [t],
        })

        /** A write holder's delete of a node and everything below it. */
        const deletedWrites = (
          t: TreeId,
          node: Granted<'write' | 'delete-data' | 'withdraw-own'>,
        ) => {
          bases.push(everyBasis(node.basis, person.id))
          stateGuards.push({
            sql: `exists (select 1 from nodes where id = ? and path = ?
                    and deleted_at is null)`,
            binds: [node.id, node.path],
          })
          if (node.origin === 'authored') authoredTouched = true
          // ?1 tree · ?2 node · ?3 its path · ?4 now · ?5 author · ?6 key
          const below = `(n.id = ?2 or ${under('n.path', '?3')})`
          const binds = [t, node.id, node.path, now, person.id, keyId]
          writes.push(
            {
              sql: `insert into node_versions (${VERSION_COLUMNS})
                    select lower(hex(randomblob(16))), n.id, ?1,
                      (select coalesce(max(r.revision), 0) + 1 from node_versions r
                         where r.node_id = n.id),
                      case when n.origin = 'authored'
                        then (select authored_seq from trees where id = ?1) end,
                      'deleted', null, null, null, null, ?5, ?6, null, null, null, ?4
                    from nodes n where n.tree_id = ?1 and n.deleted_at is null
                      and n.kind = 'file' and ${below}`,
              binds,
            },
            {
              sql: `update nodes set deleted_at = ?4, current_version_id =
                      case when kind = 'file' then (select v.id from node_versions v
                        where v.node_id = nodes.id order by v.revision desc limit 1)
                      else current_version_id end
                    where tree_id = ?1 and deleted_at is null
                      and (id = ?2 or ${under('path', '?3')})`,
              binds: binds.slice(0, 4),
            },
          )
          // The tree root takes the tree with it.
          if (node.depth === 0) {
            writes.push({
              sql: 'update trees set deleted_at = ? where id = ?',
              binds: [now, t],
            })
          }
        }

        const cs: ChangeSet = {
          guardHead: (path, base) => {
            heads.push({
              sql: `not exists (select 1 from node_versions v join nodes n on n.id = v.node_id
                        where v.tree_id = ? and n.origin = 'authored' and v.authored_seq > ?
                          and ${under('n.path', '?')})`,
              binds: [tid(), base, path, path, path, path],
            })
            // The whole tree: a move writes no version, but moves its
            // sequence.
            if (path === '') {
              heads.push({
                sql: '(select authored_seq from trees where id = ?) <= ?',
                binds: [tid(), base],
              })
            }
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
            grows = true
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
            return pushedHandle(pushId)
          },

          grant: (on, share) => {
            const t = tid()
            if (!isHandle(on)) bases.push(everyBasis(on.basis, person.id))
            const node = nodeIdSql(on, t)
            // The node is still there, as Access saw it.
            if (!isHandle(on)) {
              stateGuards.push({
                sql: 'exists (select 1 from nodes where id = ? and deleted_at is null)',
                binds: [on.id],
              })
            }
            // A team deleted since the share was asked for gets nothing, and
            // only a member of its workspace shares with it.
            if (share.targetKind === 'team') {
              stateGuards.push({
                sql: `exists (select 1 from teams tt join trees tr on tr.workspace_id = tt.workspace_id
                        join workspace_members wm on wm.workspace_id = tt.workspace_id
                          and wm.user_id = ?
                        where tt.id = ? and tr.id = ?)`,
                binds: [person.id, share.target, t],
              })
            }
            writes.push(
              {
                // A role changed in place is lost access for its target
                // when it is lower: their sockets close as on a revoke.
                sql: `select s.target_kind as kind,
                        (select u.id from "user" u where lower(u.email) = s.target) as person
                      from shares s where s.node_id = ${node.sql}
                        and s.target_kind = ? and s.target = ? and s.role <> ?`,
                binds: [
                  ...node.binds,
                  share.targetKind,
                  share.target,
                  share.role,
                ],
                rows: (rows) => {
                  for (const row of rows as {
                    kind: string
                    person: PersonId | null
                  }[]) {
                    closing.push(
                      row.kind === 'email'
                        ? row.person === null
                          ? null
                          : { people: [row.person] }
                        : { all: true },
                    )
                  }
                },
              },
              {
                sql: `insert into shares (id, tree_id, node_id, target_kind, target, role,
                        created_by, created_at)
                      values (?, ?, ${node.sql}, ?, ?, ?, ?, ?)
                      on conflict (node_id, target_kind, target) do update set role = excluded.role`,
                binds: [
                  newId(),
                  t,
                  ...node.binds,
                  share.targetKind,
                  share.target,
                  share.role,
                  person.id,
                  now,
                ],
              },
            )
          },

          revoke: (on, shareId) => {
            bases.push(everyBasis(on.basis, person.id))
            writes.push(
              {
                // Read before the row goes: whose sockets to close.
                sql: `select s.target_kind as kind,
                        (select u.id from "user" u where lower(u.email) = s.target) as person
                      from shares s where s.id = ? and s.node_id = ?`,
                binds: [shareId, on.id],
                rows: (rows) => {
                  for (const row of rows as {
                    kind: string
                    person: PersonId | null
                  }[]) {
                    closing.push(
                      row.kind === 'email'
                        ? row.person === null
                          ? null
                          : { people: [row.person] }
                        : { all: true },
                    )
                  }
                },
              },
              {
                sql: 'delete from shares where id = ? and node_id = ?',
                binds: [shareId, on.id],
              },
            )
          },

          revokeTarget: (on, target) => {
            bases.push(everyBasis(on.basis, person.id))
            stateGuards.push({
              sql: 'exists (select 1 from nodes where id = ? and deleted_at is null)',
              binds: [on.id],
            })
            writes.push(
              {
                // Read before the row goes: whose sockets to close.
                sql: `select s.target_kind as kind,
                        (select u.id from "user" u where lower(u.email) = s.target) as person
                      from shares s where s.node_id = ? and s.target_kind = ? and s.target = ?`,
                binds: [on.id, target.targetKind, target.target],
                rows: (rows) => {
                  for (const row of rows as {
                    kind: string
                    person: PersonId | null
                  }[]) {
                    closing.push(
                      row.kind === 'email'
                        ? row.person === null
                          ? null
                          : { people: [row.person] }
                        : { all: true },
                    )
                  }
                },
              },
              {
                sql: 'delete from shares where node_id = ? and target_kind = ? and target = ?',
                binds: [on.id, target.targetKind, target.target],
              },
            )
          },

          createData: (holder, node) => {
            const t = tid()
            // A grant on a page creates in no page's comments folder but its own.
            const inComments = commentsFolderIn(node.path)
            if (
              inComments !== null &&
              holder.origin === 'authored' &&
              holder.kind === 'file' &&
              `${inComments}/` !== commentsFolderOf(holder.path)
            ) {
              throw new Error(
                'a page grant creates only in its comments folder',
              )
            }
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
            grows = true
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
            grows = true
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
            if (mode === 'deleted') {
              deletedWrites(t, node)
              return
            }
            bases.push(everyBasis(node.basis, person.id))
            if (node.kind === 'folder') {
              // A writer's own folder goes once nothing lives in it, after
              // the files of this change.
              writes.push({
                sql: `update nodes set deleted_at = ?1
                      where id = ?2 and deleted_at is null and origin = 'data'
                        and not exists (select 1 from nodes c where c.parent_id = ?2
                          and c.deleted_at is null)`,
                binds: [now, node.id],
              })
              return
            }
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

          restore: (node, made) => {
            const t = tid()
            bases.push(everyBasis(node.basis, person.id))
            // What it brings back is stored again, history included.
            if (made.revive.length > 0) grows = true
            if (
              made.revive.some((r) => r.node.origin === 'authored') ||
              made.remove.some((r) => r.origin === 'authored')
            ) {
              authoredTouched = true
            }
            const revive = JSON.stringify(
              made.revive.map((r) => ({
                node: r.node.id,
                from: r.from.id,
                expect: r.node.currentVersionId,
                live: r.node.deletedAt === null ? 1 : 0,
              })),
            )
            const remove = JSON.stringify(
              made.remove.map((n) => ({
                node: n.id,
                expect: n.currentVersionId,
              })),
            )
            const folders = JSON.stringify(made.folders.map((f) => f.id))
            const empty = JSON.stringify(made.empty.map((f) => f.id))
            // Everything is as it was read, and every version copied is
            // still there: a purge that got there first fails the change.
            stateGuards.push(
              {
                sql: `not exists (select 1 from json_each(?) j
                        left join nodes n on n.id = json_extract(j.value, '$.node')
                        left join node_versions pv
                          on pv.id = json_extract(j.value, '$.from')
                          and pv.node_id = n.id and pv.state = 'live'
                        where n.id is null or pv.id is null or n.tree_id <> ?
                          or n.current_version_id is not json_extract(j.value, '$.expect')
                          or (n.deleted_at is null) <> json_extract(j.value, '$.live'))`,
                binds: [revive, t],
              },
              {
                sql: `not exists (select 1 from json_each(?) j
                        left join nodes n on n.id = json_extract(j.value, '$.node')
                        where n.id is null or n.deleted_at is not null or n.tree_id <> ?
                          or n.current_version_id is not json_extract(j.value, '$.expect'))`,
                binds: [remove, t],
              },
              {
                sql: `not exists (select 1 from json_each(?) j
                        left join nodes n on n.id = j.value
                        where n.id is null or n.deleted_at is null or n.tree_id <> ?)`,
                binds: [folders, t],
              },
            )
            // Their bytes are still there and nobody is reclaiming them.
            blobGuards.push({
              sql: `not exists (select 1 from json_each(?) j
                      join node_versions pv on pv.id = json_extract(j.value, '$.from')
                      left join blobs b on b.sha256 = pv.blob_sha256
                      where pv.blob_sha256 is not null
                        and (b.sha256 is null or b.state <> 'live'))`,
              binds: [revive],
            })
            if (made.tree) {
              writes.push({
                sql: 'update trees set deleted_at = null where id = ?',
                binds: [t],
              })
            }
            // Files the point did not hold go first, so nothing the restore
            // brings back meets them at a path.
            writes.push(
              {
                sql: `insert into node_versions (${VERSION_COLUMNS})
                      select lower(hex(randomblob(16))), n.id, ?1,
                        (select coalesce(max(r.revision), 0) + 1 from node_versions r
                           where r.node_id = n.id),
                        case when n.origin = 'authored'
                          then (select authored_seq from trees where id = ?1) end,
                        'deleted', null, null, null, null, ?3, ?4, null, null, null, ?5
                      from json_each(?2) j
                        join nodes n on n.id = json_extract(j.value, '$.node')`,
                binds: [t, remove, person.id, keyId, now],
              },
              {
                sql: `update nodes set deleted_at = ?3, current_version_id =
                        (select v.id from node_versions v where v.node_id = nodes.id
                           order by v.revision desc limit 1)
                      where tree_id = ?1 and id in
                        (select json_extract(j.value, '$.node') from json_each(?2) j)`,
                binds: [t, remove, now],
              },
            )
            writes.push(
              {
                sql: `update nodes set deleted_at = null
                      where tree_id = ?1 and id in (select value from json_each(?2))`,
                binds: [t, folders],
              },
              {
                sql: `insert into node_versions (${VERSION_COLUMNS})
                      select lower(hex(randomblob(16))), n.id, ?1,
                        (select coalesce(max(r.revision), 0) + 1 from node_versions r
                           where r.node_id = n.id),
                        case when n.origin = 'authored'
                          then (select authored_seq from trees where id = ?1) end,
                        'live', pv.blob_sha256, pv.json_value, pv.size, pv.content_type,
                        pv.author_id, pv.key_id, pv.push_id, pv.seen_push_number, null, ?3
                      from json_each(?2) j
                        join nodes n on n.id = json_extract(j.value, '$.node')
                        join node_versions pv on pv.id = json_extract(j.value, '$.from')`,
                // The content stays its writer's, and the push that wrote
                // it stays its push: the restore event names who restored it.
                binds: [t, revive, now],
              },
              {
                sql: `update blobs set ref_count = ref_count +
                        (select count(*) from json_each(?1) j
                          join node_versions pv on pv.id = json_extract(j.value, '$.from')
                          where pv.blob_sha256 = blobs.sha256)
                      where sha256 in (select pv.blob_sha256 from json_each(?1) j
                        join node_versions pv on pv.id = json_extract(j.value, '$.from'))`,
                binds: [revive],
              },
              {
                sql: `update nodes set deleted_at = null, current_version_id =
                        (select v.id from node_versions v where v.node_id = nodes.id
                           order by v.revision desc limit 1)
                      where tree_id = ?1 and id in
                        (select json_extract(j.value, '$.node') from json_each(?2) j)`,
                binds: [t, revive],
              },
              {
                // The forms its content declares where it stands now, by
                // its new version.
                sql: `insert into forms (host_version_id, host_node_id, tree_id, target_path,
                        form_key, kind, closes_at, closed, line, title, schema_json)
                      select n.current_version_id, n.id, ?1,
                        json_extract(f.value, '$.target'), json_extract(f.value, '$.key'),
                        json_extract(f.value, '$.kind'), json_extract(f.value, '$.closesAt'),
                        json_extract(f.value, '$.closed'), json_extract(f.value, '$.line'),
                        json_extract(f.value, '$.title'), json_extract(f.value, '$.schema')
                      from json_each(?2) j
                        join nodes n on n.id = json_extract(j.value, '$.node')
                        join json_each(json_extract(j.value, '$.rows')) f
                      where true on conflict do nothing`,
                binds: [
                  t,
                  JSON.stringify(
                    made.forms.map((f) => ({ node: f.node.id, rows: f.rows })),
                  ),
                ],
              },
              {
                sql: `update nodes set deleted_at = ?3
                      where tree_id = ?1 and deleted_at is null
                        and id in (select value from json_each(?2))`,
                binds: [t, empty, now],
              },
            )
            outcomes.push(liveUnderLive(t))
          },

          move: (node, to, folders, refs) => {
            const t = tid()
            authoredTouched = true
            bases.push(everyBasis(node.basis, person.id))
            // Still live where Access saw it.
            stateGuards.push({
              sql: `exists (select 1 from nodes where id = ? and path = ?
                      and deleted_at is null)`,
              binds: [node.id, node.path],
            })
            const segments = to.split('/')
            for (const folder of folders) {
              const depth = folder.split('/').length
              writes.push({
                sql: `insert into nodes (${NODE_COLUMNS})
                      select lower(hex(randomblob(16))), ?1,
                        (select p.id from nodes p where p.tree_id = ?1 and p.path = ?2
                           and p.deleted_at is null),
                        ?3, ?4, ?5, 'folder', 'authored', null, null, ?6, null
                      where not exists (select 1 from nodes n where n.tree_id = ?1
                        and n.path = ?4 and n.deleted_at is null)`,
                binds: [
                  t,
                  parentPath(folder),
                  folder.split('/').at(-1) ?? folder,
                  folder,
                  depth,
                  now,
                ],
              })
            }
            // The node and what lies below it by its folders, deleted nodes
            // included: their history goes with them.
            const subtree = `with recursive sub(id) as (select ?2
              union all select c.id from nodes c join sub on c.parent_id = sub.id)`
            writes.push(
              {
                sql: `${subtree}
                      insert into path_aliases (tree_id, old_path, node_id, moved_at_seq,
                        created_at)
                      select ?1, n.path, n.id, (select authored_seq from trees where id = ?1),
                        ?3
                      from nodes n where n.id in (select id from sub)`,
                binds: [t, node.id, now],
              },
              {
                sql: `${subtree}
                      update nodes set path = ?3 || substr(path, length(?4) + 1),
                        depth = depth + ?5
                      where id in (select id from sub)`,
                binds: [
                  t,
                  node.id,
                  to,
                  node.path,
                  segments.length - node.depth,
                ],
              },
              {
                sql: `update nodes set name = ?2,
                        parent_id = (select p.id from nodes p where p.tree_id = ?3
                          and p.path = ?4 and p.deleted_at is null and p.kind = 'folder')
                      where id = ?1`,
                binds: [node.id, segments.at(-1) ?? to, t, parentPath(to)],
              },
              ...(refs === undefined
                ? []
                : (['replyTo', 'resolves', 'reopens'] as const).map((key) => ({
                    sql: `${subtree}
                          update node_versions
                          set json_value = json_set(json_value, '$.${key}',
                            ?4 || substr(json_extract(json_value, '$.${key}'), length(?3) + 1))
                          where node_id in (select id from sub) and json_value is not null
                            and substr(json_extract(json_value, '$.${key}'), 1, length(?3) + 1)
                              = ?3 || '/'`,
                    binds: [t, node.id, refs.from, refs.to],
                  }))),
              {
                // Forms that send inside what moved follow it.
                sql: `update forms set target_path = ?2 || substr(target_path, length(?3) + 1)
                      where tree_id = ?1 and (target_path = ?3
                        or substr(target_path, 1, length(?3) + 1) = ?3 || '/')`,
                binds: [t, to, node.path],
              },
            )
            outcomes.push(
              {
                sql: `exists (select 1 from nodes n join nodes p on p.id = n.parent_id
                        where n.id = ? and n.path = ? and n.deleted_at is null
                          and p.kind = 'folder' and p.deleted_at is null)`,
                binds: [node.id, to],
              },
              liveUnderLive(t),
            )
          },

          putVersion: (file, version) => {
            const t = tid()
            grows = true
            authoredTouched = true
            bases.push(everyBasis(file.basis, person.id))
            stateGuards.push({
              sql: `exists (select 1 from nodes where id = ? and deleted_at is null
                      and current_version_id = ?)`,
              binds: [file.id, version.previous],
            })
            blobGuards.push({
              sql: `exists (select 1 from blobs where sha256 = ? and state = 'live')
                    and exists (select 1 from blob_holds where holder_kind = ?
                      and holder_id = ? and sha256 = ? and verified = 1)`,
              binds: [
                version.sha256,
                version.hold.kind,
                version.hold.id,
                version.sha256,
              ],
            })
            const versionId = newId() as VersionId
            writes.push(
              {
                sql: `insert into node_versions (${VERSION_COLUMNS})
                      select ?1, ?2, ?3,
                        (select coalesce(max(r.revision), 0) + 1 from node_versions r
                           where r.node_id = ?2),
                        (select authored_seq from trees where id = ?3), 'live', ?4, null,
                        (select size from blobs where sha256 = ?4), ?5,
                        (select author_id from node_versions where id = ?6),
                        (select key_id from node_versions where id = ?6),
                        (select push_id from node_versions where id = ?6),
                        null, null, ?7`,
                // Only its links changed: the page stays its pusher's and
                // its push's, and the move event names who moved it.
                binds: [
                  versionId,
                  file.id,
                  t,
                  version.sha256,
                  version.contentType,
                  version.previous,
                  now,
                ],
              },
              {
                sql: 'update blobs set ref_count = ref_count + 1 where sha256 = ?',
                binds: [version.sha256],
              },
              {
                sql: 'update nodes set current_version_id = ? where id = ?',
                binds: [versionId, file.id],
              },
              {
                sql: `insert into forms (host_version_id, host_node_id, tree_id, target_path,
                        form_key, kind, closes_at, closed, line, title, schema_json)
                      select ?1, host_node_id, tree_id, target_path, form_key, kind,
                        closes_at, closed, line, title, schema_json
                      from forms where host_version_id = ?2
                      on conflict do nothing`,
                binds: [versionId, version.previous],
              },
              {
                sql: `delete from blob_holds where holder_kind = ? and holder_id = ?
                        and sha256 = ?`,
                binds: [version.hold.kind, version.hold.id, version.sha256],
              },
            )
          },

          moveTree: (root, to, name, was) => {
            const t = tid()
            // Still where the move read it, and live.
            stateGuards.push({
              sql: `exists (select 1 from trees where id = ? and workspace_id = ?
                      and name = ? and deleted_at is null)`,
              binds: [t, was.workspaceId, was.name],
            })
            // A composed page holds its tree's names: a new sequence keeps
            // the cache from serving the old ones.
            authoredTouched = true
            bases.push(everyBasis(root.basis, person.id))
            bases.push(everyBasis([to.basis], person.id))
            writes.push(
              {
                sql: `insert into tree_aliases (workspace_name, tree_name, tree_id, created_at)
                      select w.name, t.name, t.id, ?2 from trees t
                        join workspaces w on w.id = t.workspace_id where t.id = ?1
                      on conflict (workspace_name, tree_name)
                        do update set tree_id = excluded.tree_id,
                          created_at = excluded.created_at`,
                binds: [t, now],
              },
              {
                sql: 'update trees set workspace_id = ?, name = ? where id = ?',
                binds: [to.workspace.id, name, t],
              },
            )
          },

          blank: (comment, blanked) => {
            const t = tid()
            bases.push(everyBasis(comment.basis, person.id))
            stateGuards.push(liveDataFile(comment.id))
            const versionId = newId() as VersionId
            const text = JSON.stringify(blanked)
            writes.push(
              {
                // One version is left, keeping the push its writer saw.
                sql: `insert into node_versions (${VERSION_COLUMNS})
                      select ?1, ?2, ?3, ${NEXT_REVISION}, null, 'live', null, json(?4),
                        length(cast(json(?4) as blob)), 'application/json', ?5, ?6, null,
                        (select v.seen_push_number from nodes n
                           join node_versions v on v.id = n.current_version_id
                           where n.id = ?2),
                        null, ?7`,
                binds: [versionId, comment.id, t, text, person.id, keyId, now],
              },
              {
                sql: 'update nodes set current_version_id = ? where id = ?',
                binds: [versionId, comment.id],
              },
              {
                sql: 'delete from node_versions where node_id = ? and id <> ?',
                binds: [comment.id, versionId],
              },
              {
                sql: 'update node_versions set revision = 1 where id = ?',
                binds: [versionId],
              },
              {
                // A replay of what wrote it answers the blank version.
                sql: `update operations set result_version_id = ?
                      where result_node_id = ? and result_state = 'stored'`,
                binds: [versionId, comment.id],
              },
              {
                sql: 'delete from mentions where comment_node_id = ?',
                binds: [comment.id],
              },
            )
            return makeVersionHandle(versionId, comment.id)
          },

          mention: (page, m) => {
            bases.push(everyBasis(page.basis, person.id))
            // The read rule is large: each check is a statement of its own.
            mentionGuards.push(m.reads)
            events.push({ type: 'mention', path: m.path, node: m.comment })
            mentioned.push({
              event: events.length - 1,
              commentId: isHandle(m.comment)
                ? handleId(m.comment)
                : m.comment.id,
              pageId: page.id,
              email: m.email.toLowerCase(),
            })
          },

          holds: (granted) => {
            bases.push(everyBasis(granted.basis, person.id))
          },

          guardCommentText: (comment) => {
            stateGuards.push({
              sql: `exists (select 1 from nodes n join node_versions v
                      on v.id = n.current_version_id
                      where n.id = ? and n.deleted_at is null
                        and json_type(v.json_value, '$.text') = 'text'
                        and json_extract(v.json_value, '$.text') <> '')`,
              binds: [comment.id],
            })
          },

          guardUnnamed: (g) => {
            const t = tid()
            if (g.files.length === 0) return
            stateGuards.push({
              sql: `not exists (select 1 from nodes n
                      join node_versions v on v.id = n.current_version_id
                      where n.tree_id = ? and n.owner_id = ? and n.deleted_at is null
                        and n.origin = 'data' and n.kind = 'file' and n.id <> ?
                        and n.path like '%.json'
                        and (n.path = ? || '.json'
                          or (substr(n.path, 1, length(?) + 1) = ? || '/'
                            and n.depth = ?))
                        and v.json_value is not null
                        and exists (select 1 from json_tree(v.json_value) j
                          where j.key = 'file'
                            and j.value in (select value from json_each(?))))`,
              binds: [
                t,
                g.owner,
                g.except,
                g.own,
                g.own,
                g.own,
                g.own.split('/').length + 1,
                JSON.stringify(g.files),
              ],
            })
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

          putPageNeeds: (needs, narrowed = false) => {
            const t = tid()
            if (narrowed) closing.push({ all: true })
            writes.push({
              sql: 'delete from page_needs where tree_id = ?',
              binds: [t],
            })
            for (let at = 0; at < needs.length; at += 200) {
              writes.push({
                sql: `insert into page_needs (tree_id, page_path, need_path, kind, host_path,
                        reads, responds)
                      select ?, json_extract(j.value, '$.page'), json_extract(j.value, '$.need'),
                        json_extract(j.value, '$.kind'), json_extract(j.value, '$.host'),
                        json_extract(j.value, '$.reads'), json_extract(j.value, '$.responds')
                      from json_each(?) j where true on conflict do nothing`,
                binds: [
                  t,
                  JSON.stringify(
                    needs.slice(at, at + 200).map((n) => ({
                      ...n,
                      reads: n.reads ? 1 : 0,
                      responds: n.responds ? 1 : 0,
                    })),
                  ),
                ],
              })
            }
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
          ...mentionGuards.map((g, i) =>
            guardRow(`${guardId}:mention${i}`, 'state', g),
          ),
          ...dataGuards.map((g, i) =>
            guardRow(`${guardId}:${g.reason}${i}`, g.reason, g.condition),
          ),
          {
            sql: `update trees set authored_seq = authored_seq + ?, event_seq = event_seq + ?,
                      push_count = push_count + ? where id = ?`,
            binds: [
              authored === 0 && authoredTouched ? 1 : authored,
              events.length,
              pushCount,
              t,
            ],
          },
          ...writes,
          ...(outcomes.length === 0
            ? []
            : [guardRow(`${guardId}:after`, 'state', allOf(outcomes))]),
          // Every version stored counts, history included, across the
          // workspace's trees, as it stands with this change's writes.
          ...(grows
            ? [
                guardRow(`${guardId}:storage`, 'storage', {
                  sql: `(select coalesce(sum(coalesce(v.size, length(v.json_value), 0)), 0)
                          from node_versions v join trees t on t.id = v.tree_id
                          where t.workspace_id = (select workspace_id from trees where id = ?))
                        <= ?`,
                  binds: [t, storageBytes],
                }),
              ]
            : []),
          ...events.map((e, i) => ({
            sql: `insert into events (tree_id, seq, type, node_id, path, actor_id, push_id,
                      created_at, detail)
                    values (?1, (select event_seq from trees where id = ?1) - ?2, ?3,
                      coalesce(?4, (select id from nodes where tree_id = ?1 and path = ?5
                                      and deleted_at is null)),
                      ?5, ?6, ?7, ?8, ?9)`,
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
              e.detail ?? null,
            ],
          })),
          ...mentioned.map((m) => ({
            sql: `insert into mentions (tree_id, event_seq, comment_node_id, page_node_id,
                      email, created_at)
                    values (?1, (select event_seq from trees where id = ?1) - ?2, ?3, ?4, ?5, ?6)`,
            binds: [
              t,
              events.length - 1 - m.event,
              m.commentId,
              m.pageId,
              m.email,
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
          catch: (error) => failureOf(error, storageBytes),
        })
        statements.forEach((s, i) => s.rows?.(results[i]?.results ?? []))
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
        yield* feed.published({
          treeId: t,
          seq: last.eventSeq as EventSeq,
          authoredSeq: last.authoredSeq as AuthoredSeq,
          events: events.map((e, i) => ({
            seq: (last.eventSeq - (events.length - 1 - i)) as EventSeq,
            type: e.type,
            path: e.path,
          })),
          close: closeOf(closing),
        } satisfies Committed)
        return {
          ...result,
          seq: last.eventSeq as EventSeq,
          authoredSeq: last.authoredSeq as AuthoredSeq,
          treeId: t,
        }
      })

    const nodeById: TreeStoreService['nodeById'] = (id) =>
      read(() =>
        database
          .select()
          .from(schema.nodes)
          .where(eq(schema.nodes.id, id))
          .get(),
      ).pipe(Effect.map((row) => (row ?? null) as NodeRow | null))

    const nearest: TreeStoreService['nearest'] = (treeId, path) =>
      Effect.gen(function* () {
        const paths = ancestorPaths(path.replace(/^\/+|\/+$/g, ''))
        const row = yield* read(() =>
          database
            .select()
            .from(schema.nodes)
            .where(
              and(
                eq(schema.nodes.treeId, treeId),
                isNull(schema.nodes.deletedAt),
                sql`${schema.nodes.path} in (${sql.join(
                  paths.map((p) => sql`${p}`),
                  sql`, `,
                )})`,
              ),
            )
            .orderBy(sql`${schema.nodes.depth} desc`)
            .limit(1)
            .get(),
        )
        return (row ?? null) as NodeRow | null
      })

    const treeNamed: TreeStoreService['treeNamed'] = (name) =>
      Effect.gen(function* () {
        if (TREE_ID.test(name)) return yield* treeById(name as TreeId)
        const [ws = '', tr = '', ...rest] = name.split('/')
        if (rest.length > 0) return null
        const found = yield* workspace(ws)
        if (found === null) return null
        const row = yield* tree(found, tr)
        return row === null ? null : { tree: row, workspace: found }
      })

    const events: TreeStoreService['events'] = (i) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const found = yield* treeNamed(i.tree)
        const deny = (treeId: TreeId | null) =>
          access
            .require('read', {
              missing: true,
              treeId,
              path: i.path ?? '',
            })
            .pipe(
              Effect.flatMap(() => Effect.fail(dossierError('not_found'))),
              Effect.mapError((e) =>
                e.code === 'sign_in_required'
                  ? (e as DossierError<'sign_in_required'>)
                  : dossierError('not_found'),
              ),
            )
        if (found === null) return yield* deny(null)
        const t = found.tree
        const readable = yield* access.readable(t.id)
        // The caller follows a path it may read, or, without one, anything
        // in the tree it may read.
        if (i.path !== null) {
          const node = yield* nearest(t.id, i.path)
          if (node === null) return yield* deny(t.id)
          yield* access
            .require('read', node)
            .pipe(
              Effect.mapError((e) =>
                e.code === 'sign_in_required'
                  ? (e as DossierError<'sign_in_required'>)
                  : dossierError('not_found'),
              ),
            )
        } else {
          const any = yield* read(() =>
            database
              .select({ one: sql<number>`1` })
              .from(schema.nodes)
              .where(and(readable.where, isNull(schema.nodes.deletedAt)))
              .limit(1)
              .all(),
          )
          if (any.length === 0) return yield* deny(t.id)
        }
        const secret = bindings.HANDLE_SECRET
        const who = caller.person?.id ?? ''
        const seal = (seq: number) =>
          Effect.promise(() => sealCursor(secret, t.id, seq, who))
        if (i.after === null) {
          return {
            events: [],
            next: yield* seal(t.eventSeq),
            more: false,
          } satisfies EventsResponse
        }
        const afterText = i.after
        const after = yield* Effect.promise(() =>
          openCursor(secret, t.id, afterText, who),
        )
        if (after === null) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'This cursor is not one this tree gave you.',
              'Start again without after.',
            ),
          )
        }
        const ref = callerRefOf(caller, t.id)
        if (ref === null || found.workspace.suspendedAt !== null) {
          return {
            events: [],
            next: yield* seal(Math.max(after, t.eventSeq)),
            more: false,
          } satisfies EventsResponse
        }
        // Only what the caller may see is ever scanned for, so a page is
        // short and `more` is set only by the visible events that follow.
        const rows = (yield* read(() =>
          database.all(sql`with ${callersCte(t.id, t.workspaceId, [ref])}
            select e.seq as seq, e.type as type, e.path as path,
              e.created_at as at, e.actor_id as actorId, p.number as push,
              u.email as email, u.name as name,
              exists (select 1 from workspace_members m
                where m.workspace_id = ${t.workspaceId} and m.user_id = cs.person) as member
            from events e
              left join pushes p on p.id = e.push_id
              left join "user" u on u.id = e.actor_id
              join cs on cs.i = 0
            where e.tree_id = ${t.id} and e.seq > ${after}
              and ${visibleEventSql(t.id, t.workspaceId, sql`${i.path}`)}
            order by e.seq
            limit ${EVENTS_PAGE + 1}`),
        )) as {
          seq: number
          type: string
          path: string
          at: number
          actorId: string | null
          push: number | null
          email: string | null
          name: string | null
          member: number
        }[]
        const more = rows.length > EVENTS_PAGE
        const page = rows.slice(0, EVENTS_PAGE)
        const listed = yield* Effect.forEach(page, (row) =>
          Effect.map(seal(row.seq), (cursor) => {
            const named =
              DATA_EVENTS.has(row.type) ||
              row.member === 1 ||
              (caller.person !== null && caller.person.id === row.actorId)
            return {
              cursor,
              type: row.type as EventType,
              path: row.path,
              at: new Date(row.at).toISOString(),
              by:
                row.actorId === null
                  ? null
                  : ((named ? row.email : row.name) ?? null),
              push: (row.push ?? null) as PushNumber | null,
            }
          }),
        )
        const last = page.at(-1)?.seq ?? after
        return {
          events: listed,
          // Past what the caller may not see, up to the tree's head.
          next: yield* seal(more ? last : Math.max(last, t.eventSeq)),
          more,
        } satisfies EventsResponse
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
      nodeById,
      nearest,
      treeNamed,
      change,
      events,
      system: Effect.map(SystemJob, () => makeSystemStore(bindings)),
    } satisfies TreeStoreService
  }),
)

/** One close for every revoked share: everyone, or the people named. */
const closeOf = (
  closing: readonly (CloseSockets | null)[],
): CloseSockets | null => {
  if (closing.some((c) => c !== null && 'all' in c)) return { all: true }
  const people = closing.flatMap((c) =>
    c !== null && 'people' in c ? c.people : [],
  )
  return people.length === 0 ? null : { people: [...new Set(people)] }
}
