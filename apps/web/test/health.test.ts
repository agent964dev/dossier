import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from '../src/worker'

describe('worker health route', () => {
  it('serves healthz through the Worker fetch handler', async () => {
    const response = await worker.fetch(
      new Request('https://dossier.test/api/healthz') as Parameters<
        typeof worker.fetch
      >[0],
      env,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      ok: true,
      service: 'dossier',
      version: '0.0.0',
    })
  })
})
