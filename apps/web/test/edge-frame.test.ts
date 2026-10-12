import type { TreeId } from '@dossier/contracts'
import { toMarkdown } from '@dossier/html'
import { SELF } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { CommitResult, StageResult } from '../src/core/index.ts'
import { SANDBOX_TOKENS } from '../src/edge/respond.ts'
import { Browser, signedIn } from './support/browser.ts'
import { harness, ORIGIN } from './support/harness.ts'
import { callerOf, fresh } from './support/people.ts'
import {
  agent,
  dataFile,
  nodeAt,
  pushAll,
  share,
  treeOf,
  workspace,
} from './support/trees.ts'
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

const viewAs = async (browser: Browser, path: string, tree = treeId) => {
  const response = await browser.fetch('/_/api/view', {
    method: 'POST',
    purpose: 'write',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tree, path }),
  })
  return response
}

const handleOf = async (browser: Browser, path = 'plan', tree = treeId) => {
  const response = await viewAs(browser, path, tree)
  expect(response.status).toBe(200)
  return ((await response.json()) as { handle: string }).handle
}

const frame = (
  browser: Browser,
  path: string,
  init: RequestInit = {},
  host = content,
) => browser.fetch(path, { ...init, host, purpose: 'none' })

const MARKDOWN = { headers: { accept: 'text/markdown' } }

const varies = (response: Response) =>
  (response.headers.get('vary') ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .includes('accept')

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
    expectContentHeaders(file, 'private, max-age=86400, immutable')
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
      expect(varies(response)).toBe(true)
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
    expect(pdf.headers.get('cache-control')).toBe(
      'private, max-age=86400, immutable',
    )
  })
})

