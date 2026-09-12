import { env as workerEnv } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { Principal, Session } from '../src/services'
import { makeCoreLayer, seedPrincipal, testEnv } from './core-helpers'

const env = testEnv(workerEnv)
const layer = makeCoreLayer(env)

function run<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>,
  )
}

async function sessionCookie(accountId: string, workspaceId: string): Promise<string> {
  const setCookie = await run(
    Effect.gen(function* () {
      const session = yield* Session
      return yield* session.createSessionCookie({ accountId, workspaceId })
    }),
  )
  return setCookie.split(';', 1)[0]
}

describe('Principal resolution', () => {
  it('resolves a valid key and verified emails', async () => {
    const seeded = await seedPrincipal(env, {
      suffix: 'principal_valid',
      email: 'VALID@Test.Example',
    })
    const principal = await run(
      Effect.gen(function* () {
        const service = yield* Principal
        return yield* service.resolve(
          new Request('https://dossier.test/api/me', {
            headers: { authorization: `Bearer ${seeded.token}` },
          }),
        )
      }),
    )
    expect(principal).toMatchObject({
      accountId: seeded.accountId,
      apiKeyId: seeded.keyId,
      workspaceId: seeded.workspaceId,
      role: 'member',
      verifiedEmails: ['VALID@Test.Example'],
    })
    const row = await env.DB.prepare('SELECT last_used_at FROM api_keys WHERE id = ?')
      .bind(seeded.keyId)
      .first<{ last_used_at: string | null }>()
    expect(row?.last_used_at).not.toBeNull()
  })

  it('rejects a revoked key', async () => {
    const seeded = await seedPrincipal(env, {
      suffix: 'principal_revoked',
      revoked: true,
    })
    const error = await run(
      Effect.gen(function* () {
        const service = yield* Principal
        return yield* service
          .resolve(
            new Request('https://dossier.test/api/me', {
              headers: { authorization: `Bearer ${seeded.token}` },
            }),
          )
          .pipe(Effect.flip)
      }),
    )
    expect(error).toMatchObject({ code: 'unauthenticated' })
  })

  it('rejects a disabled account for either credential type', async () => {
    const seeded = await seedPrincipal(env, {
      suffix: 'principal_disabled',
      disabled: true,
    })
    const cookie = await sessionCookie(seeded.accountId, seeded.workspaceId)
    const errors = await Promise.all([
      run(
        Effect.gen(function* () {
          const service = yield* Principal
          return yield* service
            .resolve(
              new Request('https://dossier.test/api/me', {
                headers: { authorization: `Bearer ${seeded.token}` },
              }),
            )
            .pipe(Effect.flip)
        }),
      ),
      run(
        Effect.gen(function* () {
          const service = yield* Principal
          return yield* service
            .resolve(
              new Request('https://dossier.test/dashboard', {
                headers: { cookie },
              }),
            )
            .pipe(Effect.flip)
        }),
      ),
    ])
    expect(errors).toEqual([
      expect.objectContaining({ code: 'unauthenticated' }),
      expect.objectContaining({ code: 'unauthenticated' }),
    ])
  })

  it('never falls back to a valid cookie for an explicit invalid Bearer', async () => {
    const seeded = await seedPrincipal(env, { suffix: 'principal_no_fallback' })
    const cookie = await sessionCookie(seeded.accountId, seeded.workspaceId)
    const error = await run(
      Effect.gen(function* () {
        const service = yield* Principal
        return yield* service
          .resolve(
            new Request('https://dossier.test/api/me', {
              headers: {
                authorization: 'Bearer definitely-invalid',
                cookie,
              },
            }),
          )
          .pipe(Effect.flip)
      }),
    )
    expect(error).toMatchObject({ code: 'unauthenticated' })
  })

  it('authenticates a removed member but rejects publisher status', async () => {
    const seeded = await seedPrincipal(env, { suffix: 'principal_removed_member' })
    await env.DB.prepare(
      'DELETE FROM memberships WHERE workspace_id = ? AND account_id = ?',
    )
      .bind(seeded.workspaceId, seeded.accountId)
      .run()
    const result = await run(
      Effect.gen(function* () {
        const service = yield* Principal
        const principal = yield* service.resolve(
          new Request('https://dossier.test/api/me', {
            headers: { authorization: `Bearer ${seeded.token}` },
          }),
        )
        const publisher = yield* service.requirePublisher(principal).pipe(Effect.either)
        return { principal, publisher }
      }),
    )
    expect(result.principal.role).toBeNull()
    expect(result.publisher).toMatchObject({
      _tag: 'Left',
      left: { code: 'publisher_required' },
    })
  })

})
