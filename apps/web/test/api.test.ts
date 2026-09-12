import { env as workerEnv } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import worker from '../src/worker'
import bomFixture from './fixtures/bom.html?raw'
import { seedPrincipal, testEnv } from './core-helpers'

const env = testEnv(workerEnv)

function html(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${title}</body></html>`
}

async function request(
  path: string,
  options: {
    readonly token?: string
    readonly method?: string
    readonly body?: unknown
    readonly environment?: Cloudflare.Env
  } = {},
): Promise<Response> {
  const headers = new Headers()
  if (options.token) headers.set('authorization', `Bearer ${options.token}`)
  let body: string | undefined
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(options.body)
  }
  return worker.fetch(
    new Request(`https://dossier.test${path}`, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
    }) as Parameters<typeof worker.fetch>[0],
    options.environment ?? env,
  )
}

async function upload(
  token: string,
  payload: Record<string, unknown>,
): Promise<{ response: Response; body: any }> {
  const response = await request('/api/uploads', { token, body: payload })
  return { response, body: await response.json() }
}

describe('phase-one HTTP API', () => {
  it('creates with 201, updates with 200, and preserves legacy upload aliases', async () => {
    const principal = await seedPrincipal(env, { suffix: 'api_upload_shapes' })
    const created = await upload(principal.token, {
      html: html('Created through API'),
      filename: 'created.html',
      draftId: null,
      idempotencyKey: 'api-upload-create',
    })
    expect(created.response.status).toBe(201)
    expect(created.body).toMatchObject({
      ok: true,
      versionNumber: 1,
      draftId: created.body.document.id,
      publicUrl: created.body.document.url,
      rawUrl: created.body.document.rawUrl,
    })

    const updated = await upload(principal.token, {
      html: html('Updated through API'),
      draftId: created.body.draftId,
      idempotencyKey: 'api-upload-update',
    })
    expect(updated.response.status).toBe(200)
    expect(updated.body).toMatchObject({
      ok: true,
      draftId: created.body.draftId,
      versionNumber: 2,
      publicUrl: created.body.publicUrl,
      rawUrl: created.body.rawUrl,
    })
  })

  it('rejects conflicting identifiers and malformed schemas with 422', async () => {
    const principal = await seedPrincipal(env, {
      suffix: 'api_upload_validation',
    })
    const conflict = await upload(principal.token, {
      html: html('Conflicting identifiers'),
      documentId: 'aaaaaaaaaaaa',
      draftId: 'bbbbbbbbbbbb',
    })
    expect(conflict.response.status).toBe(422)
    expect(conflict.body).toMatchObject({
      ok: false,
      code: 'policy_rejected',
    })

    const malformed = await upload(principal.token, {
      html: html('Unknown field'),
      unexpected: true,
    })
    expect(malformed.response.status).toBe(422)
    expect(malformed.body).toMatchObject({
      ok: false,
      code: 'policy_rejected',
    })
  })

  it('authenticates before decoding and rejects valid non-publishers', async () => {
    const unauthenticated = await request('/api/uploads', {
      body: { html: 42 },
    })
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer')
    expect(await unauthenticated.json()).toMatchObject({
      ok: false,
      code: 'unauthenticated',
    })

    const outsider = await seedPrincipal(env, {
      suffix: 'api_non_publisher',
      role: null,
    })
    const forbidden = await upload(outsider.token, {
      html: html('Not allowed to publish'),
    })
    expect(forbidden.response.status).toBe(403)
    expect(forbidden.body).toMatchObject({
      ok: false,
      code: 'publisher_required',
    })
  })

  it('rate-limits by API key with Retry-After and skips a missing test binding', async () => {
    const principal = await seedPrincipal(env, { suffix: 'api_rate_limit' })
    let calls = 0
    const limitedEnv = {
      ...env,
      UPLOAD_RATE_LIMITER: {
        limit: async ({ key }: RateLimitOptions) => {
          calls += 1
          expect(key).toBe(principal.keyId)
          return { success: false }
        },
      },
    } as Cloudflare.Env
    const limited = await request('/api/uploads', {
      token: principal.token,
      body: { html: html('Rate limited') },
      environment: limitedEnv,
    })
    expect(calls).toBe(1)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(await limited.json()).toMatchObject({
      ok: false,
      code: 'rate_limited',
    })

    const withoutLimiter = { ...env } as Partial<Cloudflare.Env>
    delete withoutLimiter.UPLOAD_RATE_LIMITER
    const allowed = await request('/api/uploads', {
      token: principal.token,
      body: {
        html: html('No test limiter'),
        idempotencyKey: 'api-no-limiter',
      },
      environment: withoutLimiter as Cloudflare.Env,
    })
    expect(allowed.status).toBe(201)
  })

  it('exposes delete conflict/force, trash restore, and disable/enable', async () => {
    const principal = await seedPrincipal(env, {
      suffix: 'api_document_mutations',
    })
    const root = await upload(principal.token, {
      html: html('Root document'),
      idempotencyKey: 'api-root',
    })
    const child = await upload(principal.token, {
      html: html('Child document'),
      idempotencyKey: 'api-child',
    })
    expect(root.response.status).toBe(201)
    expect(child.response.status).toBe(201)

    await env.DB.prepare(
      `UPDATE documents SET parent_id = ?, path = ?, depth = 1 WHERE id = ?`,
    )
      .bind(
        root.body.document.id,
        `/${root.body.document.id}/`,
        child.body.document.id,
      )
      .run()

    const conflict = await request(`/api/documents/${root.body.document.id}`, {
      token: principal.token,
      method: 'DELETE',
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      ok: false,
      code: 'has_children',
      details: { count: 1 },
    })

    const forced = await request(
      `/api/documents/${root.body.document.id}?force=1`,
      { token: principal.token, method: 'DELETE' },
    )
    expect(forced.status).toBe(200)
    const deletion = (await forced.json()) as {
      batchId: string
      deleted: number
    }
    expect(deletion.deleted).toBe(2)

    const trash = await request('/api/documents?scope=trash', {
      token: principal.token,
    })
    expect(trash.status).toBe(200)
    expect(
      (
        (await trash.json()) as { documents: Array<{ id: string }> }
      ).documents.map((document) => document.id),
    ).toContain(root.body.document.id)

    const restored = await request(
      `/api/documents/${root.body.document.id}/restore`,
      {
        token: principal.token,
        body: { batchId: deletion.batchId },
      },
    )
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({
      ok: true,
      document: { deletedAt: null, deletionBatchId: null },
    })

    const disabled = await request(
      `/api/documents/${root.body.document.id}/disable`,
      { token: principal.token, body: { reason: 'review' } },
    )
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toMatchObject({
      ok: true,
      document: { disabled: true },
    })

    const inspected = await request(`/api/documents/${root.body.document.id}`, {
      token: principal.token,
    })
    expect(inspected.status).toBe(200)
    expect(await inspected.json()).toMatchObject({
      ok: true,
      document: { disabled: true },
    })

    const enabled = await request(
      `/api/documents/${root.body.document.id}/enable`,
      { token: principal.token, method: 'POST' },
    )
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toMatchObject({
      ok: true,
      document: { disabled: false, disabledAt: null },
    })
  })

  it('returns upstream draft fields, me details, and publisher-managed keys', async () => {
    const principal = await seedPrincipal(env, {
      suffix: 'api_identity_keys',
      role: 'admin',
      email: 'admin-api@test.example',
    })
    const created = await upload(principal.token, {
      html: html('Legacy draft listing'),
      idempotencyKey: 'api-legacy-list',
    })
    expect(created.response.status).toBe(201)

    const drafts = await request('/api/drafts', { token: principal.token })
    expect(drafts.status).toBe(200)
    expect(await drafts.json()).toMatchObject({
      ok: true,
      drafts: [
        {
          draftId: created.body.document.id,
          title: 'Legacy draft listing',
          latestVersionNumber: 1,
          versionCount: 1,
          disabled: false,
          publicUrl: created.body.publicUrl,
          rawUrl: created.body.rawUrl,
        },
      ],
    })

    const me = await request('/api/me', { token: principal.token })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      accountId: principal.accountId,
      apiKeyId: principal.keyId,
      workspace: {
        id: principal.workspaceId,
        role: 'admin',
      },
      email: 'admin-api@test.example',
    })

    const minted = await request('/api/api-keys', {
      token: principal.token,
      body: { name: 'Integration key' },
    })
    expect(minted.status).toBe(201)
    const mintedBody = (await minted.json()) as {
      token: string
      apiKey: { id: string; name: string }
    }
    expect(mintedBody).toMatchObject({
      ok: true,
      apiKey: { name: 'Integration key' },
    })
    expect(mintedBody.token).toMatch(/^ds_/)

    const revoked = await request(
      `/api/api-keys/${mintedBody.apiKey.id}/revoke`,
      { token: principal.token, method: 'POST' },
    )
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({ ok: true })

    const rejected = await request('/api/me', { token: mintedBody.token })
    expect(rejected.status).toBe(401)
  })

  it('allows a removed member to revoke their own API key', async () => {
    const principal = await seedPrincipal(env, {
      suffix: 'api_removed_self_revoke',
    })
    await env.DB.prepare(
      'DELETE FROM memberships WHERE workspace_id = ? AND account_id = ?',
    )
      .bind(principal.workspaceId, principal.accountId)
      .run()

    const revoked = await request(`/api/api-keys/${principal.keyId}/revoke`, {
      token: principal.token,
      method: 'POST',
    })
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({ ok: true })
    expect(
      await env.DB.prepare('SELECT revoked_at FROM api_keys WHERE id = ?')
        .bind(principal.keyId)
        .first<{ revoked_at: string | null }>(),
    ).toMatchObject({ revoked_at: expect.any(String) })
  })

  it('serves authenticated HEAD /d/:id through the worker entry', async () => {
    const principal = await seedPrincipal(env, { suffix: 'api_worker_head' })
    expect(bomFixture.charCodeAt(0)).toBe(0xfeff)
    const created = await upload(principal.token, {
      html: bomFixture,
      filename: 'bom.html',
      idempotencyKey: 'api-worker-head',
    })
    expect(created.response.status).toBe(201)

    const response = await request(`/d/${created.body.document.id}`, {
      token: principal.token,
      method: 'HEAD',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-dossier-document-id')).toBe(
      created.body.document.id,
    )
    expect(response.headers.get('x-dossier-version')).toBe('1')
    expect(response.headers.get('content-length')).toBe(
      String(new TextEncoder().encode(bomFixture).byteLength),
    )
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })
})
