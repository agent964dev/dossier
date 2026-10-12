import { createHash } from 'node:crypto'
import { cp, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ErrorCode } from '@dossier/contracts'
import { afterEach, describe, expect, it } from 'vitest'

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
  readonly blob?: (request: SeenRequest, attempt: number) => Response
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
