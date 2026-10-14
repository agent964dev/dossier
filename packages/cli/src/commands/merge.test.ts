import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
const LINK = 'https://dossier.acme.com/agent964/acme/'

const PNG = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, n])
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const page = (...lines: string[]) => `${lines.join('\n')}\n`

type Files = Record<string, string | Buffer>

/**
 * A tree on a stub deployment: each `set` is one push. Paths under
 * `answers/` are people's data. A push is accepted when its base is the
 * tree's sequence, and changes nothing.
 */
const deployment = () => {
  let files: Files = {}
  let seq = 0
  let push = 0
  /** Runs while a file downloads, as something else edits the folder. */
  let onDownload: (() => Promise<void>) | null = null
  const bytesOf = (path: string) => {
    const value = files[path]
    return value === undefined ? null : Buffer.from(value)
  }
  const entry = (path: string, value: string | Buffer) => {
    const bytes = Buffer.from(value)
    const data = path.startsWith('answers/')
    return {
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      kind: data ? 'data' : path.endsWith('.html') ? 'page' : 'attachment',
      folder: false,
      size: bytes.byteLength,
      sha256: sha(bytes),
      contentType: null,
      title: null,
      push: data ? null : { number: push, at: '2026-10-14T00:00:00Z' },
    }
  }
  const route: Route = async (request) => {
    const path = request.url.pathname
    if (path === '/_/api/ls') {
      const data = Object.keys(files).some((p) => p.startsWith('answers/'))
      return Response.json({
        tree: { id: TREE_ID, workspace: 'agent964', name: 'acme' },
        path: '',
        seq,
        entries: [
          ...(data
            ? [
                {
                  ...entry('answers', ''),
                  kind: 'data',
                  folder: true,
                  size: null,
                  sha256: null,
                },
              ]
            : []),
          ...Object.entries(files).map(([p, value]) => entry(p, value)),
        ],
      })
    }
    if (path === '/_/api/file') {
      await onDownload?.()
      const asked = (request.url.searchParams.get('path') ?? '').replace(
        /^agent964\/acme\//,
        '',
      )
      const bytes = bytesOf(asked)
      return bytes === null
        ? errorResponse('not_found')
        : new Response(new Uint8Array(bytes))
    }
    if (request.method === 'POST' && path === '/_/api/pushes') {
      const body = request.body as { baseSeq: number | null }
      if (body.baseSeq !== seq) {
        return errorResponse(
          'stale_head',
          'Someone pushed to agent964/acme since this folder last pulled or pushed it.',
          'Pull it and push from there.',
        )
      }
      return Response.json({
        pushId: null,
        missing: [],
        plan: {
          createsTree: false,
          added: [],
          changed: [],
          deleted: [],
          unchanged: 0,
          ignored: [],
          warnings: [],
        },
        link: LINK,
        tree: { id: TREE_ID, seq, push },
      })
    }
    return new Response(null, { status: 404 })
  }
  return {
    route,
    duringDownload: (run: () => Promise<void>) => {
      onDownload = run
    },
    /** One push: the tree holds these files now. */
    set: (next: Files) => {
      files = next
      seq += 1
      push += 1
    },
  }
}

let current: Harness | undefined
let requests: SeenRequest[] = []
const setUp = async () => {
  const tree = deployment()
  const fetch = stubFetch(tree.route)
  requests = fetch.requests
  current = await harness({ fetch: fetch.fetch, env: ENV })
  const cli = current
  const at = (path: string) => join(cli.dir, 'site', path)
  return {
    cli,
    tree,
    read: (path: string) => readFile(at(path), 'utf8'),
    bytes: (path: string) => readFile(at(path)),
    exists: (path: string) =>
      stat(at(path)).then(
        () => true,
        () => false,
      ),
    write: async (path: string, value: string | Buffer) => {
      await mkdir(dirname(at(path)), { recursive: true })
      await writeFile(at(path), value)
    },
    remove: (path: string) => rm(at(path)),
    /** The file names the folder holds, as the file system spells them. */
    names: (path = '') => readdir(join(cli.dir, 'site', path)),
    pushes: () =>
      requests.filter(
        (r) => r.method === 'POST' && r.url.pathname === '/_/api/pushes',
      ).length,
  }
}
afterEach(async () => {
  await current?.cleanup()
  current = undefined
})

