import type { Person, ReadResult } from '@dossier/contracts'
import { MARKDOWN_VERSION, toMarkdown } from '@dossier/html'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  Access,
  Pages,
  TreeStore,
  type Caller,
  type CommitResult,
  type StageResult,
} from '../src/core/index.ts'
import { exec } from './support/d1.ts'
import { harness } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  agent,
  dataFile,
  failureAs,
  join,
  nodeAt,
  person,
  pushAll,
  ref,
  sha256Of,
  share,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const committed = (result: CommitResult | StageResult): CommitResult => {
  if (!('number' in result)) throw new Error('the push did not commit')
  return result
}

const PLAN_MD = '# Delivery plan\n\nTrucks leave on Monday.\n'
const GLOSSARY_JSON = '{"terms":[{"term":"push","means":"one change"}]}\n'
const DIAGRAM = `<!doctype html>
<html><head><title>Diagram</title></head>
<body>
<pre class="mermaid">graph TD
  A --> B</pre>
<svg viewBox="0 0 4 4"><title>Routes</title><circle r="2"/></svg>
</body></html>
`

const ROOT_LAYOUT = `<!doctype html>
<html><head><title>Acme</title></head>
<body><header class="site-header">Acme</header>
<form action="decisions.json"><input name="ok"></form>
<slot></slot></body></html>`

const FILES = {
  '_layout.html': ROOT_LAYOUT,
  '_theme.css': ':root { --primary: #8a1c7c; --font-body: system-ui; }',
  '_components/acme-card.js': 'export const card = 1',
  '_components/acme-card.md': 'A card.\n\nUse `<acme-card>` around a summary.',
  'plan.html':
    '<title>Plan</title><h1>Plan</h1><form action="answers/"><input name="a"></form>',
  'plan.md': PLAN_MD,
  'glossary.html':
    '<!doctype html><html><head><link rel="alternate" href="glossary.json"></head><body><p>Terms</p></body></html>',
  'glossary.json': GLOSSARY_JSON,
  'glossary.md': '# Not this one\n',
  'diagram.html': DIAGRAM,
  'brief.pdf': '%PDF-1.7 brief',
  'notes.txt': 'Plain notes\n',
  'guides/setup.html': '<title>Setup</title><p>Set up</p>',
}

let admin: Person
let owner: Caller
let tree: { id: string; workspace: string }

const read = (caller: Caller, target: string) =>
  runAs(
    caller,
    Effect.flatMap(Pages, (pages) => pages.read(ref(target))),
  )

const page = (result: ReadResult) => {
  if (result.kind !== 'page') throw new Error(`not a page: ${result.kind}`)
  return result
}

const folder = (result: ReadResult) => {
  if (result.kind !== 'folder') throw new Error(`not a folder: ${result.kind}`)
  return result
}

beforeAll(async () => {
  admin = await person('admin')
  const ws = await workspace(admin)
  owner = await sessionFor(admin)
  const result = committed(
    await pushAll(await agent(admin), `${ws.name}/handoff`, FILES),
  )
  tree = { id: result.treeId, workspace: ws.name }
  const writer = await person('sara')
  for (const [path, value] of [
    ['answers/sara@example.com.json', { trucks: 12 }],
    ['answers/omar@example.com.json', { trucks: 3 }],
    ['decisions.json', { go: true }],
    ['plan.comments/c1.json', { text: 'Looks good' }],
  ] as const) {
    await dataFile(tree.id, path, value, writer, 1)
  }
})

const at = (path: string) => `${tree.workspace}/handoff/${path}`

describe('a page with a companion', () => {
  it('returns the same-name .md with the pointer line appended', async () => {
    const result = page(await read(owner, at('plan')))
    expect(result).toMatchObject({
      path: 'plan.html',
      source: 'companion',
      companion: 'plan.md',
      type: 'text/markdown',
      push: 1,
      pointer: {
        data: [
          { path: 'answers/', files: 2 },
          { path: 'decisions.json', files: 1 },
        ],
        comments: 1,
      },
    })
    expect(result.text).toBe(
      '# Delivery plan\n\nTrucks leave on Monday.\n\nData: answers/ (2 files), decisions.json (1 file) · Comments: 1\n',
    )
    expect(result.link).toBe(`${env.PUBLIC_ORIGIN}/${at('plan')}`)
  })

  it('returns a named JSON companion byte for byte, with no pointer, over the same-name .md', async () => {
    const result = page(await read(owner, at('glossary')))
    expect(result).toMatchObject({
      source: 'companion',
      companion: 'glossary.json',
      type: 'application/json',
      pointer: { data: [], comments: 0 },
    })
    expect(result.text).toBe(GLOSSARY_JSON)
  })

  it('reads the same through the redirects a link takes', async () => {
    const direct = await read(owner, at('plan'))
    expect(await read(owner, at('plan.html'))).toEqual(direct)
  })
})

