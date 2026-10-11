import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

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
const TREE_ID = 'acmetree000000000001'

const FILES: Record<string, string> = {
  'plans/index.html': '<h1>Plans</h1>\n',
  'plans/q3.html': '<h1>Q3</h1>\n',
  'plans/answers/sara@acme.com.json': '{"ok":true}\n',
}
const contents = (path: string): string => FILES[path] ?? ''
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const file = (path: string, kind: string, push: number | null) => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind,
  folder: kind === 'folder',
  size: Buffer.byteLength(contents(path)),
  sha256: sha(contents(path)),
  contentType: null,
  title: null,
  push: push === null ? null : { number: push, at: '2026-10-12T00:00:00Z' },
})

const listing = {
  tree: { id: TREE_ID, workspace: 'agent964', name: 'acme' },
  path: 'plans',
  seq: 9,
  entries: [
    {
      name: 'answers',
      path: 'plans/answers',
      kind: 'folder',
      folder: true,
      size: null,
      sha256: null,
      contentType: null,
      title: null,
      push: null,
    },
    file('plans/answers/sara@acme.com.json', 'data', null),
    file('plans/index.html', 'page', 2),
    file('plans/q3.html', 'page', 4),
  ],
}

const serving: Route = (request) => {
  if (request.url.pathname === '/_/api/ls') return Response.json(listing)
  if (request.url.pathname === '/_/api/file') {
    const path = (request.url.searchParams.get('path') ?? '').replace(
      /^agent964\/acme\//,
      '',
    )
    return new Response(contents(path))
  }
  return new Response(null, { status: 404 })
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

describe('dossier pull', () => {
  it('writes each file under the folder and prints a line per file', async () => {
    const cli = await setUp(serving)

    expect(await cli.run(['pull', 'agent964/acme/plans', 'out'])).toBe(0)
    expect(cli.stdout()).toBe(
      [
        'pulled   answers/sara@acme.com.json',
        'pulled   index.html',
        'pulled   q3.html',
        'Pulled 3 files into out at push 4.',
        '',
      ].join('\n'),
    )
    expect(await readFile(join(cli.dir, 'out', 'q3.html'), 'utf8')).toBe(
      contents('plans/q3.html'),
    )
    const data = await stat(
      join(cli.dir, 'out', 'answers', 'sara@acme.com.json'),
    )
    expect(data.mode & 0o777).toBe(0o444)
    expect(requests[0]?.url.search).toBe(
      '?path=agent964%2Facme%2Fplans&depth=all',
    )
    for (const request of requests) {
      expect(request.url.host).toBe('dossier.acme.com')
      expect(request.headers.get('authorization')).toBe('Bearer dsk_one')
    }

    expect(await cli.run(['pull', 'agent964/acme/plans', 'out'])).toBe(0)
    expect(cli.stdout()).toBe('out is up to date at push 4.\n')
  })

  it('prints the outcome with --json', async () => {
    const cli = await setUp(serving)

    expect(
      await cli.run(['pull', 'agent964/acme/plans', 'out', '--json']),
    ).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual({
      written: ['answers/sara@acme.com.json', 'index.html', 'q3.html'],
      unchanged: 0,
      seq: 9,
      push: 4,
      dir: expect.stringMatching(/\/out$/),
    })
  })

  it.each([
    ['not_found', 3],
    ['forbidden', 3],
    ['sign_in_required', 4],
  ] as const)('exits with the code of %s', async (code, exit) => {
    const cli = await setUp(() => errorResponse(code))

    expect(await cli.run(['pull', 'agent964/acme', 'out'])).toBe(exit)
    expect(requests).toHaveLength(1)
  })

  it('never sends the key to the host of a link to another deployment', async () => {
    const cli = await setUp(serving)

    expect(
      await cli.run([
        'pull',
        'https://elsewhere.example/agent964/acme/',
        'out',
      ]),
    ).toBe(4)
    expect(requests).toEqual([])
  })
})
