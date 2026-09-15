import type { UploadResponse } from '@dossier/contracts'
import { env as workerEnv } from 'cloudflare:workers'
import { Effect, Layer } from 'effect'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { handleApiRequest } from '../src/api'
import { handleAuthRequest } from '../src/api/auth'
import { handleServingRequest } from '../src/api/serving'
import { readBoundedBody } from '../src/api/request'
import { issueCsrfToken, verifyCsrf } from '../src/server/csrf'
import { loadWorkspace } from '../src/server/workspace'
import { documentAction, loadTrash } from '../src/server/documents'
import { loadCliAuth, mintApiKey } from '../src/server/keys'
import type { CoreServices } from '../src/server/runtime'
import {
  CoreServicesLive,
  makeSession,
  resetShooCaches,
  WorkerEnv,
} from '../src/services'
import { seedPrincipal, TEST_SECRET, testEnv } from './core-helpers'

// The workerd test config does not run TanStack's server-function compiler.
// Preserve the production validators and handlers, replacing only compiler /
// request-context plumbing so web authorization runs against real D1 services.
const webContext = vi.hoisted(() => ({
  request: undefined as Request | undefined,
}))
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    let validate = (value: unknown) => value
    return {
      validator(next: (value: unknown) => unknown) {
        validate = next
        return this
      },
      handler(next: (context: { data: unknown }) => Promise<unknown>) {
        return (options?: { data?: unknown }) =>
          next({ data: validate(options?.data) })
      },
    }
  },
}))
vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => webContext.request,
}))
vi.mock('../src/server/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server/runtime')>()
  return {
    ...actual,
    runSurface: async (
      program: Effect.Effect<unknown, unknown, CoreServices>,
    ) => {
      const result = await Effect.runPromise(
        program.pipe(Effect.either, Effect.provide(layer)),
      )
      return result._tag === 'Right'
        ? result.right
        : actual.toSurfaceFailure(result.left)
    },
  }
})

const ORIGIN = 'https://dossier.test'
const env = {
  ...testEnv(workerEnv),
  UPLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) },
} as Cloudflare.Env
const layer = CoreServicesLive.pipe(
  Layer.provideMerge(Layer.succeed(WorkerEnv, env)),
)
const session = makeSession(TEST_SECRET, true)
const html =
  '<!doctype html><html><head><title>Secret</title></head><body>workspace secret</body></html>'

