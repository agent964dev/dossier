import type {
  DocumentEditor,
  DocumentPatch,
  DocumentReader,
  TreeResponse,
} from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import { Access, accessBindValues, accessCteSql } from './access'
import { Db } from './db'
import {
  loadDocumentRow,
  toDocumentEditor,
  toDocumentReader,
  type DocumentRow,
} from './documents'
import { WorkerEnv } from './env'
import { apiError, DossierError, PersistenceError } from './errors'
import { Ids } from './ids'
import { Principal, type PrincipalIdentity } from './principal'

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

export function normalizeDocumentKind(
  kind: string | null | undefined,
): Effect.Effect<string | null | undefined, DossierError> {
  if (kind === undefined || kind === null) return Effect.succeed(kind)
  const normalized = kind.trim().toLowerCase()
  return /^[a-z0-9-]{1,32}$/.test(normalized)
    ? Effect.succeed(normalized)
    : Effect.fail(
        apiError(
          'policy_rejected',
          'kind must contain 1 to 32 lowercase letters, digits, or hyphens.',
        ),
      )
}

function guarded(error: PersistenceError): DossierError | PersistenceError {
  return String(error.cause).includes('publication_guards_ok_check')
    ? apiError('conflict', 'The document changed while the operation was running.')
    : error
}

export interface TreeService {
  readonly get: (
    documentId: string,
    principal: PrincipalIdentity | null,
  ) => Effect.Effect<TreeResponse, DossierError | PersistenceError>
  readonly patch: (
    documentId: string,
    patch: DocumentPatch,
    principal: PrincipalIdentity,
  ) => Effect.Effect<DocumentEditor, DossierError | PersistenceError>
}

export class Tree extends Context.Tag('@dossier/web/Tree')<Tree, TreeService>() {}

