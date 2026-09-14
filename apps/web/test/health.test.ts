import { env as workerEnv } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from '../src/worker'
import { testEnv } from './core-helpers'

const env = testEnv(workerEnv)

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

  it('gates the state feature on the production limiter binding', async () => {
    const production = {
      ...env,
      PUBLIC_BASE_URL: 'https://dossier.agent964.com',
    } as Partial<Cloudflare.Env>
    delete production.STATE_RATE_LIMITER

    const unavailable = await worker.fetch(
      new Request('https://dossier.test/api/healthz') as Parameters<
        typeof worker.fetch
      >[0],
      production as Cloudflare.Env,
    )
    expect(await unavailable.json()).toMatchObject({ features: [] })

    const available = await worker.fetch(
      new Request('https://dossier.test/api/healthz') as Parameters<
        typeof worker.fetch
      >[0],
      {
        ...production,
        STATE_RATE_LIMITER: env.STATE_RATE_LIMITER,
      } as Cloudflare.Env,
    )
    expect(await available.json()).toMatchObject({ features: ['state'] })
  })
})
