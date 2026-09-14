import type { FieldType, StateChange } from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import { Access, accessBindValues, accessCteSql } from './access'
import { Db } from './db'
import { apiError, DossierError, PersistenceError } from './errors'
import { Ids } from './ids'
import type { PrincipalIdentity } from './principal'

export type StateActor =
  | { readonly kind: 'account'; readonly principal: PrincipalIdentity }
  | { readonly kind: 'link'; readonly generation: number }
  | { readonly kind: 'public' }

export interface StateFieldSnapshot {
  readonly value: unknown
  readonly revision: number
  readonly type: FieldType
}

export interface StateSnapshot {
  readonly documentId: string
  readonly version: number
  readonly revision: number
  readonly updatedAt: string | null
  readonly fields: Readonly<Record<string, StateFieldSnapshot>>
  readonly canSave: boolean
  readonly viewer: 'editor' | 'granted' | 'link' | 'reader'
}

export interface StateService {
  readonly read: (
    documentId: string,
    actor: StateActor,
  ) => Effect.Effect<StateSnapshot, DossierError | PersistenceError>
  readonly save: (
    documentId: string,
    actor: StateActor,
    input: {
      readonly version?: number
      readonly changes: readonly StateChange[]
    },
  ) => Effect.Effect<StateSnapshot, DossierError | PersistenceError>
}

export class State extends Context.Tag('@dossier/web/State')<
  State,
  StateService
>() {}

interface StateContextRow {
  readonly version_id: string
  readonly stateful: number
  readonly version_number: number
  readonly state_fields_json: string | null
  readonly revision: number
  readonly updated_at: string | null
}

interface SavedFieldRow {
  readonly name: string
  readonly type: FieldType
  readonly value_json: string
  readonly revision: number
}

interface SaveSnapshotRow {
  readonly name: string | null
  readonly type: FieldType | null
  readonly value_json: string | null
  readonly revision: number | null
  readonly state_revision: number
  readonly state_updated_at: string | null
}

interface FailureRow {
  readonly deleted_at: string | null
  readonly disabled_at: string | null
  readonly stateful: number
  readonly version_id: string | null
  readonly version_number: number | null
  readonly can_read: number
  readonly can_edit: number
  readonly calculated_bytes: number | null
  readonly conflict_name: string | null
  readonly conflict_revision: number | null
  readonly conflict_value_json: string | null
}

interface ManifestField {
  readonly name: string
  readonly type: FieldType
  readonly default: unknown
}

interface NormalizedChange {
  readonly name: string
  readonly type: FieldType
  readonly valueJson: string
  readonly base: number
}

const MAX_CHANGES = 200
const MAX_VALUE_BYTES = 64 * 1024
const MAX_STATE_BYTES = 256 * 1024
const encoder = new TextEncoder()

const fieldTypes = new Set<FieldType>([
  'text',
  'textarea',
  'number',
  'date',
  'checkbox',
  'radio',
  'select',
  'select-multiple',
  'json',
])

function parseManifest(value: string | null): readonly ManifestField[] {
  if (value === null)
    throw new Error('The current version has no state manifest.')
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed))
    throw new Error('The state manifest is not an array.')
  return parsed.map((field) => {
    if (
      typeof field !== 'object' ||
      field === null ||
      typeof (field as { name?: unknown }).name !== 'string' ||
      typeof (field as { type?: unknown }).type !== 'string' ||
      !fieldTypes.has((field as { type: FieldType }).type) ||
      !Object.hasOwn(field, 'default')
    ) {
      throw new Error('The state manifest contains an invalid field.')
    }
    const manifestField = field as {
      readonly name: string
      readonly type: FieldType
      readonly default: unknown
    }
    return {
      name: manifestField.name,
      type: manifestField.type,
      default: manifestField.default,
    }
  })
}

function valueFits(type: FieldType, value: unknown): boolean {
  switch (type) {
    case 'text':
    case 'textarea':
    case 'date':
      return typeof value === 'string'
    case 'number':
      return (
        value === null || (typeof value === 'number' && Number.isFinite(value))
      )
    case 'checkbox':
      return typeof value === 'boolean'
    case 'radio':
    case 'select':
      return value === null || typeof value === 'string'
    case 'select-multiple':
      return (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === 'string')
      )
    case 'json':
      return true
  }
}

