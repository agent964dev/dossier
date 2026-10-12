import type { TreeId } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Pages } from '../src/core/index.ts'
import { VISITOR_COOKIE } from '../src/edge/caller.ts'
import { Browser } from './support/browser.ts'
import { count } from './support/d1.ts'
import { harness, ORIGIN } from './support/harness.ts'
import { runAs } from './support/people.ts'
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
