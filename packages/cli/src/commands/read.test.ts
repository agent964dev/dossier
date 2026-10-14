import { threadsText, type Thread } from '@dossier/contracts'
import { afterEach, describe, expect, it } from 'vitest'

import {
  errorResponse,
  type Harness,
  harness,
  type Route,
  type SeenRequest,
  stubFetch,
} from '../test-support.ts'
import { describeRead } from './read.ts'

const ENV = { DOSSIER_DEPLOYMENT: 'dossier.acme.com', DOSSIER_KEY: 'dsk_one' }

const POINTER_TEXT =
  '# Delivery plan\n\nTrucks leave on Monday.\n\nData: answers/ (3 files) · Comments: 2\n'

const PAGE = {
  kind: 'page',
  path: 'plan.html',
  link: 'https://dossier.acme.com/agent964/acme/plan',
  text: POINTER_TEXT,
  push: 12,
  source: 'companion',
  companion: 'plan.md',
  type: 'text/markdown',
  pointer: { data: [{ path: 'answers/', files: 3 }], comments: 2 },
}

const EMPTY = {
  kind: 'folder',
  path: '',
  link: 'https://dossier.acme.com/agent964/empty2/',
  text: 'Nothing here yet.\n',
  entries: [],
  kit: [],
}

const PDF = {
  kind: 'file',
  path: 'brief.pdf',
  link: 'https://dossier.acme.com/agent964/acme/brief.pdf',
  text: null,
  contentType: 'application/pdf',
  size: 2_100_000,
  doc: null,
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

describe('dossier read', () => {
  it('prints the text the link returns', async () => {
    const cli = await setUp(() => Response.json(PAGE))

    expect(await cli.run(['read', 'agent964/acme/plan'])).toBe(0)
    expect(cli.stdout()).toBe(POINTER_TEXT)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url.href).toBe(
      'https://dossier.acme.com/_/api/read?path=agent964%2Facme%2Fplan',
    )
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer dsk_one')
  })

  it('prints the whole result with --json, the pointer as a field', async () => {
    const cli = await setUp(() => Response.json(PAGE))

    expect(await cli.run(['read', 'agent964/acme/plan', '--json'])).toBe(0)
    const printed = JSON.parse(cli.stdout())
    expect(printed).toEqual(PAGE)
    expect(printed.pointer).toEqual({
      data: [{ path: 'answers/', files: 3 }],
      comments: 2,
    })
  })

  it('reads what a link on the deployment names', async () => {
    const cli = await setUp(() => Response.json(PAGE))

    expect(
      await cli.run(['read', 'https://dossier.acme.com/agent964/acme/plan']),
    ).toBe(0)
    expect(requests[0]?.url.searchParams.get('path')).toBe('agent964/acme/plan')
  })

  it('prints Nothing here yet. and exits 0 for an empty folder', async () => {
    const cli = await setUp(() => Response.json(EMPTY))

    expect(await cli.run(['read', 'agent964/empty2/'])).toBe(0)
    expect(cli.stdout()).toBe('Nothing here yet.\n')
    expect(cli.stderr()).toBe('')
  })

  it('says how to get a file that is not text', async () => {
    const cli = await setUp(() => Response.json(PDF))

    expect(await cli.run(['read', 'agent964/acme/brief.pdf'])).toBe(0)
    expect(cli.stdout()).toBe(
      'brief.pdf is a PDF, 2.1 MB. Download it with dossier pull.\n',
    )
  })

  it('exits 3 when the path is not found or cannot be opened', async () => {
    const cli = await setUp(() =>
      errorResponse(
        'not_found',
        'Nothing is here, or you cannot open it.',
        'Check the path, or ask someone who can open it to share it with you.',
      ),
    )

    expect(await cli.run(['read', 'agent964/acme/forms/answers/'])).toBe(3)
    expect(cli.stderr()).toBe(
      'dossier: Nothing at agent964/acme/forms/answers/, or you cannot read ' +
        'it. A folder a form writes to appears with its first answer.\n' +
        'Check the path, or ask someone who can open it to share it with you.\n',
    )
    expect(await cli.run(['read', 'agent964/acme/brief.pdf', '--json'])).toBe(3)
    expect(JSON.parse(cli.stdout()).error).toMatchObject({
      code: 3,
      message: 'Nothing at agent964/acme/brief.pdf, or you cannot read it.',
    })
  })

  it('exits 4 when the key is refused', async () => {
    const cli = await setUp(() => errorResponse('sign_in_required'))

    expect(await cli.run(['read', 'agent964/acme/plan'])).toBe(4)
  })
})

