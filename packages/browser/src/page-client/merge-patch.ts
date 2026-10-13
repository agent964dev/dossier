// JSON merge patches (RFC 7396): applying one, and composing two into one
// when a single patch can say both.
import type { Json, JsonObject } from '@dossier/contracts/bridge'

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Sets an own property, so a key named `__proto__` stays a plain key. */
const put = (target: Record<string, Json>, key: string, value: Json): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

const own = (target: JsonObject, key: string): Json | undefined =>
  Object.hasOwn(target, key) ? target[key] : undefined

/** RFC 7396's MergePatch(target, patch). Neither argument is changed. */
export const applyMergePatch = (target: Json, patch: Json): Json => {
  if (!isJsonObject(patch)) return patch
  const out: Record<string, Json> = {}
  if (isJsonObject(target)) {
    for (const key of Object.keys(target)) put(out, key, target[key]!)
  }
  for (const key of Object.keys(patch)) {
    const value = patch[key]!
    if (value === null) {
      delete out[key]
      continue
    }
    put(out, key, applyMergePatch(own(out, key) ?? null, value))
  }
  return out
}

/**
 * One patch equal to applying `first`, then `then`, on every target, or null
 * when no single patch is: `first` sets a key to null or a plain value and
 * `then` sets an object under it, which one patch cannot say when the key
 * holds an object.
 */
export const composeMergePatch = (
  first: JsonObject,
  then: JsonObject,
): JsonObject | null => {
  const out: Record<string, Json> = {}
  for (const key of Object.keys(first)) put(out, key, first[key]!)
  for (const key of Object.keys(then)) {
    const b = then[key]!
    if (!isJsonObject(b) || !Object.hasOwn(first, key)) {
      put(out, key, b)
      continue
    }
    const a = first[key]!
    if (!isJsonObject(a)) return null
    const both = composeMergePatch(a, b)
    if (both === null) return null
    put(out, key, both)
  }
  return out
}
