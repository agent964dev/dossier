import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  type AuthoredSeq,
  DossierError,
  type LinkRef,
  type TreeId,
} from '@dossier/contracts'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { normalizeDeployment } from './deployment.ts'
import { Cli, type CliIo } from './io.ts'
import { makeOutput } from './render.ts'
import {
  type HeadKey,
  headStore,
  MiB,
  Remote,
  Sync,
  type SyncError,
  SyncLive,
  type SyncService,
} from './sync.ts'
import { type Route, type SeenRequest, stubFetch } from './test-support.ts'

const sha = (text: string | Uint8Array) =>
  createHash('sha256').update(text).digest('hex')

let temporary: string[] = []
const tempDir = async (): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dossier-sync-')))
  temporary.push(dir)
  return dir
}
afterEach(async () => {
  // A download still in flight may write as a folder goes: retry its removal.
  await Promise.all(
    temporary.map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }),
    ),
  )
  temporary = []
})

/** Every path under a folder, links not followed. */
const contentsOf = async (dir: string): Promise<string> =>
  JSON.stringify(
    (await readdir(dir, { recursive: true }).catch(() => [])).sort(),
  )

/**
 * Waits until nothing under the folders changes for a while, so downloads a
 * refused pull left in flight have finished before the test checks them.
 */
const settled = async (...dirs: string[]): Promise<void> => {
  let last = ''
  for (let tries = 0; tries < 50; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 40))
    const now = (await Promise.all(dirs.map(contentsOf))).join('|')
    if (now === last) return
    last = now
  }
}

/** Writes each file, creating its folders. */
const layout = async (dir: string, files: Record<string, string>) => {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), contents)
  }
}

const DEPLOYMENT = normalizeDeployment('dossier.acme.com')

interface World {
  readonly configPath: string
  readonly requests: SeenRequest[]
  readonly run: <A>(
    use: (sync: SyncService) => Effect.Effect<A, SyncError>,
  ) => Promise<A>
  readonly fail: (
    use: (sync: SyncService) => Effect.Effect<unknown, SyncError>,
  ) => Promise<SyncError>
}

const world = async (
  route: Route = () => new Response(null, { status: 500 }),
): Promise<World> => {
  const home = await tempDir()
  const fetch = stubFetch(route)
  const io: CliIo = {
    env: {},
    fetch: fetch.fetch,
    stdout: () => undefined,
    stderr: () => undefined,
    configPath: join(home, 'dossier', 'config.json'),
    cwd: home,
    sleep: async () => undefined,
  }
  const provided = <A>(
    use: (sync: SyncService) => Effect.Effect<A, SyncError>,
  ) =>
    Effect.flatMap(Sync, use).pipe(
      Effect.provide(SyncLive),
      Effect.provideService(Remote, { deployment: DEPLOYMENT, key: 'dsk_one' }),
      Effect.provideService(Cli, { io, output: makeOutput(io, false) }),
    )
  return {
    configPath: io.configPath,
    requests: fetch.requests,
    run: (use) => Effect.runPromise(provided(use)),
    fail: (use) => Effect.runPromise(Effect.flip(provided(use))),
  }
}

const PAGE = (body: string) =>
  `<!doctype html>\n<html>\n<head><title>T</title></head>\n<body>\n${body}\n</body>\n</html>\n`

