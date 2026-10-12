import { afterEach, describe, expect, it } from 'vitest'

import {
  errorResponse,
  type Harness,
  harness,
  type Route,
  type SeenRequest,
  stubFetch,
} from '../test-support.ts'

const ENV = { DOSSIER_DEPLOYMENT: 'dossier.acme.com', DOSSIER_KEY: 'dsk_one' }
const AT = '2026-10-12T09:00:00.000Z'

const SARA = {
  target: { kind: 'email', email: 'sara@acme.com' },
  role: 'respond',
  on: 'questions',
  inherited: false,
  createdAt: AT,
}
const DESIGN = {
  target: { kind: 'team', team: 'Design' },
  role: 'read',
  on: '',
  inherited: true,
  createdAt: AT,
}
const WORKSPACE = {
  target: { kind: 'workspace' },
  role: 'write',
  on: 'plans',
  inherited: true,
  createdAt: AT,
}
const ANYONE = {
  target: { kind: 'anyone' },
  role: 'read',
  on: 'questions',
  inherited: false,
  createdAt: AT,
}

const QUESTIONS = 'https://dossier.acme.com/agent964/acme/questions/'

const answer = (over: Record<string, unknown> = {}) => ({
  path: 'questions',
  link: QUESTIONS,
  shares: [],
  publicReach: [],
  ...over,
})

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

describe('dossier share, listing', () => {
  it("lists a node's shares, inherited ones with the folder they sit on", async () => {
    const listing = answer({ shares: [SARA, DESIGN, WORKSPACE, ANYONE] })
    const cli = await setUp(() => Response.json(listing))

    expect(await cli.run(['share', 'agent964/acme/questions/'])).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'agent964/acme/questions/ is shared with:',
        '- sara@acme.com · respond',
        '- Team Design · read · from acme/',
        '- Everyone in agent964 · write · from acme/plans/',
        '- Anyone with the link · read',
        '',
      ].join('\n'),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('GET')
    expect(requests[0]?.url.pathname).toBe('/_/api/shares')
    expect(requests[0]?.url.searchParams.get('path')).toBe(
      'agent964/acme/questions/',
    )
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer dsk_one')

    expect(await cli.run(['share', 'agent964/acme/questions/', '--json'])).toBe(
      0,
    )
    expect(JSON.parse(cli.stdout())).toEqual(listing)
  })

  it('names a page by its link and says when nothing is shared', async () => {
    const cli = await setUp(() =>
      Response.json(
        answer({
          path: 'plan.html',
          link: 'https://dossier.acme.com/agent964/acme/plan',
        }),
      ),
    )

    expect(
      await cli.run(['share', 'https://dossier.acme.com/agent964/acme/plan']),
    ).toBe(0)
    expect(cli.stdout()).toBe('agent964/acme/plan is not shared with anyone.\n')
    expect(requests[0]?.url.searchParams.get('path')).toBe('agent964/acme/plan')
  })
})

