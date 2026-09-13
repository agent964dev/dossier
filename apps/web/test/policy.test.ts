import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import worker from '../src/worker'

async function check(html: string): Promise<Response> {
  return worker.fetch(
    new Request('https://dossier.test/api/policy/check', {
      method: 'POST',
      headers: { 'content-type': 'text/html' },
      body: html,
    }) as Parameters<typeof worker.fetch>[0],
    env,
  )
}

describe('worker policy route', () => {
  it('runs the shared policy package inside workerd', async () => {
    const response = await check(
      '<!doctype html><html><head><title>workerd policy</title></head><body><p>safe</p></body></html>',
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      title: 'workerd policy',
      errors: [],
    })
  })

  it('uses the Worker allowlists for configurable destinations', async () => {
    const allowed = await check(
      '<!doctype html><html><head><title>styles</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2"></head><body></body></html>',
    )
    expect((await allowed.json()) as { ok: boolean }).toMatchObject({
      ok: true,
    })

    const blocked = await check(
      '<!doctype html><html><head><title>styles</title><link rel="stylesheet" href="https://blocked.example/theme.css"></head><body></body></html>',
    )
    expect((await blocked.json()) as { ok: boolean }).toMatchObject({
      ok: false,
    })
  })
})

const LIMITED_POLICY_ENV = {
  PUBLIC_BASE_URL: 'https://dossier.test',
  STYLE_HOST_ALLOWLIST: '',
  EMBED_HOST_ALLOWLIST: '',
  SCRIPT_HOST_ALLOWLIST: '',
  MAX_REQUEST_BYTES: '64',
  MAX_HTML_BYTES: '1048576',
} as unknown as Cloudflare.Env

describe('worker policy request limits', () => {
  it('rejects an oversized declared body before policy decoding', async () => {
    const body =
      '<title>This request body is deliberately larger than sixty-four bytes.</title>'
    const response = await worker.fetch(
      new Request('https://dossier.test/api/policy/check', {
        method: 'POST',
        headers: {
          'content-length': String(new TextEncoder().encode(body).byteLength),
          'content-type': 'text/html',
        },
        body,
      }) as Parameters<typeof worker.fetch>[0],
      LIMITED_POLICY_ENV,
    )

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      ok: false,
      code: 'body_too_large',
      message: 'Request body exceeds the 64 byte limit.',
    })
  })

  it('rejects a chunked body when accumulated bytes exceed the limit', async () => {
    const chunks = ['<!doctype html><title>', 'a'.repeat(48), '</title>'].map(
      (chunk) => new TextEncoder().encode(chunk),
    )
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    const response = await worker.fetch(
      new Request('https://dossier.test/api/policy/check', {
        method: 'POST',
        headers: { 'content-type': 'text/html' },
        body,
      }) as Parameters<typeof worker.fetch>[0],
      LIMITED_POLICY_ENV,
    )

    expect(response.status).toBe(413)
    expect((await response.json()) as { code: string }).toMatchObject({
      code: 'body_too_large',
    })
  })
})
