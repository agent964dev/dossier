import { ErrorBody } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { UPGRADE_MESSAGE } from '../src/edge/legacy.ts'
import { ORIGIN } from './support/harness.ts'
import { keySecretFor } from './support/keys.ts'
import { person } from './support/trees.ts'

const CONTENT = 'k3v9q2m7x8c4w1z5h6t0.content.test'

const UPGRADE_BODY = {
  ok: false,
  code: 'not_found',
  message:
    'This deployment runs Dossier next. Update with `npm i -g @agent964/dossier`.',
}

const ask = (
  path: string,
  init: RequestInit & { host?: string } = {},
): Promise<Response> => {
  const { host, ...rest } = init
  const url = new URL(path, host === undefined ? ORIGIN : `https://${host}`)
  return SELF.fetch(url, { redirect: 'manual', ...rest })
}

/** Every legacy answer: never cached, never sniffed, never a cookie. */
const expectLegacyHeaders = (response: Response, what: string) => {
  expect(response.headers.get('cache-control'), what).toContain('no-store')
  expect(response.headers.get('x-content-type-options'), what).toBe('nosniff')
  expect(response.headers.getSetCookie(), what).toEqual([])
}

describe('CLI 0.2.x', () => {
  it('says the sentence the plan names, verbatim', () => {
    expect(UPGRADE_MESSAGE).toBe(UPGRADE_BODY.message)
  })

  it('answers its API and sign-in paths with the upgrade error in its own error shape', async () => {
    for (const [method, path] of [
      ['GET', '/api/me'],
      ['GET', '/api/healthz'],
      ['POST', '/api/documents'],
      ['GET', '/cli/auth'],
      ['GET', '/api'],
      ['GET', '/cli'],
    ] as const) {
      const what = `${method} ${path}`
      const response = await ask(path, {
        method,
        headers: {
          accept: 'application/json',
          authorization: 'Bearer ds_0123456789',
          ...(method === 'POST' ? { 'content-type': 'text/html' } : {}),
        },
        ...(method === 'POST' ? { body: '<p>a page</p>' } : {}),
      })
      expect(response.status, what).toBe(404)
      expect(response.statusText, what).toBe('Not Found')
      expect(response.headers.get('content-type'), what).toContain(
        'application/json',
      )
      expect(await response.json(), what).toEqual(UPGRADE_BODY)
      expectLegacyHeaders(response, what)
    }
  })

  it('answers a browser opening /cli/auth with the plain page and the same sentence', async () => {
    const response = await ask('/cli/auth?code=abc', {
      headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    })
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('This deployment runs Dossier next.')
    expect(html).toContain(
      'Update with <code>npm i -g @agent964/dossier</code>.',
    )
    // The plain error page's layout, with nothing loaded from elsewhere.
    expect(html).toContain('<meta name="color-scheme" content="dark">')
    expect(html).not.toMatch(/<(script|link)\b/)
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    )
    expectLegacyHeaders(response, 'GET /cli/auth as a browser')
  })

  it('answers an old key on any other path with 410 and the same body', async () => {
    for (const path of ['/d/2oiktv7ofs82/raw', '/agent964/acme/plan', '/']) {
      const response = await ask(path, {
        headers: { authorization: 'Bearer ds_x' },
      })
      expect(response.status, path).toBe(410)
      expect(response.statusText, path).toBe('Gone')
      expect(await response.json(), path).toEqual(UPGRADE_BODY)
      expectLegacyHeaders(response, path)
    }
  })

  it('leaves the same path to the link route without a key or with a new key', async () => {
    const path = '/d/2oiktv7ofs82/raw'
    const visitor = await ask(path)
    expect(visitor.status).toBe(302)
    expect(visitor.headers.get('location')).toBe(
      `/_/sign-in?next=${encodeURIComponent(path)}`,
    )

    const secret = await keySecretFor(await person())
    expect(secret.startsWith('dsk_')).toBe(true)
    const agent = await ask(path, {
      headers: { authorization: `Bearer ${secret}` },
    })
    expect(agent.status).toBe(404)
    const body = Schema.decodeUnknownSync(ErrorBody)(await agent.json())
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).not.toContain('Dossier next')
  })

  it('never takes Dossier’s own paths, even with an old key', async () => {
    const health = await ask('/_/api/health', {
      headers: { authorization: 'Bearer ds_x', accept: 'application/json' },
    })
    expect(health.status).not.toBe(404)
    expect(health.status).not.toBe(410)
    expect(await health.text()).not.toContain('Dossier next')

    const plain = await ask('/_/api/health')
    expect(plain.status).toBe(200)
    expect(await plain.json()).toMatchObject({ ok: true })
  })

  it('answers /api/me on a content host with the content host’s plain 404', async () => {
    const response = await ask('/api/me', {
      host: CONTENT,
      headers: { authorization: 'Bearer ds_x', accept: 'application/json' },
    })
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toBe('Not found.\n')
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it('answers the release check’s probe on a content host with a sandboxed 404', async () => {
    // What the release asks releasecheck.<content domain> after a deploy.
    const response = await ask('/_/api/health', { host: CONTENT })
    expect(response.status).toBe(404)
    expect(response.headers.get('content-security-policy')).toMatch(
      /^sandbox\b/,
    )
    expect(response.headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.getSetCookie()).toEqual([])
  })
})
