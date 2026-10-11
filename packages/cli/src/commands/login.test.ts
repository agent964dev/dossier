import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  errorResponse,
  type Harness,
  harness,
  person,
  type Route,
  stubFetch,
} from '../test-support.ts'

const ORIGIN = 'https://dossier.agent964.com'

const deviceCode = (n: number) => ({
  device_code: `device-${n}`,
  user_code: n === 1 ? 'WDJBMJHT' : 'QRSTUVWX',
  verification_uri: `${ORIGIN}/_/device`,
  verification_uri_complete: `${ORIGIN}/_/device?user_code=CODE${n}`,
  expires_in: 600,
  interval: 5,
})

/**
 * A deployment's device flow: each code request hands out the next code, and
 * each token poll takes the next answer from `polls`.
 */
const deviceRoute = (
  polls: readonly (Response | (() => Response))[],
  origin = ORIGIN,
): Route => {
  let codes = 0
  let poll = 0
  return (request) => {
    if (request.url.origin !== origin)
      return new Response(null, { status: 404 })
    if (request.url.pathname === '/_/auth/device/code') {
      codes += 1
      const code = deviceCode(codes)
      return Response.json({
        ...code,
        verification_uri: code.verification_uri.replace(ORIGIN, origin),
        verification_uri_complete: code.verification_uri_complete.replace(
          ORIGIN,
          origin,
        ),
      })
    }
    if (request.url.pathname === '/_/api/device/token') {
      const answer = polls[poll] ?? errorResponse('device_pending')
      poll += 1
      return typeof answer === 'function' ? answer() : answer
    }
    return new Response(null, { status: 404 })
  }
}

const minted = (name = 'cli on m4', deployment = 'dossier.agent964.com') =>
  Response.json({ key: 'dsk_secret_one', name, deployment, person })

let current: Harness | undefined
const setUp = async (route: Route, env?: Record<string, string>) => {
  const fetch = stubFetch(route)
  current = await harness({ fetch: fetch.fetch, env })
  return { cli: current, requests: fetch.requests }
}

afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

