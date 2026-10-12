import type { TreeId } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { CommitResult, StageResult } from '../src/core/index.ts'
import { SANDBOX_TOKENS } from '../src/edge/respond.ts'
import { Browser, signedIn } from './support/browser.ts'
import { harness, ORIGIN } from './support/harness.ts'
import { callerOf, fresh } from './support/people.ts'
import { agent, nodeAt, pushAll, share, workspace } from './support/trees.ts'
import { everything } from './support/keys.ts'

afterEach(() => harness.reset())

const PDF = '%PDF-1.7 0123456789'
const FILES = {
  'plan.html': '<!doctype html><title>Plan</title><p>Plan</p>',
  'notes/index.html': '<p>Notes</p>',
  'mockups/a.html': '<p>A</p>',
  'brief.pdf': PDF,
}

const committed = (result: CommitResult | StageResult): CommitResult => {
  if (!('number' in result)) throw new Error('the push did not commit')
  return result
}

let owner: Browser
let ws: { id: string; name: string }
let treeId: TreeId
let content: string

beforeAll(async () => {
  owner = await signedIn(fresh())
  const caller = await callerOf(owner)
  ws = await workspace(caller.person!)
  const result = committed(
    await pushAll(await agent(caller.person!), `${ws.name}/acme`, FILES),
  )
  treeId = result.treeId
  content = `${treeId}.content.test`
})

const viewAs = async (browser: Browser, path: string) => {
  const response = await browser.fetch('/_/api/view', {
    method: 'POST',
    purpose: 'write',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tree: treeId, path }),
  })
  return response
}

const handleOf = async (browser: Browser, path = 'plan') => {
  const response = await viewAs(browser, path)
  expect(response.status).toBe(200)
  return ((await response.json()) as { handle: string }).handle
}

const frame = (browser: Browser, path: string, init: RequestInit = {}) =>
  browser.fetch(path, { ...init, host: content, purpose: 'none' })

const expectContentHeaders = (response: Response, cache: string) => {
  const csp = response.headers.get('content-security-policy') ?? ''
  expect(csp.startsWith('sandbox ')).toBe(true)
  expect(csp.slice('sandbox '.length).split(' ')).toEqual([...SANDBOX_TOKENS])
  expect(SANDBOX_TOKENS).toHaveLength(9)
  expect(response.headers.get('referrer-policy')).toBe(
    'strict-origin-when-cross-origin',
  )
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('access-control-allow-origin')).toBeNull()
  expect(response.headers.get('cache-control')).toBe(cache)
  expect(response.headers.getSetCookie()).toEqual([])
}

describe('the shell', () => {
  it('frames only the tree’s content origin, is never framed, and is never stored', async () => {
    const response = await owner.fetch(`/${ws.name}/acme/plan`)
    expect(response.status).toBe(200)
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain(`frame-src https://${content}`)
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("default-src 'none'")
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform')
    expect(response.headers.get('referrer-policy')).toBe('same-origin')
    const html = await response.text()
    expect(html).toContain('<title>dossier.test</title>')
    expect(html).toContain('<script type="module" src="/_/base/test/shell.js">')
    const boot = JSON.parse(
      /<script type="application\/json" id="dossier-shell">(.*?)<\/script>/s.exec(
        html,
      )![1]!,
    ) as { contentOrigin: string; linkPath: string; seq: number }
    expect(boot).toMatchObject({
      contentOrigin: `https://${content}`,
      linkPath: 'plan',
      seq: 1,
    })
    for (const token of SANDBOX_TOKENS) expect(html).toContain(token)
  })
})