const PLAN = page('<h1>Plan</h1>', 'Start: March', 'Team: 4', 'Status: draft')

describe('dossier pull --merge', () => {
  it("takes the tree's changes, keeps the folder's and merges text both changed", async () => {
    const { cli, tree, read, bytes, exists, write, remove } = await setUp()
    tree.set({
      'plan.html': PLAN,
      'notes.html': page('<p>Notes</p>'),
      'logo.png': PNG(1),
      'answers/sara.json': '{"ok":true}\n',
    })
    expect(await cli.run(['pull', 'agent964/acme', 'site'])).toBe(0)

    // This machine.
    await write(
      'plan.html',
      page('<h1>Plan</h1>', 'Start: March', 'Team: 4', 'Status: review'),
    )
    await write('draft.html', page('<p>Draft</p>'))
    await write('logo.png', PNG(2))
    await write('.dossierignore', 'scratch/\n')
    await write('scratch/x.html', page('<p>Mine</p>'))
    // Another machine's push.
    tree.set({
      'plan.html': page(
        '<h1>Plan</h1>',
        'Start: April',
        'Team: 4',
        'Status: draft',
      ),
      'new.html': page('<p>New</p>'),
      'logo.png': PNG(3),
      'scratch/x.html': page('<p>Theirs</p>'),
      'answers/sara.json': '{"ok":false}\n',
    })

    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(7)
    expect(cli.stdout()).toBe(
      [
        'kept     draft.html',
        "conflict logo.png  (both sides changed it; the tree's version is in logo.theirs.png)",
        'taken    new.html',
        'deleted  notes.html',
        'merged   plan.html',
        'Merged the tree at push 2 into site; 1 conflict to resolve, then push.',
        '',
      ].join('\n'),
    )
    expect(await read('plan.html')).toBe(
      page('<h1>Plan</h1>', 'Start: April', 'Team: 4', 'Status: review'),
    )
    expect(await read('new.html')).toBe(page('<p>New</p>'))
    expect(await exists('notes.html')).toBe(false)
    expect(await bytes('logo.png')).toEqual(PNG(2))
    expect(await bytes('logo.theirs.png')).toEqual(PNG(3))
    // People's data, and what push leaves out, stay as they were.
    expect(await read('answers/sara.json')).toBe('{"ok":true}\n')
    expect(await read('scratch/x.html')).toBe(page('<p>Mine</p>'))

    // Nothing goes out, and no merge runs, while theirs is beside it.
    const before = requests.length
    expect(await cli.run(['push', 'site', 'agent964/acme'])).toBe(7)
    expect(cli.stderr()).toBe(
      'dossier: A file from dossier pull --merge is not resolved: ' +
        'logo.theirs.png is still in the folder.\n' +
        'In a text file, keep the right lines and remove the marker lines; ' +
        'for a binary file, keep one version and delete its .theirs file. ' +
        'Then push again.\n',
    )
    expect(await cli.run(['push', 'site', 'agent964/acme', '--force'])).toBe(7)
    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(7)
    expect(cli.stderr()).toContain('Then run dossier pull --merge again.')
    expect(requests.length).toBe(before)

    await remove('logo.theirs.png')
    expect(await cli.run(['push', 'site', 'agent964/acme'])).toBe(0)
  })

  it('leaves markers where both changed the same lines, and push waits for them', async () => {
    const { cli, tree, read, write, pushes } = await setUp()
    tree.set({ 'plan.html': PLAN })
    expect(await cli.run(['pull', 'agent964/acme', 'site'])).toBe(0)
    await write(
      'plan.html',
      page('<h1>Plan</h1>', 'Start: March', 'Team: 4', 'Status: review'),
    )
    tree.set({
      'plan.html': page(
        '<h1>Plan</h1>',
        'Start: March',
        'Team: 4',
        'Status: approved',
      ),
    })

    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(7)
    expect(cli.stdout()).toContain(
      'conflict plan.html  (both sides changed the same lines)\n',
    )
    expect(await read('plan.html')).toBe(
      page(
        '<h1>Plan</h1>',
        'Start: March',
        'Team: 4',
        '<<<<<<< local',
        'Status: review',
        '=======',
        'Status: approved',
        '>>>>>>> push 2',
      ),
    )
    expect(await cli.run(['push', 'site', 'agent964/acme'])).toBe(7)
    expect(cli.stderr()).toContain('plan.html still has conflict markers')
    expect(pushes()).toBe(0)

    await write(
      'plan.html',
      page('<h1>Plan</h1>', 'Start: March', 'Team: 4', 'Status: approved'),
    )
    expect(await cli.run(['push', 'site', 'agent964/acme'])).toBe(0)
    expect(pushes()).toBe(1)
  })

  it('keeps a resolution when the tree changes again before the push', async () => {
    const { cli, tree, read, write } = await setUp()
    tree.set({ 'plan.html': PLAN })
    expect(await cli.run(['pull', 'agent964/acme', 'site'])).toBe(0)
    await write(
      'plan.html',
      page('<h1>Plan</h1>', 'Start: March', 'Team: 4', 'Status: review'),
    )
    tree.set({
      'plan.html': page(
        '<h1>Plan</h1>',
        'Start: March',
        'Team: 4',
        'Status: approved',
      ),
    })
    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(7)
    await write(
      'plan.html',
      page('<h1>Plan</h1>', 'Start: March', 'Team: 4', 'Status: approved!'),
    )
    // Someone pushes while this machine resolves.
    tree.set({
      'plan.html': page(
        '<h1>Plan</h1>',
        'Start: May',
        'Team: 4',
        'Status: approved',
      ),
    })

    expect(await cli.run(['push', 'site', 'agent964/acme'])).toBe(5)
    expect(cli.stderr()).toContain(
      'Run `dossier pull --merge agent964/acme site`, resolve any conflicts ' +
        'it reports, then push again.',
    )
    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(0)
    expect(cli.stdout()).toBe(
      'merged   plan.html\n' +
        'Merged the tree at push 3 into site. Push to publish the result.\n',
    )
    expect(await read('plan.html')).toBe(
      page('<h1>Plan</h1>', 'Start: May', 'Team: 4', 'Status: approved!'),
    )
    expect(await cli.run(['push', 'site', 'agent964/acme'])).toBe(0)
  })

  it('keeps the changed side of a file the other side deleted', async () => {
    const { cli, tree, read, write, remove, pushes } = await setUp()
    tree.set({ 'a.html': page('<p>A</p>'), 'b.html': page('<p>B</p>') })
    expect(await cli.run(['pull', 'agent964/acme', 'site'])).toBe(0)
    await remove('a.html')
    await write('b.html', page('<p>B, changed here</p>'))
    tree.set({ 'a.html': page('<p>A, changed there</p>') })

    expect(
      await cli.run(['pull', '--merge', 'agent964/acme', 'site', '--json']),
    ).toBe(7)
    expect(JSON.parse(cli.stdout())).toEqual({
      files: [
        {
          path: 'a.html',
          result: 'conflict',
          conflict: 'deleted-here',
          fix: 'It was deleted here and changed in the tree. Keep it, or delete it again.',
        },
        {
          path: 'b.html',
          result: 'conflict',
          conflict: 'deleted-there',
          fix: 'It was changed here and deleted in the tree. Keep it, or delete it.',
        },
      ],
      unchanged: 0,
      conflicts: 2,
      base: true,
      seq: 2,
      push: 2,
      dir: expect.stringMatching(/\/site$/),
    })
    expect(await read('a.html')).toBe(page('<p>A, changed there</p>'))
    expect(await read('b.html')).toBe(page('<p>B, changed here</p>'))
    // Keeping or deleting either resolves it: push goes ahead.
    expect(await cli.run(['push', 'site', 'agent964/acme'])).toBe(0)
    expect(pushes()).toBe(1)
  })

  it('treats every difference as a conflict in a folder with no copy of its last sync', async () => {
    const { cli, tree, read, write } = await setUp()
    tree.set({
      'same.html': page('<p>Same</p>'),
      'differs.html': page('<p>Theirs</p>'),
      'theirs.html': page('<p>Only there</p>'),
    })
    await write('same.html', page('<p>Same</p>'))
    await write('differs.html', page('<p>Ours</p>'))
    await write('ours.html', page('<p>Only here</p>'))

    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(7)
    expect(cli.stdout()).toBe(
      [
        'conflict differs.html  (both sides changed the same lines)',
        'kept     ours.html',
        'taken    theirs.html',
        'This folder had no copy of its last sync, so every file that ' +
          'differs counts as changed on both sides.',
        'Merged the tree at push 1 into site; 1 conflict to resolve, then push.',
        '',
      ].join('\n'),
    )
    expect(await read('differs.html')).toBe(
      page(
        '<<<<<<< local',
        '<p>Ours</p>',
        '=======',
        '<p>Theirs</p>',
        '>>>>>>> push 1',
      ),
    )
  })

  it("fills an empty folder like a pull, without people's data", async () => {
    const { cli, tree, read, exists } = await setUp()
    tree.set({ 'plan.html': PLAN, 'answers/sara.json': '{"ok":true}\n' })

    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(0)
    expect(cli.stdout()).toBe(
      'taken    plan.html\n' +
        'Merged the tree at push 1 into site. Push to publish the result.\n',
    )
    expect(await read('plan.html')).toBe(PLAN)
    expect(await exists('answers/sara.json')).toBe(false)

    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(0)
    expect(cli.stdout()).toBe('site is up to date at push 1.\n')
  })

  it('keeps a conflict open across a plain pull that does not settle it', async () => {
    const { cli, tree, write } = await setUp()
    tree.set({ 'logo.png': PNG(1) })
    expect(await cli.run(['pull', 'agent964/acme', 'site'])).toBe(0)
    await write('logo.png', PNG(2))
    tree.set({ 'logo.png': PNG(3) })
    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(7)

    expect(await cli.run(['pull', 'agent964/acme', 'site'])).toBe(0)
    expect(await cli.run(['push', 'site', 'agent964/acme'])).toBe(7)
    expect(cli.stderr()).toContain('logo.theirs.png is still in the folder')
  })

  it('follows a rename that changes only letter case', async () => {
    const { cli, tree, read, names } = await setUp()
    tree.set({ 'notes.html': page('<p>Notes</p>') })
    expect(await cli.run(['pull', 'agent964/acme', 'site'])).toBe(0)
    tree.set({ 'Notes.html': page('<p>Notes</p>') })

    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(0)
    expect(cli.stdout()).toBe(
      'taken    Notes.html\n' +
        'deleted  notes.html\n' +
        'Merged the tree at push 2 into site. Push to publish the result.\n',
    )
    expect(await names()).toEqual(['Notes.html'])
    expect(await read('Notes.html')).toBe(page('<p>Notes</p>'))
  })

  it('stops before writing over a local file under another letter case', async () => {
    const { cli, tree, read, write, names } = await setUp()
    tree.set({ 'notes.html': page('<p>Notes</p>') })
    expect(await cli.run(['pull', 'agent964/acme', 'site'])).toBe(0)
    await write('notes.html', page('<p>Notes, changed here</p>'))
    tree.set({ 'Notes.html': page('<p>Notes</p>') })
    const ignoresCase =
      (await names()).length === 1 &&
      (await stat(join(cli.dir, 'site', 'NOTES.HTML')).then(
        () => true,
        () => false,
      ))

    const exit = await cli.run(['pull', '--merge', 'agent964/acme', 'site'])
    if (ignoresCase) {
      expect(exit).toBe(1)
      expect(cli.stderr()).toContain(
        'Notes.html in the tree is the same file on this machine as notes.html',
      )
      expect(await names()).toEqual(['notes.html'])
      expect(await read('notes.html')).toBe(page('<p>Notes, changed here</p>'))
    } else {
      expect(exit).toBe(7)
      expect(await names()).toEqual(['Notes.html', 'notes.html'])
    }
  })

  it('stops before replacing a file edited while the merge downloads', async () => {
    const { cli, tree, read, write } = await setUp()
    tree.set({ 'plan.html': PLAN })
    expect(await cli.run(['pull', 'agent964/acme', 'site'])).toBe(0)
    tree.set({ 'plan.html': page('<h1>Plan</h1>', 'Start: April') })
    tree.duringDownload(() =>
      write('plan.html', page('<p>Edited just now</p>')),
    )

    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(1)
    expect(cli.stderr()).toContain(
      'plan.html changed while dossier pull --merge ran',
    )
    expect(await read('plan.html')).toBe(page('<p>Edited just now</p>'))
  })

  it('keeps the conflicts of a merge that stops part way', async () => {
    const { cli, tree, read, write } = await setUp()
    tree.set({ 'a.html': PLAN, 'b.html': page('<p>B</p>') })
    expect(await cli.run(['pull', 'agent964/acme', 'site'])).toBe(0)
    await write(
      'a.html',
      page('<h1>Plan</h1>', 'Start: March', 'Team: 4', 'Status: review'),
    )
    tree.set({
      'a.html': page(
        '<h1>Plan</h1>',
        'Start: March',
        'Team: 4',
        'Status: done',
      ),
      'b.html': page('<p>B, changed there</p>'),
    })
    // a.html gets its markers first; b.html, edited meanwhile, stops it.
    tree.duringDownload(() => write('b.html', page('<p>B, edited now</p>')))

    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(1)
    expect(await read('a.html')).toContain('<<<<<<< local\n')
    expect(await cli.run(['push', 'site', 'agent964/acme', '--force'])).toBe(7)
    expect(cli.stderr()).toContain('a.html still has conflict markers')
  })

  it('stops before writing a file where the folder holds a file on its way', async () => {
    const { cli, tree, read, write, exists } = await setUp()
    await write('notes', 'mine\n')
    tree.set({ 'a.html': page('<p>A</p>'), 'notes/b.html': page('<p>B</p>') })

    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(1)
    expect(cli.stderr()).toContain(
      'notes/b.html in the tree needs a folder where',
    )
    expect(await read('notes')).toBe('mine\n')
    expect(await exists('a.html')).toBe(false)
  })

  it('stops before writing a file where the folder holds a folder', async () => {
    const { cli, tree, read, write } = await setUp()
    await write('z/x.html', page('<p>Mine</p>'))
    tree.set({ z: 'a file\n' })

    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(1)
    expect(cli.stderr()).toContain('z in the tree is where')
    expect(await read('z/x.html')).toBe(page('<p>Mine</p>'))
  })

  it('does not trust a copy that does not match the last sync', async () => {
    const { cli, tree, write } = await setUp()
    tree.set({ 'plan.html': PLAN })
    expect(await cli.run(['pull', 'agent964/acme', 'site'])).toBe(0)
    await rm(join(cli.dir, 'dossier', 'heads.json'))
    await write(
      'plan.html',
      page('<h1>Plan</h1>', 'Start: March', 'Team: 4', 'Status: review'),
    )
    tree.set({
      'plan.html': page(
        '<h1>Plan</h1>',
        'Start: May',
        'Team: 4',
        'Status: draft',
      ),
    })

    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(7)
    expect(cli.stdout()).toContain('This folder had no copy of its last sync')
  })

  it('makes one conflict of a file whose base text is damaged, never a guess', async () => {
    const { cli, tree, read, write } = await setUp()
    tree.set({ 'plan.html': PLAN })
    expect(await cli.run(['pull', 'agent964/acme', 'site'])).toBe(0)
    const bases = join(cli.dir, 'dossier', 'bases')
    const [copy] = await readdir(bases)
    const [blob] = await readdir(join(bases, copy!, 'blobs'))
    await writeFile(join(bases, copy!, 'blobs', blob!), '<h1>Pl')
    await write('plan.html', '')
    tree.set({
      'plan.html': page(
        '<h1>Plan</h1>',
        'Start: May',
        'Team: 4',
        'Status: draft',
      ),
    })

    expect(await cli.run(['pull', '--merge', 'agent964/acme', 'site'])).toBe(7)
    expect(await read('plan.html')).toBe(
      '<<<<<<< local\n=======\n' +
        page('<h1>Plan</h1>', 'Start: May', 'Team: 4', 'Status: draft') +
        '>>>>>>> push 2\n',
    )
  })
})