describe('dossier login', () => {
  it('prints the link and code, polls through pending and slow_down, and saves the key', async () => {
    const { cli, requests } = await setUp(
      deviceRoute([
        errorResponse('device_pending'),
        errorResponse('slow_down'),
        errorResponse('device_pending'),
        minted(),
      ]),
    )

    expect(await cli.run(['login'])).toBe(0)

    expect(cli.stdout()).toBe(
      `Open ${ORIGIN}/_/device?user_code=CODE1 and confirm the code WDJB-MJHT.\n` +
        'Signed in to dossier.agent964.com as sara@acme.com. ' +
        'The key "cli on m4" is saved.\n',
    )
    expect(cli.stderr()).toBe('')
    expect(cli.opened).toEqual([`${ORIGIN}/_/device?user_code=CODE1`])
    // Wait the interval before every poll, five seconds longer after slow_down.
    expect(cli.sleeps).toEqual([5000, 5000, 10000, 10000])

    const [codeRequest, ...polls] = requests
    expect(codeRequest?.method).toBe('POST')
    expect(codeRequest?.url.href).toBe(`${ORIGIN}/_/auth/device/code`)
    expect(codeRequest?.body).toEqual({
      client_id: 'dossier-cli',
      scope: 'agent-key',
      device_name: 'cli on m4',
    })
    expect(polls).toHaveLength(4)
    for (const poll of polls) {
      expect(poll.url.href).toBe(`${ORIGIN}/_/api/device/token`)
      expect(poll.body).toEqual({ deviceCode: 'device-1' })
      expect(poll.headers.get('Dossier-Protocol')).toBe('1')
    }
    for (const request of requests) {
      expect(request.headers.get('authorization')).toBeNull()
    }

    const file = await stat(cli.configPath)
    expect(file.mode & 0o777).toBe(0o600)
    const config: unknown = JSON.parse(await readFile(cli.configPath, 'utf8'))
    expect(config).toEqual({
      version: 1,
      default: 'dossier.agent964.com',
      deployments: {
        'dossier.agent964.com': {
          key: 'dsk_secret_one',
          keyName: 'cli on m4',
          person: 'sara@acme.com',
          savedAt: expect.any(String),
        },
      },
    })
    // Written to a temporary file and renamed; the lock is released.
    expect(await readdir(dirname(cli.configPath))).toEqual(['config.json'])
  })

  it('writes the config file only once it holds the lock', async () => {
    const { cli } = await setUp(deviceRoute([minted()]))
    const lock = `${cli.configPath}.lock`
    await mkdir(dirname(cli.configPath), { recursive: true })
    await writeFile(lock, 'another dossier process\n')

    const running = cli.run(['login'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(existsSync(cli.configPath)).toBe(false)

    await rm(lock)
    expect(await running).toBe(0)
    expect(existsSync(cli.configPath)).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })

  it('replaces the config file by renaming, keeping other deployments', async () => {
    const other = 'https://dossier.acme.com'
    let route: Route = deviceRoute([minted()])
    const { cli } = await setUp((request) => route(request))
    expect(await cli.run(['login'])).toBe(0)
    const before = await stat(cli.configPath)

    route = deviceRoute([minted('cli on m4', 'dossier.acme.com')], other)
    expect(await cli.run(['login', `${other}/acme/plans/q3`])).toBe(0)
    const after = await stat(cli.configPath)

    expect(after.ino).not.toBe(before.ino)
    expect(after.mode & 0o777).toBe(0o600)
    const config = JSON.parse(await readFile(cli.configPath, 'utf8'))
    expect(config.default).toBe('dossier.acme.com')
    expect(Object.keys(config.deployments).sort()).toEqual([
      'dossier.acme.com',
      'dossier.agent964.com',
    ])
    expect(cli.stdout()).toContain('Signed in to dossier.acme.com as')
  })

  it('starts the flow again once when the code expires', async () => {
    const { cli, requests } = await setUp(
      deviceRoute([errorResponse('device_expired'), minted()]),
    )

    expect(await cli.run(['login'])).toBe(0)

    expect(cli.stdout()).toBe(
      `Open ${ORIGIN}/_/device?user_code=CODE1 and confirm the code WDJB-MJHT.\n` +
        'The code expired. Here is a new one.\n' +
        `Open ${ORIGIN}/_/device?user_code=CODE2 and confirm the code QRST-UVWX.\n` +
        'Signed in to dossier.agent964.com as sara@acme.com. ' +
        'The key "cli on m4" is saved.\n',
    )
    const codeRequests = requests.filter(
      (request) => request.url.pathname === '/_/auth/device/code',
    )
    expect(codeRequests).toHaveLength(2)
    const polls = requests.filter(
      (request) => request.url.pathname === '/_/api/device/token',
    )
    expect(polls.map((poll) => poll.body)).toEqual([
      { deviceCode: 'device-1' },
      { deviceCode: 'device-2' },
    ])
  })

  it('fails with exit 4 when the second code expires too', async () => {
    const { cli } = await setUp(
      deviceRoute([
        errorResponse('device_expired'),
        errorResponse('device_expired'),
      ]),
    )

    expect(await cli.run(['login'])).toBe(4)
    expect(cli.stderr()).toContain('dossier: The sign-in code expired')
    expect(cli.stderr()).toContain('`dossier login`')
    expect(existsSync(cli.configPath)).toBe(false)
  })

  it('stops polling a code that outlives its expiry', async () => {
    // The deployment answers device_pending forever.
    const { cli, requests } = await setUp(deviceRoute([]))

    expect(await cli.run(['login'])).toBe(4)
    // 600 seconds at 5 seconds a poll, for each of the two codes.
    const polls = requests.filter(
      (request) => request.url.pathname === '/_/api/device/token',
    )
    expect(polls).toHaveLength(240)
    expect(cli.stderr()).toContain('dossier: The sign-in code expired')
  })

  it('fails with exit 4 when the person denies', async () => {
    const { cli } = await setUp(deviceRoute([errorResponse('access_denied')]))

    expect(await cli.run(['login', '--json'])).toBe(4)
    expect(JSON.parse(cli.stdout())).toEqual({
      error: {
        code: 4,
        message: 'Sign-in to dossier.agent964.com was denied.',
        fix: 'Run `dossier login` again and choose Allow.',
        path: null,
      },
    })
    expect(existsSync(cli.configPath)).toBe(false)
  })

  it('keeps stdout one JSON value under --json and never prints the key', async () => {
    const { cli } = await setUp(deviceRoute([minted()]))

    expect(await cli.run(['login', '--json'])).toBe(0)

    expect(JSON.parse(cli.stdout())).toEqual({
      deployment: 'dossier.agent964.com',
      person,
      key: { name: 'cli on m4' },
    })
    expect(cli.stdout()).not.toContain('dsk_')
    expect(cli.stderr()).toBe(
      `Open ${ORIGIN}/_/device?user_code=CODE1 and confirm the code WDJB-MJHT.\n`,
    )
  })

  it('signs in to a local deployment over http with its port', async () => {
    const local = 'http://localhost:8787'
    const { cli, requests } = await setUp(
      deviceRoute([minted('cli on m4', 'localhost:8787')], local),
    )

    expect(await cli.run(['login', local])).toBe(0)

    expect(requests.every((request) => request.url.origin === local)).toBe(true)
    const config = JSON.parse(await readFile(cli.configPath, 'utf8'))
    expect(config.default).toBe(local)
    expect(Object.keys(config.deployments)).toEqual(['localhost:8787'])
  })

  it('does not open a link on another host', async () => {
    const { cli } = await setUp((request) =>
      request.url.pathname === '/_/auth/device/code'
        ? Response.json({
            ...deviceCode(1),
            verification_uri_complete: 'https://elsewhere.example/device',
          })
        : minted(),
    )

    expect(await cli.run(['login'])).toBe(0)
    expect(cli.opened).toEqual([])
    expect(cli.stdout()).toContain('Open https://elsewhere.example/device')
  })
})
