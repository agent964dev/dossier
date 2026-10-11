import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  errorResponse,
  type Harness,
  harness,
  person,
  type Route,
  type SeenRequest,
  stubFetch,
} from '../test-support.ts'

const meFor = (deployment: string, keyName = 'cli on m4') =>
  Response.json({
    person,
    deployment,
    key: { id: 'key_1', name: keyName },
  })

/** Answers `/_/api/me` for any deployment whose key it knows. */
const keyedMe =
  (keys: Record<string, string>): Route =>
  (request) => {
    const key = keys[request.url.host]
    if (request.url.pathname !== '/_/api/me') {
      return new Response(null, { status: 404 })
    }
    return request.headers.get('authorization') === `Bearer ${key}`
      ? meFor(request.url.host)
      : errorResponse('sign_in_required', 'This agent key is not known.')
  }

const savedConfig = (
  path: string,
  keys: Record<string, string>,
  defaultDeployment: string | null,
) =>
  mkdir(dirname(path), { recursive: true }).then(() =>
    writeFile(
      path,
      JSON.stringify({
        version: 1,
        default: defaultDeployment,
        deployments: Object.fromEntries(
          Object.entries(keys).map(([id, key]) => [
            id,
            {
              key,
              keyName: 'cli on m4',
              person: person.email,
              savedAt: '2026-10-11T00:00:00.000Z',
            },
          ]),
        ),
      }),
      { mode: 0o600 },
    ),
  )

let current: Harness | undefined
let requests: SeenRequest[] = []
const setUp = async (
  route: Route,
  env?: Record<string, string>,
  saved?: { keys: Record<string, string>; default: string | null },
) => {
  const fetch = stubFetch(route)
  requests = fetch.requests
  current = await harness({ fetch: fetch.fetch, env })
  if (saved) await savedConfig(current.configPath, saved.keys, saved.default)
  return current
}

afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

const KEYS = {
  'dossier.agent964.com': 'dsk_owner',
  'dossier.acme.com': 'dsk_acme',
}

describe('dossier whoami', () => {
  it('prints who the saved key acts as, in one plain line', async () => {
    const cli = await setUp(keyedMe(KEYS), undefined, {
      keys: KEYS,
      default: 'dossier.agent964.com',
    })

    expect(await cli.run(['whoami'])).toBe(0)
    expect(cli.stdout()).toBe(
      'sara@acme.com on dossier.agent964.com (key "cli on m4")\n',
    )
    expect(cli.stderr()).toBe('')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url.href).toBe('https://dossier.agent964.com/_/api/me')
    expect(requests[0]?.headers.get('Dossier-Protocol')).toBe('1')
    expect(requests[0]?.redirect).toBe('manual')
  })

  it.each([
    ['--json after the verb', ['whoami', '--json'], {}],
    ['--json before the verb', ['--json', 'whoami'], {}],
    ['DOSSIER_JSON=1', ['whoami'], { DOSSIER_JSON: '1' }],
  ])('prints the Me value with %s', async (_, argv, env) => {
    const cli = await setUp(keyedMe(KEYS), env, {
      keys: KEYS,
      default: 'dossier.agent964.com',
    })

    expect(await cli.run(argv)).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual({
      person,
      deployment: 'dossier.agent964.com',
      key: { id: 'key_1', name: 'cli on m4' },
    })
  })

  it('uses DOSSIER_KEY with DOSSIER_DEPLOYMENT', async () => {
    const cli = await setUp(keyedMe({ 'dossier.acme.com': 'dsk_env' }), {
      DOSSIER_DEPLOYMENT: 'dossier.acme.com',
      DOSSIER_KEY: 'dsk_env',
    })

    expect(await cli.run(['whoami'])).toBe(0)
    expect(cli.stdout()).toBe(
      'sara@acme.com on dossier.acme.com (key "cli on m4")\n',
    )
  })

  it.each([
    ['text', ['whoami'], {}],
    ['--json', ['whoami', '--json'], {}],
  ])(
    'exits 2 when DOSSIER_KEY comes without DOSSIER_DEPLOYMENT (%s)',
    async (mode, argv) => {
      const cli = await setUp(keyedMe(KEYS), { DOSSIER_KEY: 'dsk_env' })

      expect(await cli.run(argv)).toBe(2)
      expect(requests).toEqual([])
      if (mode === 'text') {
        expect(cli.stderr()).toContain(
          'dossier: DOSSIER_KEY is set without DOSSIER_DEPLOYMENT.',
        )
      } else {
        expect(JSON.parse(cli.stdout()).error.code).toBe(2)
      }
    },
  )

  it('exits 4 with a fix naming dossier login when not signed in', async () => {
    const cli = await setUp(keyedMe(KEYS))

    expect(await cli.run(['whoami'])).toBe(4)
    expect(cli.stdout()).toBe('')
    expect(cli.stderr()).toBe(
      'dossier: Not signed in to dossier.agent964.com.\n' +
        'Run `dossier login` to sign in.\n',
    )
    expect(requests).toEqual([])
  })

  it('exits 4 with a fix naming dossier login when the key is refused', async () => {
    const cli = await setUp(keyedMe({}), {
      DOSSIER_DEPLOYMENT: 'dossier.acme.com',
      DOSSIER_KEY: 'dsk_revoked',
    })

    expect(await cli.run(['whoami', '--json'])).toBe(4)
    expect(JSON.parse(cli.stdout())).toEqual({
      error: {
        code: 4,
        message: 'This agent key is not known.',
        fix: 'Run `dossier login dossier.acme.com` to sign in again.',
        path: null,
      },
    })
  })
})