describe('dossier share, setting', () => {
  it('gives a person a role and lists the shares that reach the node', async () => {
    const cli = await setUp(() =>
      Response.json(answer({ shares: [SARA, DESIGN] })),
    )

    expect(
      await cli.run([
        'share',
        'agent964/acme/questions/',
        'Sara@acme.com',
        'respond',
      ]),
    ).toBe(0)
    expect(cli.stderr()).toBe('')
    expect(cli.stdout()).toBe(
      [
        'agent964/acme/questions/ is shared with sara@acme.com (respond).',
        '- sara@acme.com · respond',
        '- Team Design · read · from acme/',
        '',
      ].join('\n'),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.url.pathname).toBe('/_/api/shares')
    expect(requests[0]?.body).toEqual({
      path: 'agent964/acme/questions/',
      target: { kind: 'email', email: 'sara@acme.com' },
      role: 'respond',
    })
  })

  it('says what goes public with an anyone share', async () => {
    const cli = await setUp(() =>
      Response.json(
        answer({
          shares: [ANYONE],
          publicReach: ['_layout.html', '_theme.css'],
        }),
      ),
    )

    expect(
      await cli.run(['share', 'agent964/acme/questions/', 'anyone', 'read']),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'agent964/acme/questions/ is shared with anyone with the link (read).',
        '- Anyone with the link · read',
        'Public with it: _layout.html, _theme.css (2 files above).',
        '',
      ].join('\n'),
    )
    expect(requests[0]?.body).toMatchObject({
      target: { kind: 'anyone' },
      role: 'read',
    })
  })

  it('counts one file above, and leaves the line out when nothing is above', async () => {
    const one = answer({
      shares: [{ ...ANYONE, role: 'respond' }],
      publicReach: ['_theme.css'],
    })
    let next: unknown = one
    const cli = await setUp(() => Response.json(next))

    expect(
      await cli.run(['share', 'agent964/acme/questions/', 'anyone', 'respond']),
    ).toBe(0)
    expect(cli.stdout()).toContain(
      'Public with it: _theme.css (1 file above).\n',
    )

    next = answer({ shares: [ANYONE] })
    expect(
      await cli.run(['share', 'agent964/acme/questions/', 'anyone', 'read']),
    ).toBe(0)
    expect(cli.stdout()).not.toContain('Public with it')
  })

  it('warns that anyone with write can publish pages there', async () => {
    const cli = await setUp(() =>
      Response.json(answer({ shares: [{ ...ANYONE, role: 'write' }] })),
    )

    expect(
      await cli.run(['share', 'agent964/acme/questions/', 'anyone', 'write']),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'agent964/acme/questions/ is shared with anyone with the link (write).',
        '- Anyone with the link · write',
        'Anyone with a Google account can now publish pages here.',
        '',
      ].join('\n'),
    )
  })

  it('shares with a team and the workspace, naming them in the sentence', async () => {
    const cli = await setUp(() =>
      Response.json(
        answer({ link: 'https://dossier.acme.com/agent964/acme/' }),
      ),
    )

    expect(
      await cli.run(['share', 'agent964/acme', 'team:Design', 'read']),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      'agent964/acme/ is shared with Team Design (read).\n',
    )
    expect(
      await cli.run(['share', 'agent964/acme', 'workspace', 'write']),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      'agent964/acme/ is shared with everyone in agent964 (write).\n',
    )
    expect(requests.map((request) => request.body)).toEqual([
      {
        path: 'agent964/acme',
        target: { kind: 'team', team: 'Design' },
        role: 'read',
      },
      { path: 'agent964/acme', target: { kind: 'workspace' }, role: 'write' },
    ])
  })

  it('prints the response with --json', async () => {
    const response = answer({ shares: [SARA], publicReach: [] })
    const cli = await setUp(() => Response.json(response))

    expect(
      await cli.run([
        'share',
        'agent964/acme/questions/',
        'sara@acme.com',
        'respond',
        '--json',
      ]),
    ).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual(response)
  })
})

describe('dossier share --remove', () => {
  it('takes a share away and lists what is left', async () => {
    const cli = await setUp(() => Response.json(answer({ shares: [DESIGN] })))

    expect(
      await cli.run([
        'share',
        'agent964/acme/questions/',
        'sara@acme.com',
        '--remove',
      ]),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'agent964/acme/questions/ is no longer shared with sara@acme.com.',
        'It is still shared with:',
        '- Team Design · read · from acme/',
        '',
      ].join('\n'),
    )
    expect(requests[0]?.body).toEqual({
      path: 'agent964/acme/questions/',
      target: { kind: 'email', email: 'sara@acme.com' },
      role: null,
    })
  })

  it('says when nothing is shared any more, and prints JSON with --json', async () => {
    const cli = await setUp(() => Response.json(answer()))

    expect(
      await cli.run([
        'share',
        'agent964/acme/questions/',
        'anyone',
        '--remove',
      ]),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      'agent964/acme/questions/ is no longer shared with anyone with the ' +
        'link.\nIt is not shared with anyone now.\n',
    )
    expect(
      await cli.run([
        'share',
        'agent964/acme/questions/',
        'anyone',
        '--remove',
        '--json',
      ]),
    ).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual(answer())
  })
})

