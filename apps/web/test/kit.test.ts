import type { AuthoredSeq, TreeId } from '@dossier/contracts'
import type { PageBootstrap as Bootstrap } from '@dossier/contracts/bridge'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Access,
  CurrentCaller,
  Files,
  Pages,
  TreeStore,
  type Caller,
  type CommitResult,
  type KitFound,
  type Served,
  type StageResult,
} from '../src/core/index.ts'
import { kitNames } from '../src/server/kit-row.ts'
import { signedIn } from './support/browser.ts'
import { BASE_COPY_DOC, kitRuntime } from './support/base.ts'
import { harness } from './support/harness.ts'
import { callerOf, fresh, runAs } from './support/people.ts'
import {
  agent,
  failureAs,
  nodeAt,
  pushAll,
  share,
  workspace,
} from './support/trees.ts'

let kit: ReturnType<typeof kitRuntime>
beforeEach(() => {
  kit = kitRuntime()
  harness.use(kit.runtime)
})
afterEach(() => harness.reset())

const ROOT_LAYOUT = `<!doctype html>
<html lang="en">
<head><link rel="stylesheet" href="_theme.css"><title>Acme</title></head>
<body><header class="site-header"><img src="logo.svg" alt="Acme"></header>
<slot></slot>
</body>
</html>`

const FILES = {
  '_layout.html': ROOT_LAYOUT,
  '_theme.css': ':root { --accent: teal; }',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  '_components/acme-badge.js': "import './shared.js'",
  '_components/shared.js': 'export const from = "root"',
  '_components/dossier-probe.js': 'export const from = "tree"',
  'guides/_layout.html':
    '<link rel="stylesheet" href="_theme.css"><nav class="sidebar">Guides</nav><main><slot></slot></main>',
  'guides/_theme.css': ':root { --accent: crimson; }',
  'guides/_components/shared.js': 'export const from = "guides"',
  'guides/_components/acme-card.js': 'export const card = 1',
  'guides/setup/install.html':
    '<title>Install</title><h1>Install</h1><acme-card>Card</acme-card><dossier-probe></dossier-probe><other-tag>Other</other-tag>',
  'mockups/_layout.html':
    '<!doctype html><html><head></head><body><slot></slot></body></html>',
  'mockups/one.html': '<h1>Mockup one</h1>',
  'secret/_components/acme-secret.js': 'export const secret = 1',
  'secret/_theme.css': ':root { --accent: black; }',
  'secret/page.html': '<p>Secret</p>',
  'plan.html': '<!doctype html><title>Plan</title><p>Plan</p>',
}

const committed = (result: CommitResult | StageResult): CommitResult => {
  if (!('number' in result)) throw new Error('the push did not commit')
  return result
}

/** An owner, their workspace and the kit tree pushed once. */
const world = async () => {
  const ownerBrowser = await signedIn(fresh())
  const owner = await callerOf(ownerBrowser)
  const ws = await workspace(owner.person!)
  const key = await agent(owner.person!)
  const first = committed(await pushAll(key, `${ws.name}/kit`, FILES))
  return {
    owner,
    ws,
    key,
    treeId: first.treeId,
    seq: first.seq,
    /** Pushes the tree again with these files changed. */
    repush: async (changes: Record<string, string>) =>
      committed(
        await pushAll(
          key,
          `${ws.name}/kit`,
          { ...FILES, ...changes },
          { force: true },
        ),
      ),
  }
}

/** A person signed in with a browser, holding a share on one path. */
const sharedWith = async (
  w: Awaited<ReturnType<typeof world>>,
  shares: readonly { path: string; role: 'read' | 'write' }[],
): Promise<Caller> => {
  const caller = await callerOf(await signedIn(fresh()))
  for (const { path, role } of shares) {
    const node = await nodeAt(w.treeId, path)
    if (node === undefined) throw new Error(`no node at ${path}`)
    await share(
      w.treeId,
      node.id,
      'email',
      caller.person!.email,
      role,
      w.owner.person!,
    )
  }
  return caller
}

