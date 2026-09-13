import { env as workerEnv } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'

import worker from '../src/worker'
import { seedPrincipal, testEnv } from './core-helpers'

const env = testEnv(workerEnv)

function base64(value: string | Uint8Array): string {
  const bytes =
    typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function apiRequest(
  path: string,
  token: string,
  options: {
    readonly method?: string
    readonly body?: unknown
    readonly environment?: Cloudflare.Env
  } = {},
): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${token}` })
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

async function publicRequest(path: string, method = 'GET'): Promise<Response> {
  return worker.fetch(
    new Request(`https://dossier.test${path}`, { method }) as Parameters<
      typeof worker.fetch
    >[0],
    env,
  )
}

async function push(
  token: string,
  slug: string,
  ext: 'css' | 'woff2',
  content: string | Uint8Array,
): Promise<Response> {
  return apiRequest('/api/assets', token, {
    body: { slug, ext, contentBase64: base64(content) },
  })
}

function expectSharedHeaders(response: Response): void {
  expect(response.headers.get('access-control-allow-origin')).toBe('*')
  expect(response.headers.get('cross-origin-resource-policy')).toBe(
    'cross-origin',
  )
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
}

describe('assets', () => {
  it('creates, lists, versions, and serves latest and pinned CSS unchanged', async () => {
    const principal = await seedPrincipal(env, { suffix: 'assets_versions' })
    const firstCss = ':root { color: #ff0000; }\n'
    const secondCss = ':root { color: #0000ff; }\n'

    const first = await push(
      principal.token,
      'versioned-theme',
      'css',
      firstCss,
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      slug: 'versioned-theme',
      ext: 'css',
      versionNumber: 1,
      url: 'https://dossier.test/a/versioned-theme.css',
      pinnedUrl: 'https://dossier.test/a/versioned-theme@1.css',
    })

    const second = await push(
      principal.token,
      'versioned-theme',
      'css',
      secondCss,
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({
      slug: 'versioned-theme',
      ext: 'css',
      versionNumber: 2,
      pinnedUrl: 'https://dossier.test/a/versioned-theme@2.css',
    })

    const listed = await apiRequest('/api/assets', principal.token)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({
      ok: true,
      assets: [
        {
          slug: 'versioned-theme',
          ext: 'css',
          latestVersionNumber: 2,
          url: 'https://dossier.test/a/versioned-theme.css',
          pinnedUrl: 'https://dossier.test/a/versioned-theme@2.css',
          updatedAt: expect.any(String),
        },
      ],
    })

    const latest = await publicRequest('/a/versioned-theme.css')
    expect(latest.status).toBe(200)
    expect(await latest.text()).toBe(secondCss)
    expect(latest.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(latest.headers.get('cache-control')).toBe('public, max-age=60')
    expectSharedHeaders(latest)

    const pinned = await publicRequest('/a/versioned-theme@1.css')
    expect(pinned.status).toBe(200)
    expect(await pinned.text()).toBe(firstCss)
    expect(pinned.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(pinned.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expectSharedHeaders(pinned)
  })

  it('reserves a slug to its first workspace forever', async () => {
    const owner = await seedPrincipal(env, { suffix: 'assets_slug_owner' })
    const other = await seedPrincipal(env, { suffix: 'assets_slug_other' })

    const created = await push(
      owner.token,
      'globally-reserved',
      'css',
      '.owner { color: green }',
    )
    expect(created.status).toBe(200)
    expect(
      (
        await apiRequest('/api/assets/globally-reserved', owner.token, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200)

    const rejected = await push(
      other.token,
      'globally-reserved',
      'css',
      '.other { color: red }',
    )
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({
      ok: false,
      code: 'slug_taken',
    })
  })

  it('soft-deletes latest and listing while retaining pinned versions', async () => {
    const principal = await seedPrincipal(env, { suffix: 'assets_delete' })
    const css = '.retained { display: block }\n'
    expect((await push(principal.token, 'delete-me', 'css', css)).status).toBe(
      200,
    )

    const deleted = await apiRequest('/api/assets/delete-me', principal.token, {
      method: 'DELETE',
    })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })

    const listed = await apiRequest('/api/assets', principal.token)
    expect(await listed.json()).toEqual({ ok: true, assets: [] })

    const latest = await publicRequest('/a/delete-me.css')
    expect(latest.status).toBe(404)
    expect(latest.headers.get('cache-control')).toBe('no-store')
    expectSharedHeaders(latest)

    const pinned = await publicRequest('/a/delete-me@1.css')
    expect(pinned.status).toBe(200)
    expect(await pinned.text()).toBe(css)
    expect(pinned.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
  })

  it('serves WOFF2 with CORS and supports HEAD', async () => {
    const principal = await seedPrincipal(env, { suffix: 'assets_woff2' })
    const font = Uint8Array.of(0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3, 4)
    expect(
      (await push(principal.token, 'test-font', 'woff2', font)).status,
    ).toBe(200)

    const latest = await publicRequest('/a/test-font.woff2')
    expect(latest.status).toBe(200)
    expect(new Uint8Array(await latest.arrayBuffer())).toEqual(font)
    expect(latest.headers.get('content-type')).toBe('font/woff2')
    expect(latest.headers.get('cache-control')).toBe('public, max-age=60')
    expectSharedHeaders(latest)

    const head = await publicRequest('/a/test-font@1.woff2', 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('font/woff2')
    expect(head.headers.get('content-length')).toBe(String(font.byteLength))
    expect(head.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect((await head.arrayBuffer()).byteLength).toBe(0)
    expectSharedHeaders(head)
  })

  it('rejects oversized CSS before policy validation', async () => {
    const principal = await seedPrincipal(env, { suffix: 'assets_size' })
    const limitedEnv = {
      ...env,
      MAX_ASSET_BYTES: '32',
    } as unknown as Cloudflare.Env
    const oversizedAndInvalidCss =
      '.leak { background: url("https://untrusted.example/pixel.png") }'

    const atobSpy = vi.spyOn(globalThis, 'atob')
    let rejected: Response
    let atobCalls: number
    try {
      rejected = await apiRequest('/api/assets', principal.token, {
        body: {
          slug: 'oversized-css',
          ext: 'css',
          contentBase64: base64(oversizedAndInvalidCss),
        },
        environment: limitedEnv,
      })
      atobCalls = atobSpy.mock.calls.length
    } finally {
      atobSpy.mockRestore()
    }

    expect(atobCalls).toBe(0)
    expect(rejected.status).toBe(413)
    expect(await rejected.json()).toMatchObject({
      ok: false,
      code: 'body_too_large',
    })
  })

  it('rejects invalid WOFF2 magic and CSS policy violations', async () => {
    const principal = await seedPrincipal(env, { suffix: 'assets_policy' })

    const invalidFont = await push(
      principal.token,
      'invalid-font',
      'woff2',
      Uint8Array.of(0, 1, 2, 3),
    )
    expect(invalidFont.status).toBe(422)
    expect(await invalidFont.json()).toMatchObject({
      ok: false,
      code: 'policy_rejected',
      details: { errors: expect.any(Array) },
    })

    const invalidCss = await push(
      principal.token,
      'invalid-css',
      'css',
      '.leak { background: url("https://untrusted.example/pixel.png") }',
    )
    expect(invalidCss.status).toBe(422)
    expect(await invalidCss.json()).toMatchObject({
      ok: false,
      code: 'policy_rejected',
      details: {
        errors: expect.arrayContaining([
          expect.stringContaining('CSS URL destination is not allowed.'),
        ]),
      },
    })
  })
})
