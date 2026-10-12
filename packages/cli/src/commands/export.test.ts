import { lstat, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { EXPORT_LINKED_HEADER } from '@dossier/contracts'
import { afterEach, describe, expect, it } from 'vitest'

import {
  errorResponse,
  type Harness,
  harness,
  type Route,
  type SeenRequest,
  stubFetch,
} from '../test-support.ts'
import { dispositionName, exportName, linkedPaths } from './export.ts'

const ENV = { DOSSIER_DEPLOYMENT: 'dossier.acme.com', DOSSIER_KEY: 'dsk_one' }

const PAGE = '<!doctype html>\n<html><body><h1>Plan</h1></body></html>\n'

/** The deployment's export answer, streamed in the chunks given. */
const exported = (
  chunks: readonly (string | Uint8Array)[] = [PAGE],
  headers: Record<string, string> = {},
): Response => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
        )
      }
      controller.close()
    },
  })
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

const linkedHeader = (paths: readonly string[]) => ({
  [EXPORT_LINKED_HEADER]: encodeURIComponent(JSON.stringify(paths)),
})

let current: Harness | undefined
let requests: SeenRequest[] = []
const setUp = async (route: Route) => {
  const fetch = stubFetch(route)
  requests = fetch.requests
  current = await harness({ fetch: fetch.fetch, env: ENV })
  return current
}
afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

/** What a folder holds, temporary files included, without the config. */
const filesIn = async (dir: string) =>
  (await readdir(dir)).filter((name) => name !== 'dossier').sort()

