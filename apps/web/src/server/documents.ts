import {
  isDocumentEditor,
  type AuthorSummary,
  type DocumentEditor,
  type EditLinkResponse,
  type DocumentView,
  type PurgeStatus,
  type SharesResponse,
  type Version,
  type Visibility,
} from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { Effect } from 'effect'

import {
  Db,
  Documents,
  PersistenceError,
  Shares,
  State,
  Tree,
  WorkerEnv,
  type PrincipalIdentity,
} from '../services'
import { verifyCsrf } from './csrf'
import { runSurface, type CoreServices, type SurfaceFailure } from './runtime'
import { resolveWeb, type Viewer } from './viewer'

/**
 * The dashboard reaches for two services the phase-one surface never named.
 * `CoreServicesLive` already builds both, so this only widens the requirement
 * type on the way into the one runner every web surface shares — the layer,
 * the scope, and the failure mapping stay exactly the shared ones.
 */
type WebServices = CoreServices | Tree | Shares | State

function runWeb<A, E>(
  effect: Effect.Effect<A, E, WebServices>,
): Promise<A | SurfaceFailure> {
  return runSurface(effect as Effect.Effect<A, E, CoreServices>)
}

export type DocumentScope = 'mine' | 'workspace'

/** One document plus the readable documents filed under it. */
export interface DashboardNode {
  readonly document: DocumentView
  readonly children: readonly DashboardNode[]
  /** Every readable document below this one, at any depth. */
  readonly descendants: number
  /** How many documents in this subtree, including itself, the viewer wrote. */
  readonly mine: number
}

export interface DashboardData {
  readonly viewer: Viewer
  readonly scope: DocumentScope
  /** The workspace forest. A document whose parent is unreadable is a root. */
  readonly nodes: readonly DashboardNode[]
  /** Readable documents outside this workspace — invited, or public elsewhere. */
  readonly shared: readonly DocumentView[]
  readonly total: number
  readonly mine: number
  readonly trashCount: number
  /** True when the workspace holds more documents than one page run collected. */
  readonly truncated: boolean
}

/** One archived batch the caller may restore, named by its root. */
export interface TrashBatch {
  readonly batchId: string | null
  /** Restore is authorised against the batch root, which is what trash lists. */
  readonly rootDocumentId: string
  readonly rootTitle: string
  readonly rootKind: string | null
  readonly deletedBy: string | null
  readonly deletedByAccountId: string | null
  readonly deletedAt: string | null
  readonly purgeStatus: PurgeStatus
  readonly purgesAt: string | null
  /** Every document the batch took, including other people's. */
  readonly deletedCount: number
  readonly authors: readonly AuthorSummary[]
}

/**
 * One of the caller's own documents that went to the trash inside someone
 * else's batch. It is not theirs to restore, so it is listed, named with the
 * batch that took it, and left alone (PLAN section 5.6).
 */
export interface SweptDocument {
  readonly id: string
  readonly title: string
  readonly kind: string | null
  readonly rootTitle: string
  readonly deletedBy: string | null
  readonly deletedByAccountId: string | null
  readonly deletedAt: string | null
}

export interface TrashData {
  readonly viewer: Viewer
  readonly batches: readonly TrashBatch[]
  readonly swept: readonly SweptDocument[]
  readonly retentionDays: number
}

/** A place a document may be filed under, flattened for a picker. */
export interface MoveDestination {
  readonly id: string
  readonly title: string
  readonly kind: string | null
  readonly authorName: string
  readonly depth: number
  /** Readable ancestors only; never contains a hidden parent. */
  readonly path: string
  readonly current: boolean
}

export interface Ancestor {
  readonly id: string
  readonly title: string
  /** Whether the viewer may open its management page, or only the document. */
  readonly editor: boolean
  readonly url: string
}

