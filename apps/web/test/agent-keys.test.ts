import type { AgentKeyId } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { Effect, TestClock, TestContext } from 'effect'
import { describe, expect, it } from 'vitest'

import { SignIn } from '../src/core/index.ts'
import { sha256Hex } from '../src/core/ids.ts'
import { signedIn } from './support/browser.ts'
import { rows } from './support/d1.ts'
import { ORIGIN } from './support/harness.ts'
import { callerOf, fresh, run, runAs } from './support/people.ts'
import { everything } from './support/keys.ts'

const bearer = (key: string) =>
  SELF.fetch(`${ORIGIN}/_/api/me`, {
    headers: { authorization: `Bearer ${key}` },
  })

const lastUsed = async (keyId: string) =>
  (
    await rows<{ last_used_at: number | null }>(
      'select last_used_at from agent_keys where id = ?',
      keyId,
    )
  )[0]?.last_used_at

describe('agent keys', () => {
  it('shows a new key once and stores only its SHA-256', async () => {
    const caller = await callerOf(await signedIn(fresh()))
    const created = await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) =>
        signIn.createKey({ name: '  CI  ', ...everything }),
      ),
    )
    expect(created.secret).toMatch(/^dsk_[A-Za-z0-9_-]{43}$/)
    expect(created.key).toMatchObject({ name: 'CI', lastUsedAt: null })
    const [row] = await rows<Record<string, unknown>>(
      'select * from agent_keys where id = ?',
      created.key.id,
    )
    expect(row?.hash_sha256).toBe(await sha256Hex(created.secret))
    expect(JSON.stringify(row)).not.toContain(created.secret.slice(4))
    expect(row?.created_via).toBe('settings')
    const listed = await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) => signIn.keys()),
    )
    expect(listed.map((key) => key.name)).toEqual(['CI'])
    expect(JSON.stringify(listed)).not.toContain(created.secret.slice(4))
  })

  it('refuses an empty or overlong name', async () => {
    const caller = await callerOf(await signedIn(fresh()))
    for (const name of ['   ', 'x'.repeat(65)]) {
      const exit = await runAs(
        caller,
        Effect.flatMap(SignIn, (signIn) =>
          signIn.createKey({ name, ...everything }),
        ).pipe(Effect.flip),
      )
      expect(exit).toMatchObject({ code: 'invalid', path: 'name' })
    }
  })

  it('moves the last use at most once a minute', async () => {
    const caller = await callerOf(await signedIn(fresh()))
    const { secret, key } = await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) =>
        signIn.createKey({ name: 'clock', ...everything }),
      ),
    )
    const seen = await run(
      Effect.gen(function* () {
        const signIn = yield* SignIn
        const useAfter = (millis: number) =>
          TestClock.adjust(millis).pipe(
            Effect.zipRight(signIn.agent(secret)),
            Effect.zipRight(Effect.promise(() => lastUsed(key.id))),
          )
        yield* TestClock.setTime(1_000_000)
        return [
          yield* useAfter(0),
          yield* useAfter(30_000),
          yield* useAfter(31_000),
        ]
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(seen).toEqual([1_000_000, 1_000_000, 1_061_000])
  })

  it('refuses a revoked key, and revoking an unknown key is not found', async () => {
    const caller = await callerOf(await signedIn(fresh()))
    const { secret, key } = await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) =>
        signIn.createKey({ name: 'revoke me', ...everything }),
      ),
    )
    expect((await bearer(secret)).status).toBe(200)
    await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) => signIn.revokeKey(key.id)),
    )
    const refused = await bearer(secret)
    expect(refused.status).toBe(401)
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe('sign_in_required')
    const listed = await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) => signIn.keys()),
    )
    expect(listed).toEqual([])
    const unknown = await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) =>
        signIn.revokeKey('nope' as AgentKeyId),
      ).pipe(Effect.flip),
    )
    expect(unknown.code).toBe('not_found')
  })

  it('lets a key revoke itself through the API', async () => {
    const caller = await callerOf(await signedIn(fresh()))
    const { secret } = await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) =>
        signIn.createKey({ name: 'self', ...everything }),
      ),
    )
    const revoked = await SELF.fetch(`${ORIGIN}/_/api/keys/current`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${secret}` },
    })
    expect(revoked.status).toBe(204)
    expect((await bearer(secret)).status).toBe(401)
  })

  it('ends every browser session on "Sign out everywhere" while keys keep working', async () => {
    const identity = fresh()
    const laptop = await signedIn(identity)
    const phone = await signedIn(identity)
    const caller = await callerOf(laptop)
    const { secret } = await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) =>
        signIn.createKey({ name: 'stays', ...everything }),
      ),
    )
    await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) => signIn.signOutEverywhere()),
    )
    for (const browser of [laptop, phone]) {
      expect(
        (await browser.fetch('/_/api/me', { purpose: 'read' })).status,
      ).toBe(401)
    }
    expect((await bearer(secret)).status).toBe(200)
    const history = await rows<{ kind: string }>(
      `select kind from person_history where user_id = ? order by created_at`,
      caller.person?.id,
    )
    expect(history.map((h) => h.kind)).toEqual([
      'key_created',
      'signed_out_everywhere',
    ])
  })
})
