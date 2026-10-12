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
const ORIGIN = 'https://dossier.acme.com'
/** This year, so lines from it print without one. */
const YEAR = new Date().getUTCFullYear()
const at = (monthDayTime: string, year = YEAR) =>
  `${year}-${monthDayTime}:00.000Z`

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

/** Answers by the API path asked for; anything else is a 404. */
const routes =
  (table: Record<string, () => Response>): Route =>
  (request) => {
    const answer = table[request.url.pathname.replace(/^\/_\/api/, '')]
    return answer === undefined ? errorResponse('not_found') : answer()
  }

const line = (over: Record<string, unknown>) => ({
  kind: 'push',
  seq: 40,
  at: at('10-10T14:02'),
  by: 'owner@agent964.com',
  path: 'questions',
  push: null,
  to: null,
  restorable: false,
  ...over,
})

const PUSH_12 = line({
  seq: 40,
  path: 'plan.html',
  push: { number: 12, message: 'First questions', files: 3 },
})
const DELETED = line({
  kind: 'delete',
  seq: 44,
  at: at('10-11T09:30'),
  by: 'lina@acme.com',
  path: 'plan.html',
  restorable: true,
})

const logOf = (over: Record<string, unknown> = {}) => ({
  path: 'plan.html',
  lines: [DELETED, PUSH_12],
  next: null,
  retentionDays: 30,
  ...over,
})

const change = (over: Record<string, unknown> = {}) => ({
  path: 'plan.html',
  link: `${ORIGIN}/agent964/acme/plan`,
  seq: 44,
  changed: ['plan.html'],
  ...over,
})

describe('dossier rm', () => {
  it('deletes a file and prints the command that restores it', async () => {
    const cli = await setUp(
      routes({
        '/rm': () => Response.json(change()),
        '/log': () => Response.json(logOf()),
      }),
    )

    expect(await cli.run(['rm', 'agent964/acme/plan.html'])).toBe(0)
    expect(cli.stderr()).toBe('')
    expect(cli.stdout()).toBe(
      'Deleted agent964/acme/plan.html. Restore it with `dossier restore ' +
        `agent964/acme/plan.html --to ${YEAR}-10-11T09:29:59.999Z\` within 30 days.\n`,
    )
    expect(requests.map((r) => [r.method, r.url.pathname])).toEqual([
      ['POST', '/_/api/rm'],
      ['GET', '/_/api/log'],
    ])
    expect(requests[0]?.body).toEqual({ path: 'agent964/acme/plan.html' })
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer dsk_one')
    expect(requests[1]?.url.searchParams.get('path')).toBe(
      'agent964/acme/plan.html',
    )
  })

  it('names the file the deployment deleted, and a folder with its slash', async () => {
    let answer = change()
    let history: unknown = logOf({ retentionDays: 1 })
    const cli = await setUp(
      routes({
        '/rm': () => Response.json(answer),
        '/log': () => Response.json(history),
      }),
    )

    expect(await cli.run(['rm', `${ORIGIN}/agent964/acme/plan`])).toBe(0)
    expect(requests[0]?.body).toEqual({ path: 'agent964/acme/plan' })
    expect(cli.stdout()).toBe(
      'Deleted agent964/acme/plan.html. Restore it with `dossier restore ' +
        `agent964/acme/plan.html --to ${YEAR}-10-11T09:29:59.999Z\` within 1 day.\n`,
    )

    answer = change({ path: 'questions', changed: ['questions/a.html'] })
    history = logOf({ path: 'questions', lines: [PUSH_12] })
    expect(await cli.run(['rm', 'agent964/acme/questions/'])).toBe(0)
    expect(cli.stdout()).toBe(
      'Deleted agent964/acme/questions/. Restore it from history within ' +
        '30 days.\n',
    )
    expect(requests.at(-1)?.url.searchParams.get('path')).toBe(
      'agent964/acme/questions/',
    )
  })

  it('still reports the deletion when its history cannot be read', async () => {
    const cli = await setUp(
      routes({
        '/rm': () => Response.json(change()),
        '/log': () => errorResponse('forbidden'),
      }),
    )

    expect(await cli.run(['rm', 'agent964/acme/plan.html'])).toBe(0)
    expect(cli.stdout()).toBe(
      'Deleted agent964/acme/plan.html. Restore it from history within the ' +
        'retention period.\n',
    )
  })

  it('prints the change with --json, and reads no history for it', async () => {
    const cli = await setUp(
      routes({
        '/rm': () => Response.json(change()),
        '/log': () => Response.json(logOf()),
      }),
    )

    expect(await cli.run(['rm', 'agent964/acme/plan.html', '--json'])).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual(change())
    expect(requests).toHaveLength(1)
  })
})

