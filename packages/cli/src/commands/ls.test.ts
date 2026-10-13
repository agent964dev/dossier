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
const SHA = 'a'.repeat(64)

const entry = (
  name: string,
  kind: string,
  size: number | null,
  push: number | null,
) => ({
  name,
  path: name,
  kind,
  folder: kind === 'folder',
  size,
  sha256: kind === 'folder' ? null : SHA,
  contentType: null,
  title: null,
  push: push === null ? null : { number: push, at: '2026-10-12T00:00:00Z' },
})

const listing = (entries: readonly unknown[]) => ({
  tree: { id: 'acmetree000000000001', workspace: 'agent964', name: 'acme' },
  path: '',
  seq: 7,
  entries,
})

const ENTRIES = [
  entry('_theme.css', 'kit', 70, 1),
  entry('answers', 'folder', null, null),
  entry('index.html', 'page', 1_250, 3),
  entry('logo.svg', 'attachment', 230, 1),
  entry('plans', 'folder', null, 3),
  {
    ...entry('plans', 'page', null, 3),
    name: 'brief',
    path: 'brief',
    folder: true,
    sha256: null,
  },
  entry('team.json', 'data', 4_200_000, null),
]

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

describe('dossier ls', () => {
  it('prints one row per entry: name, kind, size and last push', async () => {
    const cli = await setUp(() => Response.json(listing(ENTRIES)))

    expect(await cli.run(['ls', 'agent964/acme'])).toBe(0)
    expect(cli.stdout()).toBe(
      [
        '_theme.css  kit         70 B     push 1',
        'answers/    folder      -        -',
        'index.html  page        1.2 KiB  push 3',
        'logo.svg    attachment  230 B    push 1',
        'plans/      folder      -        push 3',
        'brief/      page        -        push 3',
        'team.json   data        4.0 MiB  -',
        '',
      ].join('\n'),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url.href).toBe(
      'https://dossier.acme.com/_/api/ls?path=agent964%2Facme&depth=one',
    )
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer dsk_one')
  })

  it('prints the listing with --json', async () => {
    const cli = await setUp(() => Response.json(listing(ENTRIES)))

    expect(await cli.run(['ls', 'agent964/acme/', '--json'])).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual(listing(ENTRIES))
  })

  it('prints Nothing here yet. for an empty folder and exits 0', async () => {
    const cli = await setUp(() => Response.json(listing([])))

    expect(await cli.run(['ls', 'agent964/acme/plans'])).toBe(0)
    expect(cli.stdout()).toBe('Nothing here yet.\n')
    expect(requests[0]?.url.searchParams.get('path')).toBe(
      'agent964/acme/plans',
    )
  })

  it('lists the node a link on the deployment names', async () => {
    const cli = await setUp(() => Response.json(listing([])))

    expect(
      await cli.run(['ls', 'https://dossier.acme.com/agent964/acme/plans/']),
    ).toBe(0)
    expect(requests[0]?.url.searchParams.get('path')).toBe(
      'agent964/acme/plans',
    )
  })

  it.each([
    ['not_found', 3],
    ['forbidden', 3],
  ] as const)('exits 3 on %s', async (code, exit) => {
    const cli = await setUp(() =>
      errorResponse(code, 'No such folder.', 'Check the path.'),
    )

    expect(await cli.run(['ls', 'agent964/acme/nope'])).toBe(exit)
    expect(cli.stderr()).toBe('dossier: No such folder.\nCheck the path.\n')
  })

  it('never sends the key to the host of a link to another deployment', async () => {
    const cli = await setUp(() => Response.json(listing([])))

    expect(
      await cli.run(['ls', 'https://elsewhere.example/agent964/acme/']),
    ).toBe(4)
    expect(requests).toEqual([])
  })

  it('exits 4 without an agent key', async () => {
    const cli = await setUp(() => Response.json(listing([])), {})

    expect(await cli.run(['ls', 'agent964/acme'])).toBe(4)
    expect(cli.stderr()).toContain('Not signed in to dossier.agent964.com.')
  })
})

const tree = (workspace: string, name: string, can: string) => ({
  name,
  target: `${workspace}/${name}/`,
  link: `https://dossier.acme.com/${workspace}/${name}/`,
  can,
})

const SHARED = [
  {
    workspace: 'globex',
    tree: 'plans',
    path: 'q3.html',
    kind: 'page',
    title: 'Q3 plan',
    target: 'globex/plans/q3',
    link: 'https://dossier.acme.com/globex/plans/q3',
    can: 'respond',
    sharedAt: '2026-10-12T00:00:00.000Z',
    waiting: true,
    mentioned: false,
  },
  {
    workspace: 'agent964',
    tree: 'acme',
    path: 'questions',
    kind: 'folder',
    title: 'Questions',
    target: 'agent964/acme/questions/',
    link: 'https://dossier.acme.com/agent964/acme/questions/',
    can: 'respond',
    sharedAt: '2026-10-11T00:00:00.000Z',
    waiting: false,
    mentioned: true,
  },
]

const PLACES = {
  scope: null,
  workspaces: [
    {
      name: 'agent964',
      role: 'admin',
      suspended: false,
      trees: [
        tree('agent964', 'acme', 'write'),
        tree('agent964', 'handbook', 'read'),
      ],
    },
    { name: 'studio', role: 'member', suspended: true, trees: [] },
  ],
  shared: SHARED,
}

const workspaceView = (over: Record<string, unknown> = {}) => ({
  name: 'agent964',
  role: 'member',
  suspended: false,
  trees: [
    tree('agent964', 'acme', 'respond'),
    tree('agent964', 'handbook', 'read'),
  ],
  shared: [SHARED[1]],
  teams: [
    { name: 'Design', members: 4 },
    { name: 'Design Ops', members: 1 },
  ],
  createsTrees: true,
  scope: null,
  ...over,
})

