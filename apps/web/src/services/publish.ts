import type {
  DocumentEditor,
  UploadRequest,
  UploadResponse,
} from '@dossier/contracts'
import { validateHtml } from '@dossier/policy'
import { Context, Effect, Layer } from 'effect'

import { Access } from './access'
import { Db } from './db'
import { loadDocumentEditor } from './documents'
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

    const receipt = (
      row: IdempotencyRow,
      warnings: readonly string[],
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
          document = yield* Effect.tryPromise({
            try: () =>
              loadDocumentEditor(db.raw, row.document_id, env.PUBLIC_BASE_URL),
            catch: (cause) =>
              new PersistenceError({
                operation: 'load publication receipt',
                cause,
              }),
          })
        }
        if (!document) {
          return yield* Effect.fail(
            apiError('not_found', 'Published document not found.'),
          )
        }
        return {
          ok: true as const,
          document,
          versionNumber: row.version_number,
          versionUrl: `${origin}/d/${row.document_id}/v/${row.version_number}`,
          warnings: [...warnings],
          draftId: row.document_id,
          publicUrl: `${origin}/d/${row.document_id}`,
          rawUrl: `${origin}/d/${row.document_id}/raw`,
        }
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
        if (payload.parentId !== undefined && payload.parentId !== null) {
          return yield* Effect.fail(
            apiError(
              'policy_rejected',
              'Parent document placement is not available until dossier phase 2.',
            ),
          )
        }

        const targetId = payload.documentId ?? legacyId
        if (targetId) {
          yield* access.requireEditor(targetId, principal)
          const target = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `SELECT workspace_id, deleted_at, disabled_at
                     FROM documents WHERE id = ? LIMIT 1`,
                )
                .bind(targetId)
                .first<{
                  workspace_id: string
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
            return yield* receipt(previous, policy.warnings)
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
        } else {
          statements.push(
            db.raw
              .prepare(
                `INSERT INTO publication_guards (id, ok)
                 VALUES (?, CASE WHEN EXISTS (
                   SELECT 1 FROM accounts a
                   JOIN workspaces w ON w.id = ?
                   LEFT JOIN memberships publisher
                     ON publisher.workspace_id = w.id AND publisher.account_id = a.id
                   WHERE a.id = ? AND a.disabled_at IS NULL
                     AND (a.kind = 'service' OR publisher.account_id IS NOT NULL)
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
                payload.kind ?? null,
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
              payload.kind ?? null,
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
            .bind(documentId, sharesPresent ? 1 : 0),
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
              sharesPresent ? 1 : 0,
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
                        'receiptDocument', json_object(
                          'id', d.id,
                          'title', d.title,
                          'description', d.description,
                          'kind', d.kind,
                          'parentId', d.parent_id,
                          'effectiveVisibility', COALESCE(d.visibility, 'team'),
                          'workspaceSlug', w.slug,
                          'authorAccountId', d.created_by,
                          'authorName', author.name,
                          'latestVersionNumber', v.version_number,
                          'disabled', json(CASE WHEN d.disabled_at IS NULL THEN 'false' ELSE 'true' END),
                          'url', ? || '/d/' || d.id,
                          'rawUrl', ? || '/d/' || d.id || '/raw',
                          'hubUrl', ? || '/d/' || d.id || '/tree',
                          'createdAt', d.created_at,
                          'updatedAt', d.updated_at,
                          'visibility', d.visibility,
                          'accessSource', CASE WHEN d.visibility IS NULL THEN 'inherited' ELSE 'own' END,
                          'versionCount', (SELECT COUNT(*) FROM document_versions counted WHERE counted.document_id = d.id),
                          'revision', d.revision,
                          'deletionBatchId', d.deletion_batch_id,
                          'deletedAt', d.deleted_at,
                          'deletedBy', NULL,
                          'disabledAt', d.disabled_at
                        )
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
              origin,
              origin,
              origin,
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
              return yield* receipt(winner, policy.warnings)
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
        return yield* receipt(row, policy.warnings)
      })

    return { publish }
  }),
)