export interface DocumentDetailData {
  readonly viewer: Viewer
  readonly document: DocumentEditor
  readonly versions: readonly Version[]
  /** Configured invites on this node versus the ones actually in force. */
  readonly shares: SharesResponse
  readonly destinations: readonly MoveDestination[]
  readonly ancestors: readonly Ancestor[]
  readonly childCount: number
  readonly archivePreview: {
    /** Live descendants only; the root is not included. */
    readonly count: number
    readonly authors: readonly AuthorSummary[]
  }
  /**
   * Whether restoring is this document's call: only the root of a batch can
   * restore it, and a document swept into someone else's archive is not it.
   */
  readonly restorable: boolean
  readonly editLink: { readonly active: boolean }
}

function countTrash(workspaceId: string, accountId: string) {
  return Effect.gen(function* () {
    const db = yield* Db
    const row = yield* Effect.tryPromise({
      try: () =>
        db.raw
          .prepare(
            `SELECT COUNT(*) AS total
               FROM documents d
          LEFT JOIN memberships self
                 ON self.workspace_id = d.workspace_id AND self.account_id = ?
              WHERE d.workspace_id = ?
                AND d.deleted_at IS NOT NULL
                AND (d.created_by = ? OR self.role = 'admin')`,
          )
          .bind(accountId, workspaceId, accountId)
          .first<{ total: number }>(),
      catch: (cause) =>
        new PersistenceError({ operation: 'count trash', cause }),
    })
    return row?.total ?? 0
  })
}

interface SweptRow {
  readonly id: string
  readonly title: string
  readonly kind: string | null
  readonly root_title: string | null
  readonly deleted_by: string | null
  readonly deleted_by_account_id: string
  readonly created_at: string
}

/**
 * The caller's archived documents that are not the root of a batch they can
 * restore. `scope=trash` deliberately lists only restorable batch roots, so
 * this is the other half of the promise: an author always finds their own
 * document, and is told which archive swallowed it.
 */
function loadSwept(
  workspaceId: string,
  accountId: string,
  restorable: readonly string[],
) {
  return Effect.gen(function* () {
    const db = yield* Db
    const rows = yield* Effect.tryPromise({
      try: () =>
        db.raw
          .prepare(
            `SELECT d.id, d.title, d.kind,
                    COALESCE(b.root_title, root.title) AS root_title,
                    deleter.name AS deleted_by,
                    b.account_id AS deleted_by_account_id, b.created_at
               FROM documents d
               JOIN deletion_batches b ON b.id = d.deletion_batch_id
               JOIN documents root ON root.id = b.root_document_id
          LEFT JOIN accounts deleter ON deleter.id = b.account_id
              WHERE d.workspace_id = ?
                AND d.created_by = ?
                AND d.deleted_at IS NOT NULL
                AND b.restored_at IS NULL
                AND b.root_document_id <> d.id
                AND b.id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
              ORDER BY b.created_at DESC, d.title`,
          )
          .bind(workspaceId, accountId, JSON.stringify(restorable))
          .all<SweptRow>(),
      catch: (cause) =>
        new PersistenceError({ operation: 'load swept documents', cause }),
    })
    return rows.results.map((row): SweptDocument => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      rootTitle: row.root_title ?? 'an archived document',
      deletedBy: row.deleted_by,
      deletedByAccountId: row.deleted_by_account_id,
      deletedAt: row.created_at,
    }))
  })
}

/** A batch can only be restored through its own root (PLAN section 5.6). */
function isBatchRoot(batchId: string, documentId: string) {
  return Effect.gen(function* () {
    const db = yield* Db
    const row = yield* Effect.tryPromise({
      try: () =>
        db.raw
          .prepare(
            `SELECT 1 AS ok FROM deletion_batches
              WHERE id = ? AND root_document_id = ? AND restored_at IS NULL`,
          )
          .bind(batchId, documentId)
          .first<{ ok: number }>(),
      catch: (cause) =>
        new PersistenceError({ operation: 'check batch root', cause }),
    })
    return row?.ok === 1
  })
}