describe('the link route', () => {
  it('asks visitors to sign in for any link, existing or not', async () => {
    const visitor = new Browser()
    for (const path of ['plan', 'no-such-page', '']) {
      const response = await visitor.fetch(`/${ws.name}/acme/${path}`)
      expect(response.status, path).toBe(302)
      expect(response.headers.get('location')).toBe(
        `/_/sign-in?next=${encodeURIComponent(`/${ws.name}/acme/${path}`)}`,
      )
    }
  })

  // Edge scope: the screen stand-in renders no real screen, so this proves
  // the edge's answer (status, document, the screen it hands over), not the
  // rendered page, which the browser checks look at.
  it('hands missing and unreadable links to the same screen, with status 404', async () => {
    const outsider = await signedIn(fresh())
    const missing = await outsider.fetch(`/${ws.name}/acme/salaries`)
    const hidden = await outsider.fetch(`/${ws.name}/acme/plan`)
    const folder = await outsider.fetch(`/${ws.name}/acme/`)
    const workspaceHome = await outsider.fetch(`/${ws.name}/`)
    for (const response of [missing, hidden, folder, workspaceHome]) {
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(response.headers.get('cache-control')).toBe('no-transform')
    }
    expect(await missing.text()).toContain(
      `data-screen="/${ws.name}/acme/salaries"`,
    )
    expect(await hidden.text()).toContain(`data-screen="/${ws.name}/acme/plan"`)
  })

  it('answers a view of a missing and of a private path with the same body', async () => {
    const outsider = await signedIn(fresh())
    const key = await agent((await callerOf(owner)).person!)
    const vault = committed(
      await pushAll(key, `${ws.name}/vault`, { 'a.html': '<p>A</p>' }),
    )
    const ask = async () => {
      const response = await outsider.fetch('/_/api/view', {
        method: 'POST',
        purpose: 'write',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tree: vault.treeId, path: 'payroll' }),
      })
      return { status: response.status, body: await response.json() }
    }
    const before = await ask()
    await pushAll(
      key,
      `${ws.name}/vault`,
      { 'a.html': '<p>A</p>', 'payroll.html': '<p>Private</p>' },
      { force: true },
    )
    const after = await ask()
    expect(before.status).toBe(404)
    expect(after).toEqual(before)
  })

  it('redirects a tree without its slash and a workspace to the home, for those who may open them', async () => {
    const bare = await owner.fetch(`/${ws.name}/acme`)
    expect(bare.status).toBe(301)
    expect(bare.headers.get('location')).toBe(`/${ws.name}/acme/`)
    const home = await owner.fetch(`/${ws.name}`)
    expect(home.status).toBe(302)
    expect(home.headers.get('location')).toBe(`/?w=${ws.name}`)
    const listing = await owner.fetch(`/${ws.name}/acme/`)
    expect(listing.status).toBe(200)
    expect(await listing.text()).toContain(`data-screen="/${ws.name}/acme/"`)
    const outsider = await signedIn(fresh())
    expect((await outsider.fetch(`/${ws.name}/acme`)).status).toBe(404)
  })
})

describe('the view endpoint', () => {
  it('gives a browser a handle and refuses agent keys', async () => {
    const response = await viewAs(owner, 'plan')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ seq: 1, role: 'write' })
    const caller = await callerOf(owner)
    const { runAs } = await import('./support/people.ts')
    const { Effect } = await import('effect')
    const { SignIn } = await import('../src/core/index.ts')
    const { secret } = await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) =>
        signIn.createKey({ name: 'frame', ...everything }),
      ),
    )
    const byKey = await SELF.fetch(`${ORIGIN}/_/api/view`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tree: treeId, path: 'plan' }),
    })
    expect(byKey.status).toBe(404)
  })
})

