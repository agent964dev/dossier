import type { ApiError as ApiErrorBody } from '@dossier/contracts'
import { Data } from 'effect'

export type ApiErrorCode = ApiErrorBody['code']

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  not_found: 404,
  editor_required: 403,
  publisher_required: 403,
  has_children: 409,
  conflict: 409,
  batch_purged: 409,
  idempotency_conflict: 409,
  state_not_enabled: 409,
  state_conflict: 409,
  state_version_changed: 409,
  state_type_mismatch: 422,
  state_too_large: 413,
  state_edit_required: 403,
  state_unavailable: 503,
  body_too_large: 413,
  policy_rejected: 422,
  rate_limited: 429,
}

export class DossierError extends Data.TaggedError('DossierError')<{
  readonly code: ApiErrorCode
  readonly message: string
  readonly details?: unknown
  readonly retryAfter?: number
}> {
  get status(): number {
    return STATUS_BY_CODE[this.code]
  }
}

export class PersistenceError extends Data.TaggedError('PersistenceError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

export class StorageError extends Data.TaggedError('StorageError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

export class SessionError extends Data.TaggedError('SessionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class SignInRefused extends Data.TaggedError('SignInRefused')<{
  readonly message: string
}> {}

export class ShooError extends Data.TaggedError('ShooError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export function apiError(
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): DossierError {
  return new DossierError({
    code,
    message,
    ...(details === undefined ? {} : { details }),
  })
}

export function errorResponse(error: DossierError): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  if (error.code === 'unauthenticated') {
    headers.set('www-authenticate', 'Bearer')
  }
  if (error.code === 'rate_limited' && error.retryAfter !== undefined) {
    headers.set('retry-after', String(error.retryAfter))
  }

  return new Response(
    JSON.stringify({
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }),
    { status: error.status, headers },
  )
}
