// A page downloaded as one file: everything it loads that the exporter may
// read inlined, the base libraries it uses, a snapshot of the exporter's
// data, made per request and never stored.
import {
  assembleThreads,
  EXPORT_LINKED_HEADER,
  fromPageFolder,
  type AuthoredSeq,
  type CommentFile,
  type OpId,
  type Person,
  type PushNumber,
  type TreeId,
} from '@dossier/contracts'
import type { ExportData } from '@dossier/contracts/bridge'
import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Data, type Caller } from '../src/core/index.ts'
import { exec } from './support/d1.ts'
import {
  formRef,
  pushForms,
  seqOf,
  sendAs,
  type FormTree,
} from './support/forms.ts'
import { harness, ORIGIN } from './support/harness.ts'
import { keySecretFor } from './support/keys.ts'
import { runAs, sessionFor } from './support/people.ts'
import { join, nodeAt, person, share, workspace } from './support/trees.ts'

afterEach(() => harness.reset())

const MiB = 1024 * 1024

const LAYOUT = `<!doctype html><html lang="en"><head><link rel="stylesheet" href="_theme.css"></head>
<body><header class="site-header">Acme</header><slot></slot></body></html>`
const THEME = `:root { --accent: #8a1c7c }
@font-face { font-family: Acme; src: url(fonts/acme.woff2) format("woff2") }
body { background: url(img/paper.png) }`
const CARD = `import { label } from './shared.js'
customElements.define('acme-card', class extends HTMLElement {
  connectedCallback() { this.textContent = label }
})`
const SHARED = `export const label = 'Acme card'`
const PLAN = `<title>Plan</title>
<acme-card></acme-card>
<img src="img/logo.png" alt="Logo">
<img src="private/secret.png" alt="Secret">
<a href="notes.html#top">Notes</a>
<pre class="mermaid">graph TD; A-->B</pre>
<form action="answers/" method="post">
  <label>Role <input name="role"></label>
  <button>Send</button>
</form>
<dossier-comments></dossier-comments>`

const FILES = {
  '_layout.html': LAYOUT,
  '_theme.css': THEME,
  'fonts/acme.woff2': 'woff2-font-bytes',
  'img/paper.png': 'paper-png-bytes',
  'img/logo.png': 'logo-png-bytes',
  'private/secret.png': 'secret-png-bytes',
  '_components/acme-card.js': CARD,
  '_components/shared.js': SHARED,
  'plan.html': PLAN,
  'notes.html': '<title>Notes</title><p>Notes.</p>',
}

const base64 = (text: string) => btoa(text)

/** GET /_/api/export as an agent key, or as nobody. */
const exportAs = (
  secret: string | null,
  link: string,
  host = new URL(ORIGIN).host,
): Promise<Response> =>
  SELF.fetch(
    `https://${host}/_/api/export?link=${encodeURIComponent(link)}`,
    secret === null ? {} : { headers: { authorization: `Bearer ${secret}` } },
  )

const scriptJson = (html: string, id: string): unknown => {
  const match = new RegExp(
    `<script type="application/json" id="${id}">(.*?)</script>`,
    's',
  ).exec(html)
  if (match === null) throw new Error(`no #${id}`)
  return JSON.parse(match[1]!)
}

const importMap = (html: string): Record<string, string> => {
  const match = /<script type="importmap">(.*?)<\/script>/s.exec(html)
  if (match === null) throw new Error('no import map')
  return (JSON.parse(match[1]!) as { imports: Record<string, string> }).imports
}

/** A data: URL's text. */
const dataText = (url: string): string => {
  const comma = url.indexOf(',')
  const head = url.slice(0, comma)
  const body = url.slice(comma + 1)
  return head.endsWith(';base64')
    ? new TextDecoder().decode(
        Uint8Array.from(atob(body), (char) => char.charCodeAt(0)),
      )
    : decodeURIComponent(body)
}

/** Makes a file's current version a large object written straight to R2. */
const largeBytes = async (treeId: string, path: string, size: number) => {
  const sha = crypto.randomUUID().replaceAll('-', '').padEnd(64, '0')
  await env.BLOBS.put(`blobs/${sha}`, new Uint8Array(size))
  await exec(
    `insert into blobs (sha256, size, ref_count, state, first_seen_at)
     values (?, ?, 1, 'live', ?)`,
    sha,
    size,
    Date.now(),
  )
  const node = (await nodeAt(treeId, path))!
  await exec(
    `update node_versions set blob_sha256 = ?, size = ?
     where id = (select current_version_id from nodes where id = ?)`,
    sha,
    size,
    node.id,
  )
}

