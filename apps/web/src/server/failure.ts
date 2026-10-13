// Safe for the browser: no server imports.
import type { ErrorFields } from '@dossier/contracts'

/** A screen read or action that failed, as plain data the screen renders. */
export interface ScreenFailure {
  readonly ok: false
  readonly error: ErrorFields
}

export const isScreenFailure = (value: unknown): value is ScreenFailure =>
  typeof value === 'object' &&
  value !== null &&
  'ok' in value &&
  (value as { ok: unknown }).ok === false &&
  'error' in value