function typeMismatch(fields: readonly string[]): DossierError {
  return apiError(
    'state_type_mismatch',
    'One or more values do not match the current state manifest.',
    { fields: [...new Set(fields)] },
  )
}

function normalizeChanges(
  manifest: readonly ManifestField[],
  changes: readonly StateChange[],
): Effect.Effect<readonly NormalizedChange[], DossierError> {
  const manifestByName = new Map(manifest.map((field) => [field.name, field]))
  const seen = new Set<string>()
  const invalid: string[] = []
  const normalized: NormalizedChange[] = []

  if (changes.length > MAX_CHANGES) {
    return Effect.fail(typeMismatch(changes.map((change) => change.name)))
  }

  for (const change of changes) {
    const field = manifestByName.get(change.name)
    if (
      field === undefined ||
      seen.has(change.name) ||
      !Number.isSafeInteger(change.base) ||
      change.base < 0 ||
      !valueFits(field.type, change.value)
    ) {
      invalid.push(change.name)
      seen.add(change.name)
      continue
    }
    seen.add(change.name)

    try {
      const valueJson = JSON.stringify(change.value)
      if (
        valueJson === undefined ||
        encoder.encode(valueJson).byteLength > MAX_VALUE_BYTES
      ) {
        invalid.push(change.name)
        continue
      }
      normalized.push({
        name: change.name,
        type: field.type,
        valueJson,
        base: change.base,
      })
    } catch {
      invalid.push(change.name)
    }
  }

  return invalid.length > 0
    ? Effect.fail(typeMismatch(invalid))
    : Effect.succeed(normalized)
}

function parseSavedValue(
  saved: SavedFieldRow,
): Effect.Effect<unknown, PersistenceError> {
  return Effect.try({
    try: () => JSON.parse(saved.value_json) as unknown,
    catch: (cause) =>
      new PersistenceError({
        operation: `parse saved state field ${saved.name}`,
        cause,
      }),
  })
}