describe('a page without a companion', () => {
  it('returns the Markdown stored at push, and makes it again once it is gone', async () => {
    const sha = await sha256Of(DIAGRAM)
    const key = `derived/markdown/${MARKDOWN_VERSION}/${sha}.md`
    const stored = await env.BLOBS.get(key)
    expect(await stored?.text()).toBe(toMarkdown(DIAGRAM))

    const expected = `${toMarkdown(DIAGRAM)}\n\nData: none · Comments: 0\n`
    const first = page(await read(owner, at('diagram')))
    expect(first).toMatchObject({ source: 'generated', companion: null })
    expect(first.text).toBe(expected)
    expect(first.text).toContain('```mermaid\ngraph TD\n  A --> B\n```')
    expect(first.text).toContain('[SVG: Routes.]')

    // The stored text is what a read serves.
    await env.BLOBS.put(key, 'Stored earlier')
    expect(page(await read(owner, at('diagram'))).text).toBe(
      'Stored earlier\n\nData: none · Comments: 0\n',
    )

    await env.BLOBS.delete(key)
    // What an earlier converter stored is never served.
    await env.BLOBS.put(
      `derived/markdown/${MARKDOWN_VERSION - 1}/${sha}.md`,
      'From an earlier converter',
    )
    expect(page(await read(owner, at('diagram'))).text).toBe(expected)
    expect(await (await env.BLOBS.get(key))?.text()).toBe(toMarkdown(DIAGRAM))
  })
})

describe('the pointer', () => {
  it('counts only the files the caller can read', async () => {
    // A public page's reader reads its comments, never people's answers.
    const plan = await nodeAt(tree.id, 'plan.html')
    const passer = await person('passer')
    await share(tree.id, plan!.id, 'anyone', '*', 'read', admin)
    const result = page(await read(await sessionFor(passer), at('plan')))
    expect(result.pointer).toEqual({
      data: [
        { path: 'answers/', files: 0 },
        { path: 'decisions.json', files: 0 },
      ],
      comments: 1,
    })
    expect(
      result.text.endsWith(
        '\n\nData: answers/ (0 files), decisions.json (0 files) · Comments: 1\n',
      ),
    ).toBe(true)
    // Later tests read the page as private again.
    await exec(
      "delete from shares where node_id = ? and target_kind = 'anyone'",
      plan!.id,
    )
    // A read share on the page carries the data its forms write.
    const reader = await person('reader')
    await share(tree.id, plan!.id, 'email', reader.email, 'read', admin)
    expect(
      page(await read(await sessionFor(reader), at('plan'))).pointer,
    ).toEqual({
      data: [
        { path: 'answers/', files: 2 },
        { path: 'decisions.json', files: 1 },
      ],
      comments: 1,
    })
  })
})

describe('a folder', () => {
  it('lists its entries, with the kit and its documentation and theme variables for a write holder', async () => {
    const result = folder(await read(owner, at('')))
    expect(result.entries.map((entry) => entry.path)).toContain('plan.html')
    expect(result.kit).not.toBeNull()
    const kit = result.kit ?? []
    expect(kit.find((item) => item.path === '_layout.html')).toMatchObject({
      from: '',
      kind: 'layout',
    })
    expect(kit.find((item) => item.path === '_theme.css')).toMatchObject({
      kind: 'theme',
      variables: ['--font-body', '--primary'],
    })
    expect(
      kit.find((item) => item.path === '_components/acme-card.js'),
    ).toMatchObject({
      kind: 'component',
      tag: 'acme-card',
      doc: 'A card.\n\nUse `<acme-card>` around a summary.',
    })
    expect(result.text).toContain('# handoff/\n\nPages\n')
    expect(result.text).toContain('- Plan · plan.html · push 1, ')
    expect(result.text).toContain('Folders\n- guides/ · 1 page')
    expect(result.text).toContain('- brief.pdf · PDF, 14 bytes')
    expect(result.text).toContain(
      '\nKit\n- _layout.html (from handoff/)\n- _theme.css (from handoff/) · sets --font-body, --primary\n- <acme-card> _components/acme-card.js (from handoff/)\n  A card.\n\n  Use `<acme-card>` around a summary.',
    )
  })

  it('lists no kit for a reader', async () => {
    const reader = await person('folder-reader')
    const root = await nodeAt(tree.id, '')
    await share(tree.id, root!.id, 'email', reader.email, 'read', admin)
    const result = folder(await read(await sessionFor(reader), at('')))
    expect(result.kit).toBeNull()
    expect(result.text).not.toContain('Kit')
    expect(result.text).not.toContain('_layout.html')
    expect(result.text).toContain('- Plan · plan.html')
  })

  it('reads a data folder as its files with who wrote each and when', async () => {
    const result = await read(owner, at('answers/'))
    expect(result.kind).toBe('data')
    if (result.kind !== 'data') return
    expect(
      result.files.map((file) => [file.path, file.data, file.push]),
    ).toEqual([
      ['answers/omar@example.com.json', { trucks: 3 }, 1],
      ['answers/sara@example.com.json', { trucks: 12 }, 1],
    ])
    expect(result.text).toContain(
      '# answers/ (2 files)\n\n## omar@example.com.json\n',
    )
    expect(result.text).toContain('· 12 Oct 2026, 14:20 UTC · push 1')
    expect(result.text).toContain('```json\n{\n  "trucks": 12\n}\n```')
  })
})