function loadArchivePreview(documentId: string) {
  return Effect.gen(function* () {
    const db = yield* Db
    const rows = yield* Effect.tryPromise({
      try: () =>
        db.raw
          .prepare(
            `WITH RECURSIVE subtree(id) AS (
               SELECT id FROM documents WHERE id = ?
               UNION ALL
               SELECT child.id FROM documents child
               JOIN subtree parent ON child.parent_id = parent.id
             )
             SELECT d.created_by, a.name AS author_name
               FROM documents d
               JOIN subtree ON subtree.id = d.id
               JOIN accounts a ON a.id = d.created_by
              WHERE d.deleted_at IS NULL
              ORDER BY d.id`,
          )
          .bind(documentId)
          .all<{ created_by: string; author_name: string }>(),
      catch: (cause) =>
        new PersistenceError({ operation: 'load archive preview', cause }),
    })
    const authors = new Map<string, AuthorSummary>()
    for (const row of rows.results) {
      const current = authors.get(row.created_by)
      authors.set(row.created_by, {
        accountId: row.created_by,
        name: row.author_name,
        count: (current?.count ?? 0) + 1,
      })
    }
    return {
      count: Math.max(0, rows.results.length - 1),
      authors: [...authors.values()].sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.accountId.localeCompare(right.accountId),
      ),
    }
  })
}

function readScope(value: unknown): DocumentScope {
  return value === 'workspace' ? 'workspace' : 'mine'
}

const PAGE = 100

/**
 * A tree needs every node, not the first page: the loader walks the cursor
 * until the scope is exhausted or the cap is reached, and says which happened
 * so the page can admit it is showing a slice.
 */
function listAll(
  scope: 'workspace' | 'readable',
  principal: PrincipalIdentity,
  maxPages: number,
) {
  return Effect.gen(function* () {
    const documents = yield* Documents
    const collected: DocumentView[] = []
    let cursor: string | undefined
    for (let page = 0; page < maxPages; page += 1) {
      const result = yield* documents.list(
        { scope, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) },
        principal,
      )
      collected.push(...result.documents)
      if (result.nextCursor === null) {
        return { documents: collected, truncated: false }
      }
      cursor = result.nextCursor
    }
    return { documents: collected, truncated: true }
  })
}

/**
 * Nests a flat page run by `parentId`. The DTO already nulls a parent the
 * viewer cannot read, so a hidden ancestor simply yields a virtual root —
 * the dashboard never learns the parent exists.
 */
export function buildForest(
  documents: readonly DocumentView[],
  accountId: string,
): readonly DashboardNode[] {
  const byId = new Map(documents.map((document) => [document.id, document]))
  const childIds = new Map<string, string[]>()
  const roots: string[] = []
  for (const document of documents) {
    const parentId = document.parentId
    if (parentId !== null && parentId !== document.id && byId.has(parentId)) {
      const siblings = childIds.get(parentId)
      if (siblings) siblings.push(document.id)
      else childIds.set(parentId, [document.id])
    } else {
      roots.push(document.id)
    }
  }

  // Kind, then title: the same order the hub page uses, so a document sits in
  // the same place in both views.
  const order = (left: string, right: string): number => {
    const a = byId.get(left)
    const b = byId.get(right)
    if (!a || !b) return 0
    return (
      (a.kind ?? '').localeCompare(b.kind ?? '') ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
    )
  }

  const placed = new Set<string>()
  const build = (id: string): DashboardNode => {
    placed.add(id)
    const document = byId.get(id)!
    const children = (childIds.get(id) ?? [])
      .filter((child) => !placed.has(child))
      .sort(order)
      .map(build)
    return {
      document,
      children,
      descendants: children.reduce(
        (total, child) => total + 1 + child.descendants,
        0,
      ),
      mine:
        (document.authorAccountId === accountId ? 1 : 0) +
        children.reduce((total, child) => total + child.mine, 0),
    }
  }

  const nodes = roots.sort(order).map(build)
  // Anything a broken parent link left unplaced still belongs on the page.
  const orphans = documents
    .filter((document) => !placed.has(document.id))
    .map((document) => document.id)
    .sort(order)
    .map(build)
  return [...nodes, ...orphans]
}

