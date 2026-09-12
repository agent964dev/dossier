import type {
  DeleteResponse,
  DocumentEditor,
  DocumentListResponse,
  Version,
} from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import { Access } from './access'
import { Db } from './db'
import { WorkerEnv } from './env'
import { apiError, DossierError, PersistenceError } from './errors'
import { Ids } from './ids'
import { Principal, type PrincipalIdentity } from './principal'

interface DocumentRow {
  id: string
  title: string
  description: string | null
  kind: string | null
  parent_id: string | null
  visibility: 'public' | 'team' | 'private' | null
  workspace_slug: string
  author_account_id: string
  author_name: string
  latest_version_number: number | null
  version_count: number
  revision: number
  deletion_batch_id: string | null
  deleted_at: string | null
  deleted_by: string | null
  disabled_at: string | null
  created_at: string
  updated_at: string
}

interface VersionRow {
  id: string
  document_id: string
  version_number: number
  content_hash: string
  file_size: number
  original_filename: string | null
  created_at: string
  created_by_account_id: string
  created_by_api_key_id: string | null
}

function base(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

export function toDocumentEditor(
  row: DocumentRow,
  publicBaseUrl: string,
): DocumentEditor {
  const origin = base(publicBaseUrl)
  const latest = row.latest_version_number ?? 0
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    kind: row.kind,
    parentId: row.parent_id,
    effectiveVisibility: row.visibility ?? 'team',
    workspaceSlug: row.workspace_slug,
    authorAccountId: row.author_account_id,
    authorName: row.author_name,
    latestVersionNumber: latest,
    disabled: row.disabled_at !== null,
    url: `${origin}/d/${row.id}`,
    rawUrl: `${origin}/d/${row.id}/raw`,
    hubUrl: `${origin}/d/${row.id}/tree`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    visibility: row.visibility,
    accessSource: row.visibility === null ? 'inherited' : 'own',
    versionCount: row.version_count,
    revision: row.revision,
    deletionBatchId: row.deletion_batch_id,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    disabledAt: row.disabled_at,
  }
}

export async function loadDocumentEditor(
  database: D1Database,
  documentId: string,
  publicBaseUrl: string,
): Promise<DocumentEditor | null> {
  const row = await database
    .prepare(
      `SELECT d.id, d.title, d.description, d.kind, d.parent_id, d.visibility,
              w.slug AS workspace_slug, d.created_by AS author_account_id,
              a.name AS author_name, cv.version_number AS latest_version_number,
              (SELECT COUNT(*) FROM document_versions v WHERE v.document_id = d.id) AS version_count,
              d.revision, d.deletion_batch_id, d.deleted_at,
              deleter.name AS deleted_by, d.disabled_at, d.created_at, d.updated_at
         FROM documents d
         JOIN workspaces w ON w.id = d.workspace_id
         JOIN accounts a ON a.id = d.created_by
    LEFT JOIN document_versions cv ON cv.id = d.current_version_id
    LEFT JOIN deletion_batches b ON b.id = d.deletion_batch_id
    LEFT JOIN accounts deleter ON deleter.id = b.account_id
        WHERE d.id = ?
        LIMIT 1`,
    )
    .bind(documentId)
    .first<DocumentRow>()
  return row ? toDocumentEditor(row, publicBaseUrl) : null
}

export async function loadVersions(
  database: D1Database,
  documentId: string,
  publicBaseUrl: string,
): Promise<Version[]> {
  const result = await database
    .prepare(
      `SELECT id, document_id, version_number, content_hash, file_size,
              original_filename, created_at, created_by_account_id,
              created_by_api_key_id
         FROM document_versions
        WHERE document_id = ?
        ORDER BY version_number DESC`,
    )
    .bind(documentId)
    .all<VersionRow>()
  const origin = base(publicBaseUrl)
  return result.results.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    versionNumber: row.version_number,
    contentHash: row.content_hash,
    fileSize: row.file_size,
    originalFilename: row.original_filename,
    createdAt: row.created_at,
    createdByAccountId: row.created_by_account_id,
    createdByApiKeyId: row.created_by_api_key_id,
    url: `${origin}/d/${row.document_id}/v/${row.version_number}`,
    rawUrl: `${origin}/d/${row.document_id}/v/${row.version_number}/raw`,
  }))
}

function encodeCursor(updatedAt: string, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([updatedAt, id]))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null
  try {
    const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    const parsed = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))),
    )
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every((v) => typeof v === 'string')
      ? [parsed[0], parsed[1]]
      : null
  } catch {
    return null
  }
}

