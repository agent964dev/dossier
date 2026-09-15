import { Data, Effect } from 'effect'

import { Session, SessionError, WorkerEnv } from '../services'

/**
 * A state-changing web request that failed the Origin check or carried no
 * valid token. Distinct from the API error contract in section 5.5: this is a
 * browser-surface rejection, not an answer to an API caller.
 */
export class CsrfRejected extends Data.TaggedError('CsrfRejected')<{
  readonly reason: 'origin_missing' | 'origin_mismatch' | 'token_invalid'
  readonly message: string
}> {}

/** Twelve hours: long enough to leave a dashboard tab open, short enough to expire. */
export const CSRF_TTL_SECONDS = 12 * 60 * 60
const CSRF_PURPOSE = 'web-csrf'

/**
 * Mints the token a page embeds in its loader data. It is an HMAC-signed
 * statement that "this account was signed in when the page was rendered", so a
 * token cannot be lifted from one account's page and replayed against another.
 */
export function issueCsrfToken(
  accountId: string,
): Effect.Effect<string, SessionError, Session> {
  return Effect.gen(function* () {
    const session = yield* Session
    return yield* session.signToken(
      { purpose: CSRF_PURPOSE, accountId },
      CSRF_TTL_SECONDS,
    )
  })
}

/**
 * The origins a state-changing request may legitimately come from, and the
 * origins allowed to frame a served document: the deployment's own public
 * origin, plus the origin the request was actually addressed to, so a preview
 * URL or a second local port works without configuration.
 *
 * Adding the request's own origin costs nothing: a cross-site post carries the
 * attacker's origin, which matches neither entry.
 */
export function allowedOrigins(
  publicBaseUrl: string,
  requestUrl: string,
): readonly string[] {
  const origins = new Set<string>()
  for (const candidate of [publicBaseUrl, requestUrl]) {
    try {
      origins.add(new URL(candidate).origin)
    } catch {
      /* an unparsable configured base URL simply contributes nothing */
    }
  }
  return [...origins]
}

export interface CsrfCheck {
  readonly request: Request
  readonly token: unknown
  readonly accountId: string
}

function requestOrigin(request: Request): string | null {
  const origin = request.headers.get('origin')
  if (origin !== null) return origin

  const referer = request.headers.get('referer')
  if (referer === null) return null
  try {
    return new URL(referer).origin
  } catch {
    return null
  }
}

/**
 * Both halves of the section 6 rule, in one place: an `Origin` header (or the
 * Referer origin when Origin is absent) that matches an origin this deployment
 * answers on, and a signed token bound to the signed-in account.
 *
 * The origin check alone stops a cross-site form post; the token additionally
 * stops a same-origin gadget — an open redirect, a reflected page — from
 * driving a mutation on the reader's behalf. Requests that fail either half
 * never reach a service.
 */
export function verifyCsrf({
  request,
  token,
  accountId,
}: CsrfCheck): Effect.Effect<void, CsrfRejected, Session | WorkerEnv> {
  return Effect.gen(function* () {
    const env = yield* WorkerEnv
    const session = yield* Session

    const origin = requestOrigin(request)
    if (origin === null) {
      return yield* Effect.fail(
        new CsrfRejected({
          reason: 'origin_missing',
          message: 'This request is missing its origin.',
        }),
      )
    }
    if (!allowedOrigins(env.PUBLIC_BASE_URL, request.url).includes(origin)) {
      return yield* Effect.fail(
        new CsrfRejected({
          reason: 'origin_mismatch',
          message: 'This request came from another site.',
        }),
      )
    }

    if (typeof token !== 'string' || token.length === 0) {
      return yield* Effect.fail(
        new CsrfRejected({
          reason: 'token_invalid',
          message: 'This page is stale; reload it and retry.',
        }),
      )
    }
    const payload = yield* session.verifyToken(token)
    if (
      payload === null ||
      payload.purpose !== CSRF_PURPOSE ||
      payload.accountId !== accountId
    ) {
      return yield* Effect.fail(
        new CsrfRejected({
          reason: 'token_invalid',
          message: 'This page is stale; reload it and retry.',
        }),
      )
    }
  })
}