function buildSnapshot(
  documentId: string,
  version: number,
  revision: number,
  updatedAt: string | null,
  manifest: readonly ManifestField[],
  savedRows: readonly SavedFieldRow[],
  canSave: boolean,
  viewer: StateSnapshot['viewer'],
): Effect.Effect<StateSnapshot, PersistenceError> {
  return Effect.gen(function* () {
    const savedByName = new Map(savedRows.map((field) => [field.name, field]))
    const manifestNames = new Set(manifest.map((field) => field.name))
    const fields: Record<string, StateFieldSnapshot> = {}
    const setField = (name: string, field: StateFieldSnapshot) => {
      Object.defineProperty(fields, name, {
        value: field,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }

    for (const field of manifest) {
      const saved = savedByName.get(field.name)
      if (saved === undefined) {
        setField(field.name, {
          value: field.default,
          revision: 0,
          type: field.type,
        })
        continue
      }
      setField(field.name, {
        value: yield* parseSavedValue(saved),
        revision: saved.revision,
        type: field.type,
      })
    }
    for (const saved of savedRows) {
      if (manifestNames.has(saved.name)) continue
      setField(saved.name, {
        value: yield* parseSavedValue(saved),
        revision: saved.revision,
        type: saved.type,
      })
    }

    return {
      documentId,
      version,
      revision,
      updatedAt,
      fields,
      canSave,
      viewer,
    }
  })
}

function isGuardFailure(error: PersistenceError): boolean {
  return String(error.cause).includes('publication_guards_ok_check')
}

export const StateLive = Layer.effect(
  State,
  Effect.gen(function* () {
    const db = yield* Db
    const access = yield* Access
    const ids = yield* Ids

    const loadContext = (documentId: string) =>
      Effect.tryPromise({
        try: () =>
          db.raw
            .prepare(
              `SELECT d.current_version_id AS version_id, d.stateful,
                      v.version_number, v.state_fields_json,
                      COALESCE(state.revision, 0) AS revision,
                      state.updated_at
                 FROM documents d
                 JOIN document_versions v ON v.id = d.current_version_id
            LEFT JOIN document_state state ON state.document_id = d.id
                WHERE d.id = ? AND d.deleted_at IS NULL
                  AND d.disabled_at IS NULL
                LIMIT 1`,
            )
            .bind(documentId)
            .first<StateContextRow>(),
        catch: (cause) =>
          new PersistenceError({ operation: 'load state context', cause }),
      })

    const manifestFromContext = (context: StateContextRow) =>
      Effect.try({
        try: () => parseManifest(context.state_fields_json),
        catch: (cause) =>
          new PersistenceError({ operation: 'parse state manifest', cause }),
      })

    const explainFailure = (
      documentId: string,
      actor: Extract<StateActor, { readonly kind: 'account' }>,
      observedVersionId: string,
      changesJson: string,
      incomingBytes: number,
    ): Effect.Effect<never, DossierError | PersistenceError> =>
      Effect.gen(function* () {
        const [accountId, emails] = accessBindValues(actor.principal)
        const result = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `${accessCteSql('SELECT ?3')},
                 failure_context AS (
                   SELECT d.deleted_at, d.disabled_at, d.stateful,
                          d.current_version_id AS version_id,
                          v.version_number,
                          COALESCE(decision.can_read, 0) AS can_read,
                          CASE WHEN account.id IS NOT NULL AND (
                            d.created_by = account.id OR EXISTS (
                              SELECT 1 FROM memberships editor
                               WHERE editor.workspace_id = d.workspace_id
                                 AND editor.account_id = account.id
                                 AND editor.role = 'admin'
                            )
                          ) THEN 1 ELSE 0 END AS can_edit,
                          state.bytes
                            - COALESCE((
                                SELECT SUM(
                                  length(CAST(field.name AS BLOB))
                                  + length(CAST(field.value_json AS BLOB))
                                )
                                  FROM document_state_fields field
                                 WHERE field.document_id = d.id
                                   AND field.name IN (
                                     SELECT json_extract(value, '$.name')
                                       FROM json_each(?4)
                                   )
                              ), 0)
                            + ?5 AS calculated_bytes
                     FROM documents d
                LEFT JOIN document_versions v ON v.id = d.current_version_id
                LEFT JOIN document_state state ON state.document_id = d.id
                LEFT JOIN accounts account
                       ON account.id = ?1 AND account.disabled_at IS NULL
                LEFT JOIN access_decisions decision
                       ON decision.document_id = d.id
                    WHERE d.id = ?3
                 )
                 SELECT context.*,
                        field.name AS conflict_name,
                        field.revision AS conflict_revision,
                        field.value_json AS conflict_value_json
                   FROM failure_context context
              LEFT JOIN json_each(?4) change ON true
              LEFT JOIN document_state_fields field
                     ON field.document_id = ?3
                    AND field.name = json_extract(change.value, '$.name')
                    AND field.revision > json_extract(change.value, '$.base')`,
              )
              .bind(accountId, emails, documentId, changesJson, incomingBytes)
              .all<FailureRow>(),
          catch: (cause) =>
            new PersistenceError({
              operation: 'explain failed state save',
              cause,
            }),
        })
        const first = result.results[0]
        if (
          first === undefined ||
          first.deleted_at !== null ||
          first.disabled_at !== null ||
          first.can_read !== 1
        ) {
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        }
        if (first.stateful !== 1) {
          return yield* Effect.fail(
            apiError(
              'state_not_enabled',
              'Saved values are not enabled for this document.',
            ),
          )
        }
        if (first.can_edit !== 1) {
          return yield* Effect.fail(
            apiError('state_edit_required', 'State edit access is required.'),
          )
        }
        if (first.version_id !== observedVersionId) {
          return yield* Effect.fail(
            apiError(
              'state_version_changed',
              'The document version changed before the save completed.',
              { currentVersion: first.version_number ?? 0 },
            ),
          )
        }
        if (
          first.calculated_bytes !== null &&
          first.calculated_bytes > MAX_STATE_BYTES
        ) {
          return yield* Effect.fail(
            apiError(
              'state_too_large',
              'The saved values exceed the document state size limit.',
              { bytes: first.calculated_bytes, limit: MAX_STATE_BYTES },
            ),
          )
        }

        const conflicts = []
        for (const row of result.results) {
          if (
            row.conflict_name === null ||
            row.conflict_revision === null ||
            row.conflict_value_json === null
          ) {
            continue
          }
          const conflictName = row.conflict_name
          const conflictValueJson = row.conflict_value_json
          const value = yield* Effect.try({
            try: () => JSON.parse(conflictValueJson) as unknown,
            catch: (cause) =>
              new PersistenceError({
                operation: `parse conflicting state field ${conflictName}`,
                cause,
              }),
          })
          conflicts.push({
            name: conflictName,
            revision: row.conflict_revision,
            value,
          })
        }
        return yield* Effect.fail(
          apiError(
            'state_conflict',
            'One or more fields changed after the supplied baseline.',
            { fields: conflicts },
          ),
        )
      })

    const read: StateService['read'] = (documentId, actor) =>
      Effect.gen(function* () {
        const decision =
          actor.kind === 'link'
            ? null
            : yield* access.requireReadable(
                documentId,
                actor.kind === 'account' ? actor.principal : null,
              )

        const context = yield* loadContext(documentId)
        if (context === null) {
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        }
        if (context.stateful !== 1) {
          return yield* Effect.fail(
            apiError(
              'state_not_enabled',
              'Saved values are not enabled for this document.',
            ),
          )
        }

        const manifest = yield* manifestFromContext(context)
        const saved = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT name, type, value_json, revision
                   FROM document_state_fields
                  WHERE document_id = ?`,
              )
              .bind(documentId)
              .all<SavedFieldRow>(),
          catch: (cause) =>
            new PersistenceError({ operation: 'read document state', cause }),
        })
        const editor = decision?.editor === true
        return yield* buildSnapshot(
          documentId,
          context.version_number,
          context.revision,
          context.updated_at,
          manifest,
          saved.results,
          editor,
          editor ? 'editor' : actor.kind === 'link' ? 'link' : 'reader',
        )
      })

    const save: StateService['save'] = (documentId, actor, input) =>
      Effect.gen(function* () {
        if (actor.kind !== 'account') {
          return yield* Effect.fail(
            apiError('state_edit_required', 'State edit access is required.'),
          )
        }

        const decision = yield* access.requireReadable(
          documentId,
          actor.principal,
        )
        if (!decision.editor) {
          return yield* Effect.fail(
            apiError('state_edit_required', 'State edit access is required.'),
          )
        }

        const context = yield* loadContext(documentId)
        if (context === null) {
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        }
        if (context.stateful !== 1) {
          return yield* Effect.fail(
            apiError(
              'state_not_enabled',
              'Saved values are not enabled for this document.',
            ),
          )
        }
        if (
          input.version !== undefined &&
          input.version !== context.version_number
        ) {
          return yield* Effect.fail(
            apiError(
              'state_version_changed',
              'The document version changed after this page was loaded.',
              { currentVersion: context.version_number },
            ),
          )
        }

        const manifest = yield* manifestFromContext(context)
        const changes = yield* normalizeChanges(manifest, input.changes)
        const changesJson = JSON.stringify(changes)
        const incomingBytes = changes.reduce(
          (total, change) =>
            total +
            encoder.encode(change.name).byteLength +
            encoder.encode(change.valueJson).byteLength,
          0,
        )
        const guardId = ids.internalId()
        const eventId = ids.internalId()
        const now = new Date().toISOString()
        const updatedBy = `account:${actor.principal.accountId}`
        const namesJson = JSON.stringify(changes.map((change) => change.name))

        const batch = yield* db
          .batch([
            db.raw
              .prepare(
                `INSERT INTO publication_guards (id, ok)
                 VALUES (?, CASE WHEN EXISTS (
                   SELECT 1
                     FROM documents d
                     JOIN document_versions version
                       ON version.id = d.current_version_id
                     JOIN document_state state ON state.document_id = d.id
                    WHERE d.id = ?
                      AND d.deleted_at IS NULL
                      AND d.disabled_at IS NULL
                      AND d.stateful = 1
                      AND d.current_version_id = ?
                      AND EXISTS (
                        SELECT 1 FROM accounts actor
                         WHERE actor.id = ? AND actor.disabled_at IS NULL
                           AND (
                             d.created_by = actor.id OR EXISTS (
                               SELECT 1 FROM memberships editor
                                WHERE editor.workspace_id = d.workspace_id
                                  AND editor.account_id = actor.id
                                  AND editor.role = 'admin'
                             )
                           )
                      )
                      AND NOT EXISTS (
                        SELECT 1
                          FROM json_each(?) change
                          JOIN document_state_fields field
                            ON field.document_id = d.id
                           AND field.name = json_extract(change.value, '$.name')
                         WHERE field.revision >
                               json_extract(change.value, '$.base')
                      )
                      AND state.bytes
                          - COALESCE((
                              SELECT SUM(
                                length(CAST(field.name AS BLOB))
                                + length(CAST(field.value_json AS BLOB))
                              )
                                FROM document_state_fields field
                               WHERE field.document_id = d.id
                                 AND field.name IN (
                                   SELECT json_extract(value, '$.name')
                                     FROM json_each(?)
                                 )
                            ), 0)
                          + ? <= ?
                 ) THEN 1 ELSE 0 END)`,
              )
              .bind(
                guardId,
                documentId,
                context.version_id,
                actor.principal.accountId,
                changesJson,
                changesJson,
                incomingBytes,
                MAX_STATE_BYTES,
              ),
            db.raw
              .prepare(
                `UPDATE document_state
                    SET revision = revision + 1,
                        updated_at = ?,
                        bytes = bytes
                          - COALESCE((
                              SELECT SUM(
                                length(CAST(field.name AS BLOB))
                                + length(CAST(field.value_json AS BLOB))
                              )
                                FROM document_state_fields field
                               WHERE field.document_id = document_state.document_id
                                 AND field.name IN (
                                   SELECT json_extract(value, '$.name')
                                     FROM json_each(?)
                                 )
                            ), 0)
                          + ?
                  WHERE document_id = ?`,
              )
              .bind(now, changesJson, incomingBytes, documentId),
            db.raw
              .prepare(
                `INSERT INTO document_state_fields
                   (document_id, name, type, value_json, revision, updated_by,
                    updated_at)
                 SELECT ?,
                        json_extract(change.value, '$.name'),
                        json_extract(change.value, '$.type'),
                        json_extract(change.value, '$.valueJson'),
                        (SELECT revision FROM document_state
                          WHERE document_id = ?),
                        ?, ?
                   FROM json_each(?) change
                  WHERE true
                 ON CONFLICT (document_id, name) DO UPDATE SET
                   type = excluded.type,
                   value_json = excluded.value_json,
                   revision = excluded.revision,
                   updated_by = excluded.updated_by,
                   updated_at = excluded.updated_at`,
              )
              .bind(documentId, documentId, updatedBy, now, changesJson),
            db.raw
              .prepare(
                `INSERT INTO upload_events
                   (id, document_id, document_version_id, account_id, api_key_id,
                    event_type, metadata_json, created_at)
                 VALUES (?, ?, ?, ?, ?, 'state_saved',
                         json_object('names', json(?), 'actorKind', ?), ?)`,
              )
              .bind(
                eventId,
                documentId,
                context.version_id,
                actor.principal.accountId,
                actor.principal.apiKeyId ?? null,
                namesJson,
                actor.kind,
                now,
              ),
            db.raw
              .prepare('DELETE FROM publication_guards WHERE id = ?')
              .bind(guardId),
            db.raw
              .prepare(
                `SELECT state.revision AS state_revision,
                        state.updated_at AS state_updated_at,
                        field.name, field.type, field.value_json, field.revision
                   FROM document_state state
              LEFT JOIN document_state_fields field
                     ON field.document_id = state.document_id
                  WHERE state.document_id = ?
                  ORDER BY field.name`,
              )
              .bind(documentId),
          ])
          .pipe(Effect.either)

        if (batch._tag === 'Left') {
          if (isGuardFailure(batch.left)) {
            return yield* explainFailure(
              documentId,
              actor,
              context.version_id,
              changesJson,
              incomingBytes,
            )
          }
          return yield* Effect.fail(batch.left)
        }

        const rows = (batch.right.at(-1)?.results ?? []) as SaveSnapshotRow[]
        const first = rows[0]
        if (first === undefined) {
          return yield* Effect.fail(
            new PersistenceError({
              operation: 'read saved state snapshot',
              cause: new Error('The committed state row was not found.'),
            }),
          )
        }
        const savedRows = rows.flatMap((row): SavedFieldRow[] =>
          row.name === null ||
          row.type === null ||
          row.value_json === null ||
          row.revision === null
            ? []
            : [
                {
                  name: row.name,
                  type: row.type,
                  value_json: row.value_json,
                  revision: row.revision,
                },
              ],
        )
        return yield* buildSnapshot(
          documentId,
          context.version_number,
          first.state_revision,
          first.state_updated_at,
          manifest,
          savedRows,
          true,
          'editor',
        )
      })

    return { read, save }
  }),
)