const handleFor = (caller: Caller, treeId: TreeId, path: string) =>
  runAs(
    caller,
    Effect.flatMap(Pages, (pages) => pages.view({ treeId, path })),
  )

/** A frame request as the handle's caller, or the failure's code. */
const frame = (
  handle: string,
  treeId: TreeId,
  seq: number,
  path: string,
  host = `${treeId}.content.test`,
) =>
  kit.runtime.runPromise(
    Effect.gen(function* () {
      const pages = yield* Pages
      const caller = yield* pages.handleCaller(handle, treeId)
      if (caller === null) return 'refused' as const
      return yield* pages
        .frame({
          treeId,
          seq: seq as AuthoredSeq,
          path,
          folder: path === '' || path.endsWith('/'),
          range: null,
          ifNoneMatch: null,
          host,
          wantsAgent: false,
        })
        .pipe(
          Effect.provideService(CurrentCaller, caller),
          Effect.catchAll((error) => Effect.succeed(error.code)),
        )
    }),
  )

const htmlOf = (served: Served | string): string => {
  if (typeof served === 'string' || served.kind !== 'framePage') {
    throw new Error(`not a page: ${JSON.stringify(served)}`)
  }
  return served.html
}

const textOf = async (served: Served | string): Promise<string> => {
  if (typeof served === 'string' || served.kind !== 'file') {
    throw new Error(`not a file: ${JSON.stringify(served)}`)
  }
  return new Response(served.body).text()
}

const bootstrapOf = (html: string): Bootstrap =>
  JSON.parse(
    /<script type="application\/json" id="dossier-bootstrap">(.*?)<\/script>/s.exec(
      html,
    )![1]!,
  ) as Bootstrap

/** What TreeStore.resolve gives for a `_` path, as paths. */
const candidates = (treeId: TreeId, path: string, at?: number) =>
  kit.runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* TreeStore
      const resolved = yield* store.resolve(
        { treeId, path, folder: false },
        at as AuthoredSeq | undefined,
      )
      if ('missing' in resolved || resolved.kind !== 'kit') {
        throw new Error(`not a kit path: ${path}`)
      }
      return resolved.found.map((found: KitFound) =>
        found.kind === 'tree'
          ? `${found.node.path}@${found.version.blobSha256?.slice(0, 6)}`
          : `base:${found.path}`,
      )
    }),
  )

const strip = (list: readonly string[]) => list.map((c) => c.split('@')[0])

describe('the `_` lookup', () => {
  it('finds the closest file at or above the folder, then the base layer', async () => {
    const w = await world()
    expect(
      strip(await candidates(w.treeId, 'guides/setup/_theme.css')),
    ).toEqual(['guides/_theme.css', '_theme.css'])
    expect(
      strip(
        await candidates(w.treeId, 'guides/setup/_components/dossier-probe.js'),
      ),
    ).toEqual([
      '_components/dossier-probe.js',
      'base:_components/dossier-probe.js',
    ])
    expect(
      strip(
        await candidates(w.treeId, 'guides/setup/_components/dossier-copy.js'),
      ),
    ).toEqual(['base:_components/dossier-copy.js'])
    // A folder that does not exist still looks up from where it would be.
    expect(
      strip(await candidates(w.treeId, 'nowhere/deep/_theme.css')),
    ).toEqual(['_theme.css'])
  })

  it('never reads beside the line up to the root, nor above the tree root', async () => {
    const w = await world()
    // Another tree's root `_theme.css` is not this tree's.
    const other = committed(
      await pushAll(w.key, `${w.ws.name}/bare`, { 'page.html': '<p>x</p>' }),
    )
    expect(await candidates(other.treeId, '_theme.css')).toEqual([])
    expect(
      strip(await candidates(w.treeId, 'guides/_components/acme-secret.js')),
    ).toEqual([])
  })

  it('answers at the pinned sequence after a newer push', async () => {
    const w = await world()
    const before = await candidates(w.treeId, 'guides/setup/_theme.css', w.seq)
    const after = await w.repush({ '_theme.css': ':root { --accent: gold; }' })
    const old = await candidates(w.treeId, 'guides/setup/_theme.css', w.seq)
    const now = await candidates(w.treeId, 'guides/setup/_theme.css', after.seq)
    expect(old).toEqual(before)
    expect(now[0]).toBe(old[0])
    expect(now[1]).not.toBe(old[1])
  })
})

