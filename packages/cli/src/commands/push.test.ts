import { createHash } from 'node:crypto'
import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ErrorCode } from '@dossier/contracts'
import { Duration } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TRANSFER_TIMEOUT } from '../client.ts'
import {
  errorResponse,
  type Harness,
  harness,
  type Route,
  type SeenRequest,
  stubFetch,
} from '../test-support.ts'

const FIXTURE = fileURLToPath(
  new URL('../../test/fixtures/acme', import.meta.url),
)
const FIXTURE_FILES = [
  '_components/lazy.js',
  '_components/x.js',
  '_theme.css',
  'body.html',
  'clip.mp4',
  'complete.html',
  'links.html',
  'logo.svg',
  'module.html',
  'nested.html',
  'other.html',
  'plan.html',
  'plans/index.html',
  'plans/q3.html',
  'probe.html',
  'questions.html',
  'rich/all/_components/acme-note.js',
  'rich/all/_layout.html',
  'rich/all/index.html',
  'rich/all/note-text.js',
  'rich/all/photo.png',
  'rich/changes.patch',
  'rich/code.html',
  'rich/copy.html',
  'rich/dark.html',
  'rich/diff.html',
  'rich/math.html',
  'rich/mermaid.html',
  'rich/override/_components/dossier-copy.js',
  'rich/override/copy.html',
  'rich/plan.md',
  'rich/rtl.html',
  'rich/v1/plan.md',
  'storage.html',
  'sw.js',
  'video.html',
  'youtube.html',
]
const ENV = { DOSSIER_DEPLOYMENT: 'dossier.acme.com', DOSSIER_KEY: 'dsk_one' }
const TREE_ID = 'acmetree000000000001'
const LINK = 'https://dossier.acme.com/agent964/acme/'

const bytes = (path: string) => readFile(join(FIXTURE, path))
const sha = async (path: string) =>
  createHash('sha256')
    .update(await bytes(path))
    .digest('hex')

const plan = (over: Record<string, unknown> = {}) => ({
  createsTree: false,
  added: [],
  changed: [],
  deleted: [],
  unchanged: 0,
  ignored: [],
  warnings: [],
  ...over,
})

interface Deployment {
  readonly stage?: (request: SeenRequest) => Response
  readonly blob?: (
    request: SeenRequest,
    attempt: number,
  ) => Response | Promise<Response>
  readonly missing?: readonly string[]
  readonly plan?: ReturnType<typeof plan>
}

/** A deployment that stages, takes blobs and commits push 3. */
const pushing = (d: Deployment = {}): Route => {
  const tries = new Map<string, number>()
  return (request) => {
    const path = request.url.pathname
    if (request.method === 'POST' && path === '/_/api/pushes') {
      if (d.stage) return d.stage(request)
      return Response.json({
        pushId: 'psh_1',
        missing: d.missing ?? [],
        plan: d.plan ?? plan(),
        link: LINK,
        tree: null,
      })
    }
    if (request.method === 'PUT' && path.startsWith('/_/api/pushes/psh_1/')) {
      const attempt = (tries.get(path) ?? 0) + 1
      tries.set(path, attempt)
      return d.blob
        ? d.blob(request, attempt)
        : new Response(null, { status: 201 })
    }
    if (request.method === 'POST' && path === '/_/api/pushes/psh_1/commit') {
      return Response.json({
        number: 3,
        link: LINK,
        seq: 7,
        treeId: TREE_ID,
        plan: d.plan ?? plan(),
      })
    }
    return new Response(null, { status: 404 })
  }
}

let current: Harness | undefined
let requests: SeenRequest[] = []
const setUp = async (route: Route, env: Record<string, string> = ENV) => {
  const fetch = stubFetch(route)
  requests = fetch.requests
  current = await harness({ fetch: fetch.fetch, env })
  return current
}
afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

const sequence = () =>
  requests.map((request) => `${request.method} ${request.url.pathname}`)

