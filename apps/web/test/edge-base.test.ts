import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

import { baseKey } from '../src/core/index.ts'
import { SANDBOX_TOKENS } from '../src/edge/respond.ts'
import { BASE_LAYOUT } from './support/base.ts'

const OLDER = '0123456789ab'
const TREE = 'abcdefghij0123456789'
const CONTENT = `https://${TREE}.content.test`
const MAIN = 'https://dossier.test'

const OLD_LAYOUT =
  '<!doctype html><html><head></head><body><slot></slot></body></html>\n'

beforeAll(async () => {
  await env.BLOBS.put(baseKey(OLDER, '_layout.html'), OLD_LAYOUT, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  })
  await env.BLOBS.put(baseKey(OLDER, '_components/my-élan.js'), '// élan\n', {
    httpMetadata: { contentType: 'text/javascript; charset=utf-8' },
  })
  // What a decoded separator must never reach.
  await env.BLOBS.put(baseKey(OLDER, 'a/b.js'), '// a/b\n', {
    httpMetadata: { contentType: 'text/javascript; charset=utf-8' },
  })
  await env.BLOBS.put(baseKey(OLDER, 'client.js'), '// an older client\n', {
    httpMetadata: { contentType: 'text/javascript; charset=utf-8' },
  })
})

const get = (url: string, init: RequestInit = {}) =>
  SELF.fetch(url, { redirect: 'manual', ...init })

/** The headers every base-layer file carries, whichever version. */
const expectBaseHeaders = (response: Response) => {
  const html = response.headers.get('content-type')?.includes('text/html')
  expect(response.headers.get('cache-control')).toBe(
    `public, max-age=31536000, immutable${html ? ', no-transform' : ''}`,
  )
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('content-security-policy')).toBe(
    `sandbox ${SANDBOX_TOKENS.join(' ')}`,
  )
  expect(response.headers.get('referrer-policy')).toBe(
    'strict-origin-when-cross-origin',
  )
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
  expect(response.headers.getSetCookie()).toEqual([])
}

describe('the base layer on a content host', () => {
  it('serves this build’s _layout.html from Static Assets', async () => {
    const response = await get(`${CONTENT}/_/base/test/_layout.html`)
    expect(response.status).toBe(200)
    expectBaseHeaders(response)
    expect(await response.text()).toBe(BASE_LAYOUT)
  })

  it('serves an older version’s files from R2 with the same headers', async () => {
    for (const origin of [CONTENT, MAIN]) {
      const response = await get(`${origin}/_/base/${OLDER}/_layout.html`)
      expect(response.status, origin).toBe(200)
      expectBaseHeaders(response)
      expect(response.headers.get('content-type')).toBe(
        'text/html; charset=utf-8',
      )
      expect(await response.text()).toBe(OLD_LAYOUT)
    }
    const script = await get(`${CONTENT}/_/base/${OLDER}/client.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    )
    expect(await script.text()).toBe('// an older client\n')
  })

  it('answers 404 for an unknown version or path', async () => {
    for (const path of [
      `/_/base/fedcba987654/_layout.html`,
      `/_/base/${OLDER}/shell.js`,
      `/_/base/${OLDER}/`,
      `/_/base/${OLDER}`,
      '/_/base/not-a-version/client.js',
      '/_/base/test/no-such-file.js',
    ]) {
      const response = await get(`${CONTENT}${path}`)
      expect(response.status, path).toBe(404)
    }
  })

  it('reads an older version’s percent-encoded names as the names they encode', async () => {
    const response = await get(
      `${CONTENT}/_/base/${OLDER}/_components/my-%C3%A9lan.js`,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('// élan\n')
    expect((await get(`${CONTENT}/_/base/${OLDER}/a/b.js`)).status).toBe(200)
  })

  it('answers 404 for a name that decodes to a separator, a dot segment or nothing valid', async () => {
    for (const path of [
      `/_/base/${OLDER}/a%2Fb.js`,
      `/_/base/${OLDER}/a%5Cb.js`,
      `/_/base/${OLDER}/%2E%2E%2Fclient.js`,
      `/_/base/${OLDER}/_components/%ZZ.js`,
      `/_/base/${OLDER}/_components/a%00.js`,
    ]) {
      const response = await get(`${CONTENT}${path}`)
      expect(response.status, path).toBe(404)
    }
  })

  it('refuses a service worker script for an older version too', async () => {
    const response = await get(`${CONTENT}/_/base/${OLDER}/client.js`, {
      headers: { 'service-worker': 'script' },
    })
    expect(response.status).toBe(403)
  })
})
