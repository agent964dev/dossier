import type { AccessSource, Visibility } from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import { Db } from './db'
import { apiError, DossierError, PersistenceError } from './errors'
import type { PrincipalIdentity } from './principal'

export interface AccessDecision {
  readonly documentId: string
  readonly workspaceId: string
  readonly effectiveVisibility: Visibility
  readonly accessSource: AccessSource
  readonly accessSourceId: string | null
  readonly editor: boolean
  readonly canRead: boolean
}

/**
 * Builds the one ACL CTE used by point reads and collection queries. seedSql
 * must return one column named target_id. Availability is deliberately checked
 * only on the target node; ancestors contribute boundary policy only.
 */
export function accessCteSql(seedSql: string): string {
  return `WITH RECURSIVE
    requested(target_id) AS (${seedSql}),
    ancestors(target_id, id, parent_id, workspace_id, created_by, visibility, deleted_at, disabled_at, hops) AS (
      SELECT d.id, d.id, d.parent_id, d.workspace_id, d.created_by,
             d.visibility, d.deleted_at, d.disabled_at, 0
        FROM documents d
        JOIN requested r ON r.target_id = d.id
      UNION ALL
      SELECT a.target_id, parent.id, parent.parent_id, parent.workspace_id,
             parent.created_by, parent.visibility, parent.deleted_at,
             parent.disabled_at, a.hops + 1
        FROM documents parent
        JOIN ancestors a ON parent.id = a.parent_id
       WHERE a.hops < 16
    ),
    boundary AS (
      SELECT a.target_id, a.id, a.visibility
        FROM ancestors a
       WHERE a.visibility IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM ancestors nearer
            WHERE nearer.target_id = a.target_id
              AND nearer.visibility IS NOT NULL
              AND nearer.hops < a.hops
         )
    ),
    verified_emails(email) AS (
      SELECT DISTINCT CAST(value AS TEXT) FROM json_each(?2)
    ),
    access_decisions AS (
      SELECT target.id AS document_id,
             target.workspace_id,
             COALESCE(policy.visibility, 'team') AS effective_visibility,
             CASE
               WHEN target.visibility IS NOT NULL THEN 'own'
               WHEN policy.id IS NOT NULL THEN 'inherited'
               ELSE 'default'
             END AS access_source,
             policy.id AS access_source_id,
             CASE WHEN ?1 IS NOT NULL AND (
               target.created_by = ?1 OR EXISTS (
                 SELECT 1 FROM memberships editor_membership
                  WHERE editor_membership.workspace_id = target.workspace_id
                    AND editor_membership.account_id = ?1
                    AND editor_membership.role = 'admin'
               )
             ) THEN 1 ELSE 0 END AS editor,
             CASE WHEN target.deleted_at IS NULL
                        AND target.disabled_at IS NULL
                        AND (
                          (?1 IS NOT NULL AND (
                            target.created_by = ?1 OR EXISTS (
                              SELECT 1 FROM memberships editor_membership
                               WHERE editor_membership.workspace_id = target.workspace_id
                                 AND editor_membership.account_id = ?1
                                 AND editor_membership.role = 'admin'
                            )
                          ))
                          OR COALESCE(policy.visibility, 'team') = 'public'
                          OR (COALESCE(policy.visibility, 'team') = 'team'
                              AND ?1 IS NOT NULL
                              AND EXISTS (
                                SELECT 1 FROM memberships reader_membership
                                 WHERE reader_membership.workspace_id = target.workspace_id
                                   AND reader_membership.account_id = ?1
                              ))
                          OR EXISTS (
                            SELECT 1
                              FROM document_shares share
                              JOIN verified_emails email ON email.email = share.email
                             WHERE share.document_id = policy.id
                          )
                          OR EXISTS (
                            SELECT 1
                              FROM document_state_grants g
                              JOIN identities i ON i.email = g.email
                             WHERE g.document_id = target.id
                               AND i.account_id = ?1
                               AND i.email_verified = 1
                          )
                        )
                   THEN 1 ELSE 0 END AS can_read
        FROM ancestors target
   LEFT JOIN boundary policy ON policy.target_id = target.id
       WHERE target.hops = 0
    )`
}

