import type { FieldType } from '@dossier/contracts'
import type { StateField } from '@dossier/policy'

export interface SavedStateRow {
  readonly name: string
  readonly type: FieldType
  readonly value_json: string
}

export interface StatePlan {
  readonly retyped: readonly {
    readonly name: string
    readonly from: FieldType
    readonly to: FieldType
    readonly default: unknown
  }[]
  readonly orphaned: readonly string[]
  readonly bytesDelta: number
}

export interface StatePlanContext {
  readonly previousManifest: readonly StateField[]
  readonly savedRows: readonly SavedStateRow[]
}

const encoder = new TextEncoder()

export function stateValueJson(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('Saved-value defaults must be JSON values.')
  }
  return serialized
}

export function stateValueBytes(value: unknown): number {
  return encoder.encode(stateValueJson(value)).byteLength
}

export function compareManifests(
  prior: StatePlanContext,
  next: readonly StateField[],
): StatePlan {
  const previousNames = new Set(
    prior.previousManifest.map((field) => field.name),
  )
  const nextByName = new Map(next.map((field) => [field.name, field]))
  const retyped: StatePlan['retyped'][number][] = []
  const orphaned: string[] = []
  let bytesDelta = 0

  for (const saved of prior.savedRows) {
    const nextField = nextByName.get(saved.name)
    if (nextField !== undefined && nextField.type !== saved.type) {
      retyped.push({
        name: saved.name,
        from: saved.type,
        to: nextField.type,
        default: nextField.default,
      })
      bytesDelta +=
        stateValueBytes(nextField.default) -
        encoder.encode(saved.value_json).byteLength
      continue
    }
    if (nextField === undefined && previousNames.has(saved.name)) {
      orphaned.push(saved.name)
    }
  }

  return { retyped, orphaned, bytesDelta }
}