const moved = (over: Record<string, unknown> = {}) => ({
  from: 'agent964/acme/plan.html',
  to: 'agent964/acme/plans/plan.html',
  link: `${ORIGIN}/agent964/acme/plans/plan`,
  seq: 45,
  rewritten: ['index.html', 'questions/index.html', 'notes.html'],
  revokedTeamShares: [],
  ...over,
})

describe('dossier mv', () => {
  it('moves a file and says how many files had their links updated', async () => {
    const cli = await setUp(routes({ '/mv': () => Response.json(moved()) }))

    expect(
      await cli.run([
        'mv',
        'agent964/acme/plan.html',
        'agent964/acme/plans/plan.html',
      ]),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'Moved agent964/acme/plan.html to agent964/acme/plans/plan.html. ' +
          'Updated links in 3 files.',
        `${ORIGIN}/agent964/acme/plans/plan`,
        '',
      ].join('\n'),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.url.pathname).toBe('/_/api/mv')
    expect(requests[0]?.body).toEqual({
      from: 'agent964/acme/plan.html',
      to: 'agent964/acme/plans/plan.html',
    })
  })

  it('counts one file, and says nothing of links when none changed', async () => {
    let answer = moved({ rewritten: ['index.html'] })
    const cli = await setUp(routes({ '/mv': () => Response.json(answer) }))

    expect(
      await cli.run([
        'mv',
        `${ORIGIN}/agent964/acme/plan`,
        `${ORIGIN}/agent964/acme/plans/plan`,
      ]),
    ).toBe(0)
    expect(cli.stdout().split('\n')[0]).toBe(
      'Moved agent964/acme/plan.html to agent964/acme/plans/plan.html. ' +
        'Updated links in 1 file.',
    )
    expect(requests[0]?.body).toEqual({
      from: 'agent964/acme/plan',
      to: 'agent964/acme/plans/plan',
    })

    answer = moved({ rewritten: [] })
    expect(
      await cli.run([
        'mv',
        'agent964/acme/plan.html',
        'agent964/acme/plans/plan.html',
      ]),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      'Moved agent964/acme/plan.html to agent964/acme/plans/plan.html.\n' +
        `${ORIGIN}/agent964/acme/plans/plan\n`,
    )
  })

  it('moves a tree to another workspace and names each team share it ends', async () => {
    const answer = moved({
      from: 'agent964/acme',
      to: 'studio/acme',
      link: `${ORIGIN}/studio/acme/`,
      rewritten: [],
      revokedTeamShares: ['Design', 'team:Research'],
    })
    const cli = await setUp(routes({ '/mv': () => Response.json(answer) }))

    expect(await cli.run(['mv', 'agent964/acme', 'studio/acme'])).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'Moved agent964/acme to studio/acme.',
        `${ORIGIN}/studio/acme/`,
        'Team Design no longer reaches it: teams belong to the workspace it ' +
          'left.',
        'Team Research no longer reaches it: teams belong to the workspace ' +
          'it left.',
        '',
      ].join('\n'),
    )
    expect(requests[0]?.body).toEqual({
      from: 'agent964/acme',
      to: 'studio/acme',
    })

    expect(
      await cli.run(['mv', 'agent964/acme', 'studio/acme', '--json']),
    ).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual(answer)
  })

  it('exits 2 before any request for a new path that is not one', async () => {
    const cli = await setUp(routes({ '/mv': () => Response.json(moved()) }))

    expect(
      await cli.run([
        'mv',
        'agent964/acme/plan.html',
        'https://elsewhere.example/agent964/acme/plan',
      ]),
    ).toBe(2)
    expect(cli.stderr()).toContain(
      '"https://elsewhere.example/agent964/acme/plan" is not a path on ' +
        'dossier.acme.com.',
    )
    expect(requests).toEqual([])
  })
})

