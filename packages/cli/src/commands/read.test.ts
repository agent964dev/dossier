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

    expect(await cli.run(['read', 'agent964/acme/pricing'])).toBe(3)
    expect(cli.stderr()).toBe(
      'dossier: Stopped. acme/pricing was not found, or you cannot open it.\n' +
        'Check the path, or ask someone who can open it to share it with you.\n',
    )
    expect(await cli.run(['read', 'agent964/acme/pricing', '--json'])).toBe(3)
    expect(JSON.parse(cli.stdout()).error).toMatchObject({
      code: 3,
      message: 'Stopped. acme/pricing was not found, or you cannot open it.',
    })
  })

  it('exits 4 when the key is refused', async () => {
    const cli = await setUp(() => errorResponse('sign_in_required'))

    expect(await cli.run(['read', 'agent964/acme/plan'])).toBe(4)
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