describe('read through the `_` files a node reaches', () => {
  it('lets a person with only a page share load its layouts, theme, components and their modules', async () => {
    const w = await world()
    const reader = await sharedWith(w, [
      { path: 'guides/setup/install.html', role: 'read' },
    ])
    const grant = await handleFor(reader, w.treeId, 'guides/setup/install')
    const page = htmlOf(
      await frame(grant.handle, w.treeId, grant.seq, 'guides/setup/install'),
    )
    expect(page).toContain('site-header')
    expect(page).toContain('class="sidebar"')
    expect(page).toContain('<title>Install</title>')
    expect(page).not.toContain('<title>Acme</title>')
    // The root layout's logo now reads from the page's folder.
    expect(page).toContain('<img src="../../logo.svg"')
    const at = (path: string) => frame(grant.handle, w.treeId, grant.seq, path)
    expect(await textOf(await at('guides/setup/_theme.css'))).toContain(
      'crimson',
    )
    expect(await textOf(await at('_components/acme-badge.js'))).toContain(
      'shared.js',
    )
    // The root component's sibling module, though guides/ has one of that name.
    expect(await textOf(await at('_components/shared.js'))).toContain('"root"')
    expect(await textOf(await at('guides/_components/shared.js'))).toContain(
      '"guides"',
    )
    // Nothing in secret/ is readable to them, so neither are its `_` files.
    expect(await at('secret/_components/acme-secret.js')).toBe('not_found')
    const secretTheme = (await nodeAt(w.treeId, 'secret/_theme.css'))!
    const refused = await failureAs(
      reader,
      Effect.flatMap(TreeStore, (store) =>
        Effect.flatMap(
          store.resolve({
            treeId: w.treeId,
            path: 'secret/_theme.css',
            folder: false,
          }),
          (resolved) => {
            if ('missing' in resolved || resolved.kind !== 'kit') {
              return Effect.die(new Error('not a kit path'))
            }
            const found = resolved.found[0]
            if (found?.kind !== 'tree' || found.node.id !== secretTheme.id) {
              return Effect.die(new Error('not the secret theme'))
            }
            return Effect.flatMap(Access, (access) =>
              access.require('read', found.node),
            )
          },
        ),
      ),
    )
    expect(refused.code).toBe('not_found')
  })

  it('gives reach only for read, and never on a node outside the reached folder', async () => {
    const w = await world()
    const reader = await sharedWith(w, [
      { path: 'guides/setup/install.html', role: 'read' },
    ])
    const layout = (await nodeAt(w.treeId, '_layout.html'))!
    const row = (await runAs(
      w.owner,
      Effect.flatMap(TreeStore, (store) =>
        store.resolve({
          treeId: w.treeId,
          path: '_layout.html',
          folder: false,
        }),
      ),
    )) as { found: readonly KitFound[] }
    const node = row.found[0]!.kind === 'tree' ? row.found[0]!.node : null
    expect(node?.id).toBe(layout.id)
    const granted = await runAs(
      reader,
      Effect.flatMap(Access, (access) => access.require('read', node!)),
    )
    expect(granted.basis).toEqual([{ kind: 'reach', from: '' }])
    const write = await failureAs(
      reader,
      Effect.flatMap(Access, (access) => access.require('write', node!)),
    )
    expect(write.code).toBe('not_found')
  })
})