describe('dossier log', () => {
  const EVERY_KIND = [
    line({
      kind: 'withdrawal',
      seq: 48,
      at: at('10-12T11:15'),
      by: 'sara@acme.com',
      path: 'questions/answers/sara@acme.com.json',
    }),
    line({
      kind: 'move',
      seq: 47,
      at: at('10-12T10:40'),
      by: 'Lina Haddad',
      path: 'plan.html',
      to: 'plans/plan.html',
    }),
    line({
      kind: 'restore',
      seq: 46,
      at: at('10-12T08:05'),
      by: 'owner@agent964.com',
      path: 'plan.html',
      to: 'push 9',
    }),
    DELETED,
    line({
      kind: 'delete',
      seq: 43,
      at: at('08-01T07:00'),
      by: 'lina@acme.com',
      path: 'old.html',
      restorable: false,
    }),
    PUSH_12,
    line({
      seq: 30,
      at: at('10-09T16:45'),
      by: null,
      push: { number: 11, message: null, files: 1 },
    }),
  ]

  it('prints a line for every kind of change, newest first, in UTC', async () => {
    const page = logOf({ path: '', lines: EVERY_KIND })
    const cli = await setUp(routes({ '/log': () => Response.json(page) }))

    expect(await cli.run(['log', 'agent964/acme'])).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'withdrawal  12 Oct 11:15  sara@acme.com withdrew a submission',
        'moved plan.html to plans/plan.html  12 Oct 10:40  Lina Haddad',
        'restored plan.html to push 9  12 Oct 08:05  owner@agent964.com',
        'deleted  11 Oct 09:30  lina@acme.com  plan.html',
        'deleted  1 Aug 07:00  lina@acme.com  old.html  (not restorable now)',
        'push 12  10 Oct 14:02  owner@agent964.com  First questions  (3 files)',
        'push 11  9 Oct 16:45  someone  (1 file)',
        '',
      ].join('\n'),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('GET')
    expect(requests[0]?.url.pathname).toBe('/_/api/log')
    expect(requests[0]?.url.searchParams.get('path')).toBe('agent964/acme')
    expect(requests[0]?.url.searchParams.has('cursor')).toBe(false)

    expect(await cli.run(['log', 'agent964/acme', '--json'])).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual(page)
  })

  it('says how to see older lines, and shows them with --cursor', async () => {
    let page: unknown = logOf({ path: 'questions', next: 'c_50' })
    const cli = await setUp(routes({ '/log': () => Response.json(page) }))

    expect(await cli.run(['log', 'agent964/acme/questions/'])).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'deleted  11 Oct 09:30  lina@acme.com  plan.html',
        'push 12  10 Oct 14:02  owner@agent964.com  First questions  (3 files)',
        'Older lines: dossier log agent964/acme/questions/ --cursor c_50',
        '',
      ].join('\n'),
    )
    expect(requests[0]?.url.searchParams.get('path')).toBe(
      'agent964/acme/questions/',
    )

    page = logOf({
      path: 'questions',
      lines: [line({ at: at('10-01T12:00', YEAR - 1), push: null })],
    })
    expect(
      await cli.run(['log', 'agent964/acme/questions/', '--cursor', 'c_50']),
    ).toBe(0)
    expect(requests[1]?.url.searchParams.get('cursor')).toBe('c_50')
    expect(cli.stdout()).toBe(
      `push  1 Oct ${YEAR - 1} 12:00  owner@agent964.com\n`,
    )
  })

  it('says when there is no history yet', async () => {
    const cli = await setUp(
      routes({
        '/log': () => Response.json(logOf({ path: 'notes', lines: [] })),
      }),
    )

    expect(await cli.run(['log', 'agent964/acme/notes/'])).toBe(0)
    expect(cli.stdout()).toBe('agent964/acme/notes/ has no history yet.\n')
  })
})

const PATCH = [
  '--- a/plan.html',
  '+++ b/plan.html',
  '@@ -1,2 +1,2 @@',
  ' <h1>Plan</h1>',
  '-<p>Draft</p>',
  '+<p>Final</p>',
  '',
].join('\n')

const diffOf = (over: Record<string, unknown> = {}) => ({
  path: 'plan.html',
  from: 'push 11',
  to: 'push 12',
  binary: false,
  before: '<h1>Plan</h1>\n<p>Draft</p>\n',
  after: '<h1>Plan</h1>\n<p>Final</p>\n',
  patch: PATCH,
  ...over,
})

