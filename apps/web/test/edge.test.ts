import { ErrorBody } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { Effect, Schema } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { SignIn } from '../src/core/index.ts'
import { callerFor } from '../src/edge/caller.ts'
import { Browser, signedIn } from './support/browser.ts'
import { brokenDatabase } from './support/d1.ts'
import { harness, ORIGIN, testRuntime } from './support/harness.ts'
import { callerOf, fresh, run, runAs } from './support/people.ts'
import { CRASHING_SCREEN } from './support/screens.ts'
import { everything } from './support/keys.ts'

const CONTENT = 'k3v9q2m7x8c4w1z5h6t0.content.test'

const errorBody = async (response: Response) =>
  Schema.decodeUnknownSync(ErrorBody)(await response.json())

let person: Browser
let email: string

beforeAll(async () => {
  const identity = fresh()
  email = identity.email
  person = await signedIn(identity)
})

afterEach(() => harness.reset())

describe('hosts', () => {
  it('serves only frames and the base layer on a content host', async () => {
    for (const path of [
      '/',
      '/_/api/health',
      '/_/api/me',
      '/_/auth/get-session',
      '/_/app/fonts/Geist-Variable.woff2',
      '/_/settings',
      '/_serverFn/abc',
      '/agent964/acme/plan',
    ]) {
      const response = await person.fetch(path, { host: CONTENT })
      expect(response.status, path).toBe(404)
      expect(response.headers.get('content-type'), path).toContain('text/plain')
    }
  })

  it('never sets a cookie on a content host, even with a valid session', async () => {
    for (const path of [
      '/_/v/handle/1/agent964/acme/plan',
      '/_/base/test/client.js',
      '/',
    ]) {
      const response = await person.fetch(path, { host: CONTENT })
      expect(response.headers.getSetCookie(), path).toEqual([])
    }
  })

  it('answers frame paths only on content hosts, and nothing on other hosts', async () => {
    expect((await person.fetch('/_/v/handle/1/a/b/c')).status).toBe(404)
    expect(
      (await person.fetch('/_/v/handle/1/a/b/c', { host: CONTENT })).status,
    ).toBe(404)
    expect((await person.fetch('/', { host: 'example.com' })).status).toBe(404)
    expect(
      (await person.fetch('/', { host: 'abc-dev.content.test' })).status,
    ).toBe(404)
  })

  it('refuses service worker scripts on every host and path', async () => {
    const headers = { 'service-worker': 'script' }
    for (const [path, host] of [
      ['/', undefined],
      ['/_/base/test/client.js', undefined],
      ['/_/v/handle/1/a/b/sw.js', CONTENT],
      ['/_/base/test/client.js', CONTENT],
    ] as const) {
      const response = await person.fetch(path, { headers, host })
      expect(response.status, `${host ?? 'main'} ${path}`).toBe(403)
    }
  })
})

