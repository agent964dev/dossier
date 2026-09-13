import type {
  ShareDelta,
  ShareReplacement,
  SharesResponse,
} from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import { Access } from './access'
import { Db } from './db'
import { apiError, DossierError, PersistenceError } from './errors'
import { Ids } from './ids'
import { Principal, type PrincipalIdentity } from './principal'

function normalizedEmails(
  values: readonly string[],
): Effect.Effect<readonly string[], DossierError> {
  const emails = [
    ...new Set(
      values.map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  ]
  const invalid = emails.find((email) => !/^[^\s@]+@[^\s@]+$/.test(email))
  return invalid
    ? Effect.fail(
        apiError('policy_rejected', `Invalid share email: ${invalid}`),
      )
    : Effect.succeed(emails.sort())
}

function guardFailure(
  error: PersistenceError,
): DossierError | PersistenceError {
  return String(error.cause).includes('publication_guards_ok_check')
    ? apiError(
        'conflict',
        'The document changed while the operation was running.',
      )
    : error
}

const inheritedShareCopySql = `WITH RECURSIVE ancestors(id, parent_id, visibility, hops) AS (
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
  SELECT id FROM ancestors WHERE visibility IS NOT NULL ORDER BY hops LIMIT 1
)
INSERT OR IGNORE INTO document_shares
  (document_id, email, created_by_account_id, created_at)
SELECT ?, share.email, ?, ?
  FROM document_shares share
 WHERE share.document_id = (SELECT id FROM boundary)
   AND (SELECT visibility FROM documents WHERE id = ?) IS NULL`

const inheritedVisibilitySql = `WITH RECURSIVE ancestors(id, parent_id, visibility, hops) AS (
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
  SELECT visibility FROM ancestors WHERE visibility IS NOT NULL ORDER BY hops LIMIT 1
)
UPDATE documents
   SET visibility = COALESCE((SELECT visibility FROM boundary), 'team')
 WHERE id = ? AND visibility IS NULL`

export interface SharesService {
  readonly get: (
    documentId: string,
    principal: PrincipalIdentity,
  ) => Effect.Effect<SharesResponse, DossierError | PersistenceError>
  readonly delta: (
    documentId: string,
    delta: ShareDelta,
    principal: PrincipalIdentity,
  ) => Effect.Effect<SharesResponse, DossierError | PersistenceError>
  readonly replace: (
    documentId: string,
    replacement: ShareReplacement,
    principal: PrincipalIdentity,
  ) => Effect.Effect<SharesResponse, DossierError | PersistenceError>
}

export class Shares extends Context.Tag('@dossier/web/Shares')<
  Shares,
  SharesService
>() {}

export const SharesLive = Layer.effect(
  Shares,
  Effect.gen(function* () {
    const db = yield* Db
    const access = yield* Access
    const ids = yield* Ids
    const principals = yield* Principal

    const get: SharesService['get'] = (documentId, principal) =>
      Effect.gen(function* () {
        const decision = yield* access.requireEditor(documentId, principal)
        const configured = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT email FROM document_shares
                  WHERE document_id = ? ORDER BY email`,
              )
              .bind(documentId)
              .all<{ email: string }>(),
          catch: (cause) =>
            new PersistenceError({
              operation: 'load configured shares',
              cause,
            }),
        })
        const effective =
          decision.accessSourceId === null
            ? { results: [] as { email: string }[] }
            : yield* Effect.tryPromise({
                try: () =>
                  db.raw
                    .prepare(
                      `SELECT email FROM document_shares
                      WHERE document_id = ? ORDER BY email`,
                    )
                    .bind(decision.accessSourceId)
                    .all<{ email: string }>(),
                catch: (cause) =>
                  new PersistenceError({
                    operation: 'load effective shares',
                    cause,
                  }),
              })
        return {
          configured: configured.results.map((row) => row.email),
          effective: effective.results.map((row) => row.email),
          accessSource: decision.accessSource,
        }
      })

    const authorizeMutation = (
      documentId: string,
      principal: PrincipalIdentity,
    ) =>
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

    const guard = (
      documentId: string,
      principal: PrincipalIdentity,
      guardId: string,
      ifRevision?: number,
    ) =>
      db.raw
        .prepare(
          `INSERT INTO publication_guards (id, ok)
           VALUES (?, CASE WHEN EXISTS (
             SELECT 1 FROM documents d
             JOIN accounts actor ON actor.id = ? AND actor.disabled_at IS NULL
        LEFT JOIN memberships publisher
               ON publisher.workspace_id = d.workspace_id AND publisher.account_id = actor.id
        LEFT JOIN memberships editor_membership
               ON editor_membership.workspace_id = d.workspace_id AND editor_membership.account_id = actor.id
            WHERE d.id = ? AND d.workspace_id = ?
              AND (? IS NULL OR d.revision = ?)
              AND (actor.kind = 'service' OR publisher.account_id IS NOT NULL)
              AND (d.created_by = actor.id OR editor_membership.role = 'admin')
           ) THEN 1 ELSE 0 END)`,
        )
        .bind(
          guardId,
          principal.accountId,
          documentId,
          principal.workspaceId,
          ifRevision ?? null,
          ifRevision ?? null,
        )

    const delta: SharesService['delta'] = (documentId, delta, principal) =>
      Effect.gen(function* () {
        yield* authorizeMutation(documentId, principal)
        const add = yield* normalizedEmails(delta.add ?? [])
        const remove = yield* normalizedEmails(delta.remove ?? [])
        const now = new Date().toISOString()
        const guardId = ids.internalId()
        yield* db
          .batch([
            guard(documentId, principal, guardId),
            db.raw
              .prepare(inheritedShareCopySql)
              .bind(
                documentId,
                documentId,
                principal.accountId,
                now,
                documentId,
              ),
            db.raw.prepare(inheritedVisibilitySql).bind(documentId, documentId),
            db.raw
              .prepare(
                `DELETE FROM document_shares
                WHERE document_id = ? AND email IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
              )
              .bind(documentId, JSON.stringify(remove)),
            db.raw
              .prepare(
                `INSERT OR IGNORE INTO document_shares
                 (document_id, email, created_by_account_id, created_at)
               SELECT ?, CAST(value AS TEXT), ?, ? FROM json_each(?)`,
              )
              .bind(documentId, principal.accountId, now, JSON.stringify(add)),
            db.raw
              .prepare(
                `UPDATE documents SET revision = revision + 1, updated_at = ? WHERE id = ?`,
              )
              .bind(now, documentId),
            db.raw
              .prepare(`DELETE FROM publication_guards WHERE id = ?`)
              .bind(guardId),
          ])
          .pipe(Effect.mapError(guardFailure))
        return yield* get(documentId, principal)
      })

    const replace: SharesService['replace'] = (
      documentId,
      replacement,
      principal,
    ) =>
      Effect.gen(function* () {
        yield* authorizeMutation(documentId, principal)
        const emails = yield* normalizedEmails(replacement.emails)
        const now = new Date().toISOString()
        const guardId = ids.internalId()
        yield* db
          .batch([
            guard(documentId, principal, guardId, replacement.ifRevision),
            db.raw.prepare(inheritedVisibilitySql).bind(documentId, documentId),
            db.raw
              .prepare(`DELETE FROM document_shares WHERE document_id = ?`)
              .bind(documentId),
            db.raw
              .prepare(
                `INSERT INTO document_shares
                 (document_id, email, created_by_account_id, created_at)
               SELECT ?, CAST(value AS TEXT), ?, ? FROM json_each(?)`,
              )
              .bind(
                documentId,
                principal.accountId,
                now,
                JSON.stringify(emails),
              ),
            db.raw
              .prepare(
                `UPDATE documents SET revision = revision + 1, updated_at = ? WHERE id = ?`,
              )
              .bind(now, documentId),
            db.raw
              .prepare(`DELETE FROM publication_guards WHERE id = ?`)
              .bind(guardId),
          ])
          .pipe(Effect.mapError(guardFailure))
        return yield* get(documentId, principal)
      })

    return { get, delta, replace }
  }),
)