describe('dossier diff', () => {
  it('prints the patch byte for byte', async () => {
    let answer = diffOf()
    const cli = await setUp(routes({ '/diff': () => Response.json(answer) }))

    expect(await cli.run(['diff', 'agent964/acme/plan.html'])).toBe(0)
    expect(cli.stdout()).toBe(PATCH)
    expect(requests[0]?.method).toBe('GET')
    expect(requests[0]?.url.pathname).toBe('/_/api/diff')
    expect(requests[0]?.url.searchParams.get('path')).toBe(
      'agent964/acme/plan.html',
    )

    answer = diffOf({ patch: '-a\n+b\n\\ No newline at end of file' })
    expect(await cli.run(['diff', 'agent964/acme/plan.html'])).toBe(0)
    expect(cli.stdout()).toBe('-a\n+b\n\\ No newline at end of file')

    expect(await cli.run(['diff', 'agent964/acme/plan.html', '--json'])).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual(answer)
  })

  it('leaves the pushes to the deployment, or compares one with now, or two', async () => {
    const cli = await setUp(routes({ '/diff': () => Response.json(diffOf()) }))

    expect(await cli.run(['diff', 'agent964/acme/questions/'])).toBe(0)
    expect(await cli.run(['diff', 'agent964/acme/plan.html', '11'])).toBe(0)
    expect(await cli.run(['diff', 'agent964/acme/plan.html', '9', '12'])).toBe(
      0,
    )
    expect(
      requests.map((r) => Object.fromEntries(r.url.searchParams.entries())),
    ).toEqual([
      { path: 'agent964/acme/questions/' },
      { path: 'agent964/acme/plan.html', from: '11' },
      { path: 'agent964/acme/plan.html', from: '9', to: '12' },
    ])
  })

  it('says a binary file changed, was added or was deleted, and when nothing differs', async () => {
    let answer: Record<string, unknown> = diffOf({
      path: 'images/plan.png',
      binary: true,
      before: null,
      after: null,
      patch: null,
    })
    const cli = await setUp(routes({ '/diff': () => Response.json(answer) }))

    expect(await cli.run(['diff', 'agent964/acme/images/plan.png'])).toBe(0)
    expect(cli.stdout()).toBe(
      'plan.png changed; it is binary or too large to show, so no diff is ' +
        'shown.\n',
    )

    answer = { ...answer, from: null }
    expect(await cli.run(['diff', 'agent964/acme/images/plan.png'])).toBe(0)
    expect(cli.stdout()).toBe(
      'plan.png was added; it is binary or too large to show, so no diff is ' +
        'shown.\n',
    )

    answer = { ...answer, from: 'push 11', to: 'deleted' }
    expect(await cli.run(['diff', 'agent964/acme/images/plan.png'])).toBe(0)
    expect(cli.stdout()).toContain('plan.png was deleted;')

    answer = diffOf({ patch: '' })
    expect(await cli.run(['diff', 'agent964/acme/plan.html', '12'])).toBe(0)
    expect(cli.stdout()).toBe(
      'No differences in plan.html between push 11 and push 12.\n',
    )
  })

  it.each([['0'], ['twelve'], ['-3'], ['1.5']])(
    'exits 6 before any request for the push %j',
    async (push) => {
      const cli = await setUp(
        routes({ '/diff': () => Response.json(diffOf()) }),
      )

      expect(
        await cli.run(['diff', 'agent964/acme/plan.html', '11', push]),
      ).toBe(6)
      expect(cli.stderr()).toBe(
        `dossier: "${push}" is not a push number.\nGive a push number from ` +
          'dossier log, such as dossier diff <path> 11 12.\n',
      )
      expect(
        await cli.run(['diff', 'agent964/acme/plan.html', push, '--json']),
      ).toBe(6)
      expect(JSON.parse(cli.stdout()).error.code).toBe(6)
      expect(requests).toEqual([])
    },
  )
})