export const TreeLive = Layer.effect(
  Tree,
  Effect.gen(function* () {
    const db = yield* Db
    const env = yield* WorkerEnv
    const access = yield* Access
    const ids = yield* Ids
    const principals = yield* Principal

    const row = (documentId: string) =>
      Effect.tryPromise({
        try: () => loadDocumentRow(db.raw, documentId),
        catch: (cause) => new PersistenceError({ operation: 'load tree document', cause }),
      })

    const reader = (
      documentRow: DocumentRow,
      principal: PrincipalIdentity | null,
      knownParentReadable?: boolean,
    ): Effect.Effect<DocumentReader, DossierError | PersistenceError> =>
      Effect.gen(function* () {
        const decision = (yield* access.resolve([documentRow.id], principal))[0]
        if (!decision?.canRead) {
          return yield* Effect.fail(apiError('not_found', 'Document not found.'))
        }
        const parentReadable = knownParentReadable ?? (
          documentRow.parent_id !== null &&
          (yield* access.resolve([documentRow.parent_id], principal))[0]?.canRead === true
        )
        return toDocumentReader(
          documentRow,
          decision,
          parentReadable,
          env.PUBLIC_BASE_URL,
        )
      })

    const editor = (
      documentId: string,
      principal: PrincipalIdentity,
    ): Effect.Effect<DocumentEditor, DossierError | PersistenceError> =>
      Effect.gen(function* () {
        const decision = yield* access.requireEditor(documentId, principal)
        const documentRow = yield* row(documentId)
        if (!documentRow) {
          return yield* Effect.fail(apiError('not_found', 'Document not found.'))
        }
        const parentReadable = documentRow.parent_id !== null &&
          (yield* access.resolve([documentRow.parent_id], principal))[0]?.canRead === true
        return toDocumentEditor(
          documentRow,
          decision,
          parentReadable,
          env.PUBLIC_BASE_URL,
        )
      })

    const get: TreeService['get'] = (documentId, principal) =>
      Effect.gen(function* () {
        yield* access.requireReadable(documentId, principal)
        const target = yield* row(documentId)
        if (!target) return yield* Effect.fail(apiError('not_found', 'Document not found.'))

        const chain = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `WITH RECURSIVE chain(id, parent_id, hops) AS (
                   SELECT parent.id, parent.parent_id, 1
                     FROM documents target
                     JOIN documents parent ON parent.id = target.parent_id
                    WHERE target.id = ?
                   UNION ALL
                   SELECT parent.id, parent.parent_id, chain.hops + 1
                     FROM chain
                     JOIN documents parent ON parent.id = chain.parent_id
                    WHERE chain.hops < 16
                 )
                 SELECT id, parent_id, hops FROM chain ORDER BY hops`,
              )
              .bind(documentId)
              .all<{ id: string; parent_id: string | null; hops: number }>(),
          catch: (cause) => new PersistenceError({ operation: 'load breadcrumb chain', cause }),
        })
        const chainDecisions = new Map(
          (yield* access.resolve(chain.results.map((item) => item.id), principal)).map(
            (item) => [item.documentId, item],
          ),
        )
        const visibleAncestors: typeof chain.results = []
        for (const item of chain.results) {
          if (!chainDecisions.get(item.id)?.canRead) break
          visibleAncestors.push(item)
        }
        const breadcrumb: DocumentReader[] = []
        for (const item of [...visibleAncestors].reverse()) {
          const ancestor = yield* row(item.id)
          if (ancestor) {
            const parentVisible = ancestor.parent_id !== null &&
              visibleAncestors.some((candidate) => candidate.id === ancestor.parent_id)
            breadcrumb.push(yield* reader(ancestor, principal, parentVisible))
          }
        }

        const immediateParentReadable = target.parent_id !== null &&
          chainDecisions.get(target.parent_id)?.canRead === true
        const siblingRows = immediateParentReadable
          ? yield* Effect.tryPromise({
              try: () =>
                db.raw
                  .prepare(
                    `SELECT id FROM documents
                      WHERE parent_id = ? AND id <> ? AND deleted_at IS NULL
                      ORDER BY COALESCE(kind, ''), title, id`,
                  )
                  .bind(target.parent_id, documentId)
                  .all<{ id: string }>(),
              catch: (cause) => new PersistenceError({ operation: 'load tree siblings', cause }),
            })
          : { results: [] as { id: string }[] }
        const childRows = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT id FROM documents
                  WHERE parent_id = ? AND deleted_at IS NULL
                  ORDER BY COALESCE(kind, ''), title, id`,
              )
              .bind(documentId)
              .all<{ id: string }>(),
          catch: (cause) => new PersistenceError({ operation: 'load tree children', cause }),
        })
        const relatedIds = [
          ...siblingRows.results.map((item) => item.id),
          ...childRows.results.map((item) => item.id),
        ]
        const relatedDecisions = new Map(
          (yield* access.resolve(relatedIds, principal)).map((item) => [item.documentId, item]),
        )
        const siblings: DocumentReader[] = []
        for (const item of siblingRows.results) {
          if (!relatedDecisions.get(item.id)?.canRead) continue
          const sibling = yield* row(item.id)
          if (sibling) siblings.push(yield* reader(sibling, principal, true))
        }
        const children: DocumentReader[] = []
        for (const item of childRows.results) {
          if (!relatedDecisions.get(item.id)?.canRead) continue
          const child = yield* row(item.id)
          if (child) children.push(yield* reader(child, principal, true))
        }

        return {
          breadcrumb,
          document: yield* reader(target, principal, immediateParentReadable),
          siblings,
          children,
        }
      })

    const patch: TreeService['patch'] = (documentId, patch, principal) =>
      Effect.gen(function* () {
        const decision = (yield* access.resolve([documentId], principal))[0]
        if (!decision || (!decision.editor && !decision.canRead)) {
          return yield* Effect.fail(apiError('not_found', 'Document not found.'))
        }
        yield* principals.requirePublisher(principal, decision.workspaceId)
        if (!decision.editor) {
          return yield* Effect.fail(
            apiError('editor_required', 'Document edit access is required.'),
          )
        }
        const source = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT id, workspace_id, parent_id, path, depth, revision, deleted_at
                   FROM documents WHERE id = ?`,
              )
              .bind(documentId)
              .first<{
                id: string
                workspace_id: string
                parent_id: string | null
                path: string
                depth: number
                revision: number
                deleted_at: string | null
              }>(),
          catch: (cause) => new PersistenceError({ operation: 'load move source', cause }),
        })
        if (!source || source.deleted_at !== null || source.workspace_id !== principal.workspaceId) {
          return yield* Effect.fail(apiError('not_found', 'Document not found.'))
        }
        if (patch.ifRevision !== undefined && patch.ifRevision !== source.revision) {
          return yield* Effect.fail(apiError('conflict', 'Document revision does not match.'))
        }
        const kind = yield* normalizeDocumentKind(patch.kind)
        const moving = hasOwn(patch, 'parentId')
        const destinationId = moving ? (patch.parentId ?? null) : source.parent_id

        if (moving && destinationId !== null) {
          const destinationAccess = yield* access.resolve([destinationId], principal)
          const destination = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `SELECT id, workspace_id, path, depth, deleted_at, disabled_at
                     FROM documents WHERE id = ?`,
                )
                .bind(destinationId)
                .first<{
                  id: string
                  workspace_id: string
                  path: string
                  depth: number
                  deleted_at: string | null
                  disabled_at: string | null
                }>(),
            catch: (cause) => new PersistenceError({ operation: 'load move destination', cause }),
          })
          if (
            !destination ||
            destination.workspace_id !== source.workspace_id ||
            destination.deleted_at !== null ||
            destination.disabled_at !== null ||
            destinationAccess[0]?.canRead !== true
          ) {
            return yield* Effect.fail(apiError('not_found', 'Parent document not found.'))
          }
          const lower = `${source.path}${source.id}/`
          const upper = `${source.path}${source.id}0`
          if (
            destination.id === source.id ||
            (destination.path >= lower && destination.path < upper)
          ) {
            return yield* Effect.fail(apiError('policy_rejected', 'A document cannot be moved beneath itself.'))
          }
          const maximum = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `SELECT MAX(depth) AS maximum
                     FROM documents
                    WHERE id = ? OR (path >= ? COLLATE BINARY AND path < ? COLLATE BINARY)`,
                )
                .bind(documentId, lower, upper)
                .first<{ maximum: number }>(),
            catch: (cause) => new PersistenceError({ operation: 'measure move subtree', cause }),
          })
          const resultingMaximum = destination.depth + 1 - source.depth + (maximum?.maximum ?? source.depth)
          if (resultingMaximum > 16) {
            return yield* Effect.fail(apiError('policy_rejected', 'The moved subtree would exceed depth 16.'))
          }
        }

        const now = new Date().toISOString()
        const guardId = ids.internalId()
        const [accountId, emails] = accessBindValues(principal)
        const guard = moving
          ? db.raw
              .prepare(
                `${accessCteSql('SELECT ?3 WHERE ?3 IS NOT NULL')},
                 source AS MATERIALIZED (
                   SELECT d.*
                     FROM documents d
                     JOIN accounts actor ON actor.id = ?1 AND actor.disabled_at IS NULL
                LEFT JOIN memberships publisher
                       ON publisher.workspace_id = d.workspace_id
                      AND publisher.account_id = actor.id
                LEFT JOIN memberships editor_membership
                       ON editor_membership.workspace_id = d.workspace_id
                      AND editor_membership.account_id = actor.id
                    WHERE d.id = ?4 AND d.workspace_id = ?5 AND d.deleted_at IS NULL
                      AND (?6 IS NULL OR d.revision = ?6)
                      AND (actor.kind = 'service' OR publisher.account_id IS NOT NULL)
                      AND (d.created_by = actor.id OR editor_membership.role = 'admin')
                 ),
                 destination AS MATERIALIZED (
                   SELECT parent.id, parent.path, parent.depth
                     FROM documents parent
                     JOIN source ON source.workspace_id = parent.workspace_id
                     JOIN access_decisions decision ON decision.document_id = parent.id
                    WHERE parent.id = ?3 AND parent.deleted_at IS NULL
                      AND parent.disabled_at IS NULL AND decision.can_read = 1
                   UNION ALL SELECT NULL, '/', -1 WHERE ?3 IS NULL
                 ),
                 move AS MATERIALIZED (
                   SELECT source.id AS source_id, destination.id AS parent_id,
                          source.path || source.id || '/' AS lower_path,
                          source.path || source.id || '0' AS upper_path,
                          CASE WHEN destination.id IS NULL THEN '/'
                               ELSE destination.path || destination.id || '/' END AS new_path,
                          destination.depth + 1 - source.depth AS depth_delta
                     FROM source CROSS JOIN destination
                    WHERE (destination.id IS NULL OR destination.id <> source.id)
                      AND (destination.id IS NULL OR NOT (
                        destination.path >= source.path || source.id || '/' COLLATE BINARY
                        AND destination.path < source.path || source.id || '0' COLLATE BINARY
                      ))
                      AND destination.depth + 1 - source.depth + (
                        SELECT MAX(descendant.depth) FROM documents descendant
                         WHERE descendant.id = source.id OR (
                           descendant.path >= source.path || source.id || '/' COLLATE BINARY
                           AND descendant.path < source.path || source.id || '0' COLLATE BINARY
                         )
                      ) <= 16
                 )
                 INSERT INTO publication_guards (id, ok)
                 VALUES (?7, CASE WHEN EXISTS (SELECT 1 FROM move) THEN 1 ELSE 0 END)`,
              )
              .bind(
                accountId,
                emails,
                destinationId,
                documentId,
                principal.workspaceId,
                patch.ifRevision ?? null,
                guardId,
              )
          : db.raw
              .prepare(
                `INSERT INTO publication_guards (id, ok)
                 VALUES (?, CASE WHEN EXISTS (
                   SELECT 1 FROM documents d
                   JOIN accounts actor ON actor.id = ? AND actor.disabled_at IS NULL
              LEFT JOIN memberships publisher
                     ON publisher.workspace_id = d.workspace_id AND publisher.account_id = actor.id
              LEFT JOIN memberships editor_membership
                     ON editor_membership.workspace_id = d.workspace_id AND editor_membership.account_id = actor.id
                  WHERE d.id = ? AND d.workspace_id = ? AND d.deleted_at IS NULL
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
                patch.ifRevision ?? null,
                patch.ifRevision ?? null,
              )

        const update = moving
          ? db.raw
              .prepare(
                `WITH
                 source AS MATERIALIZED (
                   SELECT id, workspace_id, parent_id, path, depth
                     FROM documents
                    WHERE id = ?1 AND workspace_id = ?3 AND deleted_at IS NULL
                      AND (?11 IS NULL OR revision = ?11)
                 ),
                 destination AS MATERIALIZED (
                   SELECT id, path, depth FROM documents
                    WHERE id = ?2 AND workspace_id = ?3
                      AND deleted_at IS NULL AND disabled_at IS NULL
                   UNION ALL SELECT NULL, '/', -1 WHERE ?2 IS NULL
                 ),
                 move AS MATERIALIZED (
                   SELECT source.id AS source_id, destination.id AS parent_id,
                          source.path || source.id || '/' AS lower_path,
                          source.path || source.id || '0' AS upper_path,
                          CASE WHEN destination.id IS NULL THEN '/'
                               ELSE destination.path || destination.id || '/' END AS new_path,
                          destination.depth + 1 - source.depth AS depth_delta
                     FROM source CROSS JOIN destination
                    WHERE (destination.id IS NULL OR destination.id <> source.id)
                      AND (destination.id IS NULL OR NOT (
                        destination.path >= source.path || source.id || '/' COLLATE BINARY
                        AND destination.path < source.path || source.id || '0' COLLATE BINARY
                      ))
                      AND destination.depth + 1 - source.depth + (
                        SELECT MAX(descendant.depth) FROM documents descendant
                         WHERE descendant.id = source.id OR (
                           descendant.path >= source.path || source.id || '/' COLLATE BINARY
                           AND descendant.path < source.path || source.id || '0' COLLATE BINARY
                         )
                      ) <= 16
                 )
                 UPDATE documents SET
                   path = CASE
                     WHEN id = (SELECT source_id FROM move) THEN (SELECT new_path FROM move)
                     ELSE (SELECT new_path || source_id || '/' FROM move)
                          || substr(path, length((SELECT lower_path FROM move)) + 1)
                   END,
                   depth = depth + (SELECT depth_delta FROM move),
                   parent_id = CASE WHEN id = (SELECT source_id FROM move)
                                    THEN (SELECT parent_id FROM move) ELSE parent_id END,
                   kind = CASE WHEN id = (SELECT source_id FROM move) AND ?5 = 1 THEN ?6 ELSE kind END,
                   description = CASE WHEN id = (SELECT source_id FROM move) AND ?7 = 1 THEN ?8 ELSE description END,
                   visibility = CASE WHEN id = (SELECT source_id FROM move) AND ?9 = 1 THEN ?10 ELSE visibility END,
                   updated_at = CASE WHEN id = (SELECT source_id FROM move) THEN ?4 ELSE updated_at END,
                   revision = CASE WHEN id = (SELECT source_id FROM move) THEN revision + 1 ELSE revision END
                  WHERE EXISTS (SELECT 1 FROM move)
                    AND (id = (SELECT source_id FROM move) OR (
                      path >= (SELECT lower_path FROM move) COLLATE BINARY
                      AND path < (SELECT upper_path FROM move) COLLATE BINARY
                    ))`,
              )
              .bind(
                documentId,
                destinationId,
                principal.workspaceId,
                now,
                hasOwn(patch, 'kind') ? 1 : 0,
                kind ?? null,
                hasOwn(patch, 'description') ? 1 : 0,
                patch.description ?? null,
                hasOwn(patch, 'visibility') ? 1 : 0,
                patch.visibility ?? null,
                patch.ifRevision ?? null,
              )
          : db.raw
              .prepare(
                `UPDATE documents
                    SET kind = CASE WHEN ? = 1 THEN ? ELSE kind END,
                        description = CASE WHEN ? = 1 THEN ? ELSE description END,
                        visibility = CASE WHEN ? = 1 THEN ? ELSE visibility END,
                        updated_at = ?, revision = revision + 1
                  WHERE id = ?`,
              )
              .bind(
                hasOwn(patch, 'kind') ? 1 : 0,
                kind ?? null,
                hasOwn(patch, 'description') ? 1 : 0,
                patch.description ?? null,
                hasOwn(patch, 'visibility') ? 1 : 0,
                patch.visibility ?? null,
                now,
                documentId,
              )

        yield* db.batch([
          guard,
          update,
          db.raw
            .prepare(
              `DELETE FROM document_shares
                WHERE document_id = ? AND ? = 1 AND ? IS NULL`,
            )
            .bind(
              documentId,
              hasOwn(patch, 'visibility') ? 1 : 0,
              patch.visibility ?? null,
            ),
          db.raw.prepare(`DELETE FROM publication_guards WHERE id = ?`).bind(guardId),
        ]).pipe(Effect.mapError(guarded))
        return yield* editor(documentId, principal)
      })

    return { get, patch }
  }),
)