/** The workspace tree behind `/dashboard`, plus what other workspaces shared. */
export const loadDashboard = createServerFn({ method: 'GET' })
  .validator((input: unknown) => ({
    scope: readScope((input as { scope?: unknown } | undefined)?.scope),
  }))
  .handler(async ({ data }) => {
    const request = getRequest()
    return runWeb(
      Effect.gen(function* () {
        const { viewer, principal } = yield* resolveWeb(request)
        const workspace = yield* listAll('workspace', principal, 10)
        const readable = yield* listAll('readable', principal, 5)
        const inWorkspace = new Set(
          workspace.documents.map((document) => document.id),
        )
        const shared = readable.documents
          .filter((document) => !inWorkspace.has(document.id))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        const trashCount = yield* countTrash(
          viewer.workspaceId,
          viewer.accountId,
        )

        return {
          viewer,
          scope: data.scope,
          nodes: buildForest(workspace.documents, viewer.accountId),
          shared,
          total: workspace.documents.length,
          mine: workspace.documents.filter(
            (document) => document.authorAccountId === viewer.accountId,
          ).length,
          trashCount,
          truncated: workspace.truncated,
        } satisfies DashboardData
      }),
    )
  })

/** `/dashboard/trash` — the batches the caller may restore, and what they swept. */
export const loadTrash = createServerFn({ method: 'GET' }).handler(async () => {
  const request = getRequest()
  return runWeb(
    Effect.gen(function* () {
      const { viewer, principal } = yield* resolveWeb(request)
      const env = yield* WorkerEnv
      const configuredRetention = Number(env.PURGE_RETENTION_DAYS)
      const retentionDays =
        Number.isSafeInteger(configuredRetention) && configuredRetention > 0
          ? configuredRetention
          : 30
      const documents = yield* Documents
      // `scope=trash` answers with one document per batch: its root, carrying
      // the authors the batch swept up.
      const page = yield* documents.list(
        { scope: 'trash', limit: PAGE },
        principal,
      )

      const batchIds = page.documents
        .filter(isDocumentEditor)
        .map((document) => document.deletionBatchId)
        .filter((id): id is string => id !== null)
      const db = yield* Db
      const deleters =
        batchIds.length === 0
          ? new Map<string, string>()
          : new Map(
              (yield* Effect.tryPromise({
                try: () =>
                  db.raw
                    .prepare(
                      `SELECT id, account_id FROM deletion_batches
                        WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
                    )
                    .bind(JSON.stringify(batchIds))
                    .all<{ id: string; account_id: string }>(),
                catch: (cause) =>
                  new PersistenceError({
                    operation: 'load trash deleters',
                    cause,
                  }),
              })).results.map((row) => [row.id, row.account_id] as const),
            )

      const batches = page.documents
        .filter(isDocumentEditor)
        .map((document) => {
          const authors = document.authors ?? []
          return {
            batchId: document.deletionBatchId,
            rootDocumentId: document.id,
            rootTitle: document.deletionRootTitle ?? document.title,
            rootKind: document.kind,
            deletedBy: document.deletedBy,
            deletedByAccountId:
              document.deletionBatchId === null
                ? null
                : (deleters.get(document.deletionBatchId) ?? null),
            deletedAt: document.deletedAt,
            purgeStatus: document.purgeStatus ?? 'pending',
            purgesAt: document.purgesAt ?? null,
            deletedCount:
              authors.reduce((total, author) => total + author.count, 0) || 1,
            authors,
          } satisfies TrashBatch
        })

      const swept = yield* loadSwept(
        viewer.workspaceId,
        viewer.accountId,
        batches
          .map((batch) => batch.batchId)
          .filter((id): id is string => id !== null),
      )

      return { viewer, batches, swept, retentionDays } satisfies TrashData
    }),
  )
})

/** `/dashboard/documents/$id` — the editor view: versions, access, actions. */
export const loadDocument = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const id = (input as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string' || !/^[a-z0-9]{12}$/.test(id)) {
      throw new Error('A 12-character document id is required.')
    }
    return { id }
  })
  .handler(async ({ data }) => {
    const request = getRequest()
    return runWeb(
      Effect.gen(function* () {
        const { viewer, principal } = yield* resolveWeb(request)
        const documents = yield* Documents
        const result = yield* documents.get(data.id, principal)
        if (!isDocumentEditor(result.document)) {
          throw new Error('Document edit access is required.')
        }
        const document = result.document

        // Editor-only: both what this node configures and what is in force.
        const shares = yield* (yield* Shares).get(data.id, principal)
        const editLink = document.stateful
          ? yield* (yield* State).links.status(data.id, principal)
          : { active: false as const }

        // The move picker and the breadcrumb come from the same readable
        // forest the dashboard draws, so a destination offered here is one the
        // server will actually accept.
        const workspace = yield* listAll('workspace', principal, 10)
        const forest = buildForest(workspace.documents, viewer.accountId)
        const destinations: MoveDestination[] = []
        const walk = (
          nodes: readonly DashboardNode[],
          depth: number,
          ancestorTitles: readonly string[],
        ) => {
          for (const node of nodes) {
            if (node.document.id === data.id) continue
            if (!node.document.disabled) {
              destinations.push({
                id: node.document.id,
                title: node.document.title,
                kind: node.document.kind,
                authorName: node.document.authorName,
                depth,
                path:
                  ancestorTitles.length === 0
                    ? 'Workspace root'
                    : ancestorTitles.join(' / '),
                current: node.document.id === document.parentId,
              })
            }
            walk(node.children, depth + 1, [
              ...ancestorTitles,
              node.document.title,
            ])
          }
        }
        walk(forest, 0, [])

        const byId = new Map(
          workspace.documents.map((entry) => [entry.id, entry]),
        )
        const ancestors: Ancestor[] = []
        let parentId = document.parentId
        for (let hop = 0; hop < 16 && parentId !== null; hop += 1) {
          const parent = byId.get(parentId)
          if (!parent) break
          ancestors.unshift({
            id: parent.id,
            title: parent.title,
            editor: isDocumentEditor(parent),
            url: parent.url,
          })
          parentId = parent.parentId
        }

        const restorable =
          document.deletionBatchId === null
            ? false
            : yield* isBatchRoot(document.deletionBatchId, document.id)

        const archivePreview = yield* loadArchivePreview(data.id)

        return {
          viewer,
          document,
          versions: result.versions,
          shares,
          destinations,
          ancestors,
          childCount: workspace.documents.filter(
            (entry) => entry.parentId === data.id,
          ).length,
          archivePreview,
          restorable,
          editLink: { active: editLink.active },
        } satisfies DocumentDetailData
      }),
    )
  })

export type DocumentActionName =
  | 'disable'
  | 'enable'
  | 'delete'
  | 'restore'
  | 'visibility'
  | 'shares'
  | 'savers'
  | 'link_create'
  | 'link_revoke'
  | 'move'

export type DocumentActionResult =
  | {
      readonly ok: true
      readonly action: 'deleted'
      readonly batchId: string
      readonly deleted: number
      readonly authors: readonly AuthorSummary[]
    }
  | {
      /**
       * A delete refused for want of `force`. It is a successful question, not
       * a failure: the dialog can now name the count and the authors before
       * asking again.
       */
      readonly ok: true
      readonly action: 'has_children'
      readonly count: number
      readonly authors: readonly AuthorSummary[]
    }
  | {
      readonly ok: true
      readonly action: 'updated'
      readonly document: DocumentEditor
    }
  | {
      readonly ok: true
      readonly action: 'shares'
      readonly shares: SharesResponse
    }
  | {
      readonly ok: true
      readonly action: 'link'
      readonly link: EditLinkResponse
    }
  | SurfaceFailure

interface DocumentActionInput {
  readonly id: string
  readonly action: DocumentActionName
  readonly csrfToken: string
  readonly batchId?: string
  readonly reason?: string
  readonly force?: boolean
  /** `null` is inherit: the node stops carrying a boundary of its own. */
  readonly visibility?: Visibility | null
  /** `null` is the workspace root. */
  readonly parentId?: string | null
  readonly add?: readonly string[]
  readonly remove?: readonly string[]
  readonly addSavers?: readonly string[]
  readonly removeSavers?: readonly string[]
  readonly removeGrants?: readonly string[]
}

const ACTIONS = new Set<DocumentActionName>([
  'disable',
  'enable',
  'delete',
  'restore',
  'visibility',
  'shares',
  'savers',
  'link_create',
  'link_revoke',
  'move',
])

const VISIBILITIES = new Set(['public', 'team', 'private'])

function readEmails(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const emails = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 50)
  return emails.length > 0 ? emails : undefined
}

function hasChildrenDetails(details: unknown): {
  readonly count: number
  readonly authors: readonly AuthorSummary[]
} {
  const value = (details ?? {}) as { count?: unknown; authors?: unknown }
  const authors = Array.isArray(value.authors)
    ? value.authors.filter(
        (author): author is AuthorSummary =>
          typeof author === 'object' &&
          author !== null &&
          typeof (author as { name?: unknown }).name === 'string' &&
          typeof (author as { count?: unknown }).count === 'number',
      )
    : []
  return {
    count:
      typeof value.count === 'number'
        ? value.count
        : authors.reduce((total, author) => total + author.count, 0),
    authors,
  }
}

/**
 * The one write endpoint the dashboard uses. POST-only, Origin-checked, and
 * gated on a signed token bound to the signed-in account before any service
 * runs (PLAN section 6).
 */
export const documentAction = createServerFn({ method: 'POST' })
  .validator((input: unknown): DocumentActionInput => {
    const value = (input ?? {}) as Record<string, unknown>
    if (typeof value.id !== 'string' || !/^[a-z0-9]{12}$/.test(value.id)) {
      throw new Error('A 12-character document id is required.')
    }
    if (
      typeof value.action !== 'string' ||
      !ACTIONS.has(value.action as DocumentActionName)
    ) {
      throw new Error('Unknown document action.')
    }
    const action = value.action as DocumentActionName

    let visibility: Visibility | null | undefined
    if (action === 'visibility') {
      const level = value.visibility
      if (level === null || level === 'inherit') {
        visibility = null
      } else if (typeof level === 'string' && VISIBILITIES.has(level)) {
        visibility = level as Visibility
      } else {
        throw new Error('Pick public, team, private, or inherit.')
      }
    }

    let parentId: string | null | undefined
    if (action === 'move') {
      const destination = value.parentId
      if (destination === null || destination === 'root') {
        parentId = null
      } else if (
        typeof destination === 'string' &&
        /^[a-z0-9]{12}$/.test(destination)
      ) {
        parentId = destination
      } else {
        throw new Error('Pick a destination, or the workspace root.')
      }
    }

    const add = readEmails(value.add)
    const remove = readEmails(value.remove)
    const addSavers = readEmails(value.addSavers)
    const removeSavers = readEmails(value.removeSavers)
    const removeGrants = readEmails(value.removeGrants)
    if (action === 'shares' && add === undefined && remove === undefined) {
      throw new Error('Name at least one email to add or remove.')
    }
    if (
      action === 'savers' &&
      addSavers === undefined &&
      removeSavers === undefined &&
      removeGrants === undefined
    ) {
      throw new Error('Name at least one state grant to change.')
    }

    return {
      id: value.id,
      action,
      csrfToken: typeof value.csrfToken === 'string' ? value.csrfToken : '',
      ...(typeof value.batchId === 'string' ? { batchId: value.batchId } : {}),
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      ...(value.force === true ? { force: true } : {}),
      ...(visibility === undefined ? {} : { visibility }),
      ...(parentId === undefined ? {} : { parentId }),
      ...(add === undefined ? {} : { add }),
      ...(remove === undefined ? {} : { remove }),
      ...(addSavers === undefined ? {} : { addSavers }),
      ...(removeSavers === undefined ? {} : { removeSavers }),
      ...(removeGrants === undefined ? {} : { removeGrants }),
    }
  })
  .handler(async ({ data }): Promise<DocumentActionResult> => {
    const request = getRequest()
    return runWeb(
      Effect.gen(function* () {
        const { viewer, principal } = yield* resolveWeb(request)
        yield* verifyCsrf({
          request,
          token: data.csrfToken,
          accountId: viewer.accountId,
        })

        const documents = yield* Documents

        if (data.action === 'delete') {
          // `has_children` is the server asking for confirmation, so it is
          // caught here and handed back as an answer the dialog can render.
          const outcome = yield* documents
            .delete(data.id, principal, data.force ?? false)
            .pipe(
              Effect.map((result) => ({ kind: 'deleted' as const, result })),
              Effect.catchTag('DossierError', (error) =>
                error.code === 'has_children'
                  ? Effect.succeed({
                      kind: 'has_children' as const,
                      details: hasChildrenDetails(error.details),
                    })
                  : Effect.fail(error),
              ),
            )
          return outcome.kind === 'deleted'
            ? {
                ok: true as const,
                action: 'deleted' as const,
                batchId: outcome.result.batchId,
                deleted: outcome.result.deleted,
                authors: outcome.result.authors,
              }
            : {
                ok: true as const,
                action: 'has_children' as const,
                count: outcome.details.count,
                authors: outcome.details.authors,
              }
        }

        if (data.action === 'link_create') {
          const state = yield* State
          return {
            ok: true as const,
            action: 'link' as const,
            link: yield* state.links.create(data.id, principal),
          }
        }

        if (data.action === 'link_revoke') {
          const state = yield* State
          yield* state.links.revoke(data.id, principal)
          return {
            ok: true as const,
            action: 'link' as const,
            link: {
              documentId: data.id,
              active: false,
              editUrl: null,
            },
          }
        }

        if (data.action === 'shares' || data.action === 'savers') {
          const shares = yield* Shares
          return {
            ok: true as const,
            action: 'shares' as const,
            shares: yield* shares.delta(
              data.id,
              data.action === 'shares'
                ? {
                    ...(data.add === undefined ? {} : { add: data.add }),
                    ...(data.remove === undefined
                      ? {}
                      : { remove: data.remove }),
                  }
                : {
                    ...(data.addSavers === undefined
                      ? {}
                      : { addSavers: data.addSavers }),
                    ...(data.removeSavers === undefined
                      ? {}
                      : { removeSavers: data.removeSavers }),
                    ...(data.removeGrants === undefined
                      ? {}
                      : { removeGrants: data.removeGrants }),
                  },
              principal,
            ),
          }
        }

        if (data.action === 'visibility' || data.action === 'move') {
          const tree = yield* Tree
          return {
            ok: true as const,
            action: 'updated' as const,
            document: yield* tree.patch(
              data.id,
              data.action === 'visibility'
                ? { visibility: data.visibility ?? null }
                : { parentId: data.parentId ?? null },
              principal,
            ),
          }
        }

        const document =
          data.action === 'disable'
            ? yield* documents.disable(data.id, principal, data.reason ?? null)
            : data.action === 'enable'
              ? yield* documents.enable(data.id, principal)
              : yield* documents.restore(data.id, data.batchId ?? '', principal)

        return { ok: true as const, action: 'updated' as const, document }
      }),
    ) as Promise<DocumentActionResult>
  })
