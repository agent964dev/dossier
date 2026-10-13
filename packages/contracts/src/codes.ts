// Plain TypeScript with no Effect import, so browser code can use it.

/**
 * The CLI's exit codes: 0 success · 1 failure · 2 usage · 3 not found or no
 * access · 4 not signed in or key refused · 5 conflict · 6 refused by a rule
 * or a limit.
 */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6

/**
 * Every error code Dossier answers with, its HTTP status and its CLI exit
 * code. This is the one table: a code a feature needs is added here.
 * `status: null` marks codes only the page client raises.
 */
export const ERRORS = {
  /** A value breaks a rule; `path` names the field or file. */
  invalid: { status: 400, exit: 6 },
  /** No session, or an unknown or revoked agent key. */
  sign_in_required: { status: 401, exit: 4 },
  forbidden: {
    status: 403,
    exit: 3,
    message: 'You can open this but not change it.',
  },
  /** Missing and unreadable look the same. */
  not_found: { status: 404, exit: 3 },
  /** A guarded write lost a race, or a name is taken. */
  conflict: { status: 409, exit: 5 },
  /** Someone pushed to the path since this machine last pulled or pushed. */
  stale_head: { status: 409, exit: 5 },
  form_changed: {
    status: 409,
    exit: 5,
    message:
      'This form has changed. Reload the page to see the current version.',
  },
  /** A purge holds this blob; upload it again shortly. */
  blob_reclaiming: { status: 409, exit: 5 },
  /** The form is closed. */
  closed: { status: 409, exit: 6 },
  /** The change would leave no admin, or no super admin. */
  last_admin: { status: 409, exit: 6 },
  /** A size, count or storage limit; the message names it and who can raise it. */
  too_large: { status: 413, exit: 6 },
  /** The stored value or the patch is not a JSON object. */
  not_mergeable: { status: 422, exit: 6 },
  /** A push refused by a rule. */
  policy_rejected: { status: 422, exit: 6 },
  /** The CLI and the deployment speak different protocol versions. */
  protocol_mismatch: { status: 426, exit: 1 },
  /** A rate limit; the message says when to try again. */
  rate_limited: { status: 429, exit: 6 },
  unavailable: {
    status: 503,
    exit: 1,
    message: 'Something went wrong. Try again.',
  },
  /** The device code is not approved yet; the CLI keeps polling. */
  device_pending: { status: 400, exit: 4 },
  /** Polled too fast; the CLI adds 5 seconds. */
  slow_down: { status: 400, exit: 4 },
  /** The device code expired or was spent, including a failed mint. */
  device_expired: { status: 400, exit: 4 },
  /** The person pressed Deny. */
  access_denied: { status: 400, exit: 4 },
  /** Google cannot confirm this account still owns an email a person holds. */
  email_unconfirmed: { status: 403, exit: 4 },
  /** A known account's new email belongs to another person. */
  email_in_use: { status: 409, exit: 4 },
  /** Page client only: nothing was stored. */
  offline: {
    status: null,
    exit: 1,
    message: 'Not sent. Your answers are kept on this device. Try again.',
  },
  /** Page client only, in an exported page. */
  not_in_export: {
    status: null,
    exit: 1,
    message: 'A page downloaded as one file cannot do this.',
  },
} as const satisfies Record<
  string,
  { status: number | null; exit: ExitCode; message?: string }
>

export type ErrorCode = keyof typeof ERRORS

export const ERROR_CODES: readonly ErrorCode[] = Object.keys(
  ERRORS,
) as ErrorCode[]

export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && Object.hasOwn(ERRORS, value)

/** The HTTP status of a code. Page-client-only codes have none and throw. */
export const statusFor = (code: ErrorCode): number => {
  const status: number | null = ERRORS[code].status
  if (status === null) {
    throw new TypeError(`${code} is raised only by the page client`)
  }
  return status
}

export const exitCodeFor = (code: ErrorCode): ExitCode => ERRORS[code].exit

/** The table's message for a code, or a sentence built from its name. */
export const defaultMessage = (code: ErrorCode): string => {
  const entry = ERRORS[code]
  if ('message' in entry) return entry.message
  const words = code.replaceAll('_', ' ')
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`
}

export interface ErrorFields {
  readonly code: ErrorCode
  readonly message: string
  readonly fix: string | null
  readonly path: string | null
}