describe('Sync.plan', () => {
  it('leaves out .git, node_modules, .DS_Store and what .dossierignore lists', async () => {
    const dir = await tempDir()
    await layout(dir, {
      'index.html': PAGE('<h1>Hi</h1>'),
      'notes/keep.txt': 'keep me\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
      'node_modules/x/index.js': 'export {}\n',
      'notes/node_modules/y.js': 'export {}\n',
      '.DS_Store': 'x',
      'notes/.DS_Store': 'x',
      '.dossierignore': 'drafts/\n*.log\n',
      'drafts/a.html': PAGE('<p>draft</p>'),
      'debug.log': 'noise\n',
      'notes/deep/trace.log': 'noise\n',
    })
    const { run } = await world()

    const plan = await run((sync) => sync.plan(dir))

    expect(plan.files.map((file) => file.path)).toEqual([
      'index.html',
      'notes/keep.txt',
    ])
    expect([...plan.ignored].sort()).toEqual([
      '.DS_Store',
      '.dossierignore',
      '.git/',
      'debug.log',
      'drafts/',
      'node_modules/',
      'notes/.DS_Store',
      'notes/deep/trace.log',
      'notes/node_modules/',
    ])
  })

  it('hashes and sizes every file, with paths inside the folder', async () => {
    const dir = await tempDir()
    const page = PAGE('<h1>Hi</h1>')
    await layout(dir, { 'index.html': page, 'data/table.csv': 'a,b\n1,2\n' })
    const { run } = await world()

    const plan = await run((sync) => sync.plan(dir))

    expect(
      plan.files.map(({ path, abs, sha256, size }) => ({
        path,
        abs,
        sha256,
        size,
      })),
    ).toEqual([
      {
        path: 'data/table.csv',
        abs: join(dir, 'data', 'table.csv'),
        sha256: sha('a,b\n1,2\n'),
        size: 8,
      },
      {
        path: 'index.html',
        abs: join(dir, 'index.html'),
        sha256: sha(page),
        size: Buffer.byteLength(page),
      },
    ])
    expect(plan.bytes).toBe(8 + Buffer.byteLength(page))
    expect(plan.files[0]?.analysis).toBeNull()
    expect(plan.files[1]?.analysis?.title).toBe('T')
    expect(plan.check.problems).toEqual([])
  })

  it('refuses a 51 MiB file before reading it', async () => {
    const dir = await tempDir()
    const handle = await open(join(dir, 'big.mp4'), 'w')
    await handle.truncate(51 * MiB)
    await handle.close()
    const { fail, requests } = await world()

    const error = await fail((sync) => sync.plan(dir))

    expect(error).toBeInstanceOf(DossierError)
    expect(error).toMatchObject({
      code: 'too_large',
      message:
        'big.mp4 is 51 MiB; one file in a push may be at most 50 MiB. ' +
        'A super admin can raise it.',
      path: 'big.mp4',
    })
    expect((error as DossierError).fix).toContain('.dossierignore')
    expect(requests).toEqual([])
  })

  it('refuses a folder of 2,001 files', async () => {
    const dir = await tempDir()
    await Promise.all(
      Array.from({ length: 2_001 }, (_, n) =>
        writeFile(join(dir, `f${n}.txt`), ''),
      ),
    )
    const { fail } = await world()

    const error = await fail((sync) => sync.plan(dir))

    expect(error).toMatchObject({
      code: 'too_large',
      message:
        'This folder holds 2,001 files; a push may hold at most 2,000 ' +
        'files. A super admin can raise it.',
    })
  })

  it('refuses a form without an action, naming the file, line and fix', async () => {
    const dir = await tempDir()
    await layout(dir, {
      'questions.html': [
        '<!doctype html>',
        '<html>',
        '<head><title>Questions</title></head>',
        '<body>',
        '<form method="post">',
        '<label>Name <input name="name"></label>',
        '</form>',
        '</body>',
        '</html>',
        '',
      ].join('\n'),
    })
    const { fail } = await world()

    const error = await fail((sync) => sync.plan(dir))

    expect(error).toMatchObject({
      code: 'policy_rejected',
      message: 'questions.html: the form on line 5 has no action.',
      fix:
        'Add action="decisions/" for one file per person, or ' +
        'action="decisions.json" for one shared file.',
    })
  })

  it('checks a form against the tree path it is pushed to, so ../ may climb inside the tree', async () => {
    const dir = await tempDir()
    await layout(dir, {
      'question.html': PAGE(
        '<form method="post" action="../answers/"><input name="a"></form>',
      ),
    })
    const { run, fail } = await world()

    const plan = await run((sync) => sync.plan(dir, 'plans'))
    expect(plan.files.map((file) => file.path)).toEqual(['question.html'])
    // At the tree's root the same form climbs out of the tree.
    const error = await fail((sync) => sync.plan(dir, ''))
    expect(error).toMatchObject({ code: 'policy_rejected' })
  })
})