describe('dossier read, exactly', () => {
  it('keeps a folder’s trailing slash, so open/ never reads the page open.html', async () => {
    const cli = await setUp(() => Response.json(EMPTY))

    expect(await cli.run(['read', 'agent964/acme/open/'])).toBe(0)
    expect(
      await cli.run(['read', 'https://dossier.acme.com/agent964/acme/open/']),
    ).toBe(0)
    expect(await cli.run(['read', 'agent964/acme/open'])).toBe(0)
    expect(requests.map((r) => r.url.searchParams.get('path'))).toEqual([
      'agent964/acme/open/',
      'agent964/acme/open/',
      'agent964/acme/open',
    ])
  })

  it('prints the agent text exactly, adding no newline', async () => {
    const json = '{"terms":[{"term":"push"}]}'
    const cli = await setUp(() =>
      Response.json({
        ...PAGE,
        text: json,
        type: 'application/json',
        source: 'companion',
        companion: 'glossary.json',
      }),
    )

    expect(await cli.run(['read', 'agent964/acme/glossary'])).toBe(0)
    expect(cli.stdout()).toBe(json)
  })

  it('prints a text file exactly too', async () => {
    const cli = await setUp(() =>
      Response.json({ ...PDF, path: 'a.csv', text: 'a,b\n1,2', size: 7 }),
    )

    expect(await cli.run(['read', 'agent964/acme/a.csv'])).toBe(0)
    expect(cli.stdout()).toBe('a,b\n1,2')
  })
})

describe('describeRead', () => {
  it('names a file by its kind and size', () => {
    const file = (path: string, size: number) =>
      describeRead({ ...PDF, path, size } as never)
    expect(file('clip.mp4', 12_000_000)).toBe(
      'clip.mp4 is an MP4, 12 MB. Download it with dossier pull.',
    )
    expect(file('logo.svg', 900)).toBe(
      'logo.svg is an SVG, 900 bytes. Download it with dossier pull.',
    )
    expect(file('LICENSE', 1_000)).toBe(
      'LICENSE is a file, 1.0 KB. Download it with dossier pull.',
    )
  })
})

const PRICING: Thread = {
  root: {
    path: 'plan.comments/sara@acme.com/2026-10-10T09-14-03.json',
    text: 'Per pallet or per truck?',
    anchor: 'pricing',
    label: 'Pricing',
    pin: null,
    replyTo: null,
    stance: null,
    mentions: ['lina@acme.com'],
    by: 'sara@acme.com',
    name: 'Sara',
    at: '2026-10-10T09:14:03.000Z',
    push: 3,
    edited: false,
    deleted: false,
    agent: false,
  },
  replies: [
    {
      path: 'plan.comments/lina@acme.com/2026-10-10T10-02-40.json',
      text: 'Per truck from December.\nThe old price holds until then.',
      anchor: 'pricing',
      label: 'Pricing',
      pin: null,
      replyTo: 'plan.comments/sara@acme.com/2026-10-10T09-14-03.json',
      stance: 'agree',
      mentions: [],
      by: 'lina@acme.com',
      name: null,
      at: '2026-10-10T10:02:40.000Z',
      push: 3,
      edited: true,
      deleted: false,
      // Written with the CLI, through Lina's agent key.
      agent: true,
    },
  ],
  resolved: true,
  resolvedBy: 'lina@acme.com',
  resolvedAt: '2026-10-11T08:02:11.000Z',
}

const MOCKUP: Thread = {
  root: {
    ...PRICING.root,
    path: 'plan.comments/omar@acme.com/2026-10-11T12-00-00.json',
    text: '',
    anchor: 'mock',
    label: null,
    pin: { x: 0.4, y: 0.225 },
    mentions: [],
    by: 'omar@acme.com',
    at: '2026-10-11T12:00:00.000Z',
    push: 4,
    deleted: true,
  },
  replies: [],
  resolved: false,
  resolvedBy: null,
  resolvedAt: null,
}

const threadDocs = [PRICING, MOCKUP].map((data) => ({
  path: data.root.path,
  data,
  by: data.root.by,
  at: data.root.at,
  push: data.root.push,
}))

