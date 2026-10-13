import { EventEmitter } from 'node:events'

import {
  ERROR_CODES,
  ERRORS,
  type ErrorCode,
  exitCodeFor,
} from '@dossier/contracts'
import { afterEach, describe, expect, it } from 'vitest'

import { guide, guideMarkdown } from './guide.ts'
import { endOnClosedPipe } from './io.ts'
import {
  errorResponse,
  type Harness,
  harness,
  stubFetch,
} from './test-support.ts'

const ENV = { DOSSIER_DEPLOYMENT: 'dossier.acme.com', DOSSIER_KEY: 'dsk_one' }

let current: Harness | undefined
afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

const codesWithStatus = ERROR_CODES.filter(
  (code): code is ErrorCode => ERRORS[code].status !== null,
)

describe('failures', () => {
  it.each(codesWithStatus)(
    'answers %s with its exit code under --json',
    async (code) => {
      const fetch = stubFetch(() =>
        errorResponse(code, `The deployment says ${code}.`, null),
      )
      current = await harness({ fetch: fetch.fetch, env: ENV })

      const exit = await current.run(['whoami', '--json'])

      expect(exit).toBe(exitCodeFor(code))
      const body = JSON.parse(current.stdout())
      expect(Object.keys(body)).toEqual(['error'])
      expect(body.error).toMatchObject({
        code: exitCodeFor(code),
        message: `The deployment says ${code}.`,
        path: null,
      })
      expect(typeof body.error.code).toBe('number')
    },
  )

  it('writes the message and the fix to stderr in text mode', async () => {
    const fetch = stubFetch(() =>
      errorResponse('not_found', 'No such page.', 'Check the link.'),
    )
    current = await harness({ fetch: fetch.fetch, env: ENV })

    expect(await current.run(['whoami'])).toBe(3)
    expect(current.stdout()).toBe('')
    expect(current.stderr()).toBe('dossier: No such page.\nCheck the link.\n')
  })

  it('reads a 426 without a body as a protocol mismatch', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 426 }))
    current = await harness({ fetch: fetch.fetch, env: ENV })

    expect(await current.run(['whoami', '--json'])).toBe(1)
    expect(JSON.parse(current.stdout()).error.fix).toContain('dossier update')
  })

  it('exits 1 when the deployment cannot be reached', async () => {
    const fetch = stubFetch(() => {
      throw new TypeError('fetch failed')
    })
    current = await harness({ fetch: fetch.fetch, env: ENV })

    expect(await current.run(['whoami'])).toBe(1)
    expect(current.stderr()).toContain(
      'dossier: Could not reach dossier.acme.com: fetch failed.',
    )
  })

  it('names the cause fetch keeps behind "fetch failed"', async () => {
    const fetch = stubFetch(() => {
      throw new TypeError('fetch failed', {
        cause: new Error('other side closed'),
      })
    })
    current = await harness({ fetch: fetch.fetch, env: ENV })

    expect(await current.run(['whoami'])).toBe(1)
    expect(current.stderr()).toContain(
      'dossier: Could not reach dossier.acme.com: fetch failed: other side closed.',
    )
  })

  it('exits 1 when the answer is not what the contract says', async () => {
    const fetch = stubFetch(() => Response.json({ hello: 'world' }))
    current = await harness({ fetch: fetch.fetch, env: ENV })

    expect(await current.run(['whoami'])).toBe(1)
    expect(current.stderr()).toContain('does not understand')
  })

  it.each([
    [['nope']],
    [['whoami', '--bogus']],
    [['login', 'a.example.com', 'b.example.com']],
  ])('exits 2 for a command line that does not parse: %j', async (argv) => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }))
    current = await harness({ fetch: fetch.fetch })

    expect(await current.run([...argv, '--json'])).toBe(2)
    expect(JSON.parse(current.stdout()).error.code).toBe(2)
    expect(await current.run(argv)).toBe(2)
    expect(current.stdout()).toBe('')
    expect(current.stderr()).toContain('dossier --help')
    expect(fetch.requests).toEqual([])
  })

  it('exits 2 for a deployment that is not one', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }))
    current = await harness({ fetch: fetch.fetch })

    expect(await current.run(['login', 'ftp://dossier.acme.com'])).toBe(2)
    expect(await current.run(['login', 'https://me:pw@dossier.acme.com'])).toBe(
      2,
    )
    expect(fetch.requests).toEqual([])
  })
})

