import { env as workerEnv } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { Allowlist } from '../src/services'
import { makeCoreLayer, seedPrincipal, testEnv } from './core-helpers'

const env = testEnv(workerEnv)
const layer = makeCoreLayer(env)

function run<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>,
  )
}

async function addEntry(options: {
  suffix: string
  kind: 'email' | 'domain'
  value: string
  role: 'admin' | 'member'
}) {
  const owner = await seedPrincipal(env, {
    suffix: `allow_owner_${options.suffix}`,
    role: 'admin',
  })
  const id = `allow_${options.suffix}`
  await env.DB.prepare(
    `INSERT INTO allowlist
       (id, kind, value, workspace_id, role, created_by, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      id,
      options.kind,
      options.value.toLowerCase(),
      owner.workspaceId,
      options.role,
      owner.accountId,
      '2026-09-12T00:00:00.000Z',
    )
    .run()
  return { ...owner, allowlistId: id }
}

function resolve(subject: string, email: string) {
  return run(
    Effect.gen(function* () {
      const service = yield* Allowlist
      return yield* service.resolveSignIn({
        provider: 'shoo',
        subject,
        email,
        emailVerified: true,
        displayName: email.split('@')[0],
      })
    }),
  )
}

describe('allowlist sign-in resolution', () => {
  it('refuses an unmatched email without creating an account', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS count FROM accounts')
      .first<{ count: number }>()
    const error = await run(
      Effect.gen(function* () {
        const service = yield* Allowlist
        return yield* service
          .resolveSignIn({
            provider: 'shoo',
            subject: 'allow-no-match-subject',
            email: 'nobody@unmatched-allow.example',
            emailVerified: true,
          })
          .pipe(Effect.flip)
      }),
    )
    const after = await env.DB.prepare('SELECT COUNT(*) AS count FROM accounts')
      .first<{ count: number }>()
    expect(error).toMatchObject({ _tag: 'SignInRefused' })
    expect(after?.count).toBe(before?.count)
  })

  it('joins a domain match as a member', async () => {
    const entry = await addEntry({
      suffix: 'domain_member',
      kind: 'domain',
      value: 'domain-member.example',
      role: 'member',
    })
    const result = await resolve(
      'allow-domain-member-subject',
      'Person@Domain-Member.Example',
    )
    expect(result).toMatchObject({
      workspaceId: entry.workspaceId,
      role: 'member',
      email: 'person@domain-member.example',
    })
  })

  it('prefers an exact admin entry over a domain member entry', async () => {
    const domain = await addEntry({
      suffix: 'exact_domain',
      kind: 'domain',
      value: 'exact-precedence.example',
      role: 'member',
    })
    const exactId = 'allow_exact_admin'
    await env.DB.prepare(
      `INSERT INTO allowlist
         (id, kind, value, workspace_id, role, created_by, created_at, last_used_at)
       VALUES (?, 'email', ?, ?, 'admin', ?, ?, NULL)`,
    )
      .bind(
        exactId,
        'admin@exact-precedence.example',
        domain.workspaceId,
        domain.accountId,
        '2026-09-12T00:00:00.000Z',
      )
      .run()
    const result = await resolve(
      'allow-exact-admin-subject',
      'Admin@Exact-Precedence.Example',
    )
    expect(result.role).toBe('admin')
  })

  it('keeps membership after the matching entry is removed', async () => {
    const entry = await addEntry({
      suffix: 'removal_keeps_member',
      kind: 'domain',
      value: 'keep-member.example',
      role: 'member',
    })
    const result = await resolve(
      'allow-removal-subject',
      'person@keep-member.example',
    )
    await env.DB.prepare('DELETE FROM allowlist WHERE id = ?')
      .bind(entry.allowlistId)
      .run()
    const membership = await env.DB.prepare(
      `SELECT role FROM memberships WHERE workspace_id = ? AND account_id = ?`,
    )
      .bind(entry.workspaceId, result.accountId)
      .first<{ role: string }>()
    expect(membership).toEqual({ role: 'member' })
  })
})
