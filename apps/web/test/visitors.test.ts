import type { TreeId } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Access, Pages, TreeStore } from '../src/core/index.ts'
import { VISITOR_COOKIE } from '../src/edge/caller.ts'
import { Browser, signedIn } from './support/browser.ts'
import { beforeBatch, count, exec, rows } from './support/d1.ts'
import { harness, ORIGIN, testRuntime } from './support/harness.ts'
import { fresh, runAs } from './support/people.ts'
import {
  agent,
  dataFile,
  nodeAt,
  person,
  pushAll,
  ref,
  share,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const QUESTIONS = `<!doctype html><html><head>
<title>Delivery questions</title>
<meta name="description" content="Tell us how your trucks run.">
<meta property="og:image" content="cover.png">
</head><body>
<img src="photo.png">
<a href="../private">Private</a>
<form action="answers/" method="post"><label>Role <input name="role"></label><button>Send</button></form>
</body></html>`

const FILES = {
  '_layout.html': '<header>Acme</header><slot></slot>',
  '_theme.css': ':root { --accent: teal }',
  'questions/index.html': QUESTIONS,
  'questions/cover.png': 'cover',
  'questions/photo.png': 'photo',
  'private.html': '<!doctype html><title>Salaries</title><p>Private</p>',
}

let ws: { id: string; name: string }
let treeId: TreeId
let content: string
let owner: Awaited<ReturnType<typeof person>>

beforeAll(async () => {
  owner = await person('owner')
  ws = await workspace(owner)
  const pushed = await pushAll(await agent(owner), `${ws.name}/acme`, FILES)
  if (!('treeId' in pushed)) throw new Error('no tree')
  treeId = pushed.treeId
  content = `${treeId}.content.test`
  const questions = await nodeAt(treeId, 'questions')
  await share(treeId, questions!.id, 'anyone', '*', 'respond', owner)
  await dataFile(
    treeId,
    'questions/answers/sara@acme.com.json',
    { role: 'driver' },
    await person('sara'),
  )
})

const metaOf = (html: string, key: string) =>
  new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)">`).exec(
    html,
  )?.[1] ?? null

const viewAs = (browser: Browser, path: string, renewal?: boolean) =>
  browser.fetch('/_/api/view', {
    method: 'POST',
    purpose: 'write',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tree: treeId,
      path,
      ...(renewal === undefined ? {} : { renewal }),
    }),
  })

describe('a visitor on the main host', () => {
  it('gets the shell of a public page with an anonymous session and the page’s preview', async () => {
    const visitor = new Browser()
    const response = await visitor.fetch(`/${ws.name}/acme/questions/`)
    expect(response.status).toBe(200)
    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatch(
      new RegExp(
        `^${VISITOR_COOKIE.replace('.', '\\.')}=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax$`,
      ),
    )
    const html = await response.text()
    expect(html).toContain('<title>Delivery questions</title>')
    expect(metaOf(html, 'description')).toBe('Tell us how your trucks run.')
    expect(metaOf(html, 'og:title')).toBe('Delivery questions')
    expect(metaOf(html, 'og:description')).toBe('Tell us how your trucks run.')
    expect(metaOf(html, 'og:site_name')).toBe('dossier.test')
    const image = metaOf(html, 'og:image')
    expect(image).toBe(
      `${ORIGIN}/_/api/file?path=${encodeURIComponent(`${ws.name}/acme/questions/cover.png`)}`,
    )
    // The image answers anyone, with no cookie, as an image.
    const fetched = await SELF.fetch(image!)
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('content-type')).toBe('image/png')
    expect(new TextDecoder().decode(await fetched.arrayBuffer())).toBe('cover')
    // The session is kept, not handed out again.
    const again = await visitor.fetch(`/${ws.name}/acme/questions/`)
    expect(again.headers.getSetCookie()).toEqual([])
  })

  it('is sent to sign in for a private link, whose shell names only the deployment for those who open it', async () => {
    const visitor = new Browser()
    const response = await visitor.fetch(`/${ws.name}/acme/private`)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      `/_/sign-in?next=${encodeURIComponent(`/${ws.name}/acme/private`)}`,
    )
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it('shows someone who opens a private page a shell that names only the deployment', async () => {
    const identity = fresh()
    await share(
      treeId,
      (await nodeAt(treeId, 'private.html'))!.id,
      'email',
      identity.email.toLowerCase(),
      'read',
      owner,
    )
    const reader = await signedIn(identity)
    const response = await reader.fetch(`/${ws.name}/acme/private`)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('<title>dossier.test</title>')
    expect(html).not.toContain('<title>Salaries</title>')
    for (const key of [
      'description',
      'og:title',
      'og:description',
      'og:image',
      'og:site_name',
    ]) {
      expect(metaOf(html, key)).toBeNull()
    }
  })
})