describe('the agent guide', () => {
  it('lists every verb with exit codes 0 to 6', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }))
    current = await harness({ fetch: fetch.fetch })

    expect(await current.run(['--agent-info'])).toBe(0)
    const markdown = current.stdout()
    for (const verb of [
      'login',
      'logout',
      'whoami',
      'update',
      'push',
      'pull',
      'share',
      'ls',
      'read',
      'export',
    ]) {
      expect(markdown).toContain(`### ${verb}\n`)
      expect(markdown).toContain(`dossier ${verb} `)
    }
    expect(markdown).toContain('dossier update [--check] [--json]')
    expect(markdown).toContain('dossier login [--json] [<deployment>]')
    expect(markdown).toContain(
      'dossier push [(-m, --message text)] [--dry-run] [--force] ' +
        '[--share text...] [--json] <dir> <target>',
    )
    expect(markdown).toContain('dossier pull [--json] <target> <dir>')
    expect(markdown).toContain('dossier ls [--json] <target>')
    expect(markdown).toContain(
      'dossier share [--remove] [--json] <path> [<target>] [<role>]',
    )
    expect(markdown).toContain('dossier watch [--next] [--json] <target>')
    expect(markdown).toContain(
      'dossier export [(-o, --output text)] [--json] <link>',
    )
    for (const [code, meaning] of [
      [0, 'success'],
      [1, 'failure'],
      [2, 'usage'],
      [3, 'not found or no access'],
      [4, 'not signed in or key refused'],
      [5, 'conflict'],
      [6, 'refused by a rule or a limit'],
    ] as const) {
      expect(markdown).toContain(`| ${code} | ${meaning} |`)
    }
  })

  it('gives the same data with --json', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }))
    current = await harness({ fetch: fetch.fetch })

    expect(await current.run(['--agent-info', '--json'])).toBe(0)
    const data = JSON.parse(current.stdout())
    expect(data).toEqual(guide())
    expect(data.verbs.map((verb: { name: string }) => verb.name)).toEqual([
      'login',
      'logout',
      'whoami',
      'update',
      'push',
      'pull',
      'rm',
      'mv',
      'share',
      'ls',
      'read',
      'export',
      'search',
      'watch',
      'log',
      'diff',
      'restore',
    ])
    expect(Object.keys(data.exitCodes)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ])

    expect(await current.run(['--agent-info'])).toBe(0)
    const markdown = current.stdout()
    expect(markdown).toBe(`${guideMarkdown(data)}`)
    for (const verb of data.verbs) {
      expect(markdown).toContain(verb.usage)
      expect(markdown).toContain(verb.summary)
      for (const flag of verb.flags) expect(markdown).toContain(`\`${flag}\``)
    }
  })

  it('reads each verb from its declaration', () => {
    const update = guide().verbs.find((verb) => verb.name === 'update')
    expect(update).toEqual({
      name: 'update',
      usage: 'dossier update [--check] [--json]',
      flags: ['--check', '--json'],
      summary:
        'Update the dossier CLI to the latest npm release, or check with --check.',
    })
  })
})

describe('the frame', () => {
  it('prints the version', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }))
    current = await harness({ fetch: fetch.fetch })

    expect(await current.run(['--version'])).toBe(0)
    expect(current.stdout()).toBe('1.0.1\n')
  })

  it('ends quietly with 141 when the reader of its output goes away', () => {
    const stream = new EventEmitter()
    const exits: number[] = []
    endOnClosedPipe(stream, (code) => exits.push(code))

    stream.emit(
      'error',
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    )
    expect(exits).toEqual([141])
    expect(() =>
      stream.emit('error', Object.assign(new Error('nope'), { code: 'EIO' })),
    ).toThrow('nope')
  })

  it('prints help for no verb and for --help', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }))
    current = await harness({ fetch: fetch.fetch })

    expect(await current.run([])).toBe(0)
    expect(current.stdout()).toContain('COMMANDS')
    expect(await current.run(['--help'])).toBe(0)
    expect(current.stdout()).toContain('--agent-info')
    expect(await current.run(['whoami', '--help'])).toBe(0)
    expect(current.stdout()).toContain('--json')
  })
})
