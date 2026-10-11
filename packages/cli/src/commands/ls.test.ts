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
