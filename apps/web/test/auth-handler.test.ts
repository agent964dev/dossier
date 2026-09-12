import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { handleAuthRequest, safeNextPath } from '../src/api/auth'
import { makeSession, resetShooCaches } from '../src/services'
import { TEST_SECRET, testEnv } from './core-helpers'

const environment = testEnv(env)
const ORIGIN = 'https://dossier.test'
const session = makeSession(TEST_SECRET, true)
const STATE_COOKIE = session.cookieName('auth-state')
const SESSION_COOKIE = session.cookieName('session')

const realFetch = globalThis.fetch
let issuedIdToken: string | null = null
let tokenRequests = 0

async function setUpShoo(claims: Record<string, unknown>): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', {
    extractable: true,
  })
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256' }
  issuedIdToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer('https://shoo.test')
    .setAudience(`origin:${ORIGIN}`)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)

  // Stand in for shoo: discovery, JWKS and the token endpoint. Everything else
  // in the sign-in path (PKCE, state, allowlist resolution) is the real code.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Response.json({ issuer: 'https://shoo.test' })
    }
    if (url.endsWith('/.well-known/jwks.json')) {
      return Response.json({ keys: [jwk] })
    }
    if (url.endsWith('/token')) {
      tokenRequests += 1
      return Response.json({ id_token: issuedIdToken })
    }
    return realFetch(input as RequestInfo, init)
  }) as typeof fetch
}

function readCookie(response: Response, name: string): string | null {
  const headers =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? '']
  for (const header of headers) {
    const [pair] = header.split(';')
    const equals = pair.indexOf('=')
    if (equals > 0 && pair.slice(0, equals).trim() === name) {
      return decodeURIComponent(pair.slice(equals + 1))
    }
  }
  return null
}

function cookieAttributes(response: Response, name: string): string | null {
  const headers =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? '']
  return headers.find((header) => header.startsWith(`${name}=`)) ?? null
}

async function seedAllowlist(options: {
  readonly suffix: string
  readonly kind: 'email' | 'domain'
  readonly value: string
  readonly role: 'admin' | 'member'
}): Promise<string> {
  const workspaceId = `workspace_${options.suffix}`
  const now = '2026-09-12T00:00:00.000Z'
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspaces (id, slug, kind, email_domain, name, created_at, updated_at)
       VALUES (?, ?, 'team', NULL, ?, ?, ?)`,
    ).bind(workspaceId, `ws-${options.suffix}`, options.suffix, now, now),
    env.DB.prepare(
      `INSERT INTO accounts (id, name, kind, deployment_admin, disabled_at, created_at, updated_at)
       VALUES (?, 'Seeder', 'service', 1, NULL, ?, ?)`,
    ).bind(`acct_seed_${options.suffix}`, now, now),
    env.DB.prepare(
      `INSERT INTO allowlist (id, kind, value, workspace_id, role, created_by, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(
      `allow_${options.suffix}`,
      options.kind,
      options.value,
      workspaceId,
      options.role,
      `acct_seed_${options.suffix}`,
      now,
    ),
  ])
  return workspaceId
}

/** Walks the real sign-in redirect and hands back the browser's state cookie. */
async function startSignIn(next = '/dashboard'): Promise<{
  readonly response: Response
  readonly cookie: string
  readonly state: string
  readonly authorize: URL
}> {
  const response = await handleAuthRequest(
    new Request(`${ORIGIN}/auth/sign-in?next=${encodeURIComponent(next)}`),
    environment,
  )
  const cookie = readCookie(response, STATE_COOKIE)
  if (cookie === null)
    throw new Error('sign-in did not set the auth state cookie')
  const payload = await Effect.runPromise(session.verifyToken(cookie))
  return {
    response,
    cookie,
    state: String(payload?.state),
    authorize: new URL(response.headers.get('location') ?? ''),
  }
}

