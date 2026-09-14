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
    const body = (await response.json()) as {
      ok: boolean
      service: string
      version: string
      features: string[]
    }
    expect(body.ok).toBe(true)
    expect(body.service).toBe('dossier')
    // Vite injects the git commit at build time; the test runner has no define.
    expect(body.version).toBe('unknown')
    expect(body.features).toEqual(['state'])
  })
})