describe('a visitor’s view handle on the content host', () => {
  it('loads the public page, the `_` files above it and its images, sets no cookie, and keeps people’s data and private pages out', async () => {
    const visitor = new Browser()
    await visitor.fetch(`/${ws.name}/acme/questions/`)
    const view = await viewAs(visitor, 'questions/')
    expect(view.status).toBe(200)
    const grant = (await view.json()) as {
      handle: string
      seq: number
      email: string | null
      role: string
    }
    expect(grant.email).toBeNull()
    expect(grant.role).toBe('respond')
    const frame = (path: string) =>
      visitor.fetch(`/_/v/${grant.handle}/${grant.seq}/${path}`, {
        host: content,
        purpose: 'none',
      })
    for (const path of [
      'questions/',
      'questions/_theme.css',
      '_layout.html',
      'questions/photo.png',
    ]) {
      const response = await frame(path)
      expect(response.status, path).toBe(200)
      expect(response.headers.getSetCookie(), path).toEqual([])
    }
    for (const path of [
      'questions/answers/sara@acme.com.json',
      'questions/answers/',
      'private',
    ]) {
      expect((await frame(path)).status, path).toBe(404)
    }
    // Another browser's session gets a handle of its own.
    const other = new Browser()
    await other.fetch(`/${ws.name}/acme/questions/`)
    const theirs = (await (await viewAs(other, 'questions/')).json()) as {
      handle: string
    }
    expect(theirs.handle).not.toBe(grant.handle)
    // Without the anonymous session there is no handle.
    const bare = await new Browser().fetch('/_/api/view', {
      method: 'POST',
      purpose: 'write',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree: treeId, path: 'questions/' }),
    })
    expect(bare.status).toBe(401)
    // A private page gets no handle.
    expect((await viewAs(visitor, 'private')).status).toBe(401)
  })

  it('counts a view once per load and never on an hourly renewal', async () => {
    const page = await nodeAt(treeId, 'questions/index.html')
    const views = () => count('page_views', 'node_id = ?', page!.id)
    const total = async () =>
      (
        await runAs(
          await agent(owner),
          Effect.flatMap(Pages, (pages) =>
            pages.seenBy(ref(`${ws.name}/acme/questions/`)),
          ),
        )
      ).views
    const before = (await total()) ?? 0
    const visitor = new Browser()
    await visitor.fetch(`/${ws.name}/acme/questions/`)
    expect((await viewAs(visitor, 'questions/')).status).toBe(200)
    expect(await total()).toBe(before + 1)
    expect((await viewAs(visitor, 'questions/', true)).status).toBe(200)
    expect(await total()).toBe(before + 1)
    expect((await viewAs(visitor, 'questions/')).status).toBe(200)
    expect(await total()).toBe(before + 2)
    // One row per day.
    expect(await views()).toBe(1)
    // A private page counts nothing, and its Seen by has no count.
    const ownerView = await runAs(
      await agent(owner),
      Effect.flatMap(Pages, (pages) =>
        pages.seenBy(ref(`${ws.name}/acme/private`)),
      ),
    )
    expect(ownerView.views).toBeNull()
  })
})

describe('what a page share carries over time', () => {
  it('never opens an older version through a dependency a later push added', async () => {
    const who = await person('owner')
    const space = await workspace(who)
    const ownerAgent = await agent(who)
    const first = await pushAll(ownerAgent, `${space.name}/later`, {
      'pub.html': '<!doctype html><title>Public</title><p>Public</p>',
      'secret.html': '<!doctype html><title>Secret</title><p>SECRET-ONE</p>',
    })
    if (!('treeId' in first)) throw new Error('no tree')
    const tree = first.treeId
    const pub = await nodeAt(tree, 'pub.html')
    await share(tree, pub!.id, 'anyone', '*', 'read', who)
    const visitor = new Browser()
    await visitor.fetch(`/${space.name}/later/pub`)
    const view = await visitor.fetch('/_/api/view', {
      method: 'POST',
      purpose: 'write',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree, path: 'pub' }),
    })
    const grant = (await view.json()) as { handle: string; seq: number }
    // The public page now frames the private one, which changed meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await pushAll(
      ownerAgent,
      `${space.name}/later`,
      {
        'pub.html':
          '<!doctype html><title>Public</title><iframe src="secret"></iframe>',
        'secret.html': '<!doctype html><title>Secret</title><p>SECRET-TWO</p>',
      },
      { force: true },
    )
    const old = await visitor.fetch(
      `/_/v/${grant.handle}/${grant.seq}/secret`,
      { host: `${tree}.content.test`, purpose: 'none' },
    )
    expect(old.status).toBe(404)
    expect(await old.text()).not.toContain('SECRET-ONE')
  })

  it('counts a view once when its issuance starts again because the tree moved', async () => {
    const page = await nodeAt(treeId, 'questions/index.html')
    const before =
      (
        await rows<{ n: number }>(
          'select coalesce(sum(count), 0) as n from page_views where node_id = ?',
          page!.id,
        )
      )[0]?.n ?? 0
    const visitor = new Browser()
    await visitor.fetch(`/${ws.name}/acme/questions/`)
    // A push lands while the view issues its handle: the view starts again.
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) => /insert into view_handle_firsts/i.test(sql),
            async () => {
              await exec(
                'update trees set authored_seq = authored_seq + 1 where id = ?',
                treeId,
              )
            },
          ),
        },
      }),
    )
    expect((await viewAs(visitor, 'questions/')).status).toBe(200)
    harness.reset()
    const after =
      (
        await rows<{ n: number }>(
          'select coalesce(sum(count), 0) as n from page_views where node_id = ?',
          page!.id,
        )
      )[0]?.n ?? 0
    expect(after - before).toBe(1)
  })
})

