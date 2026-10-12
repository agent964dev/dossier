import type { AuthoredSeq, LinkRef, Person, TreeId } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Access,
  CurrentCaller,
  Files,
  Pages,
  type Caller,
  type Served,
} from '../src/core/index.ts'
import { signedIn, type Browser } from './support/browser.ts'
import { exec, rows } from './support/d1.ts'
import { harness, testRuntime } from './support/harness.ts'
import { callerOf, fresh, run, runAs, sessionFor } from './support/people.ts'
import {
  agent,
  dataFile,
  failureAs,
  join,
  nodeAt,
  person,
  pushAll,
  ref,
  share,
  team,
  treeOf,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="${'STYLE'}"></head><body>${body}</body></html>`

const FILES = {
  'index.html':
    '<!doctype html><title>Acme</title><a href="plan">Plan</a> <a href="docs/">Docs</a> <a href="docs/page">Page</a>',
  'plan.html':
    '<!doctype html><title>Plan</title><link rel="stylesheet" href="style.css"><img src="img/a.png"><a href="./">Home</a> <a href="docs/page">Docs</a>',
  'style.css': 'p { color: red }',
  'img/a.png': 'png bytes',
  'docs/page.html': page(
    'Page',
    '<img src="pic.png"><a href="../plan">Plan</a>',
  ).replace('STYLE', '../style.css'),
  'docs/pic.png': 'pic bytes',
  'guide/_layout.html':
    '<!doctype html><html><head><link rel="stylesheet" href="_theme.css"></head><body><header class="guide-header">Guide</header><slot></slot></body></html>',
  'guide/_theme.css': ':root { --accent: teal }',
  'guide/_components/acme-card.js':
    'customElements.define("acme-card", class extends HTMLElement {})',
  'guide/intro.html': '<h1>Intro</h1><acme-card>Card</acme-card>',
}

/** An owner, their workspace, and the tree pushed once. */
const world = async () => {
  const ownerBrowser = await signedIn(fresh())
  const owner = await callerOf(ownerBrowser)
  const ws = await workspace(owner.person!)
  const key = await agent(owner.person!)
  const name = `m${crypto.randomUUID().slice(0, 8)}`
  const first = await pushAll(key, `${ws.name}/${name}`, FILES)
  if (!('number' in first)) throw new Error('the push did not commit')
  const at = (path: string): LinkRef => ref(`${ws.name}/${name}/${path}`)
  return {
    ownerBrowser,
    owner,
    ws,
    key,
    name,
    treeId: first.treeId,
    seq: first.seq,
    at,
  }
}

const mv = (caller: Caller, from: LinkRef, to: LinkRef) =>
  runAs(
    caller,
    Effect.flatMap(Files, (f) => f.mv({ from, to })),
  )

const mvFailure = (caller: Caller, from: LinkRef, to: LinkRef) =>
  failureAs(
    caller,
    Effect.flatMap(Files, (f) => f.mv({ from, to })),
  )

const text = async (treeId: string, path: string) => {
  const [row] = await rows<{ sha: string }>(
    `select v.blob_sha256 as sha from nodes n join node_versions v on v.id = n.current_version_id
     where n.tree_id = ? and n.path = ? and n.deleted_at is null`,
    treeId,
    path,
  )
  if (row === undefined) return null
  return (await env.BLOBS.get(`blobs/${row.sha}`))?.text() ?? null
}

const handleFor = (caller: Caller, treeId: TreeId, path: string) =>
  runAs(
    caller,
    Effect.flatMap(Pages, (pages) => pages.view({ treeId, path })),
  )

/** A frame request as the handle's caller, or the failure's code. */
const frame = (handle: string, treeId: TreeId, seq: number, path: string) =>
  run(
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
          host: `${treeId}.content.test`,
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

const fileText = async (served: Served | string): Promise<string> => {
  if (typeof served === 'string' || served.kind !== 'file') {
    throw new Error(`not a file: ${JSON.stringify(served)}`)
  }
  return new Response(served.body).text()
}

/** A person signed in with a browser, holding a read share on the root. */
const reader = async (w: Awaited<ReturnType<typeof world>>) => {
  const browser = await signedIn(fresh())
  const caller = await callerOf(browser)
  const root = await nodeAt(w.treeId, '')
  await share(
    w.treeId,
    root!.id,
    'email',
    caller.person!.email,
    'read',
    w.owner.person!,
  )
  return { browser, caller }
}

describe('moving within a tree', () => {
  it('rewrites relative links into the moved file and out of it, and nothing else', async () => {
    const w = await world()
    const moved = await mv(w.key, w.at('plan.html'), w.at('plans/plan.html'))
    expect(moved).toMatchObject({
      from: `${w.ws.name}/${w.name}/plan.html`,
      to: `${w.ws.name}/${w.name}/plans/plan.html`,
      link: `${env.PUBLIC_ORIGIN}/${w.ws.name}/${w.name}/plans/plan`,
      rewritten: ['docs/page.html', 'index.html', 'plans/plan.html'],
      revokedTeamShares: [],
    })
    expect(await text(w.treeId, 'index.html')).toBe(
      '<!doctype html><title>Acme</title><a href="plans/plan">Plan</a> <a href="docs/">Docs</a> <a href="docs/page">Page</a>',
    )
    expect(await text(w.treeId, 'plans/plan.html')).toBe(
      '<!doctype html><title>Plan</title><link rel="stylesheet" href="../style.css"><img src="../img/a.png"><a href="../">Home</a> <a href="../docs/page">Docs</a>',
    )
    expect(await text(w.treeId, 'docs/page.html')).toContain(
      '<a href="../plans/plan">Plan</a>',
    )
    expect(await text(w.treeId, 'docs/page.html')).toContain(
      'href="../style.css"',
    )
    expect(await nodeAt(w.treeId, 'plan.html')).toBeUndefined()
    // One event; the history names where it went.
    const [event] = await rows<{ type: string; path: string; detail: string }>(
      'select type, path, detail from events where tree_id = ? order by seq desc limit 1',
      w.treeId,
    )
    expect(event).toEqual({
      type: 'move',
      path: 'plan.html',
      detail: 'plans/plan.html',
    })
  })

  it('answers the old link with a redirect to the new one, only after the access check', async () => {
    const w = await world()
    await mv(w.key, w.at('plan.html'), w.at('plans/plan.html'))
    const old = await w.ownerBrowser.fetch(`/${w.ws.name}/${w.name}/plan`)
    expect(old.status).toBe(301)
    expect(old.headers.get('location')).toBe(
      `/${w.ws.name}/${w.name}/plans/plan`,
    )
    const stranger = await signedIn(fresh())
    const refused = await stranger.fetch(`/${w.ws.name}/${w.name}/plan`)
    expect(refused.status).toBe(404)
    expect(refused.headers.get('location')).toBeNull()
    // A live node at the old path wins over the alias.
    await pushAll(
      w.key,
      `${w.ws.name}/${w.name}`,
      { ...FILES, 'plans/plan.html': FILES['plan.html'] },
      { force: true },
    )
    const live = await w.ownerBrowser.fetch(`/${w.ws.name}/${w.name}/plan`)
    expect(live.status).toBe(200)
  })

  it('keeps a frame pinned before a moved folder at its old paths, and the new paths after', async () => {
    const w = await world()
    const r = await reader(w)
    const grant = await handleFor(r.caller, w.treeId, 'docs/page')
    const before = grant.seq
    const moved = await mv(w.key, w.at('docs/'), w.at('archive/docs/'))
    expect(moved.to).toBe(`${w.ws.name}/${w.name}/archive/docs`)
    const pinned = htmlOf(
      await frame(grant.handle, w.treeId, before, 'docs/page'),
    )
    expect(pinned).toContain('<img src="pic.png">')
    expect(pinned).toContain('href="../style.css"')
    expect(
      await fileText(
        await frame(grant.handle, w.treeId, before, 'docs/pic.png'),
      ),
    ).toBe('pic bytes')
    expect(
      await fileText(await frame(grant.handle, w.treeId, before, 'style.css')),
    ).toBe('p { color: red }')
    // The frame at the new sequence knows only where it is now.
    const after = (await treeOf(w.ws.name, w.name))!.authored_seq
    const later = await handleFor(r.caller, w.treeId, 'archive/docs/page')
    expect(later.seq).toBe(after)
    expect(await frame(later.handle, w.treeId, after, 'docs/page')).toBe(
      'not_found',
    )
    expect(
      htmlOf(await frame(later.handle, w.treeId, after, 'archive/docs/page')),
    ).toContain('href="../../style.css"')
  })

  it('composes a page pinned before its folder moved with that folder’s layout, theme and component', async () => {
    const w = await world()
    const r = await reader(w)
    const grant = await handleFor(r.caller, w.treeId, 'guide/intro')
    await mv(w.key, w.at('guide/'), w.at('manual/guide/'))
    const html = htmlOf(
      await frame(grant.handle, w.treeId, grant.seq, 'guide/intro'),
    )
    expect(html).toContain('guide-header')
    expect(html).toContain('href="_theme.css"')
    expect(html).toContain('_components/acme-card.js')
    expect(
      await fileText(
        await frame(grant.handle, w.treeId, grant.seq, 'guide/_theme.css'),
      ),
    ).toBe(':root { --accent: teal }')
    expect(
      await fileText(
        await frame(
          grant.handle,
          w.treeId,
          grant.seq,
          'guide/_components/acme-card.js',
        ),
      ),
    ).toContain('acme-card')
  })

  it('keeps the first alias working after a second move', async () => {
    const w = await world()
    await mv(w.key, w.at('guide/'), w.at('manual/guide/'))
    await mv(w.key, w.at('manual/guide/'), w.at('old/guide/'))
    const first = await w.ownerBrowser.fetch(
      `/${w.ws.name}/${w.name}/guide/intro`,
    )
    expect(first.status).toBe(301)
    expect(first.headers.get('location')).toBe(
      `/${w.ws.name}/${w.name}/old/guide/intro`,
    )
    const second = await w.ownerBrowser.fetch(
      `/${w.ws.name}/${w.name}/manual/guide/intro`,
    )
    expect(second.headers.get('location')).toBe(
      `/${w.ws.name}/${w.name}/old/guide/intro`,
    )
  })

  it('takes data and comments with their folder, and a page’s comments with the page', async () => {
    const w = await world()
    const sara = await person('sara')
    await dataFile(
      w.treeId,
      `docs/answers/${sara.email}.json`,
      { role: 'Ops' },
      sara,
    )
    await dataFile(
      w.treeId,
      `docs/page.comments/${sara.email}/1.json`,
      { text: 'Nice', anchor: null },
      sara,
    )
    await dataFile(
      w.treeId,
      `plan.comments/${sara.email}/1.json`,
      { text: 'Hi', anchor: null },
      sara,
    )
    await mv(w.key, w.at('docs/'), w.at('archive/docs/'))
    expect(
      await nodeAt(w.treeId, `archive/docs/answers/${sara.email}.json`),
    ).toBeDefined()
    expect(
      await nodeAt(w.treeId, `archive/docs/page.comments/${sara.email}/1.json`),
    ).toBeDefined()
    expect(await nodeAt(w.treeId, 'docs')).toBeUndefined()
    await mv(w.key, w.at('plan.html'), w.at('plans/plan.html'))
    expect(
      await nodeAt(w.treeId, `plans/plan.comments/${sara.email}/1.json`),
    ).toBeDefined()
    expect(await nodeAt(w.treeId, 'plan.comments')).toBeUndefined()
  })

  it('moves the forms that send inside what moved', async () => {
    const w = await world()
    await pushAll(
      w.key,
      `${w.ws.name}/${w.name}/q`,
      {
        'index.html':
          '<!doctype html><title>Q</title><form action="answers/" method="post"><input name="a"><button>Send</button></form>',
      },
      { force: true },
    )
    await mv(w.key, w.at('q/'), w.at('forms/q/'))
    const targets = await rows<{ target_path: string }>(
      `select f.target_path from forms f join nodes n on n.id = f.host_node_id
         and n.current_version_id = f.host_version_id where f.tree_id = ?`,
      w.treeId,
    )
    expect(targets.map((t) => t.target_path)).toEqual(['forms/q/answers/'])
  })

  it('refuses a live node in the way, a folder into itself, a page beside a folder of its name, and data alone', async () => {
    const w = await world()
    const sara = await person('sara')
    await dataFile(
      w.treeId,
      `docs/answers/${sara.email}.json`,
      { role: 'Ops' },
      sara,
    )
    expect(
      (await mvFailure(w.key, w.at('plan.html'), w.at('index.html'))).code,
    ).toBe('conflict')
    expect(
      (await mvFailure(w.key, w.at('docs/'), w.at('docs/inner/'))).code,
    ).toBe('invalid')
    expect(
      (await mvFailure(w.key, w.at('plan.html'), w.at('docs.html'))).code,
    ).toBe('policy_rejected')
    expect(
      (await mvFailure(w.key, w.at('docs/answers/'), w.at('elsewhere/'))).code,
    ).toBe('invalid')
    expect(await nodeAt(w.treeId, 'plan.html')).toBeDefined()
  })

  it('refuses a move whose links would change files the caller cannot change, naming only the ones they read', async () => {
    const w = await world()
    const lina = await person('lina')
    const docs = await nodeAt(w.treeId, 'docs')
    await share(
      w.treeId,
      docs!.id,
      'email',
      lina.email,
      'write',
      w.owner.person!,
    )
    const theirs = await agent(lina)
    const hidden = await mvFailure(
      theirs,
      w.at('docs/page.html'),
      w.at('docs/sub/page.html'),
    )
    expect(hidden.code).toBe('forbidden')
    expect(hidden.message).toBe(
      'This move would change links in files you cannot change.',
    )
    const root = await nodeAt(w.treeId, '')
    await share(
      w.treeId,
      root!.id,
      'email',
      lina.email,
      'read',
      w.owner.person!,
    )
    const named = await mvFailure(
      theirs,
      w.at('docs/page.html'),
      w.at('docs/sub/page.html'),
    )
    expect(named.message).toBe(
      'This move would change links in files you cannot change: index.html, plan.html.',
    )
    expect(await nodeAt(w.treeId, 'docs/page.html')).toBeDefined()
    expect(await nodeAt(w.treeId, 'docs/sub')).toBeUndefined()
  })

  it('fails with conflict when a write share on a rewritten file changes between the check and the commit', async () => {
    const w = await world()
    const lina = await person('lina')
    const docs = await nodeAt(w.treeId, 'docs')
    const index = await nodeAt(w.treeId, 'index.html')
    const plan = await nodeAt(w.treeId, 'plan.html')
    for (const node of [docs, index, plan]) {
      await share(
        w.treeId,
        node!.id,
        'email',
        lina.email,
        'write',
        w.owner.person!,
      )
    }
    // Before every batch of the move, the share on index.html is made again:
    // the one the check rested on is gone each time.
    const DB = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            await target.batch([
              target
                .prepare('delete from shares where node_id = ? and target = ?')
                .bind(index!.id, lina.email),
              target
                .prepare(
                  `insert into shares (id, tree_id, node_id, target_kind, target, role, created_by, created_at)
                   values (?, ?, ?, 'email', ?, 'write', ?, ?)`,
                )
                .bind(
                  crypto.randomUUID(),
                  w.treeId,
                  index!.id,
                  lina.email,
                  w.owner.person!.id,
                  Date.now(),
                ),
            ])
            return target.batch(statements)
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    harness.use(testRuntime({ env: { DB } }))
    const failed = await mvFailure(
      await agent(lina),
      w.at('docs/page.html'),
      w.at('docs/sub/page.html'),
    )
    harness.reset()
    expect(failed.code).toBe('conflict')
    expect(await nodeAt(w.treeId, 'docs/page.html')).toBeDefined()
    expect(await text(w.treeId, 'index.html')).toBe(FILES['index.html'])
  })
})

describe('moving a tree to another workspace', () => {
  const setUp = async () => {
    const w = await world()
    const owner = w.owner.person!
    const otherAdmin = await person('other-admin')
    await join(w.ws, otherAdmin, 'admin')
    const studioAdmin = await person('studio-admin')
    const studio = await workspace(studioAdmin)
    await join(studio, owner)
    const design = await team(w.ws, 'Design', [otherAdmin])
    const root = await nodeAt(w.treeId, '')
    await share(w.treeId, root!.id, 'team', design.id, 'read', owner)
    return { ...w, otherAdmin, studioAdmin, studio }
  }

  const writes = async (who: Person, treeId: string) => {
    const root = await nodeAt(treeId, '')
    const node = (
      await rows<Record<string, unknown>>(
        'select * from nodes where id = ?',
        root!.id,
      )
    )[0]!
    return runAs(
      await sessionFor(who),
      Effect.flatMap(Access, (a) =>
        a.require('write', {
          id: node.id,
          treeId: node.tree_id,
          parentId: null,
          name: '',
          path: '',
          depth: 0,
          kind: 'folder',
          origin: 'authored',
          ownerId: null,
          currentVersionId: null,
          createdAt: node.created_at,
          deletedAt: null,
          underscoreFrom: null,
        } as never),
      ).pipe(Effect.isSuccess),
    )
  }

  it('changes the workspace, revokes team shares, moves admin write, and keeps the old link', async () => {
    const t = await setUp()
    expect(await writes(t.otherAdmin, t.treeId)).toBe(true)
    expect(await writes(t.studioAdmin, t.treeId)).toBe(false)
    const moved = await mv(
      t.key,
      ref(`${t.ws.name}/${t.name}`),
      ref(`${t.studio.name}/${t.name}`),
    )
    expect(moved).toMatchObject({
      from: `${t.ws.name}/${t.name}`,
      to: `${t.studio.name}/${t.name}`,
      revokedTeamShares: ['Design'],
    })
    expect(await treeOf(t.studio.name, t.name)).toMatchObject({ id: t.treeId })
    expect(await treeOf(t.ws.name, t.name)).toBeUndefined()
    expect(
      await rows(
        'select 1 from shares where tree_id = ? and target_kind = ?',
        t.treeId,
        'team',
      ),
    ).toEqual([])
    expect(await writes(t.studioAdmin, t.treeId)).toBe(true)
    expect(await writes(t.otherAdmin, t.treeId)).toBe(false)
    const old = await t.ownerBrowser.fetch(`/${t.ws.name}/${t.name}/plan`)
    expect(old.status).toBe(301)
    expect(old.headers.get('location')).toBe(`/${t.studio.name}/${t.name}/plan`)
  })

  it('refuses someone outside the workspace and a name it already has', async () => {
    const t = await setUp()
    const outside = await workspace(await person('elsewhere'))
    expect(
      (
        await mvFailure(
          t.key,
          ref(`${t.ws.name}/${t.name}`),
          ref(`${outside.name}/${t.name}`),
        )
      ).code,
    ).toBe('not_found')
    await pushAll(await agent(t.studioAdmin), `${t.studio.name}/${t.name}`, {
      'index.html': '<p>Taken</p>',
    })
    expect(
      (
        await mvFailure(
          t.key,
          ref(`${t.ws.name}/${t.name}`),
          ref(`${t.studio.name}/${t.name}`),
        )
      ).code,
    ).toBe('conflict')
    expect(await treeOf(t.ws.name, t.name)).toMatchObject({ id: t.treeId })
  })
})

void exec
void ({} as Browser)
