import { Context, Effect, Layer } from 'effect'

import { Db } from './db'
import { apiError, DossierError, PersistenceError } from './errors'
import type { PrincipalIdentity } from './principal'

export interface AccessService {
  readonly isEditor: (
    documentId: string,
    principal: PrincipalIdentity,
  ) => Effect.Effect<boolean, PersistenceError>
  readonly canReadContent: (
    documentId: string,
    principal: PrincipalIdentity,
  ) => Effect.Effect<boolean, PersistenceError>
  readonly requireEditor: (
    documentId: string,
    principal: PrincipalIdentity,
  ) => Effect.Effect<void, DossierError | PersistenceError>
}

export class Access extends Context.Tag('@dossier/web/Access')<
  Access,
  AccessService
>() {}

export const AccessLive = Layer.effect(
  Access,
  Effect.gen(function* () {
    const db = yield* Db

    const query = (
      documentId: string,
      principal: PrincipalIdentity,
      contentOnly: boolean,
    ) =>
      Effect.tryPromise({
        try: () =>
          db.raw
            .prepare(
              `SELECT d.id,
                      CASE WHEN d.created_by = ? OR m.role = 'admin' THEN 1 ELSE 0 END AS editor
                 FROM documents d
            LEFT JOIN memberships m
                   ON m.workspace_id = d.workspace_id
                  AND m.account_id = ?
                WHERE d.id = ?
                  AND d.workspace_id = ?
                  ${contentOnly ? 'AND d.deleted_at IS NULL AND d.disabled_at IS NULL' : ''}
                LIMIT 1`,
            )
            .bind(
              principal.accountId,
              principal.accountId,
              documentId,
              principal.workspaceId,
            )
            .first<{ id: string; editor: number }>(),
        catch: (cause) =>
          new PersistenceError({ operation: 'check document access', cause }),
      })

    const isEditor: AccessService['isEditor'] = (documentId, principal) =>
      Effect.map(
        query(documentId, principal, false),
        (row) => row?.editor === 1,
      )

    const canReadContent: AccessService['canReadContent'] = (
      documentId,
      principal,
    ) =>
      Effect.map(query(documentId, principal, true), (row) => row?.editor === 1)

    const requireEditor: AccessService['requireEditor'] = (
      documentId,
      principal,
    ) =>
      Effect.gen(function* () {
        const row = yield* query(documentId, principal, false)
        if (!row) {
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        }
        if (row.editor !== 1) {
          // Phase one has an editor-only read floor. Non-editors therefore get
          // the same response as a missing ID, avoiding an existence oracle.
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        }
      })

    return { isEditor, canReadContent, requireEditor }
  }),
)
