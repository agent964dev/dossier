import { describe, expect, it } from 'vitest'

import { type CliConfig, emptyConfig } from './config.ts'
import {
  deploymentAddress,
  normalizeDeployment,
  resolveDeployment,
} from './deployment.ts'
import { CliProblem } from './render.ts'

const usageFailure = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    return error instanceof CliProblem ? error.exit : 'other'
  }
  return 'none'
}

describe('normalizeDeployment', () => {
  it.each([
    [
      'dossier.agent964.com',
      'dossier.agent964.com',
      'https://dossier.agent964.com',
    ],
    [
      'https://dossier.agent964.com',
      'dossier.agent964.com',
      'https://dossier.agent964.com',
    ],
    [
      'https://Dossier.Acme.com/',
      'dossier.acme.com',
      'https://dossier.acme.com',
    ],
    [
      'https://dossier.acme.com/acme/plans/q3?x=1#top',
      'dossier.acme.com',
      'https://dossier.acme.com',
    ],
    [
      'https://dossier.acme.com:8443/acme',
      'dossier.acme.com:8443',
      'https://dossier.acme.com:8443',
    ],
    ['localhost:8787', 'localhost:8787', 'https://localhost:8787'],
    [
      'http://localhost:8787/acme/plans',
      'localhost:8787',
      'http://localhost:8787',
    ],
    ['http://127.0.0.1:8787', '127.0.0.1:8787', 'http://127.0.0.1:8787'],
    [
      'http://dossier.localhost:5173',
      'dossier.localhost:5173',
      'http://dossier.localhost:5173',
    ],
    ['http://[::1]:8787', '[::1]:8787', 'http://[::1]:8787'],
  ])('reads %s as %s', (input, id, origin) => {
    const deployment = normalizeDeployment(input)
    expect(deployment.id).toBe(id)
    expect(deployment.origin.origin).toBe(origin)
  })

  it.each([
    [''],
    ['   '],
    ['not a host'],
    ['dossier'],
    ['http://dossier.acme.com'],
    ['ftp://dossier.acme.com'],
    ['file:///etc/passwd'],
    ['javascript:alert(1)'],
    ['https://sara:secret@dossier.acme.com'],
    ['https://sara@dossier.acme.com'],
    ['https://'],
  ])('refuses %j as a usage failure', (input) => {
    expect(usageFailure(() => normalizeDeployment(input))).toBe(2)
  })

  it('names a deployment so it reads back the same', () => {
    for (const input of ['dossier.acme.com', 'http://localhost:8787']) {
      const deployment = normalizeDeployment(input)
      const again = normalizeDeployment(deploymentAddress(deployment))
      expect(again.origin.origin).toBe(deployment.origin.origin)
    }
  })
})

const saved = (keys: Record<string, string>, defaultId: string | null) =>
  ({
    version: 1,
    default: defaultId,
    deployments: Object.fromEntries(
      Object.entries(keys).map(([id, key]) => [
        id,
        { key, keyName: 'cli on m4', person: 'sara@acme.com', savedAt: '' },
      ]),
    ),
  }) satisfies CliConfig

describe('resolveDeployment', () => {
  const config = saved(
    { 'a.example.com': 'dsk_a', 'b.example.com': 'dsk_b' },
    'a.example.com',
  )

  it('falls back to the owner deployment with nothing set', () => {
    const resolved = resolveDeployment({ env: {}, config: emptyConfig })
    expect(resolved.deployment.id).toBe('dossier.agent964.com')
    expect(resolved.key).toBeNull()
  })

  it('uses the deployment of the latest login and its saved key', () => {
    const resolved = resolveDeployment({ env: {}, config })
    expect(resolved.deployment.id).toBe('a.example.com')
    expect(resolved.key).toBe('dsk_a')
  })

  it('prefers DOSSIER_DEPLOYMENT over the latest login', () => {
    const resolved = resolveDeployment({
      env: { DOSSIER_DEPLOYMENT: 'b.example.com' },
      config,
    })
    expect(resolved).toMatchObject({
      deployment: { id: 'b.example.com' },
      key: 'dsk_b',
    })
  })

  it('prefers a link over DOSSIER_DEPLOYMENT', () => {
    const resolved = resolveDeployment({
      link: 'https://b.example.com/acme/plans/q3',
      env: { DOSSIER_DEPLOYMENT: 'a.example.com' },
      config,
    })
    expect(resolved.deployment.id).toBe('b.example.com')
    expect(resolved.key).toBe('dsk_b')
  })

  it('uses DOSSIER_KEY only for DOSSIER_DEPLOYMENT', () => {
    const env = { DOSSIER_DEPLOYMENT: 'c.example.com', DOSSIER_KEY: 'dsk_env' }
    expect(resolveDeployment({ env, config }).key).toBe('dsk_env')
    expect(
      resolveDeployment({ link: 'https://a.example.com/x', env, config }),
    ).toMatchObject({ deployment: { id: 'a.example.com' }, key: 'dsk_a' })
    expect(
      resolveDeployment({
        link: 'https://d.example.com/x',
        env,
        config,
      }).key,
    ).toBeNull()
  })

  it('never uses a saved key for another deployment', () => {
    const resolved = resolveDeployment({
      env: { DOSSIER_DEPLOYMENT: 'c.example.com' },
      config,
    })
    expect(resolved.key).toBeNull()
  })

  it('refuses DOSSIER_KEY without DOSSIER_DEPLOYMENT', () => {
    expect(
      usageFailure(() =>
        resolveDeployment({ env: { DOSSIER_KEY: 'dsk_env' }, config }),
      ),
    ).toBe(2)
  })
})