const TREE_ID = 'acmetree000000000001' as TreeId
const target = (path = ''): LinkRef => ({
  workspace: 'agent964',
  tree: 'acme',
  path,
  folder: true,
})

const FILES: Record<string, string> = {
  'index.html': PAGE('<h1>Acme</h1>'),
  'answers/sara@acme.com.json': '{"teamSize":4}\n',
}
const bytesOf = (path: string): string => FILES[path] ?? ''

const entries = [
  {
    name: 'answers',
    path: 'answers',
    kind: 'folder',
    folder: true,
    size: null,
    sha256: null,
    contentType: null,
    title: null,
    push: null,
  },
  {
    name: 'sara@acme.com.json',
    path: 'answers/sara@acme.com.json',
    kind: 'data',
    folder: false,
    size: Buffer.byteLength(bytesOf('answers/sara@acme.com.json')),
    sha256: sha(bytesOf('answers/sara@acme.com.json')),
    contentType: 'application/json',
    title: null,
    push: null,
  },
  {
    name: 'index.html',
    path: 'index.html',
    kind: 'page',
    folder: false,
    size: Buffer.byteLength(bytesOf('index.html')),
    sha256: sha(bytesOf('index.html')),
    contentType: 'text/html',
    title: 'T',
    push: { number: 2, at: '2026-10-12T00:00:00.000Z' },
  },
]

const listing = (seq: number, listed: readonly unknown[] = entries) => ({
  tree: { id: TREE_ID, workspace: 'agent964', name: 'acme' },
  path: '',
  seq,
  entries: listed,
})