const COMMENTS = {
  kind: 'comments',
  path: 'plan.comments',
  link: 'https://dossier.acme.com/agent964/acme/plan.comments/',
  page: 'plan.html',
  threads: threadDocs,
  text: threadsText({ folder: 'plan.comments', threads: threadDocs }),
}

describe('dossier read of a comments folder', () => {
  it('prints threads with their anchor, state, writers, times and replies', async () => {
    const cli = await setUp(() => Response.json(COMMENTS))

    expect(await cli.run(['read', 'agent964/acme/plan.comments/'])).toBe(0)
    expect(cli.stdout()).toBe(
      [
        '# plan.comments/ (2 threads)',
        '',
        '## On Pricing · resolved by lina@acme.com, 11 Oct 2026, 08:02 UTC',
        '',
        'sara@acme.com · 10 Oct 2026, 09:14 UTC · push 3',
        '',
        '> Per pallet or per truck?',
        '',
        'Reply from lina@acme.com (agent) · 10 Oct 2026, 10:02 UTC · push 3 · agree · edited',
        '',
        '> Per truck from December.',
        '> The old price holds until then.',
        '',
        '## On #mock, pinned at 40% across, 23% down · open',
        '',
        'omar@acme.com · 11 Oct 2026, 12:00 UTC · push 4',
        '',
        'Comment deleted.',
        '',
      ].join('\n'),
    )
  })

  it('gives every thread as a Doc with --json', async () => {
    const cli = await setUp(() => Response.json(COMMENTS))

    expect(
      await cli.run(['read', 'agent964/acme/plan.comments/', '--json']),
    ).toBe(0)
    const printed = JSON.parse(cli.stdout())
    expect(printed.kind).toBe('comments')
    expect(printed.threads).toEqual(threadDocs)
    expect(printed.threads[0].data.replies[0].replyTo).toBe(PRICING.root.path)
  })

  it('says there are no comments yet', () => {
    expect(threadsText({ folder: 'a/plan.comments', threads: [] })).toBe(
      'No comments yet.\n',
    )
  })
})

describe('dossier comment', () => {
  const written = (over: Record<string, unknown> = {}) => ({
    comment: 'plan.comments/sara@acme.com/2026-10-13T09-00-00.json',
    page: 'plan.html',
    link: 'https://dossier.acme.com/agent964/acme/plan#dossier-comment=plan.comments%2Fsara%40acme.com%2F2026-10-13T09-00-00.json&on=pricing',
    doc: {
      path: 'plan.comments/sara@acme.com/2026-10-13T09-00-00.json',
      data: { text: 'Per truck. @lina@acme.com', agent: true },
      by: 'sara@acme.com',
      at: '2026-10-13T09:00:00.000Z',
      push: 3,
    },
    ...over,
  })

  it('comments on an element with its text, and prints the path --reply-to takes and the link', async () => {
    const cli = await setUp(() => Response.json(written(), { status: 201 }))

    expect(
      await cli.run([
        'comment',
        'agent964/acme/plan',
        '--on',
        'pricing',
        '--stance',
        'agree',
        'Per truck. @lina@acme.com',
      ]),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'Commented on plan.html: plan.comments/sara@acme.com/2026-10-13T09-00-00.json',
        written().link,
        '',
      ].join('\n'),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.url.pathname).toBe('/_/api/comment')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer dsk_one')
    expect(requests[0]?.body).toMatchObject({
      path: 'agent964/acme/plan',
      text: 'Per truck. @lina@acme.com',
      on: 'pricing',
      stance: 'agree',
    })
    expect(typeof (requests[0]!.body as { opId: unknown }).opId).toBe('string')
  })

  it('replies in a thread with text from stdin', async () => {
    const fetch = stubFetch(() =>
      Response.json(
        written({ comment: 'plan.comments/sara@acme.com/r.json' }),
        {
          status: 201,
        },
      ),
    )
    requests = fetch.requests
    current = await harness({
      fetch: fetch.fetch,
      env: ENV,
      stdin: 'Done.\nSee the table.\n',
    })
    const thread = 'plan.comments/lina@acme.com/2026-10-10T09-14-03.json'

    expect(
      await current.run([
        'comment',
        'agent964/acme/plan',
        '--reply-to',
        thread,
        '-',
      ]),
    ).toBe(0)
    expect(current.stdout().split('\n')[0]).toBe(
      'Replied on plan.html: plan.comments/sara@acme.com/r.json',
    )
    expect(requests[0]?.body).toMatchObject({
      text: 'Done.\nSee the table.\n',
      replyTo: thread,
    })
  })

  it('answers a page it cannot open as nothing there, exit 3, and refuses no text before asking', async () => {
    const cli = await setUp(() =>
      errorResponse('not_found', 'Nothing is here, or you cannot open it.'),
    )

    expect(await cli.run(['comment', 'agent964/acme/secret', 'Hi'])).toBe(3)
    expect(cli.stderr()).toContain(
      'Nothing at agent964/acme/secret, or you cannot read it.',
    )
    requests.length = 0
    expect(await cli.run(['comment', 'agent964/acme/plan', '  '])).toBe(2)
    expect(requests).toHaveLength(0)
  })
})

