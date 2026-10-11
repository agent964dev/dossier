import { readFile } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { updateConfig } from '../config.ts'
import {
  errorResponse,
  type Harness,
  harness,
  person,
  type SeenRequest,
  stubFetch,
} from '../test-support.ts'

const OWNER = 'dossier.agent964.com'

/** A deployment that knows one key until it is revoked. */
const deploymentWithKey = (key: string) => {
  let revoked = false
  return (request: SeenRequest) => {
    if (request.headers.get('authorization') !== `Bearer ${key}` || revoked) {
      return errorResponse('sign_in_required', 'This agent key is not known.')
    }
    if (request.method === 'GET' && request.url.pathname === '/_/api/me') {
      return Response.json({
        person,
        deployment: request.url.host,
        key: { id: 'key_1', name: 'cli on m4' },
      })
    }
    if (
      request.method === 'DELETE' &&
      request.url.pathname === '/_/api/keys/current'
    ) {
      revoked = true
      return new Response(null, { status: 204 })
    }
    return errorResponse('not_found')
  }
}

const saveKey = (path: string, id: string, key: string) =>
  updateConfig(path, (config) => ({
    ...config,
    default: id,
    deployments: {
      ...config.deployments,
      [id]: {
        key,
        keyName: 'cli on m4',
        person: person.email,
        savedAt: '2026-10-11T00:00:00.000Z',
      },
    },
  }))

let current: Harness | undefined
afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

describe('dossier logout', () => {
  it('revokes the saved key and removes it from the config file', async () => {
    const fetch = stubFetch(deploymentWithKey('dsk_saved'))
    current = await harness({ fetch: fetch.fetch })
    await saveKey(current.configPath, OWNER, 'dsk_saved')
    await saveKey(current.configPath, 'dossier.acme.com', 'dsk_other')
    await updateConfig(current.configPath, (config) => ({
      ...config,
      default: OWNER,
    }))

    expect(await current.run(['logout'])).toBe(0)
    expect(current.stdout()).toBe(
      `Signed out of ${OWNER}. The key "cli on m4" is revoked.\n`,
    )
    const deletes = fetch.requests.filter(
      (request) => request.method === 'DELETE',
    )
    expect(deletes.map((request) => request.url.href)).toEqual([
      `https://${OWNER}/_/api/keys/current`,
    ])
    expect(deletes[0]?.headers.get('authorization')).toBe('Bearer dsk_saved')
    const config = JSON.parse(await readFile(current.configPath, 'utf8'))
    expect(Object.keys(config.deployments)).toEqual(['dossier.acme.com'])

    expect(await current.run(['whoami'])).toBe(4)
    expect(current.stderr()).toContain('`dossier login`')
  })

  it('revokes DOSSIER_KEY and leaves the config file alone', async () => {
    const fetch = stubFetch(deploymentWithKey('dsk_env'))
    current = await harness({
      fetch: fetch.fetch,
      env: { DOSSIER_DEPLOYMENT: 'dossier.acme.com', DOSSIER_KEY: 'dsk_env' },
    })

    expect(await current.run(['logout', '--json'])).toBe(0)
    expect(JSON.parse(current.stdout())).toEqual({
      deployment: 'dossier.acme.com',
      key: { name: 'cli on m4' },
      revoked: true,
      removedFromConfig: false,
    })

    // The revoked key is now refused, with a fix naming dossier login.
    expect(await current.run(['whoami'])).toBe(4)
    expect(current.stderr()).toBe(
      'dossier: This agent key is not known.\n' +
        'Run `dossier login dossier.acme.com` to sign in again.\n',
    )
  })

  it('removes a saved key the deployment has already revoked', async () => {
    const fetch = stubFetch(deploymentWithKey('dsk_current'))
    current = await harness({ fetch: fetch.fetch })
    await saveKey(current.configPath, OWNER, 'dsk_stale')

    expect(await current.run(['logout'])).toBe(0)
    expect(current.stdout()).toBe(
      `Signed out of ${OWNER}. The key "cli on m4" was already revoked ` +
        'and is removed from this machine.\n',
    )
    const config = JSON.parse(await readFile(current.configPath, 'utf8'))
    expect(config.deployments).toEqual({})
  })

  it('exits 4 when there is no key to revoke', async () => {
    const fetch = stubFetch(deploymentWithKey('dsk_any'))
    current = await harness({ fetch: fetch.fetch })

    expect(await current.run(['logout'])).toBe(4)
    expect(fetch.requests).toEqual([])
  })
})