/** A deployment that lists FILES and serves their bytes. */
const serving =
  (seq: number): Route =>
  (request) => {
    if (request.url.pathname === '/_/api/ls') {
      return Response.json(listing(seq))
    }
    if (request.url.pathname === '/_/api/file') {
      const path = request.url.searchParams.get('path') ?? ''
      const contents = FILES[path.replace(/^agent964\/acme\//, '')]
      return contents === undefined
        ? new Response(null, { status: 404 })
        : new Response(contents)
    }
    return new Response(null, { status: 404 })
  }

describe('Sync.pull', () => {
  it('writes every file, data files read-only, and only what changed after', async () => {
    const { run, requests } = await world(serving(5))
    const dir = join(await tempDir(), 'acme')

    const first = await run((sync) => sync.pull({ target: target(), dir }))

    expect(first.written).toEqual(['answers/sara@acme.com.json', 'index.html'])
    expect(first.unchanged).toBe(0)
    expect(first.seq).toBe(5)
    expect(first.push).toBe(2)
    expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe(
      bytesOf('index.html'),
    )
    const data = await stat(join(dir, 'answers', 'sara@acme.com.json'))
    expect(data.mode & 0o777).toBe(0o444)
    const page = await stat(join(dir, 'index.html'))
    expect(page.mode & 0o200).toBe(0o200)
    expect(
      requests
        .map((request) => [
          request.url.pathname,
          request.url.searchParams.get('path'),
          request.url.searchParams.get('depth'),
        ])
        .sort(),
    ).toEqual([
      ['/_/api/file', 'agent964/acme/answers/sara@acme.com.json', null],
      ['/_/api/file', 'agent964/acme/index.html', null],
      ['/_/api/ls', 'agent964/acme', 'all'],
    ])
    for (const request of requests) {
      expect(request.url.host).toBe('dossier.acme.com')
      expect(request.headers.get('authorization')).toBe('Bearer dsk_one')
      expect(request.headers.get('Dossier-Protocol')).toBe('1')
      expect(request.redirect).toBe('manual')
    }

    requests.length = 0
    await writeFile(join(dir, 'index.html'), 'changed here\n')
    const second = await run((sync) => sync.pull({ target: target(), dir }))

    expect(second.written).toEqual(['index.html'])
    expect(second.unchanged).toBe(1)
    expect(requests.map((request) => request.url.pathname)).toEqual([
      '/_/api/ls',
      '/_/api/file',
    ])
    expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe(
      bytesOf('index.html'),
    )
  })

  it('keeps the head per deployment, tree, path and local folder', async () => {
    const { run, configPath } = await world(serving(5))
    const dirA = join(await tempDir(), 'a')
    const dirB = join(await tempDir(), 'b')

    await run((sync) => sync.pull({ target: target(), dir: dirA }))

    const heads = headStore(configPath)
    const key: HeadKey = {
      deployment: 'dossier.acme.com',
      workspace: 'agent964',
      tree: 'acme',
      path: '',
      folder: dirA,
    }
    expect(await heads.get(key)).toEqual({ treeId: TREE_ID, seq: 5 })
    expect(await heads.get({ ...key, folder: dirB })).toBeNull()
    expect(await heads.get({ ...key, path: 'plans' })).toBeNull()
    expect(await heads.get({ ...key, tree: 'other' })).toBeNull()
    expect(
      await heads.get({ ...key, deployment: 'dossier.agent964.com' }),
    ).toBeNull()

    await heads.set(
      { ...key, folder: dirB },
      { treeId: TREE_ID, seq: 9 as AuthoredSeq },
    )
    expect(await heads.get(key)).toEqual({ treeId: TREE_ID, seq: 5 })
    expect(await heads.get({ ...key, folder: dirB })).toEqual({
      treeId: TREE_ID,
      seq: 9,
    })

    const file = join(dirname(configPath), 'heads.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      heads: {
        'dossier.acme.com': {
          'agent964/acme': {
            [dirA]: { treeId: TREE_ID, seq: 5 },
            [dirB]: { treeId: TREE_ID, seq: 9 },
          },
        },
      },
    })
  })

  it('refuses a listed path that would land outside the folder', async () => {
    const { fail } = await world(() =>
      Response.json(
        listing(5, [{ ...entries[2], name: 'evil', path: '../evil.html' }]),
      ),
    )
    const dir = join(await tempDir(), 'acme')

    const error = await fail((sync) => sync.pull({ target: target(), dir }))

    expect(error.message).toContain('not inside the pulled folder')
  })

  it('makes an unchanged data file read only too', async () => {
    const { run } = await world(serving(5))
    const dir = join(await tempDir(), 'acme')
    await layout(dir, {
      'answers/sara@acme.com.json': bytesOf('answers/sara@acme.com.json'),
    })
    expect(
      (await stat(join(dir, 'answers', 'sara@acme.com.json'))).mode & 0o777,
    ).not.toBe(0o444)

    const pulled = await run((sync) => sync.pull({ target: target(), dir }))

    expect(pulled.written).toEqual(['index.html'])
    const data = await stat(join(dir, 'answers', 'sara@acme.com.json'))
    expect(data.mode & 0o777).toBe(0o444)
  })

  it('refuses to write through a symlinked folder inside the destination', async () => {
    const { fail } = await world(serving(5))
    const dir = join(await tempDir(), 'acme')
    const outside = await tempDir()
    await mkdir(dir, { recursive: true })
    await symlink(outside, join(dir, 'answers'))

    const error = await fail((sync) => sync.pull({ target: target(), dir }))

    expect(error.message).toContain('answers')
    expect(await readdir(outside)).toEqual([])
    // Nor once the downloads still in flight have finished.
    await settled(dir, outside)
    expect(await readdir(outside)).toEqual([])
  })

  it('refuses a folder swapped for a symbolic link while its file downloads', async () => {
    const dir = join(await tempDir(), 'acme')
    const outside = await tempDir()
    const swapping: Route = async (request) => {
      if (request.url.pathname === '/_/api/file') {
        const path = request.url.searchParams.get('path') ?? ''
        if (path.endsWith('sara@acme.com.json')) {
          await rm(join(dir, 'answers'), { recursive: true, force: true })
          await symlink(outside, join(dir, 'answers'))
        }
      }
      return serving(5)(request)
    }
    const { fail } = await world(swapping)

    const error = await fail((sync) => sync.pull({ target: target(), dir }))

    expect(error.message).toContain('answers')
    expect(await readdir(outside)).toEqual([])
    // Nor once the downloads still in flight have finished.
    await settled(dir, outside)
    expect(await readdir(outside)).toEqual([])
  })
})