describe('dossier share, refused', () => {
  it.each([
    ['forbidden', 3],
    ['not_found', 3],
    ['invalid', 6],
    ['conflict', 5],
    ['sign_in_required', 4],
  ] as const)('exits with the code of %s', async (code, exit) => {
    const cli = await setUp(() => errorResponse(code))

    expect(
      await cli.run([
        'share',
        'agent964/acme/questions/',
        'sara@acme.com',
        'read',
      ]),
    ).toBe(exit)
    expect(cli.stderr()).toContain(`dossier: The deployment says ${code}.\n`)
    expect(await cli.run(['share', 'agent964/acme/questions/', '--json'])).toBe(
      exit,
    )
    expect(JSON.parse(cli.stdout()).error.code).toBe(exit)
  })

  it('exits 3 on a node the caller cannot share, with the reason', async () => {
    const cli = await setUp(() =>
      errorResponse(
        'forbidden',
        'Only people with write on agent964/acme/questions/ can share it.',
        'Ask someone with write to share it.',
      ),
    )

    expect(
      await cli.run(['share', 'agent964/acme/questions/', 'anyone', 'read']),
    ).toBe(3)
    expect(cli.stderr()).toBe(
      'dossier: Only people with write on agent964/acme/questions/ can ' +
        'share it.\nAsk someone with write to share it.\n',
    )
  })

  it.each([
    [
      ['someone', 'read'],
      '"someone" is not a share target.',
      'Give an email such as sara@acme.com, team:<name>, workspace or ' +
        'anyone: dossier share <path> <target> <role>.',
    ],
    [
      ['team:', 'read'],
      '"team:" is not a share target.',
      'Give an email such as sara@acme.com, team:<name>, workspace or ' +
        'anyone: dossier share <path> <target> <role>.',
    ],
    [
      ['sara@acme.com', 'admin'],
      '"admin" is not a role.',
      'Give read, respond or write: dossier share <path> <target> <role>.',
    ],
    [
      ['sara@acme.com'],
      'Say which role sara@acme.com gets on agent964/acme/questions/.',
      'Add read, respond or write, such as dossier share ' +
        'agent964/acme/questions/ sara@acme.com respond, or --remove to ' +
        'take the share away.',
    ],
    [
      ['sara@acme.com', 'read', '--remove'],
      '--remove takes a target and no role.',
      'Run dossier share agent964/acme/questions/ sara@acme.com --remove.',
    ],
    [
      ['--remove'],
      '--remove needs the target whose share to take away.',
      'Give it as dossier share agent964/acme/questions/ <target> --remove, ' +
        'with an email such as sara@acme.com, team:<name>, workspace or ' +
        'anyone.',
    ],
  ])('exits 6 before any request for %j', async (rest, message, fix) => {
    const cli = await setUp(() => Response.json(answer()))

    expect(await cli.run(['share', 'agent964/acme/questions/', ...rest])).toBe(
      6,
    )
    expect(cli.stderr()).toBe(`dossier: ${message}\n${fix}\n`)
    expect(requests).toEqual([])

    expect(
      await cli.run(['share', 'agent964/acme/questions/', ...rest, '--json']),
    ).toBe(6)
    expect(JSON.parse(cli.stdout()).error).toEqual({
      code: 6,
      message,
      fix,
      path: null,
    })
    expect(requests).toEqual([])
  })

  it('exits 4 without an agent key', async () => {
    const cli = await setUp(() => Response.json(answer()), {})

    expect(await cli.run(['share', 'agent964/acme/questions/'])).toBe(4)
    expect(requests).toEqual([])
  })

  it('exits 2 for a path that is not a tree or a link', async () => {
    const cli = await setUp(() => Response.json(answer()))

    expect(await cli.run(['share', 'nope', 'anyone', 'read'])).toBe(2)
    expect(cli.stderr()).toContain('"nope" is not a tree or a link')
    expect(requests).toEqual([])
  })
})
