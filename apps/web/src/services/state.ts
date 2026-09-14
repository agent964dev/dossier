import type { FieldType } from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import { Access } from './access'
import { Db } from './db'
import { apiError, DossierError, PersistenceError } from './errors'
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
}

export class State extends Context.Tag('@dossier/web/State')<
  State,
  StateService
>() {}

interface StateContextRow {
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

interface ManifestField {
  readonly name: string
  readonly type: FieldType
  readonly default: unknown
}

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

export const StateLive = Layer.effect(
  State,
  Effect.gen(function* () {
    const db = yield* Db
    const access = yield* Access

    const read: StateService['read'] = (documentId, actor) =>
      Effect.gen(function* () {
        const decision =
          actor.kind === 'link'
            ? null
            : yield* access.requireReadable(
                documentId,
                actor.kind === 'account' ? actor.principal : null,
              )

        const result = yield* Effect.tryPromise({
          try: async () => {
            const context = await db.raw
              .prepare(
                `SELECT d.stateful, v.version_number, v.state_fields_json,
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
              .first<StateContextRow>()
            if (context === null) return null
            const fields = await db.raw
              .prepare(
                `SELECT name, type, value_json, revision
                   FROM document_state_fields
                  WHERE document_id = ?`,
              )
              .bind(documentId)
              .all<SavedFieldRow>()
            return { context, saved: fields.results }
          },
          catch: (cause) =>
            new PersistenceError({ operation: 'read document state', cause }),
        })
        if (result === null) {
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        }
        if (result.context.stateful !== 1) {
          return yield* Effect.fail(
            apiError(
              'state_not_enabled',
              'Saved values are not enabled for this document.',
            ),
          )
        }

        const manifest = yield* Effect.try({
          try: () => parseManifest(result.context.state_fields_json),
          catch: (cause) =>
            new PersistenceError({ operation: 'parse state manifest', cause }),
        })
        const savedByName = new Map(
          result.saved.map((field) => [field.name, field]),
        )
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
        const parseSaved = (saved: SavedFieldRow) =>
          Effect.try({
            try: () => JSON.parse(saved.value_json) as unknown,
            catch: (cause) =>
              new PersistenceError({
                operation: `parse saved state field ${saved.name}`,
                cause,
              }),
          })

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
            value: yield* parseSaved(saved),
            revision: saved.revision,
            type: field.type,
          })
        }
        for (const saved of result.saved) {
          if (manifestNames.has(saved.name)) continue
          setField(saved.name, {
            value: yield* parseSaved(saved),
            revision: saved.revision,
            type: saved.type,
          })
        }

        const editor = decision?.editor === true
        return {
          documentId,
          version: result.context.version_number,
          revision: result.context.revision,
          updatedAt: result.context.updated_at,
          fields,
          canSave: editor,
          viewer: editor
            ? ('editor' as const)
            : actor.kind === 'link'
              ? ('link' as const)
              : ('reader' as const),
        }
      })

    return { read }
  }),
)
