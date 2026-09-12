import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { Session, SessionLayer } from '../src/services'

const layer = SessionLayer('a-long-test-session-secret')

function run<A>(effect: Effect.Effect<A, unknown, Session>) {
  return Effect.runPromise(effect.pipe(Effect.provide(layer)))
}

describe('Session', () => {
  it('signs and verifies a token round trip', async () => {
    const result = await run(
      Effect.gen(function* () {
        const session = yield* Session
        const token = yield* session.signToken(
          { accountId: 'account-1' },
          60,
          100,
        )
        return yield* session.verifyToken(token, 100)
      }),
    )
    expect(result).toMatchObject({ accountId: 'account-1', exp: 160 })
  })

  it('accepts only session-purpose cookies with a workspace', async () => {
    const result = await run(
      Effect.gen(function* () {
        const session = yield* Session
        const cookie = yield* session.createSessionCookie({
          accountId: 'account-1',
          workspaceId: 'workspace-1',
        })
        return yield* session.readSession(
          new Request('https://dossier.test/dashboard', {
            headers: { cookie: cookie.split(';')[0]! },
          }),
        )
      }),
    )
    expect(result).toMatchObject({
      purpose: 'session',
      accountId: 'account-1',
      workspaceId: 'workspace-1',
    })
  })

  it('rejects CSRF, auth-state, and workspace-less tokens as sessions', async () => {
    const result = await run(
      Effect.gen(function* () {
        const session = yield* Session
        const tokens = yield* Effect.all([
          session.signToken(
            { purpose: 'web-csrf', accountId: 'account-1' },
            60,
          ),
          session.signToken(
            { purpose: 'auth-state', accountId: 'account-1' },
            60,
          ),
          session.signToken({ purpose: 'session', accountId: 'account-1' }, 60),
        ])
        return yield* Effect.all(
          tokens.map((token) =>
            session.readSession(
              new Request('https://dossier.test/dashboard', {
                headers: {
                  cookie: `${session.cookieName('session')}=${token}`,
                },
              }),
            ),
          ),
        )
      }),
    )
    expect(result).toEqual([null, null, null])
  })

  it('rejects a tampered token', async () => {
    const result = await run(
      Effect.gen(function* () {
        const session = yield* Session
        const token = yield* session.signToken(
          { accountId: 'account-1' },
          60,
          100,
        )
        const [body, signature] = token.split('.')
        const tampered = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}.${signature}`
        return yield* session.verifyToken(tampered, 100)
      }),
    )
    expect(result).toBeNull()
  })
})