describe('dossier restore', () => {
  it('restores a file to a push and prints the files it changed', async () => {
    const cli = await setUp(
      routes({ '/restore': () => Response.json(change({ seq: 46 })) }),
    )

    expect(
      await cli.run(['restore', 'agent964/acme/plan.html', '--to', '9']),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      'Restored agent964/acme/plan.html to push 9.\n- plan.html\n',
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.url.pathname).toBe('/_/api/restore')
    expect(requests[0]?.body).toEqual({
      path: 'agent964/acme/plan.html',
      to: { push: 9 },
    })
  })

  it('restores a folder to a time, listing each file', async () => {
    const answer = change({
      path: 'questions',
      changed: ['questions/index.html', 'questions/extra.html'],
    })
    const cli = await setUp(routes({ '/restore': () => Response.json(answer) }))

    expect(
      await cli.run([
        'restore',
        'agent964/acme/questions/',
        '--to',
        '2026-10-11T09:30:00Z',
      ]),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'Restored agent964/acme/questions/ to 2026-10-11T09:30:00Z.',
        '- questions/index.html',
        '- questions/extra.html',
        '',
      ].join('\n'),
    )
    expect(requests[0]?.body).toEqual({
      path: 'agent964/acme/questions/',
      to: { at: '2026-10-11T09:30:00Z' },
    })

    expect(
      await cli.run([
        'restore',
        'agent964/acme/questions/',
        '--to',
        '2026-10-11',
        '--json',
      ]),
    ).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual(answer)
    expect(requests[1]?.body).toMatchObject({ to: { at: '2026-10-11' } })
  })

  it('says when there is nothing to restore', async () => {
    const cli = await setUp(
      routes({ '/restore': () => Response.json(change({ changed: [] })) }),
    )

    expect(
      await cli.run(['restore', 'agent964/acme/plan.html', '--to', '9']),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      'Nothing to restore: agent964/acme/plan.html already matches push 9.\n',
    )
  })

  it.each([['yesterday'], ['0'], ['-3'], ['2026-13-45'], ['9.5']])(
    'exits 6 before any request for --to %j',
    async (to) => {
      const cli = await setUp(
        routes({ '/restore': () => Response.json(change()) }),
      )
      const fix =
        'Give a push number from dossier log, such as --to 9, or an ISO ' +
        '8601 time, such as --to 2026-10-11T09:30:00Z.'

      expect(
        await cli.run(['restore', 'agent964/acme/plan.html', '--to', to]),
      ).toBe(6)
      expect(cli.stderr()).toBe(
        `dossier: "${to}" is not a push number or a time.\n${fix}\n`,
      )
      expect(
        await cli.run([
          'restore',
          'agent964/acme/plan.html',
          '--to',
          to,
          '--json',
        ]),
      ).toBe(6)
      expect(JSON.parse(cli.stdout()).error).toEqual({
        code: 6,
        message: `"${to}" is not a push number or a time.`,
        fix,
        path: null,
      })
      expect(requests).toEqual([])
    },
  )
})

describe('history verbs, refused', () => {
  const VERBS = [
    ['rm', ['rm', 'agent964/acme/plan.html']],
    ['mv', ['mv', 'agent964/acme/plan.html', 'agent964/acme/plans/plan.html']],
    ['log', ['log', 'agent964/acme/questions/']],
    ['diff', ['diff', 'agent964/acme/plan.html', '11', '12']],
    ['restore', ['restore', 'agent964/acme/plan.html', '--to', '9']],
  ] as const
  const CODES = [
    ['forbidden', 3],
    ['conflict', 5],
    ['invalid', 6],
  ] as const
  const cases = VERBS.flatMap(([verb, argv]) =>
    CODES.map(([code, exit]) => [verb, code, exit, argv] as const),
  )

  it.each(cases)(
    'dossier %s exits as the table says for %s (%i)',
    async (_verb, code, exit, argv) => {
      const cli = await setUp(() =>
        errorResponse(code, `The deployment says ${code}.`, `Fix for ${code}.`),
      )

      expect(await cli.run(argv)).toBe(exit)
      expect(cli.stdout()).toBe('')
      expect(cli.stderr()).toBe(
        `dossier: The deployment says ${code}.\nFix for ${code}.\n`,
      )
      expect(requests).toHaveLength(1)

      expect(await cli.run([...argv, '--json'])).toBe(exit)
      expect(cli.stderr()).toBe('')
      expect(JSON.parse(cli.stdout())).toEqual({
        error: {
          code: exit,
          message: `The deployment says ${code}.`,
          fix: `Fix for ${code}.`,
          path: null,
        },
      })
    },
  )

  it.each(VERBS)('dossier %s exits 4 without an agent key', async (_, argv) => {
    const cli = await setUp(() => errorResponse('not_found'), {})

    expect(await cli.run(argv)).toBe(4)
    expect(requests).toEqual([])
  })
})