describe('dossier comment --resolve and --reopen', () => {
  const THREAD = 'plan.comments/lina@acme.com/2026-10-10T09-14-03.json'
  const LINK = `https://dossier.acme.com/agent964/acme/plan#dossier-comment=${encodeURIComponent(THREAD)}&on=pricing`
  const marked = (over: Record<string, unknown> = {}) => ({
    thread: THREAD,
    page: 'plan.html',
    resolved: true,
    changed: true,
    link: LINK,
    ...over,
  })

  it('resolves a thread named on its own, and prints the thread and its link', async () => {
    const cli = await setUp(() => Response.json(marked()))

    expect(
      await cli.run(['comment', '--resolve', `agent964/acme/${THREAD}`]),
    ).toBe(0)
    expect(cli.stdout()).toBe(
      [`Resolved ${THREAD} on plan.html.`, LINK, ''].join('\n'),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.url.pathname).toBe('/_/api/comment/thread')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer dsk_one')
    expect(requests[0]?.body).toMatchObject({
      thread: `agent964/acme/${THREAD}`,
      resolved: true,
    })
    expect(requests[0]?.body).not.toHaveProperty('page')
    expect(typeof (requests[0]!.body as { opId: unknown }).opId).toBe('string')
  })

  it('reopens a thread named from the page’s folder, with the page', async () => {
    const cli = await setUp(() => Response.json(marked({ resolved: false })))

    expect(
      await cli.run(['comment', 'agent964/acme/plan', '--reopen', THREAD]),
    ).toBe(0)
    expect(cli.stdout().split('\n')[0]).toBe(`Reopened ${THREAD} on plan.html.`)
    expect(requests[0]?.body).toMatchObject({
      page: 'agent964/acme/plan',
      thread: THREAD,
      resolved: false,
    })
  })

  it('takes the link that opens the thread, and says when it already was resolved', async () => {
    const cli = await setUp(() => Response.json(marked({ changed: false })))

    expect(await cli.run(['comment', '--resolve', LINK, '--json'])).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual(marked({ changed: false }))
    expect(requests[0]?.body).toMatchObject({
      page: 'agent964/acme/plan',
      thread: THREAD,
      resolved: true,
    })
    expect(await cli.run(['comment', '--resolve', LINK])).toBe(0)
    expect(cli.stdout().split('\n')[0]).toBe(
      `${THREAD} on plan.html was already resolved.`,
    )
  })

  it.each([
    [['comment', '--resolve', THREAD, '--reopen', THREAD]],
    [['comment', 'agent964/acme/plan', '--resolve', THREAD, 'Done.']],
    [['comment', 'agent964/acme/plan', '--resolve', THREAD, '--on', 'x']],
    [['comment', 'agent964/acme/plan']],
    [['comment']],
  ])('refuses %j before asking, exit 2', async (argv) => {
    const cli = await setUp(() => Response.json(marked()))

    expect(await cli.run(argv)).toBe(2)
    expect(requests).toHaveLength(0)
  })

  it.each([
    ['not_found', 3],
    ['forbidden', 3],
    ['invalid', 6],
  ] as const)('exits %s as %i', async (code, exit) => {
    const cli = await setUp(() => errorResponse(code, 'Not this time.'))

    expect(
      await cli.run(['comment', '--resolve', `agent964/acme/${THREAD}`]),
    ).toBe(exit)
    if (code === 'not_found') {
      expect(cli.stderr()).toContain(
        `Nothing at agent964/acme/${THREAD}, or you cannot read it.`,
      )
    }
  })
})