describe('the frame route for agents', () => {
  const NOTES_1 = '<title>Notes</title><h1>Notes</h1><p>First version</p>'
  const NOTES_2 = '<title>Notes</title><h1>Notes</h1><p>Second version</p>'
  const DIAGRAM =
    '<title>Diagram</title><pre class="mermaid">graph TD\n  A --> B</pre>' +
    '<pre><code class="language-ts">const a = 1</code></pre>' +
    '<pre><code class="language-ts">const b = 2</code></pre>'
  const BASE = {
    'notes.html': NOTES_1,
    'brief.html': '<title>Brief</title><p>Brief</p>',
    'brief.md': '# Brief\n\nFirst companion.\n',
    'diagram.html': DIAGRAM,
    'guides/setup.html': '<title>Setup</title><p>Set up</p>',
    'old/page.html': '<p>Old</p>',
  }
  const pointer = '\n\nData: none · Comments: 0\n'
  const generated = (html: string) =>
    `${toMarkdown(html).replace(/\s+$/, '')}${pointer}`

  let tree: TreeId
  let host: string
  let pushAgain: () => Promise<void>

  beforeAll(async () => {
    const caller = await callerOf(owner)
    const key = await agent(caller.person!)
    const target = `${ws.name}/agentframe`
    tree = committed(await pushAll(key, target, BASE)).treeId
    host = `${tree}.content.test`
    pushAgain = async () => {
      // old/ goes; notes.html and brief.md change.
      const kept = Object.fromEntries(
        Object.entries(BASE).filter(([path]) => !path.startsWith('old/')),
      )
      committed(
        await pushAll(
          key,
          target,
          { ...kept, 'notes.html': NOTES_2, 'brief.md': '# Brief\n\nNew.\n' },
          { force: true },
        ),
      )
    }
    await dataFile(
      tree,
      'answers/sara@example.com.json',
      { ok: true },
      caller.person!,
    )
  })

  /** A person who reads the whole tree, signed in with a browser. */
  const reader = async () => {
    const browser = await signedIn(fresh())
    const root = (await nodeAt(tree, ''))!
    await share(
      tree,
      root.id,
      'email',
      (await callerOf(browser)).person!.email,
      'read',
      (await callerOf(owner)).person!,
    )
    return browser
  }

  const ask = (browser: Browser, handle: string, seq: number, path: string) =>
    frame(browser, `/_/v/${handle}/${seq}/${path}`, MARKDOWN, host)

  it('answers a page’s agent version at the frame’s sequence, and only as the frame would open it', async () => {
    const ownerHandle = await handleOf(owner, 'notes', tree)
    const early = await reader()
    const earlyHandle = await handleOf(early, 'notes', tree)
    await handleOf(early, 'brief', tree)

    const first = await ask(owner, ownerHandle, 1, 'notes')
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe(
      'text/markdown; charset=utf-8',
    )
    expectContentHeaders(first, 'no-store')
    expect(varies(first)).toBe(true)
    expect(await first.text()).toBe(generated(NOTES_1))
    const companion = await ask(owner, ownerHandle, 1, 'brief')
    expect(await companion.text()).toBe(`# Brief\n\nFirst companion.${pointer}`)

    await pushAgain()
    const late = await reader()
    const lateHandle = await handleOf(late, 'notes', tree)

    // A write holder reads any sequence; each answer is the text then.
    expect(await (await ask(owner, ownerHandle, 1, 'notes')).text()).toBe(
      generated(NOTES_1),
    )
    expect(await (await ask(owner, ownerHandle, 2, 'notes')).text()).toBe(
      generated(NOTES_2),
    )
    expect(await (await ask(owner, ownerHandle, 1, 'brief')).text()).toBe(
      `# Brief\n\nFirst companion.${pointer}`,
    )
    // A reader gets the old text of what a view issued at that sequence.
    expect(await (await ask(early, earlyHandle, 1, 'notes')).text()).toBe(
      generated(NOTES_1),
    )
    // Its companion changed and was never issued, but the reader could read
    // it when the sequence was issued: the open tab keeps the text then.
    expect(await (await ask(early, earlyHandle, 1, 'brief')).text()).toBe(
      `# Brief\n\nFirst companion.${pointer}`,
    )
    // A sequence the reader was never issued recovers nothing replaced.
    const refused = await ask(late, lateHandle, 1, 'notes')
    expect(refused.status).toBe(404)
    expect(varies(refused)).toBe(true)
    expect(await (await ask(late, lateHandle, 2, 'notes')).text()).toBe(
      generated(NOTES_2),
    )
    // A folder the sequence holds that is gone now has no text.
    expect((await ask(owner, ownerHandle, 1, 'old/')).status).toBe(404)
    // Without the Accept header the frame still answers the page.
    const html = await frame(late, `/_/v/${lateHandle}/2/notes`, {}, host)
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('answers a page’s text at an old sequence only when the page and every layout composed into it then may be opened', async () => {
    const caller = await callerOf(owner)
    const key = await agent(caller.person!)
    const target = `${ws.name}/agentlayout`
    const layout = (folder: string) =>
      `<header>Site</header><slot></slot>` +
      `<form action="${folder}/" method="post"><input name="a"></form>`
    const page = '<title>Page</title><h1>Page</h1><p>Unchanged</p>'
    const id = committed(
      await pushAll(key, target, {
        '_layout.html': layout('private-old-answers'),
        'page.html': page,
      }),
    ).treeId
    const at = `${id}.content.test`
    const seqNow = async () =>
      (await treeOf(ws.name, 'agentlayout'))!.authored_seq
    const first = await seqNow()
    const ownerHandle = await handleOf(owner, 'page', id)
    // The layout is replaced; the page is not.
    committed(
      await pushAll(
        key,
        target,
        { '_layout.html': layout('new-answers'), 'page.html': page },
        { force: true },
      ),
    )
    const second = await seqNow()
    expect(second).toBeGreaterThan(first)
    const late = await signedIn(fresh())
    await share(
      id,
      (await nodeAt(id, ''))!.id,
      'email',
      (await callerOf(late)).person!.email,
      'read',
      caller.person!,
    )
    const lateHandle = await handleOf(late, 'page', id)
    const old = (
      browser: Browser,
      handle: string,
      init: RequestInit = MARKDOWN,
    ) => frame(browser, `/_/v/${handle}/${first}/page`, init, at)

    // The page as HTML at the old sequence would compose the old layout,
    // which this handle may not open: 404, and the agent version alike.
    expect((await old(late, lateHandle, {})).status).toBe(404)
    const refused = await old(late, lateHandle)
    expect(refused.status).toBe(404)
    expect(await refused.text()).not.toContain('private-old-answers')
    // The current sequence answers, with the current layout's pointer.
    const now = await frame(
      late,
      `/_/v/${lateHandle}/${second}/page`,
      MARKDOWN,
      at,
    )
    expect(now.status).toBe(200)
    expect(await now.text()).toContain('Data: new-answers/ (0 files)')
    // A write holder opens the old sequence, with the old layout's pointer.
    const written = await old(owner, ownerHandle)
    expect(written.status).toBe(200)
    expect(await written.text()).toContain(
      'Data: private-old-answers/ (0 files)',
    )
  })

  it('answers a folder’s text now, a data folder’s files, and redirects as the frame does', async () => {
    const handle = await handleOf(owner, 'diagram', tree)
    const root = await ask(owner, handle, 1, '')
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toBe(
      'text/markdown; charset=utf-8',
    )
    expectContentHeaders(root, 'no-store')
    const text = await root.text()
    expect(text.startsWith('# agentframe/\n\nPages\n')).toBe(true)
    expect(text).toContain('- Notes · notes.html · push ')
    expect(text).toContain('- guides/ · 1 page')
    expect(text).toContain('\nKit\n')

    const guides = await ask(owner, handle, 1, 'guides/')
    expect(await guides.text()).toContain('# agentframe/guides/\n\nPages\n')
    const bare = await ask(owner, handle, 1, 'guides')
    expect(bare.status).toBe(301)
    expect(bare.headers.get('location')).toBe('./guides/')

    const answers = await ask(owner, handle, 1, 'answers/')
    expect(answers.status).toBe(200)
    expect(await answers.text()).toContain('# answers/ (1 file)\n')
    expect(
      (await ask(owner, handle, 1, 'answers')).headers.get('location'),
    ).toBe('./answers/')

    // Without the Accept header a folder without index.html is nothing.
    expect(
      (await frame(owner, `/_/v/${handle}/1/guides/`, {}, host)).status,
    ).toBe(404)
  })

  it('preloads each library the page uses once, and varies the page by Accept', async () => {
    const handle = await handleOf(owner, 'diagram', tree)
    const page = await frame(owner, `/_/v/${handle}/1/diagram`, {}, host)
    expect(page.status).toBe(200)
    expect(varies(page)).toBe(true)
    const html = await page.text()
    const preloads = [
      ...html.matchAll(/<link rel="modulepreload" href="([^"]*)">/g),
    ].map((match) => match[1])
    expect(preloads).toEqual([
      '/_/base/test/lib/mermaid.js',
      '/_/base/test/lib/shiki.js',
    ])
    expect(html).not.toContain('katex')
  })
})