describe('a public page’s preview', () => {
  it('escapes what the page says and leaves out an image only some may see', async () => {
    const who = await person('owner')
    const space = await workspace(who)
    const pushed = await pushAll(await agent(who), `${space.name}/odd`, {
      'pub.html':
        '<!doctype html><title>"&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>' +
        '<meta name="description" content="a &quot;quoted&quot; &lt;b&gt;line">' +
        '<meta property="og:image" content="hidden.png">',
      'hidden.png': 'hidden',
    })
    if (!('treeId' in pushed)) throw new Error('no tree')
    await share(
      pushed.treeId,
      (await nodeAt(pushed.treeId, 'pub.html'))!.id,
      'anyone',
      '*',
      'read',
      who,
    )
    const html = await (
      await new Browser().fetch(`/${space.name}/odd/pub`)
    ).text()
    const head = html.slice(0, html.indexOf('<script type="application/json"'))
    expect(head).toContain(
      '<title>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>',
    )
    expect(head).not.toContain('<script>alert')
    expect(metaOf(head, 'description')).toBe(
      'a &quot;quoted&quot; &lt;b&gt;line',
    )
    // The image is not public, so no preview names it.
    expect(metaOf(head, 'og:image')).toBeNull()
  })
})

describe('the anonymous session', () => {
  it('counts for nothing on a request whose cookie rule fails', async () => {
    const visitor = new Browser()
    await visitor.fetch(`/${ws.name}/acme/questions/`)
    expect(visitor.jar.has(VISITOR_COOKIE)).toBe(true)
    const crossSite = await visitor.fetch('/_/api/view', {
      method: 'POST',
      purpose: 'write',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ tree: treeId, path: 'questions/' }),
    })
    expect(crossSite.status).toBe(401)
    // The content host never takes it either.
    const onContent = await visitor.fetch('/_/api/view', {
      method: 'POST',
      purpose: 'write',
      host: content,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree: treeId, path: 'questions/' }),
    })
    expect(onContent.status).not.toBe(200)
    expect(onContent.headers.getSetCookie()).toEqual([])
  })
})

describe('reach from what a public page carries', () => {
  it('reads the kit above a page the public page frames', async () => {
    const who = await person('owner')
    const space = await workspace(who)
    const pushed = await pushAll(await agent(who), `${space.name}/nest`, {
      'pub.html':
        '<!doctype html><title>Public</title><iframe src="nested/page"></iframe>',
      'nested/page.html': '<title>Nested</title><p>Nested</p>',
      'nested/_theme.css': ':root { --accent: plum }',
      'nested/other.html': '<title>Other</title>',
    })
    if (!('treeId' in pushed)) throw new Error('no tree')
    await share(
      pushed.treeId,
      (await nodeAt(pushed.treeId, 'pub.html'))!.id,
      'anyone',
      '*',
      'read',
      who,
    )
    const read = (path: string) =>
      runAs(
        {
          person: null,
          via: { kind: 'visitor', anonSessionId: null },
          requestId: 'r',
        },
        Effect.gen(function* () {
          const found = yield* (yield* TreeStore).locate(
            ref(`${space.name}/nest/${path}`),
          )
          if ('missing' in found) return 'missing'
          return yield* (yield* Access).require('read', found.node).pipe(
            Effect.map(() => 'ok'),
            Effect.catchAll((error) => Effect.succeed(error.code)),
          )
        }),
      )
    expect(await read('nested/page.html')).toBe('ok')
    expect(await read('nested/_theme.css')).toBe('ok')
    expect(await read('nested/other.html')).toBe('sign_in_required')
  })
})