describe('dossier push', () => {
  it('stages, uploads only the missing files, commits and prints each change', async () => {
    const missing = [await sha('plan.html'), await sha('logo.svg')]
    const cli = await setUp(
      pushing({
        missing,
        plan: plan({
          createsTree: true,
          added: ['plan.html', 'logo.svg'],
          changed: ['plans/q3.html'],
          deleted: ['old.html'],
          unchanged: 3,
          ignored: [{ path: 'answers/x.json', reason: 'data_path' }],
        }),
      }),
    )

    const exit = await cli.run([
      'push',
      FIXTURE,
      'agent964/acme',
      '-m',
      'First push',
    ])

    expect(cli.stderr()).toBe('')
    expect(exit).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'added    plan.html',
        'added    logo.svg',
        'changed  plans/q3.html',
        'deleted  old.html',
        'ignored  answers/x.json (a data file; pushes never change data)',
        `${LINK}  (push 3)`,
        '',
      ].join('\n'),
    )
    const puts = requests.filter((request) => request.method === 'PUT')
    expect(sequence()[0]).toBe('POST /_/api/pushes')
    expect(sequence().at(-1)).toBe('POST /_/api/pushes/psh_1/commit')
    expect(puts.map((request) => request.url.pathname).sort()).toEqual(
      missing.map((hash) => `/_/api/pushes/psh_1/blobs/${hash}`).sort(),
    )
    expect(requests).toHaveLength(4)

    const stage = requests[0]?.body as Record<string, unknown>
    expect(stage).toEqual({
      target: 'agent964/acme',
      baseSeq: null,
      baseTree: null,
      force: false,
      dryRun: false,
      message: 'First push',
      share: [],
      files: await Promise.all(
        FIXTURE_FILES.map(async (path) => ({
          path,
          sha256: await sha(path),
          size: (await bytes(path)).byteLength,
        })),
      ),
    })

    const logo = puts.find((request) =>
      request.url.pathname.endsWith(missing[1] ?? ''),
    )
    expect(logo?.body).toBe((await bytes('logo.svg')).toString('utf8'))
    expect(logo?.headers.get('content-type')).toBe('application/octet-stream')
    expect(logo?.headers.get('content-length')).toBe(
      String((await bytes('logo.svg')).byteLength),
    )
    for (const request of requests) {
      expect(request.url.host).toBe('dossier.acme.com')
      expect(request.headers.get('authorization')).toBe('Bearer dsk_one')
      expect(request.headers.get('Dossier-Protocol')).toBe('1')
      expect(request.redirect).toBe('manual')
    }
  })

  it('prints the JSON value with --json', async () => {
    const cli = await setUp(
      pushing({ plan: plan({ added: ['plan.html'], unchanged: 5 }) }),
    )

    expect(await cli.run(['push', FIXTURE, 'agent964/acme', '--json'])).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual({
      push: 3,
      link: LINK,
      added: ['plan.html'],
      changed: [],
      deleted: [],
      ignored: [],
      warnings: [],
      dryRun: false,
    })
  })

  it('sends the head this folder last pushed, and none from a copy of it', async () => {
    const cli = await setUp(pushing())
    expect(await cli.run(['push', FIXTURE, 'agent964/acme'])).toBe(0)
    expect(await cli.run(['push', FIXTURE, 'agent964/acme'])).toBe(0)
    const copy = join(cli.dir, 'copy')
    await cp(FIXTURE, copy, { recursive: true })
    expect(await cli.run(['push', copy, 'agent964/acme'])).toBe(0)
    expect(await cli.run(['push', FIXTURE, 'agent964/acme/plans'])).toBe(0)
    expect(await cli.run(['push', FIXTURE, 'agent964/acme', '--force'])).toBe(0)

    const stages = requests
      .filter((request) => request.url.pathname === '/_/api/pushes')
      .map((request) => {
        const body = request.body as Record<string, unknown>
        return [body.target, body.baseTree, body.baseSeq, body.force]
      })
    expect(stages).toEqual([
      ['agent964/acme', null, null, false],
      ['agent964/acme', TREE_ID, 7, false],
      ['agent964/acme', null, null, false],
      ['agent964/acme/plans', null, null, false],
      ['agent964/acme', null, null, true],
    ])
    const heads = JSON.parse(
      await readFile(join(dirname(cli.configPath), 'heads.json'), 'utf8'),
    )
    expect(heads.heads['dossier.acme.com']['agent964/acme']).toEqual({
      [await realpath(FIXTURE)]: { treeId: TREE_ID, seq: 7 },
      [await realpath(copy)]: { treeId: TREE_ID, seq: 7 },
    })
  })

  it('exits 5 on stale_head and uploads nothing', async () => {
    const cli = await setUp(
      pushing({
        stage: () =>
          errorResponse(
            'stale_head',
            'Someone pushed plans/q3.html to agent964/acme since this ' +
              'folder last pulled or pushed.',
            'Pull first, or push with --force to replace their changes.',
          ),
      }),
    )

    expect(await cli.run(['push', FIXTURE, 'agent964/acme'])).toBe(5)
    expect(cli.stderr()).toBe(
      'dossier: Someone pushed plans/q3.html to agent964/acme since this ' +
        'folder last pulled or pushed.\n' +
        'Pull first, or push with --force to replace their changes.\n',
    )
    expect(sequence()).toEqual(['POST /_/api/pushes'])
  })

  it.each([
    ['forbidden', 3],
    ['not_found', 3],
    ['policy_rejected', 6],
    ['rate_limited', 6],
    ['too_large', 6],
  ] as const)('exits with the code of %s', async (code, exit) => {
    const cli = await setUp(
      pushing({ stage: () => errorResponse(code as ErrorCode) }),
    )

    expect(await cli.run(['push', FIXTURE, 'agent964/acme', '--json'])).toBe(
      exit,
    )
    expect(JSON.parse(cli.stdout()).error.code).toBe(exit)
  })

  it('stages a dry run and never uploads or commits', async () => {
    const cli = await setUp(
      pushing({
        missing: [await sha('plan.html')],
        plan: plan({ added: ['plan.html'] }),
      }),
    )

    expect(await cli.run(['push', FIXTURE, 'agent964/acme', '--dry-run'])).toBe(
      0,
    )
    expect(cli.stdout()).toBe(
      `added    plan.html\nDry run: nothing was published. ${LINK}\n`,
    )
    expect(sequence()).toEqual(['POST /_/api/pushes'])
    expect(requests[0]?.body).toMatchObject({ dryRun: true })

    expect(
      await cli.run(['push', FIXTURE, 'agent964/acme', '--dry-run', '--json']),
    ).toBe(0)
    expect(JSON.parse(cli.stdout())).toMatchObject({ push: null, dryRun: true })
  })

  it('sends each --share in the stage payload and says whom the push shared with', async () => {
    const cli = await setUp(
      pushing({ plan: plan({ added: ['plan.html'], unchanged: 5 }) }),
    )

    const exit = await cli.run([
      'push',
      FIXTURE,
      'agent964/acme/questions',
      '--share',
      'Sara@Acme.com:respond',
      '--share',
      'team:Design:read',
      '--share',
      'anyone:read',
    ])

    expect(cli.stderr()).toBe('')
    expect(exit).toBe(0)
    expect(requests[0]?.body).toMatchObject({
      target: 'agent964/acme/questions',
      share: [
        { target: { kind: 'email', email: 'sara@acme.com' }, role: 'respond' },
        { target: { kind: 'team', team: 'Design' }, role: 'read' },
        { target: { kind: 'anyone' }, role: 'read' },
      ],
    })
    expect(cli.stdout()).toBe(
      [
        'added    plan.html',
        `${LINK}  (push 3)`,
        'Shared with sara@acme.com (respond).',
        'Shared with Team Design (read).',
        'Shared with anyone with the link (read).',
        '',
      ].join('\n'),
    )

    expect(
      await cli.run([
        'push',
        FIXTURE,
        'agent964/acme',
        '--share',
        'workspace:write',
        '--json',
      ]),
    ).toBe(0)
    expect(JSON.parse(cli.stdout())).toMatchObject({ push: 3, dryRun: false })
  })

  it('sends the shares with a dry run, so the deployment checks them, and shares nothing', async () => {
    const cli = await setUp(pushing({ plan: plan({ added: ['plan.html'] }) }))

    expect(
      await cli.run([
        'push',
        FIXTURE,
        'agent964/acme',
        '--dry-run',
        '--share',
        'anyone:write',
      ]),
    ).toBe(0)
    expect(sequence()).toEqual(['POST /_/api/pushes'])
    expect(requests[0]?.body).toMatchObject({
      dryRun: true,
      share: [{ target: { kind: 'anyone' }, role: 'write' }],
    })
    expect(cli.stdout()).toBe(
      `added    plan.html\nDry run: nothing was published. ${LINK}\n`,
    )
  })

  it('exits 6 when the deployment refuses a share', async () => {
    const cli = await setUp(
      pushing({
        stage: () =>
          errorResponse(
            'invalid',
            'Design is not a team in agent964.',
            'Check the team name in the workspace settings.',
          ),
      }),
    )

    expect(
      await cli.run([
        'push',
        FIXTURE,
        'agent964/acme',
        '--share',
        'team:Design:read',
      ]),
    ).toBe(6)
    expect(cli.stderr()).toBe(
      'dossier: Design is not a team in agent964.\n' +
        'Check the team name in the workspace settings.\n',
    )
    expect(sequence()).toEqual(['POST /_/api/pushes'])
  })

  it.each([
    ['sara@acme.com'],
    ['sara@acme.com:admin'],
    ['someone:read'],
    [':read'],
    ['team::read'],
  ])(
    'exits 6 for a --share that is not one, before any request: %s',
    async (spec) => {
      const cli = await setUp(pushing())

      expect(
        await cli.run([
          'push',
          FIXTURE,
          'agent964/acme',
          '--share',
          'anyone:read',
          '--share',
          spec,
        ]),
      ).toBe(6)
      expect(cli.stderr()).toBe(
        `dossier: --share ${spec} is not a share.\n` +
          'Give it as <target>:<role>, such as sara@acme.com:respond, ' +
          'team:Design:read, workspace:write or anyone:read.\n',
      )
      expect(requests).toEqual([])

      expect(
        await cli.run([
          'push',
          FIXTURE,
          'agent964/acme',
          '--share',
          spec,
          '--json',
        ]),
      ).toBe(6)
      expect(JSON.parse(cli.stdout()).error).toMatchObject({ code: 6 })
      expect(requests).toEqual([])
    },
  )

  it('prints No changes with the current push and records the head', async () => {
    const cli = await setUp(
      pushing({
        stage: () =>
          Response.json({
            pushId: null,
            missing: [],
            plan: plan({ unchanged: 6 }),
            link: LINK,
            tree: { id: TREE_ID, seq: 4, push: 2 },
          }),
      }),
    )

    expect(await cli.run(['push', FIXTURE, 'agent964/acme'])).toBe(0)
    expect(cli.stdout()).toBe(`No changes. ${LINK}  (push 2)\n`)
    expect(sequence()).toEqual(['POST /_/api/pushes'])
    expect(await cli.run(['push', FIXTURE, 'agent964/acme'])).toBe(0)
    expect(requests[1]?.body).toMatchObject({ baseTree: TREE_ID, baseSeq: 4 })
  })

  it('waits and uploads again while a purge holds a blob', async () => {
    const cli = await setUp(
      pushing({
        missing: [await sha('logo.svg')],
        blob: (_, attempt) =>
          attempt < 3
            ? errorResponse('blob_reclaiming')
            : new Response(null, { status: 201 }),
      }),
    )

    expect(await cli.run(['push', FIXTURE, 'agent964/acme'])).toBe(0)
    expect(cli.sleeps).toEqual([2_000, 4_000])
    expect(sequence().filter((line) => line.startsWith('PUT'))).toHaveLength(3)
  })

  it('uploads again after a network error, a 503 or a 429, waiting longer each time', async () => {
    const cli = await setUp(
      pushing({
        missing: [await sha('logo.svg')],
        blob: (_, attempt) => {
          if (attempt === 1) {
            throw new TypeError('fetch failed', {
              cause: new Error(
                'Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM',
              ),
            })
          }
          if (attempt === 2) return new Response('busy', { status: 503 })
          if (attempt === 3) {
            return new Response(null, {
              status: 429,
              headers: { 'retry-after': '7' },
            })
          }
          return new Response(null, { status: 201 })
        },
      }),
    )

    expect(await cli.run(['push', FIXTURE, 'agent964/acme'])).toBe(0)
    expect(cli.sleeps).toEqual([1_000, 2_000, 7_000])
    expect(sequence().filter((line) => line.startsWith('PUT'))).toHaveLength(4)
    expect(sequence().at(-1)).toBe('POST /_/api/pushes/psh_1/commit')
  })

  it('stops after 6 tries, naming the cause fetch hides, and commits nothing', async () => {
    const cli = await setUp(
      pushing({
        missing: [await sha('logo.svg')],
        blob: () => {
          throw new TypeError('fetch failed', {
            cause: new Error('other side closed'),
          })
        },
      }),
    )

    expect(await cli.run(['push', FIXTURE, 'agent964/acme'])).toBe(1)
    expect(cli.stderr()).toContain(
      'dossier: Could not reach dossier.acme.com after 6 tries: fetch failed: other side closed.',
    )
    expect(cli.sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    expect(sequence()).not.toContain('POST /_/api/pushes/psh_1/commit')
  })

  it('gives up on an error answer whose body stalls, within the transfer timeout, and cancels it', async () => {
    let cancelled = false
    const cli = await setUp(
      pushing({
        missing: [await sha('logo.svg')],
        blob: (request) =>
          new Response(
            new ReadableStream({
              start(controller) {
                request.signal?.addEventListener('abort', () => {
                  cancelled = true
                  controller.error(new Error('aborted'))
                })
              },
            }),
            { status: 400 },
          ),
      }),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const run = cli.run(['push', FIXTURE, 'agent964/acme'])
      // The upload is answered; then its body stalls past the timeout.
      while (!sequence().some((line) => line.startsWith('PUT'))) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      await vi.advanceTimersByTimeAsync(Duration.toMillis(TRANSFER_TIMEOUT))
      expect(await run).toBe(1)
      expect(cli.stderr()).toContain('did not answer within 5 minutes')
      expect(cancelled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['a 503', () => new Response('busy', { status: 503 })],
    ['a purge', () => errorResponse('blob_reclaiming')],
  ])(
    'stops the wait after %s when another upload fails',
    async (_, waiting) => {
      const logo = await sha('logo.svg')
      const signals: (AbortSignal | undefined)[] = []
      let waited = () => {}
      const waits = new Promise<void>((resolve) => {
        waited = resolve
      })
      const fetch = stubFetch(
        pushing({
          missing: [logo, await sha('plan.html')],
          // The other upload fails once the first is waiting.
          blob: (request) =>
            request.url.pathname.endsWith(logo)
              ? waiting()
              : waits.then(() => errorResponse('forbidden')),
        }),
      )
      requests = fetch.requests
      current = await harness({
        fetch: fetch.fetch,
        env: ENV,
        // A wait ends only when it is stopped.
        sleep: (_ms, signal) => {
          signals.push(signal)
          waited()
          return new Promise((resolve) =>
            signal?.addEventListener('abort', () => resolve()),
          )
        },
      })
      expect(await current.run(['push', FIXTURE, 'agent964/acme'])).toBe(3)
      expect(signals).not.toEqual([])
      expect(signals.every((signal) => signal?.aborted === true)).toBe(true)
    },
  )

  it('holds at most 4 uploads and 16 MiB in flight', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dossier-push-'))
    const sizes = [6, 6, 6, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1].map((mib) =>
      Math.round(mib * 1024 * 1024),
    )
    const hashes = await Promise.all(
      sizes.map(async (size, i) => {
        const content = Buffer.alloc(size, i)
        await writeFile(join(folder, `f${i}.bin`), content)
        return createHash('sha256').update(content).digest('hex')
      }),
    )
    const route = pushing({ missing: hashes })
    let count = 0
    let held = 0
    let most = { count: 0, held: 0 }
    const cli = await setUp(async (request) => {
      if (request.method !== 'PUT') return route(request)
      const size = Number(request.headers.get('content-length'))
      count += 1
      held += size
      most = {
        count: Math.max(most.count, count),
        held: Math.max(most.held, held),
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      count -= 1
      held -= size
      return route(request)
    })

    try {
      expect(await cli.run(['push', folder, 'agent964/acme'])).toBe(0)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
    expect(sequence().filter((line) => line.startsWith('PUT'))).toHaveLength(9)
    expect(most.count).toBe(4)
    expect(most.held).toBeLessThanOrEqual(16 * 1024 * 1024)
  })

  it('reads a link on the deployment as the target', async () => {
    const cli = await setUp(pushing())

    expect(
      await cli.run([
        'push',
        FIXTURE,
        'https://dossier.acme.com/agent964/acme/',
      ]),
    ).toBe(0)
    expect(requests[0]?.body).toMatchObject({ target: 'agent964/acme' })
  })

  it('never sends the key to the host of a link to another deployment', async () => {
    const cli = await setUp(pushing())

    expect(
      await cli.run([
        'push',
        FIXTURE,
        'https://elsewhere.example/agent964/acme',
      ]),
    ).toBe(4)
    expect(cli.stderr()).toContain('Not signed in to elsewhere.example.')
    expect(requests).toEqual([])
  })

  it.each([['nope'], ['agent964'], ['Agent964/acme']])(
    'exits 2 for a target that is not one: %s',
    async (input) => {
      const cli = await setUp(pushing())

      expect(await cli.run(['push', FIXTURE, input])).toBe(2)
      expect(cli.stderr()).toContain(`"${input}" is not a tree or a link`)
      expect(cli.stderr()).toContain('agent964/acme/plans')
      expect(requests).toEqual([])
    },
  )

  it('exits 2 when the folder is not one', async () => {
    const cli = await setUp(pushing())

    expect(await cli.run(['push', 'missing-folder', 'agent964/acme'])).toBe(2)
    expect(cli.stderr()).toContain('missing-folder is not a folder.')
    expect(requests).toEqual([])
  })

  it('exits 4 without an agent key', async () => {
    const cli = await setUp(pushing(), {})

    expect(await cli.run(['push', FIXTURE, 'agent964/acme'])).toBe(4)
    expect(requests).toEqual([])
  })
})