describe('dossier ls with no tree', () => {
  it('lists each workspace with its role, its trees with what you may do, then what is shared with you', async () => {
    const cli = await setUp(() => Response.json(PLACES))

    expect(await cli.run(['ls'])).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'agent964/           workspace  admin',
        'agent964/acme/      tree       write',
        'agent964/handbook/  tree       read',
        'studio/             workspace  member, suspended',
        '',
        'Shared with you:',
        'globex/plans/q3           page    respond  Q3 plan · waiting for your answer',
        'agent964/acme/questions/  folder  respond  Questions · mentioned you',
        '',
      ].join('\n'),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url.href).toBe(
      'https://dossier.acme.com/_/api/workspaces',
    )
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer dsk_one')
  })

  it('gives the same structure with --json, and asks the deployment a link to its root names', async () => {
    const cli = await setUp(() => Response.json(PLACES))

    expect(await cli.run(['ls', 'https://dossier.acme.com/', '--json'])).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual(PLACES)
    expect(requests[0]?.url.pathname).toBe('/_/api/workspaces')
  })

  it('says so when there is nowhere to work yet', async () => {
    const cli = await setUp(() =>
      Response.json({ scope: null, workspaces: [], shared: [] }),
    )

    expect(await cli.run(['ls'])).toBe(0)
    expect(cli.stdout()).toBe(
      'You are in no workspace, and nothing is shared with you yet.\n',
    )
  })

  it('shows a key limited to a node only that node', async () => {
    const scope = {
      target: 'agent964/acme/plans/',
      workspace: 'agent964',
      link: 'https://dossier.acme.com/agent964/acme/plans/',
      can: 'read',
    }
    const cli = await setUp((request) =>
      Response.json(
        request.url.pathname === '/_/api/workspaces'
          ? { scope, workspaces: [], shared: [] }
          : workspaceView({
              role: null,
              trees: [],
              shared: [],
              teams: null,
              createsTrees: false,
              scope,
            }),
      ),
    )
    const expected = [
      'agent964/acme/plans/  read',
      'This key is limited to agent964/acme/plans/; it sees nothing else.',
      '',
    ].join('\n')

    expect(await cli.run(['ls'])).toBe(0)
    expect(cli.stdout()).toBe(expected)
    expect(await cli.run(['ls', 'agent964'])).toBe(0)
    expect(cli.stdout()).toBe(expected)
    expect(requests[1]?.url.pathname).toBe('/_/api/workspaces/agent964')
  })

  it('exits 4 without an agent key, asking nothing', async () => {
    const cli = await setUp(() => Response.json(PLACES), {})

    expect(await cli.run(['ls'])).toBe(4)
    expect(requests).toEqual([])
  })
})

describe('dossier ls <workspace>', () => {
  it.each([['agent964'], ['agent964/'], ['https://dossier.acme.com/agent964']])(
    'lists a member its trees, what is shared there, its teams and how to make a tree: %s',
    async (target) => {
      const cli = await setUp(() => Response.json(workspaceView()))

      expect(await cli.run(['ls', target])).toBe(0)
      expect(cli.stdout()).toBe(
        [
          'agent964/           workspace  member',
          'agent964/acme/      tree       respond',
          'agent964/handbook/  tree       read',
          '',
          'Shared with you here:',
          'agent964/acme/questions/  folder  respond  Questions · mentioned you',
          '',
          'Teams: share with team:<name>, mention with @team:<name> (@team:"<name>" when it has a space):',
          'Design      4 members',
          'Design Ops  1 member',
          '',
          'Make a tree by pushing to a new tree name: dossier push <folder> agent964/<tree>/',
          '',
        ].join('\n'),
      )
      expect(requests[0]?.url.pathname).toBe('/_/api/workspaces/agent964')
    },
  )

  it('shows someone with only shares there those shares, with no teams and no way to make a tree', async () => {
    const cli = await setUp(() =>
      Response.json(
        workspaceView({
          role: null,
          trees: [],
          teams: null,
          createsTrees: false,
        }),
      ),
    )

    expect(await cli.run(['ls', 'agent964'])).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'Shared with you in agent964:',
        'agent964/acme/questions/  folder  respond  Questions · mentioned you',
        '',
      ].join('\n'),
    )
  })

  it('leaves out the way to make a tree for a key that cannot push, and says when no tree opens', async () => {
    const cli = await setUp(() =>
      Response.json(
        workspaceView({
          trees: [],
          shared: [],
          teams: [],
          createsTrees: false,
        }),
      ),
    )

    expect(await cli.run(['ls', 'agent964', '--json'])).toBe(0)
    expect(JSON.parse(cli.stdout()).createsTrees).toBe(false)
    expect(await cli.run(['ls', 'agent964'])).toBe(0)
    expect(cli.stdout()).toBe(
      ['agent964/  workspace  member', 'No trees you can open yet.', ''].join(
        '\n',
      ),
    )
  })

  it('answers a workspace you cannot see as nothing there, exit 3', async () => {
    const cli = await setUp(() =>
      errorResponse('not_found', 'Nothing is here, or you cannot open it.'),
    )

    expect(await cli.run(['ls', 'globex'])).toBe(3)
    expect(cli.stderr()).toBe(
      'dossier: Nothing at globex, or you cannot open it.\n' +
        'Run dossier ls to see your workspaces and what is shared with you.\n',
    )
  })

  it('refuses a name that is not a workspace before asking', async () => {
    const cli = await setUp(() => Response.json(workspaceView()))

    expect(await cli.run(['ls', 'Not_A_Workspace'])).toBe(2)
    expect(requests).toEqual([])
  })
})