describe('the kit map', () => {
  it('replaces a base component with a folder’s file of the same tag, and points each tag at its folder', async () => {
    const w = await world()
    const grant = await handleFor(w.owner, w.treeId, 'guides/setup/install')
    const html = htmlOf(
      await frame(grant.handle, w.treeId, grant.seq, 'guides/setup/install'),
    )
    const boot = bootstrapOf(html)
    expect(boot.kit).toEqual({
      'acme-badge': '../../_components/acme-badge.js',
      'acme-card': '../_components/acme-card.js',
      'dossier-probe': '../../_components/dossier-probe.js',
      'dossier-copy': '/_/base/base0000test/_components/dossier-copy.js',
      'dossier-diff': '/_/base/base0000test/_components/dossier-diff.js',
    })
    expect(boot.used).toEqual(['acme-card', 'dossier-probe'])
    expect(boot.base).toBe('base0000test')
    expect(html).toContain(
      '<script src="/_/base/base0000test/client.js"></script>' +
        '<link rel="modulepreload" href="../_components/acme-card.js">' +
        '<link rel="modulepreload" href="../../_components/dossier-probe.js">',
    )
    expect(html).not.toContain('crossorigin')
    // Another folder shares the same module URL for a root component.
    const other = await handleFor(w.owner, w.treeId, 'mockups/one')
    const mock = bootstrapOf(
      htmlOf(await frame(other.handle, w.treeId, other.seq, 'mockups/one')),
    )
    expect(mock.kit['acme-badge']).toBe('../_components/acme-badge.js')
    expect(mock.kit['acme-card']).toBeUndefined()
  })

  it('lists the kit at a folder for write holders through Files.kit', async () => {
    const w = await world()
    const listed = await runAs(
      w.owner,
      Effect.flatMap(Files, (files) =>
        files.kit({
          workspace: w.ws.name,
          tree: 'kit',
          path: 'guides/setup',
          folder: true,
        }),
      ),
    )
    expect(listed.folder).toBe('guides/setup')
    expect(
      listed.items.map((item) => [item.from, item.path, item.kind, item.tag]),
    ).toEqual([
      ['guides', '_components/acme-card.js', 'component', 'acme-card'],
      ['guides', '_components/shared.js', 'file', null],
      ['guides', '_layout.html', 'layout', null],
      ['guides', '_theme.css', 'theme', null],
      ['', '_components/acme-badge.js', 'component', 'acme-badge'],
      ['', '_components/dossier-probe.js', 'component', 'dossier-probe'],
      [null, '_components/dossier-copy.js', 'component', 'dossier-copy'],
      // The base layer's export build of dossier-diff is not a component.
      [null, '_components/dossier-diff.js', 'component', 'dossier-diff'],
    ])
    const reader = await sharedWith(w, [{ path: 'guides', role: 'read' }])
    const refused = await failureAs(
      reader,
      Effect.flatMap(Files, (files) =>
        files.kit({
          workspace: w.ws.name,
          tree: 'kit',
          path: 'guides',
          folder: true,
        }),
      ),
    )
    expect(refused.code).toBe('forbidden')
  })
})

describe('a folder read', () => {
  it('shows a write holder each base component with the base layer’s documentation, and a tree component that replaces one with its own', async () => {
    const w = await world()
    const read = await runAs(
      w.owner,
      Effect.flatMap(Pages, (pages) =>
        pages.read({
          workspace: w.ws.name,
          tree: 'kit',
          path: 'mockups',
          folder: true,
        }),
      ),
    )
    if (read.kind !== 'folder') throw new Error(`not a folder: ${read.kind}`)
    const doc = BASE_COPY_DOC.trimEnd()
      .split('\n')
      .map((line) => (line === '' ? '' : `  ${line}`))
      .join('\n')
    expect(read.text).toContain(`\n- <dossier-copy> base layer\n${doc}\n`)
    expect(read.kit?.find((item) => item.tag === 'dossier-copy')?.doc).toBe(
      BASE_COPY_DOC,
    )
    // A base component without documentation is listed alone.
    expect(read.text.endsWith('\n- <dossier-diff> base layer\n')).toBe(true)
    // The tree's dossier-probe replaces the base one, and has no notes.
    expect(read.text).toContain(
      '\n- <dossier-probe> _components/dossier-probe.js (from kit/)\n- ',
    )
    expect(read.text).not.toContain('The base probe.')
    // The base layer's export build is not a component.
    expect(read.text).not.toContain('export')
    expect(read.kit?.map((item) => item.tag)).not.toContain(
      'dossier-diff.export',
    )
  })
})