beforeEach(() => {
  resetShooCaches()
  tokenRequests = 0
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('safeNextPath', () => {
  it('keeps same-site paths and refuses anything that could leave the site', () => {
    expect(safeNextPath('/cli/auth')).toBe('/cli/auth')
    expect(safeNextPath('/dashboard/documents/aaaaaaaaaaaa')).toBe(
      '/dashboard/documents/aaaaaaaaaaaa',
    )
    expect(safeNextPath('//evil.example/phish')).toBe('/dashboard')
    expect(safeNextPath('https://evil.example')).toBe('/dashboard')
    expect(safeNextPath('/\\evil.example')).toBe('/dashboard')
    for (const unsafe of [
      '/\t/evil.example/phish',
      '/\r/evil.example/phish',
      '/\n/evil.example/phish',
      '/\u0000/dashboard',
      '/\u007f/dashboard',
    ]) {
      expect(safeNextPath(unsafe, ORIGIN)).toBe('/dashboard')
    }
    expect(safeNextPath('/dashboard?tab=mine#latest', ORIGIN)).toBe(
      '/dashboard?tab=mine#latest',
    )
    expect(safeNextPath(null)).toBe('/dashboard')
  })
})

describe('GET /auth/sign-in', () => {
  it('redirects to shoo with PKCE and stores the matching state in a cookie', async () => {
    const { response, authorize, state, cookie } =
      await startSignIn('/cli/auth')

    expect(response.status).toBe(302)
    expect(authorize.origin).toBe('https://shoo.test')
    expect(authorize.pathname).toBe('/authorize')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `${ORIGIN}/auth/callback`,
    )
    // The state in the URL is the state in the cookie: that pairing is what
    // makes the callback unforgeable.
    expect(authorize.searchParams.get('state')).toBe(state)

    const payload = await Effect.runPromise(session.verifyToken(cookie))
    expect(payload?.purpose).toBe('auth-state')
    expect(payload?.next).toBe('/cli/auth')
    expect(typeof payload?.verifier).toBe('string')

    const attributes = cookieAttributes(response, STATE_COOKIE) ?? ''
    expect(attributes).toContain('HttpOnly')
    expect(attributes).toContain('SameSite=Lax')
    expect(attributes).toContain('Secure')
  })
})

describe('GET /auth/callback', () => {
  it('renders the consent page and clears the state cookie on access_denied', async () => {
    const { cookie } = await startSignIn()
    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/auth/callback?error=access_denied`, {
        headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(cookie)}` },
      }),
      environment,
    )

    expect(response.status).toBe(403)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('Sign-in was cancelled')
    expect(html).toContain('/auth/sign-in')
    expect(cookieAttributes(response, STATE_COOKIE)).toContain('Max-Age=0')
  })

  it('refuses a state that does not match the cookie', async () => {
    const { cookie } = await startSignIn()
    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/auth/callback?state=not-the-state&code=abc`, {
        headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(cookie)}` },
      }),
      environment,
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('That sign-in link expired')
    expect(tokenRequests).toBe(0)
  })

  it('refuses a callback with no state cookie at all', async () => {
    const { state } = await startSignIn()
    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/auth/callback?state=${state}&code=abc`),
      environment,
    )

    expect(response.status).toBe(400)
    expect(tokenRequests).toBe(0)
  })

  it('refuses an email with no allowlist entry and creates no account', async () => {
    await setUpShoo({
      pairwise_sub: 'sub-stranger',
      email: 'stranger@nowhere.example',
      email_verified: true,
      name: 'A Stranger',
    })
    const { cookie, state } = await startSignIn()

    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/auth/callback?state=${state}&code=live-code`, {
        headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(cookie)}` },
      }),
      environment,
    )

    expect(response.status).toBe(403)
    const html = await response.text()
    expect(html.toLowerCase()).toContain('this dossier is invite-only')
    expect(html).toContain('stranger@nowhere.example')
    expect(readCookie(response, SESSION_COOKIE)).toBeNull()

    const identity = await env.DB.prepare(
      `SELECT id FROM identities WHERE subject = ?`,
    )
      .bind('sub-stranger')
      .first<{ id: string }>()
    expect(identity).toBeNull()
  })

  it('refuses an unverified email even when the address is allowed', async () => {
    await seedAllowlist({
      suffix: 'unverified',
      kind: 'email',
      value: 'unverified@allowed.example',
      role: 'member',
    })
    await setUpShoo({
      pairwise_sub: 'sub-unverified',
      email: 'unverified@allowed.example',
      email_verified: false,
    })
    const { cookie, state } = await startSignIn()

    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/auth/callback?state=${state}&code=live-code`, {
        headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(cookie)}` },
      }),
      environment,
    )

    expect(response.status).toBe(403)
    expect(await response.text()).toContain('A verified email is required')
  })

  it('signs in an allowed domain, joins the workspace, and honours next', async () => {
    const workspaceId = await seedAllowlist({
      suffix: 'allowed',
      kind: 'domain',
      value: 'allowed.example',
      role: 'member',
    })
    await setUpShoo({
      pairwise_sub: 'sub-allowed',
      email: 'Rania@Allowed.Example',
      email_verified: true,
      name: 'Rania Haddad',
      picture: 'https://pictures.example/rania.png',
    })
    const { cookie, state } = await startSignIn('/cli/auth')

    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/auth/callback?state=${state}&code=live-code`, {
        headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(cookie)}` },
      }),
      environment,
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/cli/auth')
    expect(tokenRequests).toBe(1)
    expect(cookieAttributes(response, STATE_COOKIE)).toContain('Max-Age=0')

    const sessionCookie = readCookie(response, SESSION_COOKIE)
    expect(sessionCookie).not.toBeNull()
    const payload = await Effect.runPromise(session.verifyToken(sessionCookie!))
    expect(payload?.purpose).toBe('session')
    expect(payload?.workspaceId).toBe(workspaceId)
    expect(payload?.email).toBe('rania@allowed.example')

    const membership = await env.DB.prepare(
      `SELECT m.role, i.email
         FROM memberships m
         JOIN identities i ON i.account_id = m.account_id
        WHERE m.workspace_id = ? AND i.subject = ?`,
    )
      .bind(workspaceId, 'sub-allowed')
      .first<{ role: string; email: string }>()
    expect(membership?.role).toBe('member')
    // The normalised address is what the allowlist and invites are matched on.
    expect(membership?.email).toBe('rania@allowed.example')
  })

  it('refuses a disabled account', async () => {
    await seedAllowlist({
      suffix: 'disabled',
      kind: 'email',
      value: 'gone@allowed.example',
      role: 'member',
    })
    const now = '2026-09-12T00:00:00.000Z'
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO accounts (id, name, kind, deployment_admin, disabled_at, created_at, updated_at)
         VALUES ('acct_gone', 'Gone', 'user', 0, ?, ?, ?)`,
      ).bind(now, now, now),
      env.DB.prepare(
        `INSERT INTO identities
           (id, account_id, provider, subject, email, email_verified, display_name,
            picture_url, pii_subject, created_at, last_login_at)
         VALUES ('identity_gone', 'acct_gone', 'shoo', 'sub-gone', 'gone@allowed.example',
                 1, NULL, NULL, NULL, ?, ?)`,
      ).bind(now, now),
    ])
    await setUpShoo({
      pairwise_sub: 'sub-gone',
      email: 'gone@allowed.example',
      email_verified: true,
    })
    const { cookie, state } = await startSignIn()

    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/auth/callback?state=${state}&code=live-code`, {
        headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(cookie)}` },
      }),
      environment,
    )

    expect(response.status).toBe(403)
    expect(await response.text()).toContain('This account is disabled')
    expect(readCookie(response, SESSION_COOKIE)).toBeNull()
  })

  it('renders a retryable page when shoo cannot be reached', async () => {
    await setUpShoo({ pairwise_sub: 'sub-broken', email: 'x@y.example' })
    globalThis.fetch = (async () =>
      new Response('nope', { status: 503 })) as typeof fetch
    const { cookie, state } = await startSignIn()

    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/auth/callback?state=${state}&code=live-code`, {
        headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(cookie)}` },
      }),
      environment,
    )

    expect(response.status).toBe(502)
    expect(await response.text()).toContain('Sign-in could not be completed')
  })
})

describe('POST /auth/sign-out', () => {
  it('clears the session cookie for a same-origin post', async () => {
    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/auth/sign-out`, {
        method: 'POST',
        headers: { origin: ORIGIN },
      }),
      environment,
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
    expect(cookieAttributes(response, SESSION_COOKIE)).toContain('Max-Age=0')
  })

  it('refuses a cross-site post and leaves the session alone', async () => {
    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/auth/sign-out`, {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
      environment,
    )

    expect(response.status).toBe(403)
    expect(await response.text()).toContain('another site')
    expect(cookieAttributes(response, SESSION_COOKIE)).toBeNull()
  })

  it('never signs out on GET', async () => {
    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/auth/sign-out`),
      environment,
    )
    expect(response.status).toBe(302)
    expect(cookieAttributes(response, SESSION_COOKIE)).toBeNull()
  })
})

describe('unknown auth routes', () => {
  it('renders a 404 page', async () => {
    const response = await handleAuthRequest(
      new Request(`${ORIGIN}/auth/nope`),
      environment,
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('text/html')
  })
})