export function accessBindValues(
  principal: PrincipalIdentity | null,
): readonly [string | null, string] {
  return [
    principal?.accountId ?? null,
    JSON.stringify(principal?.verifiedEmails ?? []),
  ]
}

export interface AccessService {
  readonly resolve: (
    documentIds: readonly string[],
    principal: PrincipalIdentity | null,
  ) => Effect.Effect<readonly AccessDecision[], PersistenceError>
  readonly isEditor: (
    documentId: string,
    principal: PrincipalIdentity,
  ) => Effect.Effect<boolean, PersistenceError>
  readonly canReadContent: (
    documentId: string,
    principal: PrincipalIdentity | null,
  ) => Effect.Effect<boolean, PersistenceError>
  readonly requireReadable: (
    documentId: string,
    principal: PrincipalIdentity | null,
  ) => Effect.Effect<AccessDecision, DossierError | PersistenceError>
  readonly requireEditor: (
    documentId: string,
    principal: PrincipalIdentity,
  ) => Effect.Effect<AccessDecision, DossierError | PersistenceError>
}

export class Access extends Context.Tag('@dossier/web/Access')<
  Access,
  AccessService
>() {}

type AccessRow = {
  document_id: string
  workspace_id: string
  effective_visibility: Visibility
  access_source: AccessSource
  access_source_id: string | null
  editor: number
  can_read: number
}

function decision(row: AccessRow): AccessDecision {
  return {
    documentId: row.document_id,
    workspaceId: row.workspace_id,
    effectiveVisibility: row.effective_visibility,
    accessSource: row.access_source,
    accessSourceId: row.access_source_id,
    editor: row.editor === 1,
    canRead: row.can_read === 1,
  }
}

export const AccessLive = Layer.effect(
  Access,
  Effect.gen(function* () {
    const db = yield* Db

    const resolve: AccessService['resolve'] = (documentIds, principal) => {
      if (documentIds.length === 0) return Effect.succeed([])
      return Effect.tryPromise({
        try: async () => {
          const [accountId, emails] = accessBindValues(principal)
          const result = await db.raw
            .prepare(
              `${accessCteSql('SELECT CAST(value AS TEXT) FROM json_each(?3)')}
               SELECT document_id, workspace_id, effective_visibility,
                      access_source, access_source_id, editor, can_read
                 FROM access_decisions`,
            )
            .bind(accountId, emails, JSON.stringify([...new Set(documentIds)]))
            .all<AccessRow>()
          return result.results.map(decision)
        },
        catch: (cause) =>
          new PersistenceError({ operation: 'resolve document access', cause }),
      })
    }

    const one = (documentId: string, principal: PrincipalIdentity | null) =>
      Effect.map(resolve([documentId], principal), (rows) => rows[0])

    const isEditor: AccessService['isEditor'] = (documentId, principal) =>
      Effect.map(one(documentId, principal), (row) => row?.editor === true)

    const canReadContent: AccessService['canReadContent'] = (
      documentId,
      principal,
    ) => Effect.map(one(documentId, principal), (row) => row?.canRead === true)

    const requireReadable: AccessService['requireReadable'] = (
      documentId,
      principal,
    ) =>
      Effect.gen(function* () {
        const row = yield* one(documentId, principal)
        if (!row?.canRead) {
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        }
        return row
      })

    const requireEditor: AccessService['requireEditor'] = (
      documentId,
      principal,
    ) =>
      Effect.gen(function* () {
        const row = yield* one(documentId, principal)
        if (!row) {
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        }
        if (row.editor) return row
        if (row.canRead) {
          return yield* Effect.fail(
            apiError('editor_required', 'Document edit access is required.'),
          )
        }
        return yield* Effect.fail(apiError('not_found', 'Document not found.'))
      })

    return { resolve, isEditor, canReadContent, requireReadable, requireEditor }
  }),
)