function guardFailure(error: PersistenceError): DossierError | PersistenceError {
  const text = String(error.cause)
  return text.includes('publication_guards_ok_check')
    ? apiError('conflict', 'The document changed while the operation was running.')
    : error
}

export interface DocumentsService {
  readonly get: (
    documentId: string,
    principal: PrincipalIdentity,
  ) => Effect.Effect<
    { readonly document: DocumentEditor; readonly versions: readonly Version[] },
    DossierError | PersistenceError
  >
  readonly list: (
    options: {
      readonly scope?: 'mine' | 'workspace' | 'trash'
      readonly limit?: number
      readonly cursor?: string
    },
    principal: PrincipalIdentity,
  ) => Effect.Effect<DocumentListResponse, DossierError | PersistenceError>
  readonly delete: (
    documentId: string,
    principal: PrincipalIdentity,
    force?: boolean,
  ) => Effect.Effect<DeleteResponse, DossierError | PersistenceError>
  readonly restore: (
    documentId: string,
    batchId: string,
    principal: PrincipalIdentity,
  ) => Effect.Effect<DocumentEditor, DossierError | PersistenceError>
  readonly disable: (
    documentId: string,
    principal: PrincipalIdentity,
    reason?: string | null,
  ) => Effect.Effect<DocumentEditor, DossierError | PersistenceError>
  readonly enable: (
    documentId: string,
    principal: PrincipalIdentity,
  ) => Effect.Effect<DocumentEditor, DossierError | PersistenceError>
}

export class Documents extends Context.Tag('@dossier/web/Documents')<
  Documents,
  DocumentsService
>() {}