describe('dossier export', () => {
  it('asks the export route for the page and saves it under the page’s name', async () => {
    const cli = await setUp(() => exported())

    expect(await cli.run(['export', 'agent964/acme/plan'])).toBe(0)
    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request?.method).toBe('GET')
    expect(request?.url.href).toBe(
      'https://dossier.acme.com/_/api/export?link=agent964%2Facme%2Fplan',
    )
    expect(request?.headers.get('authorization')).toBe('Bearer dsk_one')
    expect(request?.headers.get('accept')).toBe('text/html')
    expect(request?.redirect).toBe('manual')
    expect(await readFile(join(cli.dir, 'plan.html'), 'utf8')).toBe(PAGE)
    expect(cli.stdout()).toBe(`Saved plan.html (${PAGE.length} bytes).\n`)
    expect(await filesIn(cli.dir)).toEqual(['plan.html'])
  })

  it('names the file by the page: .html dropped, index.html by its folder, the root by its tree', async () => {
    const cli = await setUp(() => exported())

    const cases: readonly [string, string, string][] = [
      ['agent964/acme/plans/q3.html', 'agent964/acme/plans/q3.html', 'q3'],
      [
        'agent964/acme/rich/index.html',
        'agent964/acme/rich/index.html',
        'rich',
      ],
      ['agent964/acme/rich/', 'agent964/acme/rich/', 'rich'],
      [
        'https://dossier.acme.com/agent964/acme/rich/',
        'agent964/acme/rich/',
        'rich',
      ],
      ['agent964/acme/index.html', 'agent964/acme/index.html', 'acme'],
      ['agent964/acme', 'agent964/acme', 'acme'],
      ['https://dossier.acme.com/agent964/acme/', 'agent964/acme', 'acme'],
    ]
    for (const [target, link, name] of cases) {
      expect(await cli.run(['export', target])).toBe(0)
      expect(requests.at(-1)?.url.searchParams.get('link')).toBe(link)
      expect(cli.stdout()).toBe(`Saved ${name}.html (${PAGE.length} bytes).\n`)
      expect(await readFile(join(cli.dir, `${name}.html`), 'utf8')).toBe(PAGE)
    }
    expect(await filesIn(cli.dir)).toEqual([
      'acme.html',
      'q3.html',
      'rich.html',
    ])
  })

  it('prefers the name the deployment gives, kept to a plain name in this folder', async () => {
    const cli = await setUp((request) => {
      const link = request.url.searchParams.get('link')
      if (link === 'agent964/acme/plan') {
        return exported([PAGE], {
          'content-disposition':
            'attachment; filename="Delivery plan - Q3.html"; ' +
            "filename*=UTF-8''Delivery%20plan%20%E2%80%94%20Q3.html",
        })
      }
      if (link === 'agent964/acme/rich/') {
        return exported([PAGE], {
          'content-disposition': 'attachment; filename="all.html"',
        })
      }
      return exported([PAGE], {
        'content-disposition': 'attachment; filename="../../.profile"',
      })
    })

    expect(await cli.run(['export', 'agent964/acme/plan'])).toBe(0)
    expect(cli.stdout()).toBe(
      `Saved Delivery plan — Q3.html (${PAGE.length} bytes).\n`,
    )
    expect(await cli.run(['export', 'agent964/acme/rich/'])).toBe(0)
    expect(cli.stdout()).toBe(`Saved all.html (${PAGE.length} bytes).\n`)
    expect(await cli.run(['export', 'agent964/acme/notes'])).toBe(0)
    expect(cli.stdout()).toBe(`Saved profile.html (${PAGE.length} bytes).\n`)
    expect(await filesIn(cli.dir)).toEqual([
      'Delivery plan — Q3.html',
      'all.html',
      'profile.html',
    ])
  })

  it('writes where -o says, relative to the current folder, and into a folder it names', async () => {
    const cli = await setUp(() =>
      exported([PAGE], {
        'content-disposition': 'attachment; filename="plan.html"',
      }),
    )

    expect(
      await cli.run(['export', 'agent964/acme/plan', '-o', 'out/all.html']),
    ).toBe(0)
    expect(cli.stdout()).toBe(`Saved all.html (${PAGE.length} bytes).\n`)
    expect(await readFile(join(cli.dir, 'out', 'all.html'), 'utf8')).toBe(PAGE)

    const absolute = join(cli.dir, 'elsewhere', 'copy.html')
    expect(
      await cli.run(['export', 'agent964/acme/plan', '--output', absolute]),
    ).toBe(0)
    expect(await readFile(absolute, 'utf8')).toBe(PAGE)

    expect(await cli.run(['export', 'agent964/acme/plan', '-o', 'out'])).toBe(0)
    expect(cli.stdout()).toBe(`Saved plan.html (${PAGE.length} bytes).\n`)
    expect(await filesIn(join(cli.dir, 'out'))).toEqual([
      'all.html',
      'plan.html',
    ])
    expect(await filesIn(cli.dir)).toEqual(['elsewhere', 'out'])
  })

  it('streams a large answer to disk and gives its size', async () => {
    const chunk = new Uint8Array(100_000).fill(0x61)
    const cli = await setUp(() => exported(Array(23).fill(chunk)))

    expect(await cli.run(['export', 'agent964/acme/plan'])).toBe(0)
    expect(cli.stdout()).toBe('Saved plan.html (2.3 MB).\n')
    expect((await lstat(join(cli.dir, 'plan.html'))).size).toBe(2_300_000)
  })

  it('lists the media kept as links, one canonical link a line', async () => {
    const cli = await setUp(() =>
      exported(
        [PAGE],
        linkedHeader(['media/walkthrough.mp4', 'media/team photo.png']),
      ),
    )

    expect(await cli.run(['export', 'agent964/acme/plan'])).toBe(0)
    expect(cli.stdout()).toBe(
      `Saved plan.html (${PAGE.length} bytes).\n` +
        'Linked, not included:\n' +
        'https://dossier.acme.com/agent964/acme/media/walkthrough.mp4\n' +
        'https://dossier.acme.com/agent964/acme/media/team%20photo.png\n',
    )
  })

  it('prints file, bytes and linked with --json', async () => {
    const cli = await setUp((request) =>
      request.url.searchParams.get('link') === 'agent964/acme/plan'
        ? exported([PAGE], linkedHeader(['media/walkthrough.mp4']))
        : exported([PAGE], linkedHeader([])),
    )

    expect(
      await cli.run([
        'export',
        'agent964/acme/plan',
        '-o',
        'all.html',
        '--json',
      ]),
    ).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual({
      file: join(cli.dir, 'all.html'),
      bytes: PAGE.length,
      linked: ['https://dossier.acme.com/agent964/acme/media/walkthrough.mp4'],
    })

    expect(await cli.run(['export', 'agent964/acme/notes', '--json'])).toBe(0)
    expect(JSON.parse(cli.stdout())).toEqual({
      file: join(cli.dir, 'notes.html'),
      bytes: PAGE.length,
      linked: [],
    })
  })

  it('passes a too_large refusal through with its exit code and writes nothing', async () => {
    const message =
      'This page would export as 63 MiB, above the 50 MiB limit even with ' +
      'its media linked.'
    const cli = await setUp(() => errorResponse('too_large', message))

    expect(await cli.run(['export', 'agent964/acme/plan'])).toBe(6)
    expect(cli.stderr()).toBe(`dossier: ${message}\n`)
    expect(cli.stdout()).toBe('')
    expect(await filesIn(cli.dir)).toEqual([])

    expect(await cli.run(['export', 'agent964/acme/plan', '--json'])).toBe(6)
    expect(JSON.parse(cli.stdout()).error).toMatchObject({ code: 6, message })
  })

  it('exits 3 for a page that is not found and 4 for a refused key', async () => {
    const cli = await setUp((request) =>
      request.url.searchParams.get('link') === 'agent964/acme/gone'
        ? errorResponse('not_found')
        : errorResponse('sign_in_required'),
    )

    expect(await cli.run(['export', 'agent964/acme/gone'])).toBe(3)
    expect(await cli.run(['export', 'agent964/acme/plan'])).toBe(4)
    expect(await filesIn(cli.dir)).toEqual([])
  })

  it('never writes through a symbolic link at the destination', async () => {
    const cli = await setUp(() => exported())
    const outside = join(cli.dir, 'outside.txt')
    await writeFile(outside, 'kept\n')
    await symlink(outside, join(cli.dir, 'plan.html'))

    expect(await cli.run(['export', 'agent964/acme/plan'])).toBe(1)
    expect(cli.stderr()).toContain('is a symbolic link')
    expect(await readFile(outside, 'utf8')).toBe('kept\n')
    expect((await lstat(join(cli.dir, 'plan.html'))).isSymbolicLink()).toBe(
      true,
    )
    expect(await filesIn(cli.dir)).toEqual(['outside.txt', 'plan.html'])
  })

  it('refuses an answer that is not a page, and keeps no partial file', async () => {
    const cli = await setUp((request) => {
      if (request.url.searchParams.get('link') === 'agent964/acme/plan') {
        return Response.json({ ok: true })
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<!doctype html>'))
          controller.error(new Error('connection reset'))
        },
      })
      return new Response(body, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    })

    expect(await cli.run(['export', 'agent964/acme/plan'])).toBe(1)
    expect(cli.stderr()).toContain('does not understand')
    expect(await cli.run(['export', 'agent964/acme/notes'])).toBe(1)
    expect(cli.stderr()).toContain('connection reset')
    expect(await filesIn(cli.dir)).toEqual([])
  })
})