describe('the layout chain', () => {
  it('stops at the first complete layout', async () => {
    const w = await world()
    const grant = await handleFor(w.owner, w.treeId, 'mockups/one')
    const html = htmlOf(
      await frame(grant.handle, w.treeId, grant.seq, 'mockups/one'),
    )
    expect(html).toContain('<h1>Mockup one</h1>')
    expect(html).not.toContain('site-header')
    expect(
      html.startsWith('<!doctype html><html><head><meta charset="utf-8">'),
    ).toBe(true)
  })

  it('closes with the base layer’s layout when no tree layout is complete', async () => {
    const ownerBrowser = await signedIn(fresh())
    const owner = await callerOf(ownerBrowser)
    const ws = await workspace(owner.person!)
    const pushed = committed(
      await pushAll(await agent(owner.person!), `${ws.name}/plain`, {
        '_layout.html': '<nav>Plain</nav><slot></slot>',
        'page.html': '<p>Body only</p>',
      }),
    )
    const grant = await handleFor(owner, pushed.treeId, 'page')
    const html = htmlOf(
      await frame(grant.handle, pushed.treeId, grant.seq, 'page'),
    )
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    )
    expect(html).toContain('<body><nav>Plain</nav><p>Body only</p></body>')
  })
})

describe('a sequence never issued to the handle', () => {
  it('opens a page only for write on the page and every layout composed into it then', async () => {
    const w = await world()
    // The page and its layouts all change, so the old sequence is history.
    await w.repush({
      'guides/setup/install.html': '<h1>Install two</h1>',
      '_layout.html': ROOT_LAYOUT.replace(
        '</body>',
        '<footer>v2</footer></body>',
      ),
      'guides/_layout.html': `${FILES['guides/_layout.html']}<!-- v2 -->`,
    })
    const pageOnly = await sharedWith(w, [
      { path: 'guides/setup/install.html', role: 'write' },
    ])
    const one = await handleFor(pageOnly, w.treeId, 'guides/setup/install')
    expect(one.seq).not.toBe(w.seq)
    expect(
      await frame(one.handle, w.treeId, w.seq, 'guides/setup/install'),
    ).toBe('not_found')

    const chain = await sharedWith(w, [
      { path: 'guides', role: 'write' },
      { path: '_layout.html', role: 'write' },
    ])
    const two = await handleFor(chain, w.treeId, 'guides/setup/install')
    const old = htmlOf(
      await frame(two.handle, w.treeId, w.seq, 'guides/setup/install'),
    )
    expect(old).toContain('<h1>Install</h1>')

    // A complete page composes no layout, so write on it alone suffices.
    const plan = await sharedWith(w, [{ path: 'plan.html', role: 'write' }])
    const three = await handleFor(plan, w.treeId, 'plan')
    expect(
      htmlOf(await frame(three.handle, w.treeId, w.seq, 'plan')),
    ).toContain('<p>Plan</p>')
  })
})

describe('the kit row', () => {
  it('names the layout, the theme, then the rest, closest folder first, and folders count no `_` file as a page', async () => {
    const w = await world()
    const kitAtGuides = await runAs(
      w.owner,
      Effect.flatMap(Files, (files) =>
        files.kit({
          workspace: w.ws.name,
          tree: 'kit',
          path: 'guides',
          folder: true,
        }),
      ),
    )
    expect(kitNames(kitAtGuides.items)).toEqual([
      '_layout.html',
      '_theme.css',
      '_components/',
    ])
    const root = await runAs(
      w.owner,
      Effect.flatMap(Files, (files) =>
        files.ls({
          ref: { workspace: w.ws.name, tree: 'kit', path: '', folder: true },
          depth: 'one',
        }),
      ),
    )
    const mockups = root.entries.find((e) => e.path === 'mockups')
    expect(mockups?.pages).toBe(1)
  })
})

