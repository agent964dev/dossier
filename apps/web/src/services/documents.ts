import type {
  AuthorSummary,
  DeleteResponse,
  DocumentEditor,
  DocumentListResponse,
  DocumentReader,
  DocumentView,
  Version,
} from '@dossier/contracts'
import { isDocumentEditor } from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import {
  Access,
  accessBindValues,
  accessCteSql,
  type AccessDecision,
} from './access'
import { Db } from './db'
import { WorkerEnv } from './env'
import { apiError, DossierError, PersistenceError } from './errors'
import { Ids } from './ids'
import { Principal, type PrincipalIdentity } from './principal'

export interface DocumentRow {
  id: string
  title: string
  description: string | null
  kind: string | null
  parent_id: string | null
  visibility: 'public' | 'team' | 'private' | null
  workspace_id: string
  workspace_slug: string
  author_account_id: string
  author_name: string
  latest_version_number: number | null
  version_count: number
  revision: number
  deletion_batch_id: string | null
  deletion_root_title: string | null
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

interface TreeListRow extends DocumentRow {
  effective_visibility: AccessDecision['effectiveVisibility']
  access_source: AccessDecision['accessSource']
  access_source_id: string | null
  editor: number
}

function base(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

export function toDocumentReader(
  row: DocumentRow,
  access: AccessDecision,
  parentReadable: boolean,
  publicBaseUrl: string,
): DocumentReader {
  const origin = base(publicBaseUrl)
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    kind: row.kind,
    parentId: row.parent_id !== null && parentReadable ? row.parent_id : null,
    effectiveVisibility: access.effectiveVisibility,
    workspaceSlug: row.workspace_slug,
    authorAccountId: row.author_account_id,
    authorName: row.author_name,
    latestVersionNumber: row.latest_version_number ?? 0,
    disabled: row.disabled_at !== null,
    url: `${origin}/d/${row.id}`,
    rawUrl: `${origin}/d/${row.id}/raw`,
    hubUrl: `${origin}/d/${row.id}/tree`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toDocumentEditor(
  row: DocumentRow,
  access: AccessDecision,
  parentReadable: boolean,
  publicBaseUrl: string,
): DocumentEditor {
  return {
    ...toDocumentReader(row, access, parentReadable, publicBaseUrl),
    visibility: row.visibility,
    accessSource: access.accessSource,
    versionCount: row.version_count,
    revision: row.revision,
    deletionBatchId: row.deletion_batch_id,
    deletionRootTitle: row.deletion_root_title,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    disabledAt: row.disabled_at,
  }
}

export async function loadDocumentRow(
  database: D1Database,
  documentId: string,
): Promise<DocumentRow | null> {
  return database
    .prepare(
      `SELECT d.id, d.title, d.description, d.kind, d.parent_id, d.visibility,
              d.workspace_id, w.slug AS workspace_slug,
              d.created_by AS author_account_id, a.name AS author_name,
              cv.version_number AS latest_version_number,
              (SELECT COUNT(*) FROM document_versions v WHERE v.document_id = d.id) AS version_count,
              d.revision, d.deletion_batch_id, b.root_title AS deletion_root_title,
              d.deleted_at, deleter.name AS deleted_by, d.disabled_at,
              d.created_at, d.updated_at
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
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null
  try {
    const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    const parsed = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))),
    )
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((v) => typeof v === 'string')
      ? [parsed[0], parsed[1]]
      : null
  } catch {
    return null
  }
}

function guardFailure(
  error: PersistenceError,
): DossierError | PersistenceError {
  const text = String(error.cause)
  return text.includes('publication_guards_ok_check')
    ? apiError(
        'conflict',
        'The document changed while the operation was running.',
      )
    : error
}

function authorSummaries(
  rows: readonly { created_by: string; author_name: string }[],
): AuthorSummary[] {
  const summaries = new Map<string, AuthorSummary>()
  for (const row of rows) {
    const existing = summaries.get(row.created_by)
    summaries.set(row.created_by, {
      accountId: row.created_by,
      name: row.author_name,
      count: (existing?.count ?? 0) + 1,
    })
  }
  return [...summaries.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.accountId.localeCompare(right.accountId),
  )
}

/**
 * Returns a visible forest in pre-order. Both placement and ordering use only
 * reader DTO fields: a hidden physical parent has already become `null`, so
 * its id and storage path cannot influence where a virtual root appears.
 */
function orderVisibleForest(
  documents: readonly DocumentView[],
): DocumentView[] {
  const byId = new Map(documents.map((document) => [document.id, document]))
  const children = new Map<string, string[]>()
  const roots: string[] = []

  for (const document of documents) {
    if (document.parentId !== null && byId.has(document.parentId)) {
      const siblings = children.get(document.parentId)
      if (siblings) siblings.push(document.id)
      else children.set(document.parentId, [document.id])
    } else {
      roots.push(document.id)
    }
  }

  const compare = (left: string, right: string): number => {
    const a = byId.get(left)!
    const b = byId.get(right)!
    return (
      (a.kind ?? '').localeCompare(b.kind ?? '') ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
    )
  }
  const ordered: DocumentView[] = []
  const placed = new Set<string>()
  const visit = (id: string) => {
    if (placed.has(id)) return
    placed.add(id)
    ordered.push(byId.get(id)!)
    for (const child of (children.get(id) ?? []).sort(compare)) visit(child)
  }

  for (const root of roots.sort(compare)) visit(root)
  for (const orphan of [...byId.keys()]
    .filter((id) => !placed.has(id))
    .sort(compare)) {
    visit(orphan)
  }
  return ordered
}

export interface DocumentsService {
  readonly get: (
    documentId: string,
    principal: PrincipalIdentity,
  ) => Effect.Effect<
    { readonly document: DocumentView; readonly versions: readonly Version[] },
    DossierError | PersistenceError
  >
  readonly list: (
    options: {
      readonly scope?: 'mine' | 'workspace' | 'readable' | 'trash'
      readonly parent?: string | null
      readonly tree?: boolean
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

    const loadView = (
      documentId: string,
      principal: PrincipalIdentity,
      management = false,
      visibleIds?: ReadonlySet<string>,
    ): Effect.Effect<DocumentView, DossierError | PersistenceError> =>
      Effect.gen(function* () {
        const decisions = yield* access.resolve([documentId], principal)
        const decision = decisions[0]
        if (
          !decision ||
          (!management && !decision.editor && !decision.canRead)
        ) {
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        }
        if (management && !decision.editor) {
          if (decision.canRead) {
            return yield* Effect.fail(
              apiError('editor_required', 'Document edit access is required.'),
            )
          }
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        }
        const row = yield* Effect.tryPromise({
          try: () => loadDocumentRow(db.raw, documentId),
          catch: (cause) =>
            new PersistenceError({ operation: 'load document', cause }),
        })
        if (!row)
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        const parentReadable =
          row.parent_id === null
            ? false
            : visibleIds !== undefined
              ? visibleIds.has(row.parent_id)
              : (yield* access.resolve([row.parent_id], principal))[0]
                  ?.canRead === true
        return decision.editor
          ? toDocumentEditor(row, decision, parentReadable, env.PUBLIC_BASE_URL)
          : toDocumentReader(row, decision, parentReadable, env.PUBLIC_BASE_URL)
      })

    const loadEditor = (
      documentId: string,
      principal: PrincipalIdentity,
    ): Effect.Effect<DocumentEditor, DossierError | PersistenceError> =>
      Effect.map(
        loadView(documentId, principal, true),
        (document) => document as DocumentEditor,
      )

    const authorizeMutation = (
      documentId: string,
      principal: PrincipalIdentity,
    ): Effect.Effect<AccessDecision, DossierError | PersistenceError> =>
      Effect.gen(function* () {
        const decision = (yield* access.resolve([documentId], principal))[0]
        if (!decision || (!decision.editor && !decision.canRead)) {
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        }
        yield* principals.requirePublisher(principal, decision.workspaceId)
        if (!decision.editor) {
          return yield* Effect.fail(
            apiError('editor_required', 'Document edit access is required.'),
          )
        }
        return decision
      })

    const get: DocumentsService['get'] = (documentId, principal) =>
      Effect.gen(function* () {
        const document = yield* loadView(documentId, principal)
        const versions = isDocumentEditor(document)
          ? yield* Effect.tryPromise({
              try: () => loadVersions(db.raw, documentId, env.PUBLIC_BASE_URL),
              catch: (cause) =>
                new PersistenceError({
                  operation: 'load document versions',
                  cause,
                }),
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
          return yield* Effect.fail(
            apiError('policy_rejected', 'Invalid pagination cursor.'),
          )
        }
        if (options.parent !== undefined && options.parent !== null) {
          yield* access.requireReadable(options.parent, principal)
        }

        const [accountId, emails] = accessBindValues(principal)

        if (options.tree) {
          if (scope !== 'mine' && scope !== 'readable') {
            return yield* Effect.fail(
              apiError(
                'policy_rejected',
                'tree=1 supports only mine and readable scopes.',
              ),
            )
          }
          if (options.parent !== undefined) {
            return yield* Effect.fail(
              apiError(
                'policy_rejected',
                'tree=1 cannot be combined with parent.',
              ),
            )
          }
          const scopeWhere =
            scope === 'mine'
              ? `d.workspace_id = ?3 AND d.created_by = ?1 AND d.deleted_at IS NULL`
              : `d.deleted_at IS NULL`
          const rows = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `${accessCteSql(`
                    SELECT d.id
                      FROM documents d
                     WHERE ${scopeWhere}
                  `)}
                   SELECT d.id, d.title, d.description, d.kind, d.parent_id,
                          d.visibility, d.workspace_id, w.slug AS workspace_slug,
                          d.created_by AS author_account_id, a.name AS author_name,
                          cv.version_number AS latest_version_number,
                          (SELECT COUNT(*) FROM document_versions v
                            WHERE v.document_id = d.id) AS version_count,
                          d.revision, d.deletion_batch_id,
                          batch.root_title AS deletion_root_title,
                          d.deleted_at, deleter.name AS deleted_by, d.disabled_at,
                          d.created_at, d.updated_at,
                          decision.effective_visibility, decision.access_source,
                          decision.access_source_id, decision.editor
                     FROM access_decisions decision
                     JOIN documents d ON d.id = decision.document_id
                     JOIN workspaces w ON w.id = d.workspace_id
                     JOIN accounts a ON a.id = d.created_by
                LEFT JOIN document_versions cv ON cv.id = d.current_version_id
                LEFT JOIN deletion_batches batch ON batch.id = d.deletion_batch_id
                LEFT JOIN accounts deleter ON deleter.id = batch.account_id
                    WHERE decision.can_read = 1`,
                )
                .bind(
                  ...(scope === 'mine'
                    ? [accountId, emails, principal.workspaceId]
                    : [accountId, emails]),
                )
                .all<TreeListRow>(),
            catch: (cause) =>
              new PersistenceError({ operation: 'list document tree', cause }),
          })
          const visibleIds = new Set(rows.results.map((row) => row.id))
          const documents = orderVisibleForest(
            rows.results.map((row): DocumentView => {
              const decision: AccessDecision = {
                documentId: row.id,
                workspaceId: row.workspace_id,
                effectiveVisibility: row.effective_visibility,
                accessSource: row.access_source,
                accessSourceId: row.access_source_id,
                editor: row.editor === 1,
                canRead: true,
              }
              const parentVisible =
                row.parent_id !== null && visibleIds.has(row.parent_id)
              return decision.editor
                ? toDocumentEditor(
                    row,
                    decision,
                    parentVisible,
                    env.PUBLIC_BASE_URL,
                  )
                : toDocumentReader(
                    row,
                    decision,
                    parentVisible,
                    env.PUBLIC_BASE_URL,
                  )
            }),
          )
          return { ok: true as const, documents, nextCursor: null }
        }

        if (scope === 'trash') {
          if (options.parent !== undefined) {
            return yield* Effect.fail(
              apiError(
                'policy_rejected',
                'Trash cannot be filtered by parent.',
              ),
            )
          }
          const rows = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `SELECT b.id AS batch_id, b.root_document_id AS id,
                          b.created_at AS updated_at, b.purge_status
                     FROM deletion_batches b
                     JOIN documents root ON root.id = b.root_document_id
                LEFT JOIN memberships self
                       ON self.workspace_id = root.workspace_id
                      AND self.account_id = ?1
                    WHERE root.workspace_id = ?2
                      AND root.deleted_at IS NOT NULL
                      AND root.deletion_batch_id = b.id
                      AND b.restored_at IS NULL
                      AND (root.created_by = ?1 OR self.role = 'admin')
                      AND (?3 IS NULL OR b.created_at < ?3
                        OR (b.created_at = ?3 AND b.id < ?4))
                    ORDER BY b.created_at DESC, b.id DESC
                    LIMIT ?5`,
                )
                .bind(
                  principal.accountId,
                  principal.workspaceId,
                  cursor?.[0] ?? null,
                  cursor?.[1] ?? null,
                  limit + 1,
                )
                .all<{
                  batch_id: string
                  id: string
                  updated_at: string
                  purge_status: 'pending' | 'claimed' | 'purged'
                }>(),
            catch: (cause) =>
              new PersistenceError({ operation: 'list trash batches', cause }),
          })
          const pageRows = rows.results.slice(0, limit)
          const documents: DocumentView[] = []
          for (const row of pageRows) {
            const document = yield* loadEditor(row.id, principal)
            const authorRows = yield* Effect.tryPromise({
              try: () =>
                db.raw
                  .prepare(
                    `SELECT d.created_by, a.name AS author_name
                       FROM documents d
                       JOIN accounts a ON a.id = d.created_by
                      WHERE d.deletion_batch_id = ? AND d.deleted_at IS NOT NULL
                      ORDER BY d.id`,
                  )
                  .bind(row.batch_id)
                  .all<{ created_by: string; author_name: string }>(),
              catch: (cause) =>
                new PersistenceError({
                  operation: 'load trash batch authors',
                  cause,
                }),
            })
            const configuredRetention = Number(env.PURGE_RETENTION_DAYS)
            const retentionDays =
              Number.isSafeInteger(configuredRetention) &&
              configuredRetention > 0
                ? configuredRetention
                : 30
            documents.push({
              ...document,
              deletionRootTitle: document.deletionRootTitle ?? document.title,
              authors: authorSummaries(authorRows.results),
              purgeStatus: row.purge_status,
              purgesAt: new Date(
                Date.parse(row.updated_at) + retentionDays * 86_400_000,
              ).toISOString(),
            })
          }
          const last = pageRows.at(-1)
          return {
            ok: true as const,
            documents,
            nextCursor:
              rows.results.length > limit && last
                ? encodeCursor(last.updated_at, last.batch_id)
                : null,
          }
        }

        const scopeWhere =
          scope === 'readable'
            ? `d.deleted_at IS NULL`
            : scope === 'mine'
              ? `d.workspace_id = ?3 AND d.created_by = ?1 AND d.deleted_at IS NULL`
              : `d.workspace_id = ?3 AND d.deleted_at IS NULL`
        const accessWhere =
          scope === 'readable'
            ? 'decision.can_read = 1'
            : scope === 'workspace'
              ? '(decision.can_read = 1 OR decision.editor = 1)'
              : 'decision.editor = 1'
        const parentMode =
          options.parent === undefined
            ? 'none'
            : options.parent === null
              ? 'root'
              : 'id'
        const rows = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `${accessCteSql(`
                  SELECT d.id
                    FROM documents d
                   WHERE ${scopeWhere}
                  UNION
                  SELECT d.parent_id
                    FROM documents d
                   WHERE ${scopeWhere} AND d.parent_id IS NOT NULL
                `)}
                 SELECT d.id, d.updated_at
                   FROM access_decisions decision
                   JOIN documents d ON d.id = decision.document_id
              LEFT JOIN access_decisions parent_decision
                     ON parent_decision.document_id = d.parent_id
                  WHERE ${scopeWhere}
                    AND ${accessWhere}
                    AND (?4 = 'none'
                      OR (?4 = 'root' AND (
                        d.parent_id IS NULL OR COALESCE(parent_decision.can_read, 0) = 0
                      ))
                      OR (?4 = 'id' AND d.parent_id = ?5))
                    AND (?6 IS NULL OR d.updated_at < ?6
                      OR (d.updated_at = ?6 AND d.id < ?7))
                  ORDER BY d.updated_at DESC, d.id DESC
                  LIMIT ?8`,
              )
              .bind(
                accountId,
                emails,
                principal.workspaceId,
                parentMode,
                options.parent ?? null,
                cursor?.[0] ?? null,
                cursor?.[1] ?? null,
                limit + 1,
              )
              .all<{ id: string; updated_at: string }>(),
          catch: (cause) =>
            new PersistenceError({ operation: 'list documents', cause }),
        })
        const pageRows = rows.results.slice(0, limit)
        const documents: DocumentView[] = []
        for (const row of pageRows) {
          documents.push(
            yield* loadView(row.id, principal, true).pipe(
              Effect.catchTag('DossierError', (error) =>
                error.code === 'editor_required'
                  ? loadView(row.id, principal)
                  : Effect.fail(error),
              ),
            ),
          )
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

    const remove: DocumentsService['delete'] = (
      documentId,
      principal,
      force = false,
    ) =>
      Effect.gen(function* () {
        yield* authorizeMutation(documentId, principal)
        const now = new Date().toISOString()
        const batchId = ids.internalId()
        const guardId = ids.internalId()
        const results = yield* db
          .batch([
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
              .bind(
                guardId,
                principal.accountId,
                documentId,
                principal.workspaceId,
              ),
            db.raw
              .prepare(
                `WITH RECURSIVE subtree(id) AS (
                 SELECT root.id FROM documents root
                  WHERE root.id = ? AND root.deleted_at IS NULL
                 UNION ALL
                 SELECT child.id FROM documents child
                 JOIN subtree parent ON child.parent_id = parent.id
               ), live_subtree AS (
                 SELECT d.id FROM documents d
                 JOIN subtree ON subtree.id = d.id
                  WHERE d.deleted_at IS NULL
               )
               INSERT INTO deletion_batches
                 (id, root_document_id, account_id, created_at, restored_at,
                  deleted_count, root_title)
               SELECT ?, root.id, ?, ?, NULL,
                      (SELECT COUNT(*) FROM live_subtree), root.title
                 FROM documents root
                WHERE root.id = ? AND root.deleted_at IS NULL
                  AND (? = 1 OR (SELECT COUNT(*) FROM live_subtree) <= 1)`,
              )
              .bind(
                documentId,
                batchId,
                principal.accountId,
                now,
                documentId,
                force ? 1 : 0,
              ),
            db.raw
              .prepare(
                `WITH RECURSIVE subtree(id) AS (
                 SELECT root.id FROM documents root
                  WHERE root.id = ? AND root.deleted_at IS NULL
                 UNION ALL
                 SELECT child.id FROM documents child
                 JOIN subtree parent ON child.parent_id = parent.id
               )
               SELECT d.id, d.created_by, a.name AS author_name
                 FROM documents d
                 JOIN subtree ON subtree.id = d.id
                 JOIN accounts a ON a.id = d.created_by
                WHERE d.deleted_at IS NULL
                ORDER BY d.id`,
              )
              .bind(documentId),
            db.raw
              .prepare(
                `WITH RECURSIVE subtree(id) AS (
                 SELECT root.id FROM documents root
                  WHERE root.id = ? AND root.deleted_at IS NULL
                 UNION ALL
                 SELECT child.id FROM documents child
                 JOIN subtree parent ON child.parent_id = parent.id
               )
               UPDATE documents
                  SET deleted_at = ?, deletion_batch_id = ?, updated_at = ?
                WHERE deleted_at IS NULL
                  AND id IN (SELECT id FROM subtree)
                  AND EXISTS (SELECT 1 FROM deletion_batches WHERE id = ?)`,
              )
              .bind(documentId, now, batchId, now, batchId),
            db.raw
              .prepare(
                `SELECT d.id, d.created_by, a.name AS author_name
                 FROM documents d
                 JOIN accounts a ON a.id = d.created_by
                WHERE d.deletion_batch_id = ? AND d.deleted_at = ?
                ORDER BY d.id`,
              )
              .bind(batchId, now),
            db.raw
              .prepare(`DELETE FROM publication_guards WHERE id = ?`)
              .bind(guardId),
          ])
          .pipe(Effect.mapError(guardFailure))

        type AffectedRow = {
          id: string
          created_by: string
          author_name: string
        }
        const candidates = (results[2]?.results ?? []) as AffectedRow[]
        const tagged = (results[4]?.results ?? []) as AffectedRow[]
        if (tagged.length === 0 && candidates.length > 1 && !force) {
          return yield* Effect.fail(
            apiError('has_children', 'Document has live descendants.', {
              count: candidates.length - 1,
              authors: authorSummaries(candidates),
            }),
          )
        }
        if (tagged.length === 0) {
          return yield* Effect.fail(
            apiError(
              'conflict',
              'The document changed while the operation was running.',
            ),
          )
        }
        return {
          ok: true as const,
          batchId,
          deleted: tagged.length,
          authors: authorSummaries(tagged),
        }
      })

    const restore: DocumentsService['restore'] = (
      documentId,
      batchId,
      principal,
    ) =>
      Effect.gen(function* () {
        const batch = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT b.root_document_id, b.restored_at, b.purge_status,
                        d.parent_id, d.workspace_id,
                        parent.deleted_at AS parent_deleted_at
                   FROM deletion_batches b
              LEFT JOIN documents d ON d.id = b.root_document_id
              LEFT JOIN documents parent ON parent.id = d.parent_id
                  WHERE b.id = ?`,
              )
              .bind(batchId)
              .first<{
                root_document_id: string
                restored_at: string | null
                purge_status: 'pending' | 'claimed' | 'purged'
                parent_id: string | null
                workspace_id: string | null
                parent_deleted_at: string | null
              }>(),
          catch: (cause) =>
            new PersistenceError({ operation: 'load deletion batch', cause }),
        })
        if (!batch || batch.root_document_id !== documentId) {
          return yield* Effect.fail(
            apiError('not_found', 'Deletion batch not found.'),
          )
        }
        if (batch.purge_status !== 'pending') {
          return yield* Effect.fail(
            apiError(
              'batch_purged',
              'The deletion batch is being or has been permanently purged.',
            ),
          )
        }
        if (batch.workspace_id !== principal.workspaceId) {
          return yield* Effect.fail(
            apiError('not_found', 'Deletion batch not found.'),
          )
        }
        yield* authorizeMutation(batch.root_document_id, principal)
        if (batch.parent_id !== null && batch.parent_deleted_at !== null) {
          return yield* Effect.fail(
            apiError('conflict', 'The document parent is deleted.'),
          )
        }
        const now = new Date().toISOString()
        const guardId = ids.internalId()
        const restoreResult = yield* db
          .batch([
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
                   AND b.purge_status = 'pending'
                   AND d.workspace_id = ?
                   AND (d.parent_id IS NULL OR parent.deleted_at IS NULL)
                   AND (a.kind = 'service' OR publisher.account_id IS NOT NULL)
                   AND (d.created_by = a.id OR editor.role = 'admin')
               ) THEN 1 ELSE 0 END)`,
              )
              .bind(
                guardId,
                principal.accountId,
                batchId,
                documentId,
                principal.workspaceId,
              ),
            db.raw
              .prepare(
                `UPDATE documents
                  SET deleted_at = NULL, deletion_batch_id = NULL, updated_at = ?
                WHERE deletion_batch_id = ?
                  AND EXISTS (
                    SELECT 1 FROM deletion_batches
                     WHERE id = ? AND restored_at IS NULL
                       AND purge_status = 'pending'
                  )`,
              )
              .bind(now, batchId, batchId),
            db.raw
              .prepare(
                `UPDATE deletion_batches
                    SET restored_at = ?
                  WHERE id = ? AND restored_at IS NULL
                    AND purge_status = 'pending'`,
              )
              .bind(now, batchId),
            db.raw
              .prepare(`DELETE FROM publication_guards WHERE id = ?`)
              .bind(guardId),
          ])
          .pipe(Effect.either)
        if (restoreResult._tag === 'Left') {
          const status = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  'SELECT purge_status FROM deletion_batches WHERE id = ?',
                )
                .bind(batchId)
                .first<{ purge_status: 'pending' | 'claimed' | 'purged' }>(),
            catch: (cause) =>
              new PersistenceError({
                operation: 'reload deletion batch after restore conflict',
                cause,
              }),
          }).pipe(Effect.orElseSucceed(() => null))
          if (status && status.purge_status !== 'pending') {
            return yield* Effect.fail(
              apiError(
                'batch_purged',
                'The deletion batch is being or has been permanently purged.',
              ),
            )
          }
          return yield* Effect.fail(guardFailure(restoreResult.left))
        }
        return yield* loadEditor(documentId, principal)
      })

    const setDisabled = (
      documentId: string,
      principal: PrincipalIdentity,
      disabled: boolean,
      reason?: string | null,
    ): Effect.Effect<DocumentEditor, DossierError | PersistenceError> =>
      Effect.gen(function* () {
        yield* authorizeMutation(documentId, principal)
        const now = new Date().toISOString()
        const guardId = ids.internalId()
        yield* db
          .batch([
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
                 WHERE d.id = ? AND d.deleted_at IS NULL AND d.workspace_id = ?
                   AND (a.kind = 'service' OR publisher.account_id IS NOT NULL)
                   AND (d.created_by = a.id OR editor.role = 'admin')
               ) THEN 1 ELSE 0 END)`,
              )
              .bind(
                guardId,
                principal.accountId,
                documentId,
                principal.workspaceId,
              ),
            db.raw
              .prepare(
                `UPDATE documents
                  SET disabled_at = ?, disabled_reason = ?, updated_at = ?, revision = revision + 1
                WHERE id = ?`,
              )
              .bind(
                disabled ? now : null,
                disabled ? (reason ?? null) : null,
                now,
                documentId,
              ),
            db.raw
              .prepare(`DELETE FROM publication_guards WHERE id = ?`)
              .bind(guardId),
          ])
          .pipe(Effect.mapError(guardFailure))
        return yield* loadEditor(documentId, principal)
      })

    return {
      get,
      list,
      delete: remove,
      restore,
      disable: (documentId, principal, reason) =>
        setDisabled(documentId, principal, true, reason),
      enable: (documentId, principal) =>
        setDisabled(documentId, principal, false),
    }
  }),
)