describe('export names and links', () => {
  it('reads the deployment’s file name, the extended form first', () => {
    expect(dispositionName(null)).toBe(null)
    expect(dispositionName('attachment')).toBe(null)
    expect(dispositionName('attachment; filename=plan.html')).toBe('plan.html')
    expect(dispositionName('attachment; filename="a \\"b\\".html"')).toBe(
      'a "b".html',
    )
    expect(
      dispositionName(
        'attachment; filename*=UTF-8\'\'%C3%A9t%C3%A9.html; filename="ete.html"',
      ),
    ).toBe('été.html')
    expect(
      dispositionName("attachment; filename*=UTF-8''%E0; filename=x"),
    ).toBe('x.html')
    expect(dispositionName('attachment; filename="..\\\\x\\\\y.htm"')).toBe(
      'y.html',
    )
    expect(dispositionName('attachment; filename="..."')).toBe(null)
  })

  it('names a page with no name from the deployment', () => {
    const ref = (path: string, folder = false) => ({
      workspace: 'agent964',
      tree: 'acme',
      path,
      folder,
    })
    expect(exportName(ref('plan'))).toBe('plan.html')
    expect(exportName(ref('a/b/plan.html'))).toBe('plan.html')
    expect(exportName(ref('rich/index.html'))).toBe('rich.html')
    expect(exportName(ref('rich/index'))).toBe('rich.html')
    expect(exportName(ref('rich', true))).toBe('rich.html')
    expect(exportName(ref('index.html'))).toBe('acme.html')
    expect(exportName(ref('', true))).toBe('acme.html')
  })

  it('reads the linked tree paths, and nothing from a header it cannot read', () => {
    expect(linkedPaths(null)).toEqual([])
    expect(linkedPaths('')).toEqual([])
    expect(linkedPaths(encodeURIComponent('[]'))).toEqual([])
    expect(
      linkedPaths(encodeURIComponent(JSON.stringify(['media/a b.mp4']))),
    ).toEqual(['media/a b.mp4'])
    expect(linkedPaths('%E0')).toEqual([])
    expect(linkedPaths(encodeURIComponent('{"a":1}'))).toEqual([])
  })
})
