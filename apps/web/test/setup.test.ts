import { env as workerEnv } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import worker from '../src/worker'
import { testEnv } from './core-helpers'

const BOOTSTRAP_KEY = 'setup-test-bootstrap-key'
const env = {
  ...testEnv(workerEnv),
  SEED_WORKSPACE: 'setup-test:setup.test',
  SEED_ADMIN_EMAIL: 'owner@setup.test',
  BOOTSTRAP_API_KEY: BOOTSTRAP_KEY,
} as unknown as Cloudflare.Env

function setup(token?: string): Promise<Response> {
  const headers = new Headers()
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
  return worker.fetch(
    new Request('https://dossier.test/api/setup', {
      method: 'POST',
      headers,
    }) as Parameters<typeof worker.fetch>[0],
    env,
  )
}

async function seedCounts(): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT 'accounts' AS name, COUNT(*) AS count FROM accounts WHERE id = 'acct_bootstrap'
     UNION ALL
     SELECT 'workspaces', COUNT(*) FROM workspaces WHERE id = 'workspace_setup-test'
     UNION ALL
     SELECT 'allowlist', COUNT(*) FROM allowlist WHERE workspace_id = 'workspace_setup-test'
     UNION ALL
     SELECT 'api_keys', COUNT(*) FROM api_keys WHERE id = 'key_bootstrap'`,
  ).all<{ name: string; count: number }>()
  return Object.fromEntries(rows.results.map((row) => [row.name, row.count]))
}

describe('deployment setup endpoint', () => {
  it('requires the bootstrap Bearer key before seeding', async () => {
    const response = await setup()

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'unauthenticated',
    })
    expect(await seedCounts()).toEqual({
      accounts: 0,
      workspaces: 0,
      allowlist: 0,
      api_keys: 0,
    })
  })

  it('seeds once and is idempotent when rerun', async () => {
    const first = await setup(BOOTSTRAP_KEY)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({
      ok: true,
      workspaceId: 'workspace_setup-test',
      workspaceSlug: 'setup-test',
      bootstrapAccountId: 'acct_bootstrap',
      bootstrapApiKeyId: 'key_bootstrap',
    })
    expect(await seedCounts()).toEqual({
      accounts: 1,
      workspaces: 1,
      allowlist: 2,
      api_keys: 1,
    })

    const second = await setup(BOOTSTRAP_KEY)
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({
      ok: true,
      workspaceId: 'workspace_setup-test',
      bootstrapApiKeyId: 'key_bootstrap',
    })
    expect(await seedCounts()).toEqual({
      accounts: 1,
      workspaces: 1,
      allowlist: 2,
      api_keys: 1,
    })
  })
})