let owner: Person
let ownerKey: string
let ws: { id: string; name: string }
let tree: FormTree

const link = (path: string) => `${ORIGIN}/${ws.name}/${tree.name}/${path}`

/** Sends the plan's form as `who`. */
const answer = async (who: Caller, role: string) =>
  sendAs(who, tree, {
    page: 'plan.html',
    form: await formRef(tree, 'plan.html', 'answers/'),
    entries: [['role', role]],
  })

const comment = async (who: Caller, text: string, replyTo: string | null) =>
  runAs(
    who,
    Effect.flatMap(Data, (data) =>
      Effect.gen(function* () {
        return yield* data.write({
          tree: tree.treeId,
          page: 'plan.html',
          path: 'plan.comments/',
          patch: {
            text,
            anchor: null,
            label: null,
            pin: null,
            replyTo,
            stance: null,
            mentions: [],
          },
          replace: false,
          opId: crypto.randomUUID() as OpId,
          seq: (yield* Effect.promise(() => seqOf(tree))) as AuthoredSeq,
        })
      }),
    ),
  )

let respondent: Person
let respondentKey: string
let other: Person

beforeAll(async () => {
  owner = await person('owner')
  ws = await workspace(owner)
  tree = await pushForms(owner, ws, FILES)
  ownerKey = await keySecretFor(owner)
  // A respondent on the page alone, and someone else who answered too.
  respondent = await person('respondent')
  other = await person('other')
  const plan = (await nodeAt(tree.treeId, 'plan.html'))!.id
  share(tree.treeId, plan, 'email', respondent.email, 'respond', owner)
  share(tree.treeId, plan, 'email', other.email, 'respond', owner)
  // The secret image is shared with nobody, so only the owner reads it.
  await new Promise((resolve) => setTimeout(resolve, 5))
  respondentKey = await keySecretFor(respondent)
  await answer(await sessionFor(respondent), 'Driver')
  await answer(await sessionFor(other), 'Dispatcher')
  const first = await comment(await sessionFor(owner), 'Looks right.', null)
  await comment(
    await sessionFor(respondent),
    'Agreed.',
    `plan.comments/${first.path.split('/plan.comments/')[1] ?? first.path.slice(first.path.indexOf('plan.comments/') + 'plan.comments/'.length)}`,
  )
})