describe('the session cookie rules', () => {
  it('reads the cookie on API reads only from the same origin', async () => {
    const crossSite = await person.fetch('/_/api/me', {
      purpose: 'read',
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(crossSite.status).toBe(401)
    expect((await errorBody(crossSite)).error.code).toBe('sign_in_required')
    const noMetadata = await SELF.fetch(`${ORIGIN}/_/api/me`, {
      headers: { cookie: person.cookieHeader() },
    })
    expect(noMetadata.status).toBe(401)
    const sameOrigin = await person.fetch('/_/api/me', { purpose: 'read' })
    expect(sameOrigin.status).toBe(200)
    expect(
      ((await sameOrigin.json()) as { person: { email: string } }).person.email,
    ).toBe(email)
  })

  it('reads the cookie on writes only with the CSRF header and our Origin', async () => {
    const asks: { headers: Record<string, string>; expected: string }[] = [
      { headers: { 'dossier-csrf': '0' }, expected: 'visitor' },
      { headers: { origin: 'https://evil.example' }, expected: 'visitor' },
      { headers: { 'sec-fetch-site': 'same-site' }, expected: 'visitor' },
      { headers: {}, expected: email },
    ]
    for (const { headers, expected } of asks) {
      const response = await person.fetch('/_serverFn/screen', {
        method: 'POST',
        purpose: 'write',
        headers,
      })
      expect(await response.text(), JSON.stringify(headers)).toContain(
        `Signed in as ${expected}`,
      )
    }
    // The same rule decides callers on the API's write routes.
    const writer = (headers: Record<string, string>) =>
      run(
        callerFor(
          'api-write',
          new Request(`${ORIGIN}/_/api/anything`, {
            method: 'POST',
            headers: {
              cookie: person.cookieHeader(),
              'sec-fetch-site': 'same-origin',
              'dossier-csrf': '1',
              origin: ORIGIN,
              ...headers,
            },
          }),
          ORIGIN,
        ).pipe(Effect.map(({ caller }) => caller.person?.email ?? 'visitor')),
      )
    expect(await writer({})).toBe(email)
    expect(await writer({ 'dossier-csrf': '' })).toBe('visitor')
    expect(await writer({ origin: 'https://evil.example' })).toBe('visitor')
  })

  it('reads the cookie on screens only for navigations', async () => {
    const navigation = await person.fetch('/_/settings')
    expect(await navigation.text()).toContain(`Signed in as ${email}`)
    const subresource = await person.fetch('/_/settings', {
      purpose: 'read',
      headers: { 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site' },
    })
    expect(await subresource.text()).toContain('Signed in as visitor')
  })

  it('accepts an agent key as a bearer on the API', async () => {
    const { key } = await createKeyFor(person)
    const response = await SELF.fetch(`${ORIGIN}/_/api/me`, {
      headers: { authorization: `Bearer ${key}` },
    })
    expect(response.status).toBe(200)
    const me = (await response.json()) as {
      person: { email: string }
      key: { name: string }
    }
    expect(me.person.email).toBe(email)
    expect(me.key.name).toBe('edge')
    const unknown = await SELF.fetch(`${ORIGIN}/_/api/me`, {
      headers: { authorization: 'Bearer dsk_unknown' },
    })
    expect(unknown.status).toBe(401)
  })
})

describe('errors', () => {
  it('answers each code with its status and the one body', async () => {
    const notFound = await SELF.fetch(`${ORIGIN}/_/api/no-such-route`)
    expect(notFound.status).toBe(404)
    expect((await errorBody(notFound)).error.code).toBe('not_found')

    const signIn = await SELF.fetch(`${ORIGIN}/_/api/me`)
    expect(signIn.status).toBe(401)
    expect(await errorBody(signIn)).toMatchObject({
      error: {
        code: 'sign_in_required',
        fix: expect.stringContaining('dossier login'),
      },
    })

    const protocol = await SELF.fetch(`${ORIGIN}/_/api/health`, {
      headers: { 'dossier-protocol': '2' },
    })
    expect(protocol.status).toBe(426)
    expect((await errorBody(protocol)).error.code).toBe('protocol_mismatch')

    const invalid = await SELF.fetch(`${ORIGIN}/_/api/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nothing: true }),
    })
    expect(invalid.status).toBe(400)
    expect((await errorBody(invalid)).error.code).toBe('invalid')

    const legacy = await SELF.fetch(`${ORIGIN}/api/documents`)
    expect(legacy.status).toBe(404)
    expect((await errorBody(legacy)).error.code).toBe('not_found')
  })

  it('answers unavailable when D1 fails', async () => {
    harness.use(testRuntime({ env: { DB: brokenDatabase() } }))
    const health = await SELF.fetch(`${ORIGIN}/_/api/health`)
    expect(health.status).toBe(503)
    expect(await errorBody(health)).toEqual({
      error: {
        code: 'unavailable',
        message: 'Something went wrong. Try again.',
        fix: null,
        path: null,
      },
    })
  })

  it('answers a screen whose loader fails with unavailable with the plain error page', async () => {
    harness.use(testRuntime({ env: { DB: brokenDatabase() } }))
    const response = await SELF.fetch(`${ORIGIN}/`, {
      headers: { 'sec-fetch-mode': 'navigate' },
    })
    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('Something went wrong. Try again.')
  })

  it('puts Dossier-Protocol: 1 on every API response', async () => {
    const responses = [
      await SELF.fetch(`${ORIGIN}/_/api/health`),
      await SELF.fetch(`${ORIGIN}/_/api/me`),
      await SELF.fetch(`${ORIGIN}/_/api/nope`),
      await SELF.fetch(`${ORIGIN}/_/api/health`, {
        headers: { 'dossier-protocol': '9' },
      }),
      await SELF.fetch(`${ORIGIN}/_/api/device/token`, {
        method: 'POST',
        body: '{}',
      }),
    ]
    harness.use(testRuntime({ env: { DB: brokenDatabase() } }))
    responses.push(await SELF.fetch(`${ORIGIN}/_/api/health`))
    for (const response of responses) {
      expect(
        response.headers.get('dossier-protocol'),
        String(response.status),
      ).toBe('1')
    }
  })

  it('sends a visitor who opens a link to sign in', async () => {
    const response = await new Browser().fetch('/agent964/x')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      '/_/sign-in?next=%2Fagent964%2Fx',
    )
    const withQuery = await new Browser().fetch('/agent964/acme/plan?view=1')
    expect(withQuery.headers.get('location')).toBe(
      '/_/sign-in?next=%2Fagent964%2Facme%2Fplan%3Fview%3D1',
    )
  })

  it('answers health with the deployment and the build', async () => {
    const response = await SELF.fetch(`${ORIGIN}/_/api/health`)
    expect(await response.json()).toEqual({
      ok: true,
      service: 'dossier',
      version: 'test',
      protocol: 1,
      deployment: 'dossier.test',
      db: 'ok',
    })
  })
})

describe('the plain error page', () => {
  it('answers an unexpected failure on a screen without a stack trace', async () => {
    const response = await person.fetch(CRASHING_SCREEN)
    expect(response.status).toBe(503)
    const html = await response.text()
    expect(html).toContain('Something went wrong. Try again.')
    expect(html).toMatch(/<a [^>]*>Try again<\/a>/)
    expect(html).not.toContain('stack trace')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('answers a failure on a link with the plain page, and on the API with the unavailable body', async () => {
    harness.use(testRuntime({ env: { DB: brokenDatabase() } }))
    const link = await person.fetch('/agent964/acme/plan')
    expect(link.status).toBe(503)
    expect(await link.text()).toContain('Something went wrong. Try again.')
    const api = await person.fetch('/_/api/me', { purpose: 'read' })
    expect(api.status).toBe(503)
    expect((await errorBody(api)).error.code).toBe('unavailable')
  })
})

/** Creates an agent key named "edge" for the browser's person. */
async function createKeyFor(browser: Browser) {
  const caller = await callerOf(browser)
  const created = await runAs(
    caller,
    Effect.flatMap(SignIn, (signIn) =>
      signIn.createKey({ name: 'edge', ...everything }),
    ),
  )
  return { key: created.secret }
}