describe('an agent key goes only to its own deployment', () => {
  const authorized = () =>
    requests.filter((request) => request.headers.get('authorization'))

  it('does not send a saved key to the deployment DOSSIER_DEPLOYMENT names', async () => {
    const cli = await setUp(
      keyedMe(KEYS),
      { DOSSIER_DEPLOYMENT: 'b.example.com' },
      {
        keys: { 'dossier.agent964.com': 'dsk_owner' },
        default: 'dossier.agent964.com',
      },
    )

    expect(await cli.run(['whoami'])).toBe(4)
    expect(cli.stderr()).toContain('Not signed in to b.example.com.')
    expect(authorized()).toEqual([])
  })

  it('sends the saved key of the deployment DOSSIER_DEPLOYMENT names', async () => {
    const cli = await setUp(
      keyedMe(KEYS),
      { DOSSIER_DEPLOYMENT: 'dossier.acme.com' },
      { keys: KEYS, default: 'dossier.agent964.com' },
    )

    expect(await cli.run(['whoami'])).toBe(0)
    expect(cli.stdout()).toContain('on dossier.acme.com')
    expect(
      authorized().map((request) => [
        request.url.host,
        request.headers.get('authorization'),
      ]),
    ).toEqual([['dossier.acme.com', 'Bearer dsk_acme']])
  })

  it('does not send DOSSIER_KEY to the deployment of a link', async () => {
    const cli = await setUp(() => Response.json({}, { status: 500 }), {
      DOSSIER_DEPLOYMENT: 'b.example.com',
      DOSSIER_KEY: 'dsk_for_b',
    })

    // login takes a link; its requests never carry any key.
    await cli.run(['login', 'https://a.example.com/acme/plans/q3'])
    expect(requests.length).toBeGreaterThan(0)
    expect(
      requests.every((request) => request.url.host === 'a.example.com'),
    ).toBe(true)
    expect(authorized()).toEqual([])
  })

  it('does not follow a redirect to another host', async () => {
    const cli = await setUp(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example/_/api/me' },
        }),
      undefined,
      { keys: KEYS, default: 'dossier.agent964.com' },
    )

    expect(await cli.run(['whoami'])).toBe(1)
    expect(cli.stderr()).toContain(
      'dossier.agent964.com answered with a redirect to ' +
        'https://elsewhere.example/_/api/me, which is not followed.',
    )
    expect(requests.map((request) => request.url.host)).toEqual([
      'dossier.agent964.com',
    ])
    expect(requests[0]?.redirect).toBe('manual')
  })
})