function api(path: string, token?: string, body?: unknown, method?: string) {
  return handleApiRequest(
    new Request(`${ORIGIN}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  )
}

async function publish(token: string) {
  const response = await api('/api/uploads', token, { html })
  expect(response.status).toBe(201)
  return response.json() as Promise<UploadResponse>
}

function responseCookie(response: Response, name: string): string {
  const pair = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(';')[0]
  if (!pair) throw new Error(`Response did not set ${name}`)
  return pair
}

afterEach(() => {
  vi.restoreAllMocks()
  resetShooCaches()
})

describe('adversarial phase-one security regressions', () => {
  it('does not turn a workspace-bound API key into a cookie for another workspace through a CSRF token', async () => {
    // The victim account belongs to two workspaces, but the attacker knows only
    // its B-bound API key. The cookie fallback selects the first membership (A).
    const other = await seedPrincipal(env, { suffix: 'aaa_security_other' })
    const victim = await seedPrincipal(env, { suffix: 'zzz_security_victim' })
    await env.DB.prepare(
      `INSERT INTO memberships (workspace_id, account_id, role, created_at) VALUES (?, ?, 'admin', ?)`,
    )
      .bind(other.workspaceId, victim.accountId, new Date().toISOString())
      .run()
    const receipt = await publish(other.token)
    const path = `${ORIGIN}/d/${receipt.document.id}`
    const denied = await handleServingRequest(
      new Request(path, {
        headers: { authorization: `Bearer ${victim.token}` },
      }),
      env,
    )
    expect(denied.status).toBe(200)

    // Web loaders are cookie-only, and even a valid browser-readable CSRF
    // token cannot be substituted for the HttpOnly session cookie.
    webContext.request = new Request(`${ORIGIN}/cli/auth`, {
      headers: { authorization: `Bearer ${victim.token}` },
    })
    expect(await loadCliAuth()).toMatchObject({
      ok: false,
      code: 'unauthenticated',
    })
    const csrfToken = await Effect.runPromise(
      issueCsrfToken(victim.accountId).pipe(Effect.provide(layer)),
    )
    const replay = await handleServingRequest(
      new Request(path, {
        headers: { cookie: `${session.cookieName('session')}=${csrfToken}` },
      }),
      env,
    )
    expect(replay.status).toBe(404)
  })

  it('does not accept a browser-readable CSRF token as authentication after the originating API key is revoked', async () => {
    const victim = await seedPrincipal(env, {
      suffix: 'security_revoke_replay',
    })
    const receipt = await publish(victim.token)
    const csrfToken = await Effect.runPromise(
      issueCsrfToken(victim.accountId).pipe(Effect.provide(layer)),
    )
    await env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), victim.keyId)
      .run()
    expect((await api('/api/me', victim.token)).status).toBe(401)
    const replay = await handleServingRequest(
      new Request(`${ORIGIN}/d/${receipt.document.id}`, {
        headers: { cookie: `${session.cookieName('session')}=${csrfToken}` },
      }),
      env,
    )
    expect(replay.status).toBe(404)
  })

  it('keeps the actual OAuth callback redirect on-origin for a tab-obfuscated next parameter', async () => {
    const seed = await seedPrincipal(env, { suffix: 'security_redirect' })
    await env.DB.prepare(
      `INSERT INTO allowlist (id, kind, value, workspace_id, role, created_by, created_at) VALUES (?, 'email', ?, ?, 'member', ?, ?)`,
    )
      .bind(
        'allow_security_redirect',
        'redirect@security.example',
        seed.workspaceId,
        seed.accountId,
        new Date().toISOString(),
      )
      .run()
    const { publicKey, privateKey } = await generateKeyPair('ES256', {
      extractable: true,
    })
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: 'security-key',
      alg: 'ES256',
    }
    const idToken = await new SignJWT({
      pairwise_sub: 'security-redirect-sub',
      email: 'redirect@security.example',
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'security-key' })
      .setIssuer('https://shoo.test')
      .setAudience(`origin:${ORIGIN}`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url.endsWith('/.well-known/openid-configuration'))
        return Response.json({ issuer: 'https://shoo.test' })
      if (url.endsWith('/.well-known/jwks.json'))
        return Response.json({ keys: [jwk] })
      if (url.endsWith('/token')) return Response.json({ id_token: idToken })
      throw new Error(`Unexpected test fetch: ${url}`)
    })
    const started = await handleAuthRequest(
      new Request(
        `${ORIGIN}/auth/sign-in?next=${encodeURIComponent('/\t/attacker.example/phish')}`,
      ),
      env,
    )
    const state = new URL(started.headers.get('location')!).searchParams.get(
      'state',
    )!
    const callback = await handleAuthRequest(
      new Request(
        `${ORIGIN}/auth/callback?code=one-use-code&state=${encodeURIComponent(state)}`,
        {
          headers: {
            cookie: responseCookie(started, session.cookieName('auth-state')),
          },
        },
      ),
      env,
    )
    expect(callback.status).toBe(302)
    // WHATWG/browser URL parsing removes embedded tabs: /\t/ becomes //.
    expect(new URL(callback.headers.get('location')!, ORIGIN).origin).toBe(
      ORIGIN,
    )
  })

  it('does not reveal workspace member identities to a removed member with an otherwise-valid session', async () => {
    const owner = await seedPrincipal(env, {
      suffix: 'security_roster_owner',
      email: 'owner@private.example',
    })
    const former = await seedPrincipal(env, {
      suffix: 'security_roster_former',
    })
    await env.DB.prepare(
      `INSERT INTO memberships (workspace_id, account_id, role, created_at) VALUES (?, ?, 'member', ?)`,
    )
      .bind(owner.workspaceId, former.accountId, new Date().toISOString())
      .run()
    const cookie = (
      await Effect.runPromise(
        session.createSessionCookie({
          accountId: former.accountId,
          workspaceId: owner.workspaceId,
        }),
      )
    ).split(';')[0]
    await env.DB.prepare(
      'DELETE FROM memberships WHERE workspace_id = ? AND account_id = ?',
    )
      .bind(owner.workspaceId, former.accountId)
      .run()
    webContext.request = new Request(`${ORIGIN}/workspace`, {
      headers: { cookie },
    })
    const result = await loadWorkspace()
    expect('ok' in result && result.ok === false).toBe(true)
  })

  it('restricts workspace roster and allowlist data to admins', async () => {
    const member = await seedPrincipal(env, {
      suffix: 'security_roster_member',
    })
    const cookie = (
      await Effect.runPromise(
        session.createSessionCookie({
          accountId: member.accountId,
          workspaceId: member.workspaceId,
        }),
      )
    ).split(';')[0]
    webContext.request = new Request(`${ORIGIN}/workspace`, {
      headers: { cookie },
    })
    expect(await loadWorkspace()).toMatchObject({
      ok: false,
      code: 'editor_required',
    })
  })

  it('allows a workspace member to read the default team boundary', async () => {
    const owner = await seedPrincipal(env, { suffix: 'security_oracle_owner' })
    const outsider = await seedPrincipal(env, {
      suffix: 'security_oracle_outsider',
    })
    await env.DB.prepare(
      `INSERT INTO memberships (workspace_id, account_id, role, created_at) VALUES (?, ?, 'member', ?)`,
    )
      .bind(owner.workspaceId, outsider.accountId, new Date().toISOString())
      .run()
    await env.DB.prepare('UPDATE api_keys SET workspace_id = ? WHERE id = ?')
      .bind(owner.workspaceId, outsider.keyId)
      .run()
    const receipt = await publish(owner.token)
    expect(
      (
        await handleServingRequest(
          new Request(`${ORIGIN}/d/${receipt.document.id}`, {
            headers: { authorization: `Bearer ${outsider.token}` },
          }),
          env,
        )
      ).status,
    ).toBe(200)
    const missing = await api('/api/documents/000000000000', outsider.token)
    const hidden = await api(
      `/api/documents/${receipt.document.id}`,
      outsider.token,
    )
    expect(missing.status).toBe(404)
    expect(hidden.status).toBe(200)
    expect(await hidden.json()).toMatchObject({
      ok: true,
      document: { id: receipt.document.id, effectiveVisibility: 'team' },
    })
  })
})

describe('dashboard trash data', () => {
  it('maps purge metadata and retention into the loader contract', async () => {
    const owner = await seedPrincipal(env, { suffix: 'trash_purge_metadata' })
    const receipt = await publish(owner.token)
    const deleted = await api(
      `/api/documents/${receipt.document.id}`,
      owner.token,
      undefined,
      'DELETE',
    )
    expect(deleted.status).toBe(200)
    const { batchId } = (await deleted.json()) as { batchId: string }
    const batch = await env.DB.prepare(
      'SELECT created_at, purge_status FROM deletion_batches WHERE id = ?',
    )
      .bind(batchId)
      .first<{ created_at: string; purge_status: string }>()
    expect(batch).not.toBeNull()

    const cookie = (
      await Effect.runPromise(
        session.createSessionCookie({
          accountId: owner.accountId,
          workspaceId: owner.workspaceId,
        }),
      )
    ).split(';')[0]
    webContext.request = new Request(`${ORIGIN}/dashboard/trash`, {
      headers: { cookie },
    })

    expect(await loadTrash()).toMatchObject({
      retentionDays: 30,
      batches: [
        {
          batchId,
          rootDocumentId: receipt.document.id,
          purgeStatus: 'pending',
          purgesAt: new Date(
            Date.parse(batch!.created_at) + 30 * 86_400_000,
          ).toISOString(),
        },
      ],
    })
  })
})

describe('adversarial controls that must remain closed', () => {
  it('does not accept a forged account ID or fall back from an invalid Bearer to a valid cookie', async () => {
    const victim = await seedPrincipal(env, { suffix: 'security_forgery' })
    const receipt = await publish(victim.token)
    const cookie = (
      await Effect.runPromise(
        session.createSessionCookie({
          accountId: victim.accountId,
          workspaceId: victim.workspaceId,
        }),
      )
    ).split(';')[0]
    const valid = new Request(`${ORIGIN}/d/${receipt.document.id}`, {
      headers: { cookie },
    })
    expect((await handleServingRequest(valid, env)).status).toBe(200)
    const invalidBearer = await handleServingRequest(
      new Request(valid, {
        headers: { cookie, authorization: 'Bearer ds_invalid' },
      }),
      env,
    )
    expect(invalidBearer.status).toBe(401)
    const token = cookie.slice(cookie.indexOf('=') + 1)
    const forged = token.replace(
      /^[^.]+/,
      btoa(
        JSON.stringify({
          accountId: victim.accountId,
          workspaceId: victim.workspaceId,
          exp: 9999999999,
        }),
      ),
    )
    expect(
      (
        await handleServingRequest(
          new Request(valid, {
            headers: { cookie: `${session.cookieName('session')}=${forged}` },
          }),
          env,
        )
      ).status,
    ).toBe(404)
  })

  it('keeps cross-workspace reads and every implemented document mutation inaccessible', async () => {
    const owner = await seedPrincipal(env, { suffix: 'security_idor_owner' })
    const attacker = await seedPrincipal(env, {
      suffix: 'security_idor_attacker',
    })
    const receipt = await publish(owner.token)
    const path = `/api/documents/${receipt.document.id}`
    for (const [method, target, body] of [
      ['GET', path, undefined],
      ['DELETE', path, undefined],
      ['POST', `${path}/disable`, {}],
      ['POST', `${path}/enable`, undefined],
      ['POST', `${path}/restore`, { batchId: 'guessed-batch' }],
      ['POST', '/api/uploads', { html, documentId: receipt.document.id }],
    ] as const) {
      expect(
        (await api(target, attacker.token, body, method)).status,
        `${method} ${target}`,
      ).toBe(404)
    }
    for (const suffix of ['', '/raw', '/v/1', '/v/1/raw']) {
      expect(
        (
          await handleServingRequest(
            new Request(`${ORIGIN}/d/${receipt.document.id}${suffix}`, {
              headers: { authorization: `Bearer ${attacker.token}` },
            }),
            env,
          )
        ).status,
      ).toBe(404)
    }
  })

  it('rejects cookie-only API mutations, cross-origin CSRF, and tokens belonging to another account', async () => {
    const victim = await seedPrincipal(env, { suffix: 'security_csrf' })
    const cookie = (
      await Effect.runPromise(
        session.createSessionCookie({
          accountId: victim.accountId,
          workspaceId: victim.workspaceId,
        }),
      )
    ).split(';')[0]
    for (const path of ['/api/uploads', '/api/api-keys']) {
      const result = await handleApiRequest(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            cookie,
            origin: ORIGIN,
            'content-type': 'application/json',
          },
          body: '{}',
        }),
        env,
      )
      expect(result.status).toBe(401)
    }
    const token = await Effect.runPromise(
      issueCsrfToken(victim.accountId).pipe(Effect.provide(layer)),
    )
    for (const [origin, accountId] of [
      ['https://attacker.example', victim.accountId],
      [ORIGIN, 'another-account'],
      ['null', victim.accountId],
    ] as const) {
      const result = await Effect.runPromise(
        verifyCsrf({
          request: new Request(`${ORIGIN}/_serverFn/documentAction`, {
            method: 'POST',
            headers: { origin },
          }),
          token,
          accountId,
        }).pipe(Effect.either, Effect.provide(layer)),
      )
      expect(result._tag).toBe('Left')
    }
  })

  it('runs the actual dashboard-action and key-mint handlers without allowing missing or hostile CSRF', async () => {
    const owner = await seedPrincipal(env, { suffix: 'security_handler_csrf' })
    const receipt = await publish(owner.token)
    const cookie = (
      await Effect.runPromise(
        session.createSessionCookie({
          accountId: owner.accountId,
          workspaceId: owner.workspaceId,
        }),
      )
    ).split(';')[0]
    const valid = await Effect.runPromise(
      issueCsrfToken(owner.accountId).pipe(Effect.provide(layer)),
    )
    const other = await Effect.runPromise(
      issueCsrfToken('another-account').pipe(Effect.provide(layer)),
    )
    for (const [origin, csrfToken] of [
      [undefined, valid],
      ['https://attacker.example', valid],
      ['null', valid],
      [ORIGIN, ''],
      [ORIGIN, other],
    ] as const) {
      webContext.request = new Request(`${ORIGIN}/_serverFn/action`, {
        method: 'POST',
        headers: { cookie, ...(origin === undefined ? {} : { origin }) },
      })
      expect(
        await documentAction({
          data: { id: receipt.document.id, action: 'delete', csrfToken },
        }),
      ).toMatchObject({ ok: false, code: 'csrf_rejected' })
      expect(
        await mintApiKey({ data: { name: 'Stolen key', csrfToken } }),
      ).toMatchObject({ ok: false, code: 'csrf_rejected' })
    }
    expect(
      await env.DB.prepare('SELECT deleted_at FROM documents WHERE id = ?')
        .bind(receipt.document.id)
        .first(),
    ).toMatchObject({ deleted_at: null })
    expect(
      (
        await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM api_keys WHERE account_id = ?',
        )
          .bind(owner.accountId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1)
  })

  it('changes saved-values grants through the savers action, for an editor only', async () => {
    const owner = await seedPrincipal(env, { suffix: 'security_savers_owner' })
    const stranger = await seedPrincipal(env, {
      suffix: 'security_savers_stranger',
    })
    const receipt = await publish(owner.token)
    const documentId = receipt.document.id
    const cookieFor = async (account: {
      accountId: string
      workspaceId: string
    }) =>
      (
        await Effect.runPromise(
          session.createSessionCookie({
            accountId: account.accountId,
            workspaceId: account.workspaceId,
          }),
        )
      ).split(';')[0]
    const ownerCookie = await cookieFor(owner)
    const strangerCookie = await cookieFor(stranger)
    const ownerToken = await Effect.runPromise(
      issueCsrfToken(owner.accountId).pipe(Effect.provide(layer)),
    )
    const strangerToken = await Effect.runPromise(
      issueCsrfToken(stranger.accountId).pipe(Effect.provide(layer)),
    )
    const act = (
      cookie: string | undefined,
      csrfToken: string,
      data: Record<string, unknown>,
      origin: string = ORIGIN,
    ) => {
      webContext.request = new Request(`${ORIGIN}/_serverFn/action`, {
        method: 'POST',
        headers: { ...(cookie ? { cookie } : {}), origin },
      })
      return documentAction({ data: { id: documentId, csrfToken, ...data } })
    }

    // The dashboard toggle turned on: one upsert, answered like the shares
    // action so the panel can re-render from the same payload.
    expect(
      await act(ownerCookie, ownerToken, {
        action: 'savers',
        addSavers: [' Saver@Example.COM '],
      }),
    ).toMatchObject({
      ok: true,
      action: 'shares',
      shares: { grants: [{ email: 'saver@example.com', canSave: true }] },
    })

    // Turned off again: the row survives, so the email keeps reading.
    expect(
      await act(ownerCookie, ownerToken, {
        action: 'savers',
        removeSavers: ['saver@example.com'],
      }),
    ).toMatchObject({
      shares: { grants: [{ email: 'saver@example.com', canSave: false }] },
    })

    // An account that cannot even read the document cannot touch its grants.
    expect(
      await act(strangerCookie, strangerToken, {
        action: 'savers',
        addSavers: ['stranger@example.com'],
      }),
    ).toMatchObject({ ok: false, code: 'not_found' })

    // The validator refuses a savers action that names nothing to change.
    expect(() =>
      act(ownerCookie, ownerToken, { action: 'savers' }),
    ).toThrowError('Name at least one state grant to change.')

    // And the CSRF guard still runs ahead of the service.
    expect(
      await act(
        ownerCookie,
        ownerToken,
        { action: 'savers', removeGrants: ['saver@example.com'] },
        'https://attacker.example',
      ),
    ).toMatchObject({ ok: false, code: 'csrf_rejected' })

    expect(
      await act(ownerCookie, ownerToken, {
        action: 'savers',
        removeGrants: ['saver@example.com'],
      }),
    ).toMatchObject({ ok: true, action: 'shares', shares: { grants: [] } })
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM document_state_grants WHERE document_id = ?',
      )
        .bind(documentId)
        .first<{ n: number }>(),
    ).toMatchObject({ n: 0 })
  })

  it('enforces streamed byte limits without trusting Content-Length', async () => {
    for (const declared of [undefined, '1', '-1', 'nonsense']) {
      const request = new Request(`${ORIGIN}/api/uploads`, {
        method: 'POST',
        headers: declared === undefined ? {} : { 'content-length': declared },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(7))
            controller.enqueue(new Uint8Array(7))
            controller.close()
          },
        }),
      })
      expect(await readBoundedBody(request, 10)).toBeNull()
    }
  })

  it('does not use original filenames as R2 object keys and refuses traversal document IDs', async () => {
    const owner = await seedPrincipal(env, { suffix: 'security_traversal' })
    const response = await api('/api/uploads', owner.token, {
      html,
      filename: '../../../../secrets.html',
    })
    expect(response.status).toBe(201)
    const receipt = (await response.json()) as UploadResponse
    const row = await env.DB.prepare(
      'SELECT object_key FROM document_versions WHERE document_id = ?',
    )
      .bind(receipt.document.id)
      .first<{ object_key: string }>()
    expect(row?.object_key).toMatch(
      new RegExp(`^docs/${receipt.document.id}/[A-Za-z0-9_-]+\\.html$`),
    )
    for (const documentId of [
      '../../other',
      '%2e%2e%2fother',
      'aaaaaaaaaaa/',
    ]) {
      expect(
        (await api('/api/uploads', owner.token, { html, documentId })).status,
      ).toBe(422)
    }
  })

  it('cannot bypass a rejecting per-key limiter by changing the upload pathname', async () => {
    const owner = await seedPrincipal(env, { suffix: 'security_rate' })
    const limit = vi.fn(async (_options: RateLimitOptions) => ({
      success: false,
    }))
    const limited = { ...env, UPLOAD_RATE_LIMITER: { limit } } as Cloudflare.Env
    for (const path of [
      '/api/uploads',
      '/api/uploads/',
      '/api/%75ploads',
      '/api/uploads?bypass=1',
    ]) {
      const response = await handleApiRequest(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${owner.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ html }),
        }),
        limited,
      )
      expect([404, 429], path).toContain(response.status)
    }
    expect(limit).toHaveBeenCalledWith({ key: owner.keyId })
  })
})
