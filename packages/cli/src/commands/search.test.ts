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

const PLAN = {
  kind: 'page',
  title: 'Delivery plan',
  workspace: 'agent964',
  tree: 'acme',
  path: 'plan.html',
  link: 'https://dossier.acme.com/agent964/acme/plan',
  snippet: null,
}
const DEPOT = {
  kind: 'page',
  title: 'Erbil depot plan',
  workspace: 'agent964',
  tree: 'acme',
  path: 'mockups/erbil-depot.html',
  link: 'https://dossier.acme.com/agent964/acme/mockups/erbil-depot',
  snippet: [
    { text: '…the ', match: false },
    { text: 'Erbil', match: true },
    { text: ' depot opens in November…', match: false },
  ],
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

describe('dossier search', () => {
  it('searches titles and paths, one line a result', async () => {
    const answer = {
      query: 'plan',
      mode: 'titles',
      results: [PLAN, { ...DEPOT, snippet: null }],
      next: null,
    }
    const cli = await setUp(() => Response.json(answer))
    expect(await cli.run(['search', 'plan'])).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'Delivery plan  https://dossier.acme.com/agent964/acme/plan',
        'Erbil depot plan  https://dossier.acme.com/agent964/acme/mockups/erbil-depot',
        '',
      ].join('\n'),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('GET')
    expect(requests[0]?.url.pathname).toBe('/_/api/search')
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({
      q: 'plan',
      mode: 'titles',
      offset: '0',
    })
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer dsk_one')
  })

  it('searches page contents after "in", with the snippet on the next line', async () => {
    const answer = {
      query: 'erbil depot',
      mode: 'content',
      results: [DEPOT],
      next: null,
    }
    const cli = await setUp(() => Response.json(answer))
    expect(await cli.run(['search', 'in', 'erbil', 'depot'])).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'Erbil depot plan  https://dossier.acme.com/agent964/acme/mockups/erbil-depot',
        '  …the Erbil depot opens in November…',
        '',
      ].join('\n'),
    )
    expect(requests[0]?.url.searchParams.get('q')).toBe('erbil depot')
    expect(requests[0]?.url.searchParams.get('mode')).toBe('content')

    // One argument written with "in " means the same.
    expect(await cli.run(['search', 'in erbil depot'])).toBe(0)
    expect(requests[1]?.url.searchParams.get('q')).toBe('erbil depot')
    expect(requests[1]?.url.searchParams.get('mode')).toBe('content')
  })

  it('prints the response as returned with --json', async () => {
    const answer = {
      query: 'erbil',
      mode: 'content',
      results: [DEPOT],
      next: 20,
    }
    const cli = await setUp(() => Response.json(answer))
    expect(await cli.run(['search', 'in', 'erbil', '--json'])).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual(answer)
  })

  it('says how to see more, and asks for the next page with --offset', async () => {
    const answer = {
      query: 'plan',
      mode: 'titles',
      results: [PLAN],
      next: 20,
    }
    const cli = await setUp(() => Response.json(answer))
    expect(await cli.run(['search', 'plan'])).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'Delivery plan  https://dossier.acme.com/agent964/acme/plan',
        'More results: dossier search plan --offset 20',
        '',
      ].join('\n'),
    )
    expect(await cli.run(['search', 'plan', '--offset', '20'])).toBe(0)
    expect(requests[1]?.url.searchParams.get('offset')).toBe('20')
  })

  it('says no pages match and exits 0', async () => {
    const cli = await setUp(() =>
      Response.json({
        query: 'budget',
        mode: 'content',
        results: [],
        next: null,
      }),
    )
    expect(await cli.run(['search', 'in', 'budget'])).toBe(0)
    expect(cli.stdout()).toBe('No pages match "budget".\n')
  })

  it('exits 2 for "dossier search in" alone, asking nothing', async () => {
    const cli = await setUp(() => Response.json({}))
    expect(await cli.run(['search', 'in'])).toBe(2)
    expect(cli.stderr()).toContain('Give the words to look for after "in"')
    expect(await cli.run(['search'])).toBe(2)
    expect(requests).toHaveLength(0)
  })

  it('exits 2 for a query over 200 characters, asking nothing', async () => {
    const cli = await setUp(() => Response.json({}))
    expect(await cli.run(['search', 'a'.repeat(150), 'b'.repeat(60)])).toBe(2)
    expect(cli.stderr()).toContain('A search is at most 200 characters.')
    expect(requests).toHaveLength(0)
  })

  it('exits as the error table says when the deployment refuses', async () => {
    const cli = await setUp(() =>
      errorResponse('sign_in_required', 'This agent key is not known.'),
    )
    expect(await cli.run(['search', 'plan'])).toBe(4)
    expect(cli.stderr()).toContain('This agent key is not known.')
    const refused = await setUp(() =>
      errorResponse('invalid', 'Type something to search for.'),
    )
    expect(await refused.run(['search', '!'])).toBe(6)
  })
})
