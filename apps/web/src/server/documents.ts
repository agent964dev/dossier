import type { DocumentEditor, Version } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { Effect } from 'effect'

import { Db, Documents, PersistenceError } from '../services'
import { verifyCsrf } from './csrf'
import { runSurface, type SurfaceFailure } from './runtime'
import { resolveWeb, type Viewer } from './viewer'

export type DocumentScope = 'mine' | 'workspace'

export interface DashboardData {
  readonly viewer: Viewer
  readonly scope: DocumentScope
  readonly documents: readonly DocumentEditor[]
  readonly trashCount: number
}

export interface TrashBatch {
  readonly batchId: string | null
  readonly rootTitle: string
  readonly deletedBy: string | null
  readonly deletedAt: string | null
  /** How many documents the batch archived, including any the caller cannot see. */
  readonly deletedCount: number
  /** The batch root first, then the rest — the caller's visible slice. */
  readonly documents: readonly DocumentEditor[]
}

export interface TrashData {
  readonly viewer: Viewer
  readonly batches: readonly TrashBatch[]
}

export interface DocumentDetailData {
  readonly viewer: Viewer
  readonly document: DocumentEditor
  readonly versions: readonly Version[]
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
      catch: (cause) => new PersistenceError({ operation: 'count trash', cause }),
    })
    return row?.total ?? 0
  })
}


interface BatchRoot {
  readonly rootDocumentId: string
  readonly accountName: string | null
  readonly createdAt: string
  readonly deletedCount: number
}

function loadBatchRoots(batchIds: readonly string[]) {
  return Effect.gen(function* () {
    const unique = [...new Set(batchIds)]
    const roots = new Map<string, BatchRoot>()
    if (unique.length === 0) return roots
    const db = yield* Db
    const placeholders = unique.map(() => '?').join(', ')
    const result = yield* Effect.tryPromise({
      try: () =>
        db.raw
          .prepare(
            `SELECT b.id, b.root_document_id, b.created_at, b.deleted_count,
                    a.name AS account_name
               FROM deletion_batches b
          LEFT JOIN accounts a ON a.id = b.account_id
              WHERE b.id IN (${placeholders})`,
          )
          .bind(...unique)
          .all<{
            id: string
            root_document_id: string
            created_at: string
            deleted_count: number
            account_name: string | null
          }>(),
      catch: (cause) =>
        new PersistenceError({ operation: 'load deletion batches', cause }),
    })
    for (const row of result.results) {
      roots.set(row.id, {
        rootDocumentId: row.root_document_id,
        accountName: row.account_name,
        createdAt: row.created_at,
        deletedCount: row.deleted_count,
      })
    }
    return roots
  })
}

function readScope(value: unknown): DocumentScope {
  return value === 'workspace' ? 'workspace' : 'mine'
}

/** The document list behind `/dashboard`, in the caller's workspace. */
export const loadDashboard = createServerFn({ method: 'GET' })
  .validator((input: unknown) => ({
    scope: readScope((input as { scope?: unknown } | undefined)?.scope),
  }))
  .handler(async ({ data }) => {
    const request = getRequest()
    return runSurface(
      Effect.gen(function* () {
        const { viewer, principal } = yield* resolveWeb(request)
        const documents = yield* Documents
        const page = yield* documents.list(
          { scope: data.scope, limit: 100 },
          principal,
        )
        const trashCount = yield* countTrash(viewer.workspaceId, viewer.accountId)
        return {
          viewer,
          scope: data.scope,
          documents: page.documents,
          trashCount,
        } satisfies DashboardData
      }),
    )
  })

/** `/dashboard/trash` — archived documents, grouped by the batch that took them. */
export const loadTrash = createServerFn({ method: 'GET' }).handler(async () => {
  const request = getRequest()
  return runSurface(
    Effect.gen(function* () {
      const { viewer, principal } = yield* resolveWeb(request)
      const documents = yield* Documents
      const page = yield* documents.list(
        { scope: 'trash', limit: 100 },
        principal,
      )

      const order: string[] = []
      const grouped = new Map<string, DocumentEditor[]>()
      for (const document of page.documents) {
        const key = document.deletionBatchId ?? `single:${document.id}`
        if (!grouped.has(key)) {
          grouped.set(key, [])
          order.push(key)
        }
        grouped.get(key)!.push(document)
      }

      // Restore is a batch operation, so the card has to name the batch *root*
      // — not whichever member happens to sort first by updated time.
      const roots = yield* loadBatchRoots(
        page.documents
          .map((document) => document.deletionBatchId)
          .filter((id): id is string => id !== null),
      )

      const batches: TrashBatch[] = order.map((key) => {
        const members = grouped.get(key)!
        const batchId = members[0].deletionBatchId
        const batch = batchId === null ? undefined : roots.get(batchId)
        const rootIndex = members.findIndex(
          (document) => document.id === batch?.rootDocumentId,
        )
        const ordered =
          rootIndex > 0
            ? [members[rootIndex], ...members.filter((_, i) => i !== rootIndex)]
            : members
        return {
          batchId,
          rootTitle: ordered[0].title,
          deletedBy: batch?.accountName ?? ordered[0].deletedBy,
          deletedAt: batch?.createdAt ?? ordered[0].deletedAt,
          deletedCount: batch?.deletedCount ?? ordered.length,
          documents: ordered,
        }
      })

      return { viewer, batches } satisfies TrashData
    }),
  )
})

/** `/dashboard/documents/$id` — the editor view: versions, links, actions. */
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
    return runSurface(
      Effect.gen(function* () {
        const { viewer, principal } = yield* resolveWeb(request)
        const documents = yield* Documents
        const result = yield* documents.get(data.id, principal)
        return {
          viewer,
          document: result.document,
          versions: result.versions,
        } satisfies DocumentDetailData
      }),
    )
  })

export type DocumentActionName =
  | 'disable'
  | 'enable'
  | 'delete'
  | 'restore'

export type DocumentActionResult =
  | { readonly ok: true; readonly action: 'deleted'; readonly batchId: string }
  | {
      readonly ok: true
      readonly action: 'updated'
      readonly document: DocumentEditor
    }
  | SurfaceFailure

interface DocumentActionInput {
  readonly id: string
  readonly action: DocumentActionName
  readonly csrfToken: string
  readonly batchId?: string
  readonly reason?: string
  readonly force?: boolean
}

const ACTIONS: readonly DocumentActionName[] = [
  'disable',
  'enable',
  'delete',
  'restore',
]

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
      !ACTIONS.includes(value.action as DocumentActionName)
    ) {
      throw new Error('Unknown document action.')
    }
    return {
      id: value.id,
      action: value.action as DocumentActionName,
      csrfToken: typeof value.csrfToken === 'string' ? value.csrfToken : '',
      ...(typeof value.batchId === 'string' ? { batchId: value.batchId } : {}),
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      ...(value.force === true ? { force: true } : {}),
    }
  })
  .handler(async ({ data }): Promise<DocumentActionResult> => {
    const request = getRequest()
    return runSurface(
      Effect.gen(function* () {
        const { viewer, principal } = yield* resolveWeb(request)
        yield* verifyCsrf({
          request,
          token: data.csrfToken,
          accountId: viewer.accountId,
        })

        const documents = yield* Documents

        if (data.action === 'delete') {
          const result = yield* documents.delete(
            data.id,
            principal,
            data.force ?? false,
          )
          return {
            ok: true as const,
            action: 'deleted' as const,
            batchId: result.batchId,
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
