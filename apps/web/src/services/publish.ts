import type {
  DocumentEditor,
  UploadRequest,
  UploadResponse,
} from '@dossier/contracts'
import { validateHtml } from '@dossier/policy'
import { Context, Effect, Layer } from 'effect'

import { Access, accessBindValues, accessCteSql } from './access'
import { Db } from './db'
import { loadDocumentRow, toDocumentEditor } from './documents'
import { WorkerEnv } from './env'
import {
  apiError,
  DossierError,
  PersistenceError,
  StorageError,
} from './errors'
import { Ids } from './ids'
import { Objects } from './objects'
import { Principal, type PrincipalIdentity } from './principal'
import { normalizeDocumentKind } from './tree'

type IdempotencyRow = {
  id: string
  document_id: string
  version_number: number
  request_hash: string | null
  receipt_json: string | null
}

function commaSeparatedHosts(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Canonical JSON cannot encode non-finite numbers.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}.`)
}

function canonicalField(
  payload: UploadRequest,
  key: keyof UploadRequest,
): unknown {
  return hasOwn(payload, key)
    ? { present: true, value: payload[key] ?? null }
    : { present: false }
}

function filenameTitle(filename: string | undefined): string | null {
  if (!filename) return null
  const name = filename.split(/[\\/]/).at(-1)?.trim()
  if (!name) return null
  return name.replace(/\.[^.]+$/, '') || name
}

function failureText(error: PersistenceError): string {
  return String(error.cause)
}

function isIdempotencyUniqueFailure(error: PersistenceError): boolean {
  const text = failureText(error)
  return (
    /document_versions_api_key_idempotency_unique/i.test(text) ||
    /UNIQUE constraint failed:\s*document_versions\.created_by_api_key_id,\s*document_versions\.idempotency_key/i.test(
      text,
    )
  )
}

function isGuardFailure(error: PersistenceError): boolean {
  return failureText(error).includes('publication_guards_ok_check')
}

/**
 * Only errors that identify a SQLite rollback are safe to compensate. A generic
 * D1/internal/network response may have arrived after commit, so its R2 object
 * must be retained for reconciliation.
 */
function isDefiniteRollbackFailure(error: PersistenceError): boolean {
  const text = failureText(error)
  return (
    isGuardFailure(error) ||
    isIdempotencyUniqueFailure(error) ||
    /SQLITE_(?:CONSTRAINT|ABORT|ERROR|MISMATCH|TOOBIG|RANGE|NOTADB|CORRUPT|FULL|READONLY)/i.test(
      text,
    ) ||
    /(?:CHECK|FOREIGN KEY|NOT NULL|UNIQUE) constraint failed/i.test(text)
  )
}

export interface PublishService {
  readonly publish: (
    payload: UploadRequest,
    principal: PrincipalIdentity,
    context?: { readonly requestBytes?: number },
  ) => Effect.Effect<
    UploadResponse,
    DossierError | PersistenceError | StorageError
  >
}

export class Publish extends Context.Tag('@dossier/web/Publish')<
  Publish,
  PublishService
>() {}

export const PublishLive = Layer.effect(
  Publish,
  Effect.gen(function* () {
    const db = yield* Db
    const objects = yield* Objects
    const ids = yield* Ids
    const env = yield* WorkerEnv
    const access = yield* Access
    const principals = yield* Principal
    const origin = env.PUBLIC_BASE_URL.replace(/\/$/, '')

    const findIdempotency = (apiKeyId: string, key: string) =>
      Effect.tryPromise({
        try: () =>
          db.raw
            .prepare(
              `SELECT v.id, v.document_id, v.version_number, v.request_hash,
                      e.metadata_json AS receipt_json
                 FROM document_versions v
            LEFT JOIN upload_events e
                   ON e.document_version_id = v.id AND e.event_type = 'published'
                WHERE v.created_by_api_key_id = ? AND v.idempotency_key = ?
                LIMIT 1`,
            )
            .bind(apiKeyId, key)
            .first<IdempotencyRow>(),
        catch: (cause) =>
          new PersistenceError({
            operation: 'look up idempotent publication',
            cause,
          }),
      })

    const loadReceiptDocument = (
      documentId: string,
      principal: PrincipalIdentity,
    ): Effect.Effect<DocumentEditor, DossierError | PersistenceError> =>
      Effect.gen(function* () {
        const decision = (yield* access.resolve([documentId], principal))[0]
        const row = yield* Effect.tryPromise({
          try: () => loadDocumentRow(db.raw, documentId),
          catch: (cause) =>
            new PersistenceError({
              operation: 'load publication receipt',
              cause,
            }),
        })
        if (!decision?.editor || !row) {
          return yield* Effect.fail(
            apiError('not_found', 'Published document not found.'),
          )
        }
        const parentReadable =
          row.parent_id !== null &&
          (yield* access.resolve([row.parent_id], principal))[0]?.canRead ===
            true
        return toDocumentEditor(
          row,
          decision,
          parentReadable,
          env.PUBLIC_BASE_URL,
        )
      })

    const response = (
      row: IdempotencyRow,
      document: DocumentEditor,
      warnings: readonly string[],
    ): UploadResponse => ({
      ok: true as const,
      document,
      versionNumber: row.version_number,
      versionUrl: `${origin}/d/${row.document_id}/v/${row.version_number}`,
      warnings: [...warnings],
      draftId: row.document_id,
      publicUrl: `${origin}/d/${row.document_id}`,
      rawUrl: `${origin}/d/${row.document_id}/raw`,
    })

    const receipt = (
      row: IdempotencyRow,
      warnings: readonly string[],
      principal: PrincipalIdentity,
    ): Effect.Effect<UploadResponse, DossierError | PersistenceError> =>
      Effect.gen(function* () {
        let document: DocumentEditor | null = null
        if (row.receipt_json !== null) {
          try {
            const metadata = JSON.parse(row.receipt_json) as {
              receiptDocument?: DocumentEditor
            }
            document = metadata.receiptDocument ?? null
          } catch {
            // Rows created before stable receipts were persisted use the
            // compatibility fallback below.
          }
        }
        if (document === null) {
          document = yield* loadReceiptDocument(row.document_id, principal)
        }
        return response(row, document, warnings)
      })

    const publish: PublishService['publish'] = (payload, principal, context) =>
      Effect.gen(function* () {
        yield* principals.requirePublisher(principal)
        const requestBytes =
          context?.requestBytes ??
          new TextEncoder().encode(JSON.stringify(payload)).byteLength
        const maxRequestBytes = positiveInteger(
          env.MAX_REQUEST_BYTES,
          'MAX_REQUEST_BYTES',
        )
        if (requestBytes > maxRequestBytes) {
          return yield* Effect.fail(
            apiError(
              'body_too_large',
              `Request body exceeds the ${maxRequestBytes} byte limit.`,
            ),
          )
        }
        const rateLimit = yield* Effect.tryPromise({
          try: () =>
            env.UPLOAD_RATE_LIMITER.limit({
              key: principal.apiKeyId ?? principal.accountId,
            }),
          catch: (cause) =>
            new PersistenceError({
              operation: 'check upload rate limit',
              cause,
            }),
        })
        if (!rateLimit.success) {
          return yield* Effect.fail(
            new DossierError({
              code: 'rate_limited',
              message: 'Upload rate limit exceeded.',
              retryAfter: 60,
            }),
          )
        }

        const legacyId = payload.draftId ?? undefined
        if (
          payload.documentId !== undefined &&
          legacyId !== undefined &&
          payload.documentId !== legacyId
        ) {
          return yield* Effect.fail(
            apiError(
              'policy_rejected',
              'documentId and draftId must identify the same document.',
            ),
          )
        }
        if (payload.idempotencyKey === '') {
          return yield* Effect.fail(
            apiError('policy_rejected', 'idempotencyKey must not be empty.'),
          )
        }
        const normalizedKind = yield* normalizeDocumentKind(payload.kind)
        const targetId = payload.documentId ?? legacyId
        if (targetId) {
          yield* access.requireEditor(targetId, principal)
          const target = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `SELECT workspace_id, parent_id, deleted_at, disabled_at
                     FROM documents WHERE id = ? LIMIT 1`,
                )
                .bind(targetId)
                .first<{
                  workspace_id: string
                  parent_id: string | null
                  deleted_at: string | null
                  disabled_at: string | null
                }>(),
            catch: (cause) =>
              new PersistenceError({
                operation: 'load publication target',
                cause,
              }),
          })
          if (
            !target ||
            target.workspace_id !== principal.workspaceId ||
            target.deleted_at !== null ||
            target.disabled_at !== null
          ) {
            return yield* Effect.fail(
              apiError('not_found', 'Document not found.'),
            )
          }
          if (
            hasOwn(payload, 'parentId') &&
            (payload.parentId ?? null) !== target.parent_id
          ) {
            return yield* Effect.fail(
              apiError(
                'conflict',
                'Use the move operation to change a document parent.',
              ),
            )
          }
        } else if (
          payload.parentId !== undefined &&
          payload.parentId !== null
        ) {
          const parentDecision = (yield* access.resolve(
            [payload.parentId],
            principal,
          ))[0]
          const parent = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `SELECT workspace_id, depth, deleted_at, disabled_at
                     FROM documents WHERE id = ? LIMIT 1`,
                )
                .bind(payload.parentId)
                .first<{
                  workspace_id: string
                  depth: number
                  deleted_at: string | null
                  disabled_at: string | null
                }>(),
            catch: (cause) =>
              new PersistenceError({
                operation: 'load publication parent',
                cause,
              }),
          })
          if (
            !parent ||
            parent.workspace_id !== principal.workspaceId ||
            parent.deleted_at !== null ||
            parent.disabled_at !== null ||
            parentDecision?.canRead !== true
          ) {
            return yield* Effect.fail(
              apiError('not_found', 'Parent document not found.'),
            )
          }
          if (parent.depth >= 16) {
            return yield* Effect.fail(
              apiError(
                'policy_rejected',
                'A child cannot be created below depth 16.',
              ),
            )
          }
        }

        const policy = validateHtml(payload.html, {
          maxBytes: positiveInteger(env.MAX_HTML_BYTES, 'MAX_HTML_BYTES'),
          publicOrigin: env.PUBLIC_BASE_URL,
          styleHostAllowlist: commaSeparatedHosts(env.STYLE_HOST_ALLOWLIST),
          embedHostAllowlist: commaSeparatedHosts(env.EMBED_HOST_ALLOWLIST),
          scriptHostAllowlist: commaSeparatedHosts(env.SCRIPT_HOST_ALLOWLIST),
        })
        if (!policy.ok) {
          return yield* Effect.fail(
            apiError(
              'policy_rejected',
              'HTML failed the dossier upload policy.',
              {
                errors: policy.errors,
                warnings: policy.warnings,
              },
            ),
          )
        }

        const htmlBytes = new TextEncoder().encode(payload.html)
        const contentHash = yield* ids.sha256Hex(htmlBytes)
        const requestHash = yield* ids.sha256Hex(
          canonicalJson({
            htmlHash: contentHash,
            target: targetId ? { documentId: targetId } : { create: true },
            parent: canonicalField(payload, 'parentId'),
            kind: canonicalField(payload, 'kind'),
            description: canonicalField(payload, 'description'),
            visibility: canonicalField(payload, 'visibility'),
            shares: canonicalField(payload, 'shares'),
            metadata: canonicalField(payload, 'metadata'),
            filename: canonicalField(payload, 'filename'),
          }),
        )

        if (payload.idempotencyKey !== undefined && principal.apiKeyId) {
          const previous = yield* findIdempotency(
            principal.apiKeyId,
            payload.idempotencyKey,
          )
          if (previous) {
            if (previous.request_hash !== requestHash) {
              return yield* Effect.fail(
                apiError(
                  'idempotency_conflict',
                  'The idempotency key was already used for a different request.',
                ),
              )
            }
            return yield* receipt(previous, policy.warnings, principal)
          }
        }

        const documentId = targetId ?? ids.documentId()
        const versionId = ids.internalId()
        const eventId = ids.internalId()
        const guardId = ids.internalId()
        const objectKey = `docs/${documentId}/${versionId}.html`
        const now = new Date().toISOString()
        const title =
          policy.title?.trim() || filenameTitle(payload.filename) || 'Untitled'
        const metadata = payload.metadata
        const sharesPresent = hasOwn(payload, 'shares')
        const clearingVisibility =
          hasOwn(payload, 'visibility') && payload.visibility === null
        const writeShares = sharesPresent && !clearingVisibility
        const clearShares = sharesPresent || clearingVisibility
        const sharesJson = JSON.stringify(
          [
            ...new Set(
              (payload.shares ?? []).map((email) => email.trim().toLowerCase()),
            ),
          ].filter(Boolean),
        )

        yield* objects.put(objectKey, htmlBytes, {
          httpMetadata: { contentType: 'text/html; charset=utf-8' },
          customMetadata: { contentHash, documentId, versionId },
        })

        const statements: D1PreparedStatement[] = []
        if (targetId) {
          statements.push(
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
                   WHERE d.id = ? AND d.workspace_id = ?
                     AND d.deleted_at IS NULL AND d.disabled_at IS NULL
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
          )
        } else if (
          payload.parentId !== undefined &&
          payload.parentId !== null
        ) {
          const [accountId, emails] = accessBindValues(principal)
          statements.push(
            db.raw
              .prepare(
                `${accessCteSql('SELECT ?3')}
                 INSERT INTO publication_guards (id, ok)
                 VALUES (?4, CASE WHEN EXISTS (
                   SELECT 1 FROM accounts actor
                   JOIN workspaces workspace ON workspace.id = ?5
              LEFT JOIN memberships publisher
                     ON publisher.workspace_id = workspace.id
                    AND publisher.account_id = actor.id
                  WHERE actor.id = ?1 AND actor.disabled_at IS NULL
                    AND (actor.kind = 'service' OR publisher.account_id IS NOT NULL)
                    AND EXISTS (
                      SELECT 1 FROM documents parent
                      JOIN access_decisions decision ON decision.document_id = parent.id
                       WHERE parent.id = ?3 AND parent.workspace_id = workspace.id
                         AND parent.deleted_at IS NULL AND parent.disabled_at IS NULL
                         AND parent.depth < 16 AND decision.can_read = 1
                    )
                 ) THEN 1 ELSE 0 END)`,
              )
              .bind(
                accountId,
                emails,
                payload.parentId,
                guardId,
                principal.workspaceId,
              ),
            db.raw
              .prepare(
                `INSERT INTO documents
                   (id, workspace_id, created_by, parent_id, path, depth, kind,
                    title, description, visibility, current_version_id,
                    next_version_number, revision, created_at, updated_at,
                    deleted_at, deletion_batch_id, disabled_at, disabled_reason)
                 SELECT ?, ?, ?, parent.id, parent.path || parent.id || '/',
                        parent.depth + 1, ?, ?, ?, ?, NULL, 1, 0, ?, ?,
                        NULL, NULL, NULL, NULL
                   FROM documents parent WHERE parent.id = ?`,
              )
              .bind(
                documentId,
                principal.workspaceId,
                principal.accountId,
                normalizedKind ?? null,
                title,
                payload.description ?? null,
                payload.visibility ?? null,
                now,
                now,
                payload.parentId,
              ),
          )
        } else {
          statements.push(
            db.raw
              .prepare(
                `INSERT INTO publication_guards (id, ok)
                 VALUES (?, CASE WHEN EXISTS (
                   SELECT 1 FROM accounts actor
                   JOIN workspaces workspace ON workspace.id = ?
              LEFT JOIN memberships publisher
                     ON publisher.workspace_id = workspace.id AND publisher.account_id = actor.id
                  WHERE actor.id = ? AND actor.disabled_at IS NULL
                    AND (actor.kind = 'service' OR publisher.account_id IS NOT NULL)
                 ) THEN 1 ELSE 0 END)`,
              )
              .bind(guardId, principal.workspaceId, principal.accountId),
            db.raw
              .prepare(
                `INSERT INTO documents
                   (id, workspace_id, created_by, parent_id, path, depth, kind,
                    title, description, visibility, current_version_id,
                    next_version_number, revision, created_at, updated_at,
                    deleted_at, deletion_batch_id, disabled_at, disabled_reason)
                 VALUES (?, ?, ?, NULL, '/', 0, ?, ?, ?, ?, NULL, 1, 0, ?, ?,
                         NULL, NULL, NULL, NULL)`,
              )
              .bind(
                documentId,
                principal.workspaceId,
                principal.accountId,
                normalizedKind ?? null,
                title,
                payload.description ?? null,
                payload.visibility ?? null,
                now,
                now,
              ),
          )
        }
        statements.push(
          db.raw
            .prepare(
              `UPDATE documents
                  SET next_version_number = next_version_number + 1
                WHERE id = ?`,
            )
            .bind(documentId),
          db.raw
            .prepare(
              `INSERT INTO document_versions
                 (id, document_id, version_number, object_key, content_hash,
                  file_size, created_at, created_by_account_id,
                  created_by_api_key_id, user_agent, cli_version, git_branch,
                  git_commit_sha, git_commit_subject, git_dirty,
                  original_filename, has_inline_script, external_image_hosts,
                  stylesheet_refs, ci_run_url, ci_actor, idempotency_key,
                  request_hash)
               SELECT ?, id, next_version_number - 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                 FROM documents WHERE id = ?`,
            )
            .bind(
              versionId,
              objectKey,
              contentHash,
              htmlBytes.byteLength,
              now,
              principal.accountId,
              principal.apiKeyId ?? null,
              metadata?.userAgent ?? null,
              metadata?.cliVersion ?? null,
              metadata?.gitBranch ?? null,
              metadata?.gitCommitSha ?? null,
              metadata?.gitCommitSubject ?? null,
              metadata?.gitDirty === undefined || metadata.gitDirty === null
                ? null
                : metadata.gitDirty
                  ? 1
                  : 0,
              payload.filename ?? null,
              policy.stats.hasInlineScript ? 1 : 0,
              JSON.stringify(policy.stats.externalImageHosts),
              JSON.stringify(policy.stats.stylesheetRefs),
              metadata?.ciRunUrl ?? null,
              metadata?.ciActor ?? null,
              payload.idempotencyKey ?? null,
              requestHash,
              documentId,
            ),
          db.raw
            .prepare(
              `WITH RECURSIVE ancestors(id, parent_id, visibility, hops) AS (
                 SELECT parent.id, parent.parent_id, parent.visibility, 1
                   FROM documents target
                   JOIN documents parent ON parent.id = target.parent_id
                  WHERE target.id = ?
                 UNION ALL
                 SELECT parent.id, parent.parent_id, parent.visibility, ancestors.hops + 1
                   FROM ancestors
                   JOIN documents parent ON parent.id = ancestors.parent_id
                  WHERE ancestors.hops < 16
               ), boundary AS (
                 SELECT visibility FROM ancestors
                  WHERE visibility IS NOT NULL ORDER BY hops LIMIT 1
               )
               UPDATE documents
                  SET visibility = COALESCE((SELECT visibility FROM boundary), 'team')
                WHERE id = ? AND visibility IS NULL AND ? = 1 AND ? = 0`,
            )
            .bind(
              documentId,
              documentId,
              sharesPresent ? 1 : 0,
              hasOwn(payload, 'visibility') ? 1 : 0,
            ),
          db.raw
            .prepare(
              `UPDATE documents
                  SET current_version_id = ?, title = ?,
                      kind = CASE WHEN ? = 1 THEN ? ELSE kind END,
                      description = CASE WHEN ? = 1 THEN ? ELSE description END,
                      visibility = CASE WHEN ? = 1 THEN ? ELSE visibility END,
                      revision = revision + 1, updated_at = ?
                WHERE id = ?`,
            )
            .bind(
              versionId,
              title,
              hasOwn(payload, 'kind') ? 1 : 0,
              normalizedKind ?? null,
              hasOwn(payload, 'description') ? 1 : 0,
              payload.description ?? null,
              hasOwn(payload, 'visibility') ? 1 : 0,
              payload.visibility ?? null,
              now,
              documentId,
            ),
          db.raw
            .prepare(
              `DELETE FROM document_shares
                WHERE document_id = ? AND ? = 1`,
            )
            .bind(documentId, clearShares ? 1 : 0),
          db.raw
            .prepare(
              `INSERT INTO document_shares
                 (document_id, email, created_by_account_id, created_at)
               SELECT ?, value, ?, ? FROM json_each(?) WHERE ? = 1`,
            )
            .bind(
              documentId,
              principal.accountId,
              now,
              sharesJson,
              writeShares ? 1 : 0,
            ),
          db.raw
            .prepare(
              `INSERT INTO upload_events
                 (id, document_id, document_version_id, account_id, api_key_id,
                  event_type, metadata_json, created_at)
               SELECT ?, d.id, v.id, ?, ?, 'published',
                      json_object(
                        'contentHash', ?,
                        'requestHash', ?,
                        'filename', ?,
                        'metadata', json(?),
                        'receiptDocument', NULL
                      ), ?
                 FROM documents d
                 JOIN workspaces w ON w.id = d.workspace_id
                 JOIN accounts author ON author.id = d.created_by
                 JOIN document_versions v ON v.id = ?
                WHERE d.id = ?`,
            )
            .bind(
              eventId,
              principal.accountId,
              principal.apiKeyId ?? null,
              contentHash,
              requestHash,
              payload.filename ?? null,
              JSON.stringify(metadata ?? null),
              now,
              versionId,
              documentId,
            ),
          db.raw
            .prepare(`DELETE FROM publication_guards WHERE id = ?`)
            .bind(guardId),
        )

        const batchResult = yield* db.batch(statements).pipe(Effect.either)
        if (batchResult._tag === 'Left') {
          const failure = batchResult.left
          const idempotencyConflict =
            isIdempotencyUniqueFailure(failure) &&
            payload.idempotencyKey !== undefined &&
            principal.apiKeyId !== undefined

          if (idempotencyConflict) {
            // The uniqueness response proves this attempt rolled back. Its R2
            // object cannot be the winner's because object keys are per attempt.
            yield* objects
              .delete(objectKey)
              .pipe(Effect.catchAll(() => Effect.void))
            const winner = yield* findIdempotency(
              principal.apiKeyId!,
              payload.idempotencyKey!,
            )
            if (winner) {
              if (winner.request_hash !== requestHash) {
                return yield* Effect.fail(
                  apiError(
                    'idempotency_conflict',
                    'The idempotency key was already used for a different request.',
                  ),
                )
              }
              return yield* receipt(winner, policy.warnings, principal)
            }
          } else if (isDefiniteRollbackFailure(failure)) {
            yield* objects
              .delete(objectKey)
              .pipe(Effect.catchAll(() => Effect.void))
          }
          if (isGuardFailure(failure)) {
            return yield* Effect.fail(
              apiError(
                'conflict',
                'A publication precondition changed before commit.',
              ),
            )
          }
          return yield* Effect.fail(failure)
        }

        const row = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT v.id, v.document_id, v.version_number, v.request_hash,
                        e.metadata_json AS receipt_json
                   FROM document_versions v
              LEFT JOIN upload_events e
                     ON e.document_version_id = v.id AND e.event_type = 'published'
                  WHERE v.id = ? LIMIT 1`,
              )
              .bind(versionId)
              .first<IdempotencyRow>(),
          catch: (cause) =>
            new PersistenceError({
              operation: 'load publication result',
              cause,
            }),
        })
        if (!row) {
          return yield* Effect.fail(
            new PersistenceError({
              operation: 'load publication result',
              cause: new Error('Committed version row was not found.'),
            }),
          )
        }
        const document = yield* loadReceiptDocument(documentId, principal)
        yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `UPDATE upload_events
                    SET metadata_json = json_set(metadata_json, '$.receiptDocument', json(?))
                  WHERE document_version_id = ? AND event_type = 'published'`,
              )
              .bind(JSON.stringify(document), versionId)
              .run(),
          catch: (cause) =>
            new PersistenceError({
              operation: 'persist publication receipt',
              cause,
            }),
        })
        return response(row, document, policy.warnings)
      })

    return { publish }
  }),
)