describe('what a view issues with a composed page', () => {
  it("keeps an open tab's layouts after a push changes them, and never shows them to a reader shared later", async () => {
    const w = await world()
    const reader = await sharedWith(w, [{ path: '', role: 'read' }])
    const open = await handleFor(reader, w.treeId, 'guides/setup/install')
    expect(open.seq).toBe(w.seq)
    await w.repush({
      '_layout.html': ROOT_LAYOUT.replace(
        '</body>',
        '<footer>v2</footer></body>',
      ),
      'guides/_layout.html':
        '<nav class="sidebar">Guides v2</nav><main><slot></slot></main>',
      'logo.svg':
        '<svg xmlns="http://www.w3.org/2000/svg"><circle r="3"/></svg>',
      'guides/_components/acme-card.js': 'export const card = 2',
    })
    // The open tab still composes the layouts it was issued, and loads the
    // files they and the page use, as they were.
    const old = htmlOf(
      await frame(open.handle, w.treeId, w.seq, 'guides/setup/install'),
    )
    expect(old).toContain('<nav class="sidebar">Guides</nav>')
    // Look for the pushed markers themselves: a random tree id in the page
    // may contain "v2" too.
    expect(old).not.toContain('<footer>v2</footer>')
    expect(old).not.toContain('Guides v2')
    for (const path of ['logo.svg', 'guides/_components/acme-card.js']) {
      expect(
        await frame(open.handle, w.treeId, w.seq, path),
        path,
      ).toMatchObject({ kind: 'file' })
    }
    // A reader given the tree after the push was never issued the old
    // layouts, so the old sequence is not theirs to open.
    const laterReader = await sharedWith(w, [{ path: '', role: 'read' }])
    const renewed = await handleFor(
      laterReader,
      w.treeId,
      'guides/setup/install',
    )
    expect(renewed.seq).toBe(w.seq + 1)
    expect(
      await frame(renewed.handle, w.treeId, w.seq, 'guides/setup/install'),
    ).toBe('not_found')
    expect(
      await frame(
        renewed.handle,
        w.treeId,
        w.seq,
        'guides/_components/acme-card.js',
      ),
    ).toBe('not_found')
    expect(
      htmlOf(
        await frame(
          renewed.handle,
          w.treeId,
          renewed.seq,
          'guides/setup/install',
        ),
      ),
    ).toContain('Guides v2')
  })
})

describe('an open tab after a later push', () => {
  it('opens layouts and `_` files it was never issued only for a reader whose grant predates the view', async () => {
    const w = await world()
    const early = await sharedWith(w, [{ path: '', role: 'read' }])
    const late = await sharedWith(w, [{ path: 'plan.html', role: 'read' }])
    const a = await handleFor(early, w.treeId, 'plan')
    const b = await handleFor(late, w.treeId, 'plan')
    expect(b.seq).toBe(a.seq)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const guides = (await nodeAt(w.treeId, 'guides'))!
    await share(
      w.treeId,
      guides.id,
      'email',
      late.person!.email,
      'read',
      w.owner.person!,
    )
    await w.repush({
      'guides/_layout.html':
        '<nav class="sidebar">Guides v2</nav><main><slot></slot></main>',
      'guides/_components/shared.js': 'export const from = "guides v2"',
    })
    // Neither viewed the guide at this sequence: the reader who could read
    // it then still opens it as it was, layouts and `_` files included.
    const old = htmlOf(
      await frame(a.handle, w.treeId, a.seq, 'guides/setup/install'),
    )
    expect(old).toContain('<nav class="sidebar">Guides</nav>')
    expect(
      await frame(a.handle, w.treeId, a.seq, 'guides/_components/shared.js'),
    ).toMatchObject({ kind: 'file' })
    // The reader given the guides after the view could not read them then.
    expect(await frame(b.handle, w.treeId, b.seq, 'guides/setup/install')).toBe(
      'not_found',
    )
    expect(
      await frame(b.handle, w.treeId, b.seq, 'guides/_components/shared.js'),
    ).toBe('not_found')
  })
})