export const DocumentsLive = Layer.effect(
  Documents,
  Effect.gen(function* () {
    const db = yield* Db
    const ids = yield* Ids
    const env = yield* WorkerEnv
    const access = yield* Access
    const principals = yield* Principal

    const get: DocumentsService['get'] = (documentId, principal) =>
      Effect.gen(function* () {
        yield* access.requireEditor(documentId, principal)
        const document = yield* Effect.tryPromise({
          try: () => loadDocumentEditor(db.raw, documentId, env.PUBLIC_BASE_URL),
          catch: (cause) => new PersistenceError({ operation: 'load document', cause }),
        })
        if (!document) {
          return yield* Effect.fail(apiError('not_found', 'Document not found.'))
        }
        const versions =
          document.authorAccountId === principal.accountId
            ? yield* Effect.tryPromise({
                try: () => loadVersions(db.raw, documentId, env.PUBLIC_BASE_URL),
                catch: (cause) =>
                  new PersistenceError({ operation: 'load document versions', cause }),
              })
            : []
        return { document, versions }
      })

    const list: DocumentsService['list'] = (options, principal) =>
      Effect.gen(function* () {
        const scope = options.scope ?? 'mine'
        const limit = Math.max(1, Math.min(100, options.limit ?? 50))
        const cursor = decodeCursor(options.cursor)
        if (options.cursor && !cursor) {
          return yield* Effect.fail(apiError('conflict', 'Invalid pagination cursor.'))
        }
        const stateClause = scope === 'trash' ? 'd.deleted_at IS NOT NULL' : 'd.deleted_at IS NULL'
        const scopeClause = scope === 'mine'
          ? 'd.created_by = ?'
          : `(d.created_by = ? OR self.role = 'admin')`
        const rows = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT d.id, d.updated_at
                   FROM documents d
              LEFT JOIN memberships self
                     ON self.workspace_id = d.workspace_id AND self.account_id = ?
                  WHERE d.workspace_id = ?
                    AND ${stateClause}
                    AND ${scopeClause}
                    AND (? IS NULL OR d.updated_at < ? OR (d.updated_at = ? AND d.id < ?))
                  ORDER BY d.updated_at DESC, d.id DESC
                  LIMIT ?`,
              )
              .bind(
                principal.accountId,
                principal.workspaceId,
                principal.accountId,
                cursor?.[0] ?? null,
                cursor?.[0] ?? null,
                cursor?.[0] ?? null,
                cursor?.[1] ?? null,
                limit + 1,
              )
              .all<{ id: string; updated_at: string }>(),
          catch: (cause) => new PersistenceError({ operation: 'list documents', cause }),
        })
        const pageRows = rows.results.slice(0, limit)
        const documents: DocumentEditor[] = []
        for (const row of pageRows) {
          const document = yield* Effect.tryPromise({
            try: () => loadDocumentEditor(db.raw, row.id, env.PUBLIC_BASE_URL),
            catch: (cause) => new PersistenceError({ operation: 'load listed document', cause }),
          })
          if (document) documents.push(document)
        }
        const last = pageRows.at(-1)
        return {
          ok: true as const,
          documents,
          nextCursor:
            rows.results.length > limit && last
              ? encodeCursor(last.updated_at, last.id)
              : null,
        }
      })

    const remove: DocumentsService['delete'] = (documentId, principal, force = false) =>
      Effect.gen(function* () {
        yield* principals.requirePublisher(principal)
        yield* access.requireEditor(documentId, principal)
        const root = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(`SELECT id, path, deleted_at FROM documents WHERE id = ?`)
              .bind(documentId)
              .first<{ id: string; path: string; deleted_at: string | null }>(),
          catch: (cause) => new PersistenceError({ operation: 'load delete root', cause }),
        })
        if (!root || root.deleted_at !== null) {
          return yield* Effect.fail(apiError('not_found', 'Document not found.'))
        }
        const lower = `${root.path}${root.id}/`
        const upper = `${root.path}${root.id}0`
        const affected = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT d.id, d.created_by, a.name AS author_name
                   FROM documents d JOIN accounts a ON a.id = d.created_by
                  WHERE d.deleted_at IS NULL
                    AND (d.id = ? OR (d.path >= ? COLLATE BINARY AND d.path < ? COLLATE BINARY))`,
              )
              .bind(documentId, lower, upper)
              .all<{ id: string; created_by: string; author_name: string }>(),
          catch: (cause) => new PersistenceError({ operation: 'load delete subtree', cause }),
        })
        if (affected.results.length > 1 && !force) {
          return yield* Effect.fail(
            apiError('has_children', 'Document has live descendants.', {
              count: affected.results.length - 1,
              authors: [...new Set(affected.results.map((row) => row.author_name))],
            }),
          )
        }
        const now = new Date().toISOString()
        const batchId = ids.internalId()
        const guardId = ids.internalId()
        yield* db.batch([
          db.raw
            .prepare(
              `INSERT INTO publication_guards (id, ok)
               VALUES (?, CASE WHEN EXISTS (
                 SELECT 1 FROM documents d
                 JOIN accounts a ON a.id = ? AND a.disabled_at IS NULL
                 LEFT JOIN memberships publisher
                   ON publisher.workspace_id = d.workspace_id AND publisher.account_id = a.id
                 LEFT JOIN memberships editor
                   ON editor.workspace_id = d.workspace_id AND editor.account_id = a.id
                 WHERE d.id = ? AND d.deleted_at IS NULL
                   AND d.workspace_id = ?
                   AND (a.kind = 'service' OR publisher.account_id IS NOT NULL)
                   AND (d.created_by = a.id OR editor.role = 'admin')
               ) THEN 1 ELSE 0 END)`,
            )
            .bind(guardId, principal.accountId, documentId, principal.workspaceId),
          db.raw
            .prepare(
              `INSERT INTO deletion_batches
                 (id, root_document_id, account_id, created_at, restored_at, deleted_count)
               VALUES (?, ?, ?, ?, NULL, ?)`,
            )
            .bind(batchId, documentId, principal.accountId, now, affected.results.length),
          db.raw
            .prepare(
              `UPDATE documents
                  SET deleted_at = ?, deletion_batch_id = ?, updated_at = ?
                WHERE deleted_at IS NULL
                  AND (id = ? OR (path >= ? COLLATE BINARY AND path < ? COLLATE BINARY))`,
            )
            .bind(now, batchId, now, documentId, lower, upper),
          db.raw.prepare(`DELETE FROM publication_guards WHERE id = ?`).bind(guardId),
        ]).pipe(Effect.mapError(guardFailure))
        return {
          ok: true as const,
          batchId,
          deleted: affected.results.length,
          authors: [...new Set(affected.results.map((row) => row.author_name))],
        }
      })

    const restore: DocumentsService['restore'] = (documentId, batchId, principal) =>
      Effect.gen(function* () {
        yield* principals.requirePublisher(principal)
        yield* access.requireEditor(documentId, principal)
        const batch = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT b.root_document_id, b.restored_at, d.parent_id,
                        parent.deleted_at AS parent_deleted_at
                   FROM deletion_batches b
                   JOIN documents d ON d.id = b.root_document_id
              LEFT JOIN documents parent ON parent.id = d.parent_id
                  WHERE b.id = ?`,
              )
              .bind(batchId)
              .first<{
                root_document_id: string
                restored_at: string | null
                parent_id: string | null
                parent_deleted_at: string | null
              }>(),
          catch: (cause) => new PersistenceError({ operation: 'load deletion batch', cause }),
        })
        if (!batch || batch.root_document_id !== documentId) {
          return yield* Effect.fail(apiError('not_found', 'Deletion batch not found.'))
        }
        if (batch.parent_id !== null && batch.parent_deleted_at !== null) {
          return yield* Effect.fail(apiError('conflict', 'The document parent is deleted.'))
        }
        const now = new Date().toISOString()
        const guardId = ids.internalId()
        yield* db.batch([
          db.raw
            .prepare(
              `INSERT INTO publication_guards (id, ok)
               VALUES (?, CASE WHEN EXISTS (
                 SELECT 1 FROM deletion_batches b
                 JOIN documents d ON d.id = b.root_document_id
                 JOIN accounts a ON a.id = ? AND a.disabled_at IS NULL
                 LEFT JOIN memberships publisher
                   ON publisher.workspace_id = d.workspace_id AND publisher.account_id = a.id
                 LEFT JOIN memberships editor
                   ON editor.workspace_id = d.workspace_id AND editor.account_id = a.id
                 LEFT JOIN documents parent ON parent.id = d.parent_id
                 WHERE b.id = ? AND b.root_document_id = ? AND b.restored_at IS NULL
                   AND (d.parent_id IS NULL OR parent.deleted_at IS NULL)
                   AND (a.kind = 'service' OR publisher.account_id IS NOT NULL)
                   AND (d.created_by = a.id OR editor.role = 'admin')
               ) THEN 1 ELSE 0 END)`,
            )
            .bind(guardId, principal.accountId, batchId, documentId),
          db.raw
            .prepare(
              `UPDATE documents
                  SET deleted_at = NULL, deletion_batch_id = NULL, updated_at = ?
                WHERE deletion_batch_id = ?`,
            )
            .bind(now, batchId),
          db.raw
            .prepare(`UPDATE deletion_batches SET restored_at = ? WHERE id = ?`)
            .bind(now, batchId),
          db.raw.prepare(`DELETE FROM publication_guards WHERE id = ?`).bind(guardId),
        ]).pipe(Effect.mapError(guardFailure))
        const document = yield* Effect.tryPromise({
          try: () => loadDocumentEditor(db.raw, documentId, env.PUBLIC_BASE_URL),
          catch: (cause) => new PersistenceError({ operation: 'load restored document', cause }),
        })
        if (!document) return yield* Effect.fail(apiError('not_found', 'Document not found.'))
        return document
      })

    const setDisabled = (
      documentId: string,
      principal: PrincipalIdentity,
      disabled: boolean,
      reason?: string | null,
    ): Effect.Effect<DocumentEditor, DossierError | PersistenceError> =>
      Effect.gen(function* () {
        yield* principals.requirePublisher(principal)
        yield* access.requireEditor(documentId, principal)
        const now = new Date().toISOString()
        const guardId = ids.internalId()
        yield* db.batch([
          db.raw
            .prepare(
              `INSERT INTO publication_guards (id, ok)
               VALUES (?, CASE WHEN EXISTS (
                 SELECT 1 FROM documents d
                 JOIN accounts a ON a.id = ? AND a.disabled_at IS NULL
                 LEFT JOIN memberships publisher
                   ON publisher.workspace_id = d.workspace_id AND publisher.account_id = a.id
                 LEFT JOIN memberships editor
                   ON editor.workspace_id = d.workspace_id AND editor.account_id = a.id
                 WHERE d.id = ? AND d.deleted_at IS NULL
                   AND (a.kind = 'service' OR publisher.account_id IS NOT NULL)
                   AND (d.created_by = a.id OR editor.role = 'admin')
               ) THEN 1 ELSE 0 END)`,
            )
            .bind(guardId, principal.accountId, documentId),
          db.raw
            .prepare(
              `UPDATE documents
                  SET disabled_at = ?, disabled_reason = ?, updated_at = ?, revision = revision + 1
                WHERE id = ?`,
            )
            .bind(disabled ? now : null, disabled ? (reason ?? null) : null, now, documentId),
          db.raw.prepare(`DELETE FROM publication_guards WHERE id = ?`).bind(guardId),
        ]).pipe(Effect.mapError(guardFailure))
        const document = yield* Effect.tryPromise({
          try: () => loadDocumentEditor(db.raw, documentId, env.PUBLIC_BASE_URL),
          catch: (cause) => new PersistenceError({ operation: 'load changed document', cause }),
        })
        if (!document) return yield* Effect.fail(apiError('not_found', 'Document not found.'))
        return document
      })

    return {
      get,
      list,
      delete: remove,
      restore,
      disable: (documentId, principal, reason) =>
        setDisabled(documentId, principal, true, reason),
      enable: (documentId, principal) => setDisabled(documentId, principal, false),
    }
  }),
)