describe('a file', () => {
  it('gives a text file its text and a binary one none', async () => {
    expect(await read(owner, at('notes.txt'))).toMatchObject({
      kind: 'file',
      text: 'Plain notes\n',
      doc: null,
    })
    expect(await read(owner, at('brief.pdf'))).toMatchObject({
      kind: 'file',
      text: null,
      size: 14,
      doc: null,
    })
  })

  it('gives a data file its JSON and who wrote it', async () => {
    const result = await read(owner, at('decisions.json'))
    expect(result).toMatchObject({
      kind: 'file',
      text: '{"go":true}',
      doc: { path: 'decisions.json', data: { go: true }, push: 1 },
    })
  })
})

describe('denials', () => {
  it('answer a visitor with sign_in_required and a person without access with not_found, for what exists and what does not', async () => {
    const outsider = await sessionFor(await person('outsider'))
    const visitor: Caller = {
      person: null,
      via: { kind: 'visitor', anonSessionId: null },
      requestId: 'test',
    }
    for (const path of ['plan', 'nothing-here']) {
      const asked = ref(at(path))
      const denied = await failureAs(
        outsider,
        Effect.flatMap(Pages, (pages) => pages.read(asked)),
      )
      expect(denied).toMatchObject({ code: 'not_found', path })
      const signIn = await failureAs(
        visitor,
        Effect.flatMap(Pages, (pages) => pages.read(asked)),
      )
      expect(signIn).toMatchObject({ code: 'sign_in_required', path })
    }
  })
})

describe('TreeStore.docs', () => {
  it('gives each authored file its push and time, and names the pusher by email to members and by name to others', async () => {
    const ws = await workspace(await person('docs-admin'))
    const pusher = await person('pusher')
    await join(ws, pusher)
    const result = committed(
      await pushAll(await agent(pusher), `${ws.name}/docs`, {
        'a.md': 'A',
        'b/c.md': 'C',
      }),
    )
    const member = await person('member')
    await join(ws, member)
    const outsider = await person('outsider')
    const root = await nodeAt(result.treeId, '')
    for (const reader of [member, outsider]) {
      await share(
        result.treeId,
        root!.id,
        'email',
        reader.email,
        'read',
        pusher,
      )
    }

    const docsAs = async (who: Person) =>
      runAs(
        await sessionFor(who),
        Effect.gen(function* () {
          const store = yield* TreeStore
          const access = yield* Access
          const node = yield* store.locate(ref(`${ws.name}/docs/`))
          if ('missing' in node) throw new Error('no root')
          const granted = yield* access.require('read', node.node)
          return yield* store.docs(granted, { origin: 'any' })
        }),
      )

    const byMember = await docsAs(member)
    expect(byMember.map((row) => [row.node.path, row.by, row.push])).toEqual([
      ['a.md', pusher.email, 1],
      ['b/c.md', pusher.email, 1],
    ])
    expect(byMember[0]?.version.createdAt).toEqual(expect.any(Number))
    expect((await docsAs(pusher)).map((row) => row.by)).toEqual([
      pusher.email,
      pusher.email,
    ])
    expect((await docsAs(outsider)).map((row) => row.by)).toEqual([
      pusher.name,
      pusher.name,
    ])
  })
})
