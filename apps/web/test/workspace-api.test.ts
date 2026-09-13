import { env as workerEnv } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import worker from '../src/worker'
import { seedPrincipal, testEnv } from './core-helpers'

const env = testEnv(workerEnv)
const now = '2026-09-12T00:00:00.000Z'

type Seeded = Awaited<ReturnType<typeof seedPrincipal>>

async function request(
  path: string,
  options: {
    readonly token?: string
    readonly method?: string
    readonly body?: unknown
    readonly rawBody?: string
  } = {},
): Promise<Response> {
  const headers = new Headers()
  if (options.token) headers.set('authorization', `Bearer ${options.token}`)
  const body = options.rawBody ?? (
    options.body === undefined ? undefined : JSON.stringify(options.body)
  )
  if (body !== undefined) headers.set('content-type', 'application/json')
  return worker.fetch(
    new Request(`https://dossier.test${path}`, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
    }) as Parameters<typeof worker.fetch>[0],
    env,
  )
}

async function expectError(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ ok: false, code })
}

async function scopedPrincipal(
  suffix: string,
  workspaceId: string,
  options: {
    readonly role?: 'admin' | 'member' | null
    readonly accountKind?: 'user' | 'service'
    readonly deploymentAdmin?: boolean
    readonly email?: string
  } = {},
): Promise<Seeded> {
  const principal = await seedPrincipal(env, {
    suffix,
    role: null,
    accountKind: options.accountKind,
    email: options.email,
  })
  await env.DB.prepare('UPDATE api_keys SET workspace_id = ? WHERE id = ?')
    .bind(workspaceId, principal.keyId)
    .run()
  if (options.role !== null) {
    await env.DB.prepare(
      `INSERT INTO memberships (workspace_id, account_id, role, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(workspaceId, principal.accountId, options.role ?? 'member', now)
      .run()
  }
  if (options.deploymentAdmin) {
    await env.DB.prepare('UPDATE accounts SET deployment_admin = 1 WHERE id = ?')
      .bind(principal.accountId)
      .run()
  }
  return { ...principal, workspaceId }
}

async function membership(principal: Seeded) {
  return env.DB.prepare(
    'SELECT role FROM memberships WHERE workspace_id = ? AND account_id = ?',
  )
    .bind(principal.workspaceId, principal.accountId)
    .first<{ role: 'admin' | 'member' }>()
}

const protectedRoutes = [
  { name: 'load workspace', method: 'GET', path: '/api/workspace' },
  {
    name: 'add allowlist entry',
    method: 'POST',
    path: '/api/workspace/allowlist',
    body: { kind: 'email', value: 'allowed@workspace-api.example', role: 'member' },
  },
  {
    name: 'remove allowlist entry',
    method: 'DELETE',
    path: '/api/workspace/allowlist/allow_missing',
  },
  {
    name: 'change member role',
    method: 'POST',
    path: '/api/workspace/members/account_missing',
    body: { role: 'admin' },
  },
  {
    name: 'remove member',
    method: 'DELETE',
    path: '/api/workspace/members/account_missing',
  },
] as const

describe('workspace management HTTP API', () => {
  it('returns admin member and allowlist projections without other workspaces', async () => {
    const admin = await seedPrincipal(env, {
      suffix: 'workspace_api_shapes_admin',
      role: 'admin',
      email: 'admin@workspace-shapes.example',
    })
    const member = await scopedPrincipal('workspace_api_shapes_member', admin.workspaceId)
    const outsider = await seedPrincipal(env, { suffix: 'workspace_api_shapes_outsider' })
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO allowlist
           (id, kind, value, workspace_id, role, created_by, created_at, last_used_at)
         VALUES (?, 'email', ?, ?, 'admin', ?, ?, NULL)`,
      ).bind('allow_workspace_api_shapes', 'admin@workspace-shapes.example', admin.workspaceId, admin.accountId, now),
      env.DB.prepare(
        `INSERT INTO allowlist
           (id, kind, value, workspace_id, role, created_by, created_at, last_used_at)
         VALUES (?, 'domain', ?, ?, 'member', ?, ?, NULL)`,
      ).bind('allow_workspace_api_other_shapes', 'other-workspace-shapes.example', outsider.workspaceId, outsider.accountId, now),
    ])

    const response = await request('/api/workspace', { token: admin.token })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      members: [
        {
          accountId: admin.accountId,
          name: 'Account workspace_api_shapes_admin',
          email: 'admin@workspace-shapes.example',
          pictureUrl: null,
          role: 'admin',
          joinedAt: now,
          lastLoginAt: now,
          disabled: false,
          deploymentAdmin: false,
          kind: 'user',
        },
        {
          accountId: member.accountId,
          name: 'Account workspace_api_shapes_member',
          email: null,
          pictureUrl: null,
          role: 'member',
          joinedAt: now,
          lastLoginAt: null,
          disabled: false,
          deploymentAdmin: false,
          kind: 'user',
        },
      ],
      allowlist: [
        {
          id: 'allow_workspace_api_shapes',
          kind: 'email',
          value: 'admin@workspace-shapes.example',
          role: 'admin',
          createdAt: now,
          createdByName: 'Account workspace_api_shapes_admin',
          lastUsedAt: null,
        },
      ],
    })
  })

  it.each(protectedRoutes)('rejects members who try to $name with editor_required', async (route) => {
    const member = await seedPrincipal(env, {
      suffix: `workspace_api_forbidden_${route.name.replaceAll(' ', '_')}`,
    })
    await expectError(await request(route.path, { ...route, token: member.token }), 403, 'editor_required')
  })

  it.each(protectedRoutes)('rejects anonymous callers who try to $name with 401', async (route) => {
    const response = await request(route.path, route)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    await expectError(response, 401, 'unauthenticated')
  })

  it('allows a deployment-admin service account with no workspace membership', async () => {
    const service = await seedPrincipal(env, {
      suffix: 'workspace_api_deployment_admin',
      accountKind: 'service',
      role: null,
    })
    await env.DB.prepare('UPDATE accounts SET deployment_admin = 1 WHERE id = ?')
      .bind(service.accountId)
      .run()
    expect(await membership(service)).toBeNull()
    const response = await request('/api/workspace', { token: service.token })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, members: [], allowlist: [] })

    const added = await request('/api/workspace/allowlist', {
      token: service.token,
      body: { kind: 'domain', value: 'deployment-admin-workspace.example', role: 'member' },
    })
    expect(added.status).toBe(200)
    expect(await added.json()).toEqual({ ok: true, message: expect.any(String) })
  })

  it.each([
    { kind: 'email', value: 'Person@Workspace-Duplicate.Example', normalized: 'person@workspace-duplicate.example', role: 'admin' },
    { kind: 'domain', value: 'Workspace-Duplicate.Example', normalized: 'workspace-duplicate.example', role: 'member' },
  ] as const)('adds normalized $kind entries and rejects local and cross-workspace duplicates', async ({ kind, value, normalized, role }) => {
    const admin = await seedPrincipal(env, { suffix: `workspace_api_duplicate_${kind}`, role: 'admin' })
    const other = await seedPrincipal(env, { suffix: `workspace_api_duplicate_other_${kind}`, role: 'admin' })
    const added = await request('/api/workspace/allowlist', {
      token: admin.token,
      body: { kind, value, role },
    })
    expect(added.status).toBe(200)
    expect(await added.json()).toEqual({ ok: true, message: expect.any(String) })
    for (const token of [admin.token, other.token]) {
      await expectError(await request('/api/workspace/allowlist', {
        token,
        body: { kind, value: normalized, role: role === 'admin' ? 'member' : 'admin' },
      }), 409, 'conflict')
    }
    const rows = await env.DB.prepare(
      'SELECT kind, value, workspace_id, role, created_by FROM allowlist WHERE value = ?',
    ).bind(normalized).all()
    expect(rows.results).toEqual([{
      kind, value: normalized, workspace_id: admin.workspaceId, role, created_by: admin.accountId,
    }])
  })

  it('removes an allowlist entry, returns 404 on repeat, and preserves its existing member', async () => {
    const admin = await seedPrincipal(env, { suffix: 'workspace_api_allow_remove', role: 'admin' })
    const member = await scopedPrincipal('workspace_api_allow_remove_member', admin.workspaceId, {
      email: 'member@workspace-remove-entry.example',
    })
    const added = await request('/api/workspace/allowlist', {
      token: admin.token,
      body: { kind: 'email', value: 'member@workspace-remove-entry.example', role: 'member' },
    })
    expect(added.status).toBe(200)
    const entry = await env.DB.prepare('SELECT id FROM allowlist WHERE workspace_id = ?')
      .bind(admin.workspaceId).first<{ id: string }>()
    expect(entry).not.toBeNull()
    const path = `/api/workspace/allowlist/${entry!.id}`
    const removed = await request(path, { token: admin.token, method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ ok: true, message: expect.any(String) })
    await expectError(await request(path, { token: admin.token, method: 'DELETE' }), 404, 'not_found')
    expect(await membership(member)).toEqual({ role: 'member' })
    expect(await env.DB.prepare('SELECT id FROM allowlist WHERE id = ?').bind(entry!.id).first()).toBeNull()
    const upload = await request('/api/uploads', {
      token: member.token,
      body: { html: '<!doctype html><html><head><title>Still a member</title></head><body>Allowed</body></html>' },
    })
    expect(upload.status).toBe(201)
  })

  it('does not delete an allowlist entry from another workspace', async () => {
    const admin = await seedPrincipal(env, { suffix: 'workspace_api_allow_scope', role: 'admin' })
    const other = await seedPrincipal(env, { suffix: 'workspace_api_allow_scope_other', role: 'admin' })
    const added = await request('/api/workspace/allowlist', {
      token: other.token,
      body: { kind: 'domain', value: 'workspace-delete-scope.example', role: 'member' },
    })
    expect(added.status).toBe(200)
    const entry = await env.DB.prepare('SELECT id FROM allowlist WHERE workspace_id = ?')
      .bind(other.workspaceId).first<{ id: string }>()
    expect(entry).not.toBeNull()
    await expectError(await request(`/api/workspace/allowlist/${entry!.id}`, {
      token: admin.token, method: 'DELETE',
    }), 404, 'not_found')
    expect(await env.DB.prepare('SELECT id FROM allowlist WHERE id = ?').bind(entry!.id).first()).toEqual(entry)
  })

  it('promotes and demotes a member while retaining another admin', async () => {
    const admin = await seedPrincipal(env, { suffix: 'workspace_api_roles', role: 'admin' })
    const member = await scopedPrincipal('workspace_api_roles_member', admin.workspaceId)
    for (const role of ['admin', 'admin', 'member'] as const) {
      const response = await request(`/api/workspace/members/${member.accountId}`, {
        token: admin.token, body: { role },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, message: expect.any(String) })
      expect(await membership(member)).toEqual({ role })
      const management = await request('/api/workspace', { token: member.token })
      if (role === 'admin') expect(management.status).toBe(200)
      else await expectError(management, 403, 'editor_required')
    }
    expect(await membership(admin)).toEqual({ role: 'admin' })
  })

  it('rejects demotion of the last admin with 409 without changing membership', async () => {
    const admin = await seedPrincipal(env, { suffix: 'workspace_api_last_demote', role: 'admin' })
    await expectError(await request(`/api/workspace/members/${admin.accountId}`, {
      token: admin.token, body: { role: 'member' },
    }), 409, 'conflict')
    expect(await membership(admin)).toEqual({ role: 'admin' })
  })

  it('rejects removing yourself even when another admin remains', async () => {
    const admin = await seedPrincipal(env, { suffix: 'workspace_api_self_remove', role: 'admin' })
    await scopedPrincipal('workspace_api_self_remove_other', admin.workspaceId, { role: 'admin' })
    await expectError(await request(`/api/workspace/members/${admin.accountId}`, {
      token: admin.token, method: 'DELETE',
    }), 409, 'conflict')
    expect(await membership(admin)).toEqual({ role: 'admin' })
  })

  it('rejects a deployment admin removing the last workspace admin', async () => {
    const admin = await seedPrincipal(env, { suffix: 'workspace_api_last_remove', role: 'admin' })
    const service = await scopedPrincipal('workspace_api_last_remove_service', admin.workspaceId, {
      role: null, accountKind: 'service', deploymentAdmin: true,
    })
    expect(await membership(service)).toBeNull()
    await expectError(await request(`/api/workspace/members/${admin.accountId}`, {
      token: service.token, method: 'DELETE',
    }), 409, 'conflict')
    expect(await membership(admin)).toEqual({ role: 'admin' })
  })

  it('removes a member and immediately rejects uploads through their still-valid API key', async () => {
    const admin = await seedPrincipal(env, { suffix: 'workspace_api_member_remove', role: 'admin' })
    const member = await scopedPrincipal('workspace_api_member_remove_target', admin.workspaceId)
    const path = `/api/workspace/members/${member.accountId}`
    const removed = await request(path, { token: admin.token, method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ ok: true, message: expect.any(String) })
    expect(await membership(member)).toBeNull()
    await expectError(await request(path, { token: admin.token, method: 'DELETE' }), 404, 'not_found')
    expect(await env.DB.prepare('SELECT revoked_at FROM api_keys WHERE id = ?')
      .bind(member.keyId).first()).toEqual({ revoked_at: null })
    await expectError(await request('/api/uploads', {
      token: member.token,
      body: { html: '<!doctype html><html><head><title>Removed member</title></head><body>Forbidden</body></html>' },
    }), 403, 'publisher_required')
  })

  it.each(['POST', 'DELETE'])('returns 404 for %s targeting a member of another workspace', async (method) => {
    const admin = await seedPrincipal(env, { suffix: `workspace_api_member_scope_${method}`, role: 'admin' })
    const other = await seedPrincipal(env, { suffix: `workspace_api_member_scope_other_${method}` })
    await expectError(await request(`/api/workspace/members/${other.accountId}`, {
      token: admin.token, method, ...(method === 'POST' ? { body: { role: 'admin' } } : {}),
    }), 404, 'not_found')
    expect(await membership(other)).toEqual({ role: 'member' })
  })

  it.each([
    { name: 'missing kind', body: { value: 'person@workspace-invalid.example', role: 'member' } },
    { name: 'invalid kind', body: { kind: 'group', value: 'workspace-invalid.example', role: 'member' } },
    { name: 'non-string value', body: { kind: 'email', value: 42, role: 'member' } },
    { name: 'invalid role', body: { kind: 'email', value: 'person@workspace-invalid.example', role: 'owner' } },
    { name: 'unknown property', body: { kind: 'email', value: 'person@workspace-invalid.example', role: 'member', unexpected: true } },
    { name: 'invalid email syntax', body: { kind: 'email', value: 'not-an-email', role: 'member' } },
    { name: 'invalid domain syntax', body: { kind: 'domain', value: 'bad domain.example', role: 'member' } },
    { name: 'email kind with domain value', body: { kind: 'email', value: 'workspace-invalid.example', role: 'member' } },
    { name: 'domain kind with email value', body: { kind: 'domain', value: 'person@workspace-invalid.example', role: 'member' } },
  ])('rejects allowlist $name with 422 policy_rejected', async ({ name, body }) => {
    const admin = await seedPrincipal(env, { suffix: `workspace_api_invalid_${name.replaceAll(' ', '_')}`, role: 'admin' })
    await expectError(await request('/api/workspace/allowlist', {
      token: admin.token, body,
    }), 422, 'policy_rejected')
    expect((await env.DB.prepare('SELECT id FROM allowlist WHERE workspace_id = ?')
      .bind(admin.workspaceId).all()).results).toEqual([])
  })

  it.each([
    { name: 'missing role', body: {} },
    { name: 'invalid role', body: { role: 'owner' } },
    { name: 'unknown property', body: { role: 'member', unexpected: true } },
  ])('rejects member mutation $name with 422 policy_rejected', async ({ name, body }) => {
    const admin = await seedPrincipal(env, { suffix: `workspace_api_invalid_role_${name.replaceAll(' ', '_')}`, role: 'admin' })
    await expectError(await request(`/api/workspace/members/${admin.accountId}`, {
      token: admin.token, body,
    }), 422, 'policy_rejected')
    expect(await membership(admin)).toEqual({ role: 'admin' })
  })

  it.each(['allowlist', 'members'])('rejects malformed JSON for %s with 422 policy_rejected', async (resource) => {
    const admin = await seedPrincipal(env, { suffix: `workspace_api_json_${resource}`, role: 'admin' })
    const path = resource === 'allowlist'
      ? '/api/workspace/allowlist'
      : `/api/workspace/members/${admin.accountId}`
    await expectError(await request(path, { token: admin.token, rawBody: '{' }), 422, 'policy_rejected')
  })
})
