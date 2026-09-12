import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { CsrfRejected, issueCsrfToken, verifyCsrf } from '../src/server/csrf'
import { Session } from '../src/services'
import { makeCoreLayer, testEnv } from './core-helpers'

const environment = testEnv(env)
const layer = makeCoreLayer(environment)
const ORIGIN = 'https://dossier.test'

function run<A, E>(effect: Effect.Effect<A, E, never>) {
  return Effect.runPromise(effect)
}

function post(headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/_serverFn/documentAction`, {
    method: 'POST',
    headers,
  })
}

/** Runs the guard and reports the rejection reason, or `null` when it passed. */
function check(request: Request, token: unknown, accountId: string) {
  return run(
    verifyCsrf({ request, token, accountId }).pipe(
      Effect.as(null),
      Effect.catchTag('CsrfRejected', (error: CsrfRejected) =>
        Effect.succeed(error.reason),
      ),
      Effect.provide(layer),
    ),
  )
}

describe('web CSRF guard', () => {
  it('accepts a same-origin request carrying the account’s own token', async () => {
    const token = await run(
      issueCsrfToken('account_csrf').pipe(Effect.provide(layer)),
    )
    expect(
      await check(post({ origin: ORIGIN }), token, 'account_csrf'),
    ).toBeNull()
  })

  it('accepts the origin the request was addressed to, so previews work', async () => {
    const token = await run(
      issueCsrfToken('account_csrf').pipe(Effect.provide(layer)),
    )
    const request = new Request('https://preview.example/_serverFn/x', {
      method: 'POST',
      headers: { origin: 'https://preview.example' },
    })
    expect(await check(request, token, 'account_csrf')).toBeNull()
  })

  it('rejects a request with no Origin header', async () => {
    const token = await run(
      issueCsrfToken('account_csrf').pipe(Effect.provide(layer)),
    )
    expect(await check(post(), token, 'account_csrf')).toBe('origin_missing')
  })

  it('rejects a cross-site Origin even with a valid token', async () => {
    const token = await run(
      issueCsrfToken('account_csrf').pipe(Effect.provide(layer)),
    )
    expect(
      await check(
        post({ origin: 'https://evil.example' }),
        token,
        'account_csrf',
      ),
    ).toBe('origin_mismatch')
  })

  it('rejects a missing or non-string token', async () => {
    expect(
      await check(post({ origin: ORIGIN }), undefined, 'account_csrf'),
    ).toBe('token_invalid')
    expect(await check(post({ origin: ORIGIN }), '', 'account_csrf')).toBe(
      'token_invalid',
    )
    expect(await check(post({ origin: ORIGIN }), 42, 'account_csrf')).toBe(
      'token_invalid',
    )
  })

  it('rejects a token minted for a different account', async () => {
    const token = await run(
      issueCsrfToken('account_other').pipe(Effect.provide(layer)),
    )
    expect(await check(post({ origin: ORIGIN }), token, 'account_csrf')).toBe(
      'token_invalid',
    )
  })

  it('rejects a tampered signature', async () => {
    const token = await run(
      issueCsrfToken('account_csrf').pipe(Effect.provide(layer)),
    )
    const [body, signature] = token.split('.')
    const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
    expect(
      await check(
        post({ origin: ORIGIN }),
        `${body}.${flipped}`,
        'account_csrf',
      ),
    ).toBe('token_invalid')
  })

  it('rejects a token that has expired', async () => {
    const expired = await run(
      Effect.flatMap(Session, (session) =>
        session.signToken(
          { purpose: 'web-csrf', accountId: 'account_csrf' },
          60,
          Math.floor(Date.now() / 1000) - 3_600,
        ),
      ).pipe(Effect.provide(layer)),
    )
    expect(await check(post({ origin: ORIGIN }), expired, 'account_csrf')).toBe(
      'token_invalid',
    )
  })

  it('rejects a token signed for another purpose', async () => {
    const other = await run(
      Effect.flatMap(Session, (session) =>
        session.signToken(
          { purpose: 'session', accountId: 'account_csrf' },
          600,
        ),
      ).pipe(Effect.provide(layer)),
    )
    expect(await check(post({ origin: ORIGIN }), other, 'account_csrf')).toBe(
      'token_invalid',
    )
  })
})