describe('the frame route', () => {
  it('serves a page and a file with the content headers', async () => {
    const handle = await handleOf(owner)
    const page = await frame(owner, `/_/v/${handle}/1/plan`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expectContentHeaders(page, 'private, no-cache, no-transform')
    const html = await page.text()
    expect(html).toContain('<script src="/_/base/test/client.js"></script>')
    expect(html).toContain('id="dossier-bootstrap"')

    const file = await frame(owner, `/_/v/${handle}/1/brief.pdf`)
    expect(file.status).toBe(200)
    expectContentHeaders(file, 'private, max-age=86400')
    expect(file.headers.get('accept-ranges')).toBe('bytes')
    expect(await file.text()).toBe(PDF)
  })

  it('refuses a session cookie without a valid handle, and another tree’s handle', async () => {
    const handle = await handleOf(owner)
    for (const path of [
      '/_/v/nohandle/1/plan',
      `/_/v/${'A'.repeat(43)}/1/plan`,
      '/_/v/plan',
    ]) {
      const response = await frame(owner, path)
      expect(response.status, path).toBe(404)
      expect(response.headers.get('content-type')).toContain('text/plain')
      expect(response.headers.getSetCookie()).toEqual([])
    }
    const other = await owner.fetch(`/_/v/${handle}/1/plan`, {
      host: 'abcdefghij0123456789.content.test',
      purpose: 'none',
    })
    expect(other.status).toBe(404)
    // A frame path on the main host is nothing.
    expect((await owner.fetch(`/_/v/${handle}/1/plan`)).status).toBe(404)
  })

  it('redirects inside the frame, keeping the handle and sequence', async () => {
    const handle = await handleOf(owner)
    const html = await frame(owner, `/_/v/${handle}/1/plan.html`)
    expect(html.status).toBe(301)
    expect(html.headers.get('location')).toBe('./plan')
    const folder = await frame(owner, `/_/v/${handle}/1/notes`)
    expect(folder.status).toBe(301)
    expect(folder.headers.get('location')).toBe('./notes/')
    expectContentHeaders(folder, 'no-store')
    const index = await frame(owner, `/_/v/${handle}/1/notes/index.html`)
    expect(index.headers.get('location')).toBe('./')
    // A folder without index.html has nothing to frame.
    expect((await frame(owner, `/_/v/${handle}/1/mockups/`)).status).toBe(404)
  })

  it('answers byte ranges with 206 and Content-Range, and If-None-Match with 304', async () => {
    const handle = await handleOf(owner)
    const path = `/_/v/${handle}/1/brief.pdf`
    const size = PDF.length
    const head = await frame(owner, path, { headers: { range: 'bytes=0-3' } })
    expect(head.status).toBe(206)
    expect(head.headers.get('content-range')).toBe(`bytes 0-3/${size}`)
    expect(head.headers.get('content-length')).toBe('4')
    expect(await head.text()).toBe('%PDF')
    const tail = await frame(owner, path, { headers: { range: 'bytes=-4' } })
    expect(tail.status).toBe(206)
    expect(tail.headers.get('content-range')).toBe(
      `bytes ${size - 4}-${size - 1}/${size}`,
    )
    expect(await tail.text()).toBe('6789')
    const open = await frame(owner, path, { headers: { range: 'bytes=10-' } })
    expect(await open.text()).toBe(PDF.slice(10))
    const beyond = await frame(owner, path, {
      headers: { range: `bytes=${size}-` },
    })
    expect(beyond.status).toBe(416)
    expect(beyond.headers.get('content-range')).toBe(`bytes */${size}`)

    const etag = (await frame(owner, path)).headers.get('etag')!
    const cached = await frame(owner, path, {
      headers: { 'if-none-match': etag },
    })
    expect(cached.status).toBe(304)
    expect(cached.headers.get('etag')).toBe(etag)
    const page = await frame(owner, `/_/v/${handle}/1/plan`)
    const pageTag = page.headers.get('etag')!
    const pageCached = await frame(owner, `/_/v/${handle}/1/plan`, {
      headers: { 'if-none-match': pageTag },
    })
    expect(pageCached.status).toBe(304)
  })

  it('refuses service worker scripts on frame and base paths', async () => {
    const handle = await handleOf(owner)
    for (const path of [
      `/_/v/${handle}/1/sw.js`,
      `/_/v/${handle}/1/plan`,
      '/_/base/test/client.js',
    ]) {
      const response = await frame(owner, path, {
        headers: { 'service-worker': 'script' },
      })
      expect(response.status, path).toBe(403)
    }
  })

  it('serves base files from Static Assets with the base layer’s headers', async () => {
    for (const host of [content, undefined]) {
      const response = await owner.fetch('/_/base/test/client.js', {
        host,
        purpose: 'none',
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      )
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('content-security-policy')).toBe(
        `sandbox ${SANDBOX_TOKENS.join(' ')}`,
      )
      expect(response.headers.get('referrer-policy')).toBe(
        'strict-origin-when-cross-origin',
      )
      if (host !== undefined) {
        expect(response.headers.getSetCookie()).toEqual([])
      }
    }
    const old = await owner.fetch('/_/base/0123456789ab/client.js', {
      host: content,
      purpose: 'none',
    })
    expect(old.status).toBe(404)
  })

  it('opens only what the person may read now', async () => {
    const reader = await signedIn(fresh())
    const readerCaller = await callerOf(reader)
    const plan = (await nodeAt(treeId, 'plan.html'))!
    await share(
      treeId,
      plan.id,
      'email',
      readerCaller.person!.email,
      'read',
      (await callerOf(owner)).person!,
    )
    const handle = await handleOf(reader)
    expect((await frame(reader, `/_/v/${handle}/1/plan`)).status).toBe(200)
    // The rest of the tree stays closed to a page share.
    expect((await frame(reader, `/_/v/${handle}/1/brief.pdf`)).status).toBe(404)
  })
})

describe('HTML on either host', () => {
  /** Cloudflare adds nothing to a response marked no-transform. */
  const expectNoTransform = (
    response: Response,
    keeps: string,
    what: string,
  ) => {
    expect(response.headers.get('content-type'), what).toContain('text/html')
    const directives = (response.headers.get('cache-control') ?? '')
      .split(',')
      .map((d) => d.trim())
    expect(directives, what).toContain('no-transform')
    for (const kept of keeps.split(',').map((d) => d.trim())) {
      expect(directives, what).toContain(kept)
    }
  }

  it('is marked no-transform and keeps its caching', async () => {
    const handle = await handleOf(owner)
    expectNoTransform(
      await owner.fetch(`/${ws.name}/acme/plan`),
      'no-store',
      'shell',
    )
    expectNoTransform(
      await frame(owner, `/_/v/${handle}/1/plan`),
      'private, no-cache',
      'composed page',
    )
    expectNoTransform(
      await frame(owner, `/_/v/${handle}/1/notes/`),
      'private, no-cache',
      'composed folder page',
    )
    expectNoTransform(
      await owner.fetch('/_/base/test/_layout.html', {
        host: content,
        purpose: 'none',
      }),
      'public, max-age=31536000, immutable',
      'base layout',
    )
    const outsider = await signedIn(fresh())
    const screen = await outsider.fetch(`/${ws.name}/acme/salaries`)
    expectNoTransform(screen, 'no-transform', 'no-access page')
  })

  it('leaves other responses’ caching as it was', async () => {
    const handle = await handleOf(owner)
    const pdf = await frame(owner, `/_/v/${handle}/1/brief.pdf`)
    expect(pdf.headers.get('cache-control')).toBe('private, max-age=86400')
  })
})