describe('a page as one file', () => {
  it('holds its layout, theme, components, images and fonts inline, and the exporter’s data', async () => {
    const response = await exportAs(ownerKey, link('plan'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    )
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="plan.html"; filename*=UTF-8''plan.html`,
    )
    const html = await response.text()
    expect(
      html.startsWith(
        `<!-- Exported from ${link('plan')} by ${owner.email} on `,
      ),
    ).toBe(true)
    // The layout and the theme, the theme's font and image as data: URLs.
    expect(html).toContain('<header class="site-header">Acme</header>')
    expect(html).toContain('<style>:root { --accent: #8a1c7c }')
    expect(html).toContain(
      `url(data:font/woff2;base64,${base64('woff2-font-bytes')})`,
    )
    expect(html).toContain(
      `url(data:image/png;base64,${base64('paper-png-bytes')})`,
    )
    expect(html).toContain(
      `src="data:image/png;base64,${base64('logo-png-bytes')}"`,
    )
    // The owner reads the secret image too.
    expect(html).toContain(
      `src="data:image/png;base64,${base64('secret-png-bytes')}"`,
    )
    // Links to other pages are their canonical links.
    expect(html).toContain(`href="${link('notes')}#top"`)
    // The component and what it imports, by bare names in the import map.
    const map = importMap(html)
    expect(dataText(map['dossier-export/_components/acme-card.js']!)).toBe(
      CARD.replace("'./shared.js'", "'dossier-export/_components/shared.js'"),
    )
    expect(dataText(map['dossier-export/_components/shared.js']!)).toBe(SHARED)
    const bootstrap = scriptJson(html, 'dossier-bootstrap') as {
      export: true
      kit: Record<string, string>
    }
    expect(bootstrap.export).toBe(true)
    expect(bootstrap.kit['acme-card']).toBe(
      'dossier-export/_components/acme-card.js',
    )
    // The page client, inline, and nothing loaded from the base layer's URL.
    expect(html).toContain("// the test build's stand-in client.js")
    expect(html).not.toContain('/_/base/test/')
    // The data the owner reads: both answers.
    const data = scriptJson(html, 'dossier-export') as ExportData
    expect(data.me).toEqual({
      email: owner.email,
      name: owner.name,
      role: 'write',
    })
    expect(data.link).toBe(link('plan'))
    const answers = data.files
      .filter((file) => file.path.startsWith('answers/'))
      .map((file) => file.data)
    expect(answers).toEqual(
      expect.arrayContaining([{ role: 'Driver' }, { role: 'Dispatcher' }]),
    )
    expect(answers).toHaveLength(2)
    // Everything inlined: no Look, no fonts route, no content host.
    expect(html).not.toContain('/_/look/')
    expect(html).not.toContain('/_/fonts/')
    expect(html).not.toContain('content.test')
  })

  it('gives a respondent their own answers and not another person’s', async () => {
    const response = await exportAs(respondentKey, link('plan'))
    expect(response.status).toBe(200)
    const data = scriptJson(
      await response.text(),
      'dossier-export',
    ) as ExportData
    expect(data.me?.role).toBe('respond')
    const answers = data.files.filter((file) =>
      file.path.startsWith('answers/'),
    )
    expect(answers.map((file) => [file.path, file.data])).toEqual([
      [`answers/${respondent.email}.json`, { role: 'Driver' }],
    ])
  })

  it('keeps a file the exporter cannot read as its canonical link', async () => {
    // A reader of public/ alone. What its page renders with is carried with
    // the share, but not what only its stylesheet names.
    const folder = await pushForms(owner, ws, {
      'public/page.html':
        '<title>Public</title><link rel="stylesheet" href="style.css"><img src="pic.png">',
      'public/style.css': 'body { background: url(../private/secret.png) }',
      'public/pic.png': 'pic-png-bytes',
      'private/secret.png': 'secret-png-bytes',
    })
    const reader = await person('reader')
    share(
      folder.treeId,
      (await nodeAt(folder.treeId, 'public'))!.id,
      'email',
      reader.email,
      'read',
      owner,
    )
    const response = await exportAs(
      await keySecretFor(reader),
      `${ORIGIN}/${ws.name}/${folder.name}/public/page`,
    )
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain(
      `src="data:image/png;base64,${base64('pic-png-bytes')}"`,
    )
    expect(html).toContain(
      `url(${ORIGIN}/${ws.name}/${folder.name}/private/secret.png)`,
    )
    expect(html).not.toContain(base64('secret-png-bytes'))
    // The owner reads it, so their export holds it.
    const theirs = await (
      await exportAs(
        ownerKey,
        `${ORIGIN}/${ws.name}/${folder.name}/public/page`,
      )
    ).text()
    expect(theirs).toContain(
      `url(data:image/png;base64,${base64('secret-png-bytes')})`,
    )
  })

  it('is made for each person and request, and never stored', async () => {
    const [mine, theirs] = await Promise.all([
      exportAs(ownerKey, link('plan')),
      exportAs(respondentKey, link('plan')),
    ])
    for (const response of [mine, theirs]) {
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    }
    const [a, b] = await Promise.all([mine.text(), theirs.text()])
    expect(a).not.toBe(b)
    expect(a).toContain(`by ${owner.email}`)
    expect(b).toContain(`by ${respondent.email}`)
    expect(b).not.toContain(`"me":{"email":"${owner.email}"`)
  })

  it('carries the Mermaid export build and the comments, which assemble into its threads', async () => {
    const html = await (await exportAs(ownerKey, link('plan'))).text()
    const map = importMap(html)
    expect(dataText(map['dossier-export/base/lib/mermaid.js']!)).toBe(
      "// the test build's stand-in lib/mermaid.export.js\n",
    )
    const data = scriptJson(html, 'dossier-export') as ExportData
    const entries = data.files.filter((file) =>
      file.path.startsWith('plan.comments/'),
    )
    expect(entries).toHaveLength(2)
    // Assembled as the export's page client assembles them, they are the
    // threads the live page reads.
    const folder = 'plan.comments'
    const files: CommentFile[] = entries.map((file) => ({
      path: `${fromPageFolder(folder)}${file.path.slice(folder.length)}`,
      treePath: file.path,
      by: file.by,
      name: data.comments[file.path]!.name,
      at: Date.parse(data.comments[file.path]!.created),
      push: file.push as PushNumber,
      revision: data.comments[file.path]!.revision,
      value: file.data,
    }))
    const live = await runAs(
      await sessionFor(owner),
      Effect.flatMap(Data, (d) =>
        d.read({ treeId: tree.treeId as TreeId, path: 'plan.comments/' }),
      ),
    )
    expect(assembleThreads(files)).toEqual('files' in live ? live.files : [])
    const [thread] = assembleThreads(files)
    expect(thread?.data.root.text).toBe('Looks right.')
    expect(thread?.data.root.name).toBe(owner.name)
    expect(thread?.data.replies.map((reply) => reply.text)).toEqual(['Agreed.'])
  })

  it('links a 60 MiB video and stays under 50 MiB, naming it', async () => {
    const video = await pushForms(owner, ws, {
      'watch.html':
        '<title>Watch</title><video src="media/walkthrough.mp4"></video><img src="still.png">',
      'media/walkthrough.mp4': 'placeholder',
      'still.png': 'still-png-bytes',
    })
    // The video's bytes become a 60 MiB object in R2.
    await largeBytes(video.treeId, 'media/walkthrough.mp4', 60 * MiB)
    const key = await keySecretFor(owner)
    const response = await exportAs(
      key,
      `${ORIGIN}/${ws.name}/${video.name}/watch`,
    )
    expect(response.status).toBe(200)
    expect(
      JSON.parse(
        decodeURIComponent(response.headers.get(EXPORT_LINKED_HEADER) ?? ''),
      ),
    ).toEqual(['media/walkthrough.mp4'])
    const html = await response.text()
    expect(new TextEncoder().encode(html).length).toBeLessThan(50 * MiB)
    const canonical = `${ORIGIN}/${ws.name}/${video.name}/media/walkthrough.mp4`
    expect(html).toContain(`<video src="${canonical}">`)
    expect(html).toContain(`Linked, not included: ${canonical}`)
    expect(html).toContain(
      `src="data:image/png;base64,${base64('still-png-bytes')}"`,
    )
    const data = scriptJson(html, 'dossier-export') as ExportData
    expect(data.linked).toEqual([canonical])
  })

  it('answers too_large when its scripts alone pass the limit', async () => {
    const big = await pushForms(owner, ws, {
      'heavy.html': '<title>Heavy</title><script src="vendor.js"></script>',
      'vendor.js': 'window.vendor = 1',
    })
    await largeBytes(big.treeId, 'vendor.js', 40 * MiB)
    const response = await exportAs(
      await keySecretFor(owner),
      `${ORIGIN}/${ws.name}/${big.name}/heavy`,
    )
    expect(response.status).toBe(413)
    const { error } = (await response.json()) as {
      error: { code: string; message: string }
    }
    expect(error.code).toBe('too_large')
    expect(error.message).toBe(
      'This page would export as 54 MiB, above the 50 MiB limit even with its media linked.',
    )
  })

  it('works with an agent key, asks a visitor to sign in, and is not on a content host', async () => {
    expect((await exportAs(ownerKey, link('plan'))).status).toBe(200)
    const visitor = await exportAs(null, link('plan'))
    expect(visitor.status).toBe(401)
    expect(
      ((await visitor.json()) as { error: { code: string } }).error.code,
    ).toBe('sign_in_required')
    const content = await exportAs(
      ownerKey,
      link('plan'),
      `${tree.treeId}.content.test`,
    )
    expect(content.status).toBe(404)
  })

  it('answers not_found alike for a missing page and one the exporter cannot read', async () => {
    const outsider = await keySecretFor(await person('outsider'))
    const missing = await exportAs(outsider, link('nothing'))
    const unreadable = await exportAs(outsider, link('plan'))
    expect(missing.status).toBe(404)
    expect(unreadable.status).toBe(404)
    const [a, b] = (await Promise.all([missing.json(), unreadable.json()])) as {
      error: { code: string; message: string }
    }[]
    expect(a!.error.code).toBe('not_found')
    expect(b!.error).toEqual({ ...a!.error, path: 'plan' })
    // A member of the workspace reads it all; a folder is not a page.
    const member = await person('member')
    await join(ws, member)
    const folder = await exportAs(await keySecretFor(member), link('img/'))
    expect(folder.status).toBe(404)
  })
})
