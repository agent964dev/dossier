import type {
  NodeId,
  Person,
  PushNumber,
  SearchMode,
  TreeId,
} from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { Effect, FastCheck as fc } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  Access,
  Files,
  Search,
  type Caller,
  type SearchPage,
} from '../src/core/index.ts'
import { count, exec, rows } from './support/d1.ts'
import { harness, ORIGIN } from './support/harness.ts'
import { keySecretFor } from './support/keys.ts'
import { runAs } from './support/people.ts'
import { at, DAY, MINUTE, purgeAt, pushAt } from './support/purge.ts'
import {
  agent,
  commit,
  dataFile,
  failureAs,
  inTeam,
  join,
  nodeAt,
  person,
  pushAll,
  ref,
  share,
  stage,
  team,
  upload,
  visitorCaller,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const search = (
  caller: Caller,
  text: string,
  mode: SearchMode = 'titles',
  offset = 0,
): Promise<SearchPage> =>
  runAs(
    caller,
    Effect.flatMap(Search, (s) => s.query({ text, mode, offset })),
  )

const searchFailure = (caller: Caller, text: string, mode: SearchMode) =>
  failureAs(
    caller,
    Effect.flatMap(Search, (s) => s.query({ text, mode, offset: 0 })),
  )

/** Where each result is: `tree/path`. */
const places = (page: SearchPage) =>
  page.results.map((r) => `${r.tree}/${r.node.path}`)

/** The snippets' text, joined, for what a person was shown. */
const shown = (page: SearchPage) =>
  page.results
    .flatMap((r) => [r.title, ...(r.snippet ?? []).map((p) => p.text)])
    .join(' ')

/** A word no other test's pages hold. */
const word = (stem: string) =>
  `${stem}${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`

const page = (title: string, body: string, head = '') =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`

/** An owner with a workspace and a tree pushed with `files`. */
const world = async (files: Record<string, string>) => {
  const owner = await person('owner')
  const ws = await workspace(owner)
  const key = await agent(owner)
  const name = `s${crypto.randomUUID().slice(0, 8)}`
  const pushed = await pushAll(key, `${ws.name}/${name}`, files)
  if (!('number' in pushed)) throw new Error('the push did not commit')
  return { owner, ws, key, name, treeId: pushed.treeId as TreeId }
}

describe('titles and paths', () => {
  it('finds a page by a word of its title and by a path segment, and an attachment and a folder by the start of their name', async () => {
    const title = word('Quarterly')
    const folder = word('mockups')
    const file = word('floormap')
    const body = word('underground')
    const t = await world({
      'plan.html': page(`${title} delivery plan`, '<p>Body text.</p>'),
      [`${folder}/erbil-depot.html`]: page('Depot', `<p>${body} words.</p>`),
      [`${folder}/${file}.png`]: 'png bytes',
      '_layout.html': `<title>${title} layout</title><slot></slot>`,
    })
    const byTitle = await search(t.key, title.toLowerCase())
    expect(places(byTitle)).toEqual([`${t.name}/plan.html`])
    expect(byTitle.results[0]).toMatchObject({
      kind: 'page',
      title: `${title} delivery plan`,
      workspace: t.ws.name,
      tree: t.name,
      link: `${ORIGIN}/${t.ws.name}/${t.name}/plan`,
      snippet: null,
    })
    const bySegment = await search(t.key, folder)
    expect(places(bySegment)).toEqual([
      `${t.name}/${folder}/erbil-depot.html`,
      `${t.name}/${folder}`,
    ])
    expect(bySegment.results.map((r) => r.kind)).toEqual(['page', 'folder'])
    const byName = await search(t.key, file.slice(0, 6))
    expect(byName.results).toEqual([
      expect.objectContaining({
        kind: 'attachment',
        title: `${file}.png`,
        link: `${ORIGIN}/${t.ws.name}/${t.name}/${folder}/${file}.png`,
      }),
    ])
    // Titles mode reads titles and paths, never a page's text.
    expect((await search(t.key, body)).results).toEqual([])
    expect(places(await search(t.key, body, 'content'))).toEqual([
      `${t.name}/${folder}/erbil-depot.html`,
    ])
  })

  it('takes the file name as the title of a page without one', async () => {
    const name = word('untitled')
    const t = await world({ [`${name}.html`]: '<p>No title here.</p>' })
    expect((await search(t.key, name)).results[0]?.title).toBe(`${name}.html`)
  })
})

describe('page contents', () => {
  it('finds a word only in a page’s same-name Markdown companion, and one only in a JSON companion its alternate link names', async () => {
    const inMarkdown = word('kirkuk')
    const inJson = word('zanzibar')
    const t = await world({
      'plan.html': page('Delivery plan', '<p>Erbil and Basra.</p>'),
      'plan.md': `# Delivery plan\n\nThe ${inMarkdown} warehouse.\n`,
      'glossary.html': page(
        'Glossary',
        '<p>Terms we use.</p>',
        '<link rel="alternate" type="application/json" href="data/glossary.json">',
      ),
      'data/glossary.json': JSON.stringify({ terms: [inJson] }),
    })
    const md = await search(t.key, inMarkdown, 'content')
    expect(places(md)).toEqual([`${t.name}/plan.html`])
    expect(md.results[0]!.snippet).toContainEqual({
      text: inMarkdown,
      match: true,
    })
    expect(places(await search(t.key, inJson, 'content'))).toEqual([
      `${t.name}/glossary.html`,
    ])
    // Titles mode never reads a companion.
    expect((await search(t.key, inMarkdown)).results).toEqual([])
  })

  it('searches a companion only for someone who reads it, in matches and snippets alike', async () => {
    const hidden = word('quokka')
    const visible = word('wombat')
    const t = await world({
      'shared.html': page(
        'Shared page',
        `<p>Visible ${visible} words.</p>`,
        '<link rel="alternate" type="text/markdown" href="private/notes.md">',
      ),
      'private/notes.md': `Private ${hidden} notes, and ${visible} too.\n`,
    })
    const reader = await person('reader')
    await share(
      t.treeId,
      (await nodeAt(t.treeId, 'shared.html'))!.id,
      'email',
      reader.email,
      'read',
      t.owner,
    )
    const readerKey = await agent(reader)
    // The page is the reader's; its companion is not.
    const companion = (
      await rows<Record<string, unknown>>(
        'select * from nodes where tree_id = ? and path = ?',
        t.treeId,
        'private/notes.md',
      )
    )[0]!
    const companionRead = await runAs(
      readerKey,
      Effect.flatMap(Access, (a) =>
        a.require('read', {
          id: companion.id,
          treeId: companion.tree_id,
          parentId: companion.parent_id,
          name: companion.name,
          path: companion.path,
          depth: companion.depth,
          kind: companion.kind,
          origin: companion.origin,
          ownerId: null,
          currentVersionId: companion.current_version_id,
          createdAt: companion.created_at,
          deletedAt: null,
          underscoreFrom: null,
        } as never),
      ).pipe(Effect.isSuccess),
    )
    expect(companionRead).toBe(false)

    expect((await search(readerKey, hidden, 'content')).results).toEqual([])
    const both = `${visible} ${hidden}`
    expect((await search(readerKey, both, 'content')).results).toEqual([])
    const own = await search(readerKey, visible, 'content')
    expect(places(own)).toEqual([`${t.name}/shared.html`])
    expect(shown(own)).not.toContain(hidden)
    expect(shown(own)).not.toContain('Private')

    // The owner reads both: the companion's words find the page, and a
    // query split across the page and its companion finds it too.
    expect(places(await search(t.key, hidden, 'content'))).toEqual([
      `${t.name}/shared.html`,
    ])
    expect(places(await search(t.key, both, 'content'))).toEqual([
      `${t.name}/shared.html`,
    ])
  })

  it('finds Arabic written with marks by the bare word and the bare word by the marked one, and cafe finds Café', async () => {
    const tag = word('x')
    const t = await world({
      [`${tag}/erbil.html`]: page(
        'خُطَّةُ أَرْبِيل',
        '<p dir="rtl">مَرْحَبًا بِكُمْ فِي إِرْبِيل، نَبْدَأُ التَّوْصِيلَ</p>',
      ),
      [`${tag}/cafe.html`]: page('Le Café', '<p>Un café crème.</p>'),
    })
    const inTag = (p: SearchPage) =>
      places(p).filter((place) => place.includes(`/${tag}/`))
    expect(inTag(await search(t.key, 'مرحبا', 'content'))).toEqual([
      `${t.name}/${tag}/erbil.html`,
    ])
    expect(inTag(await search(t.key, 'اربيل', 'content'))).toEqual([
      `${t.name}/${tag}/erbil.html`,
    ])
    expect(inTag(await search(t.key, 'أَرْبِيل'))).toEqual([
      `${t.name}/${tag}/erbil.html`,
    ])
    expect(inTag(await search(t.key, 'cafe', 'content'))).toEqual([
      `${t.name}/${tag}/cafe.html`,
    ])
    expect(inTag(await search(t.key, 'CAFÉ'))).toEqual([
      `${t.name}/${tag}/cafe.html`,
    ])
  })

  it('returns a page’s markup written as text as text parts, never as markup', async () => {
    const budget = word('budget')
    const t = await world({
      'plan.html': page(
        'Plan',
        `<p>The &lt;b&gt;${budget}&lt;/b&gt; line.</p>`,
      ),
    })
    const found = await search(t.key, budget, 'content')
    expect(found.results[0]!.snippet).toEqual([
      { text: 'The <b>', match: false },
      { text: budget, match: true },
      { text: '</b> line.', match: false },
    ])
  })

  it('finds a staged push only after its commit, and the old text no more', async () => {
    const before = word('ocelot')
    const after = word('pangolin')
    const t = await world({
      'plan.html': page('Plan', `<p>Before: ${before}.</p>`),
    })
    expect(places(await search(t.key, before, 'content'))).toEqual([
      `${t.name}/plan.html`,
    ])
    const files = { 'plan.html': page('Plan', `<p>After: ${after}.</p>`) }
    const staged = await stage(t.key, `${t.ws.name}/${t.name}`, files, {
      force: true,
    })
    await upload(t.key, staged.pushId!, files, staged.missing)
    expect((await search(t.key, after, 'content')).results).toEqual([])
    await commit(t.key, staged.pushId!)
    expect(places(await search(t.key, after, 'content'))).toEqual([
      `${t.name}/plan.html`,
    ])
    expect((await search(t.key, before, 'content')).results).toEqual([])
  })

  it('never finds people’s data, as a file or as a companion', async () => {
    const answer = word('narwhal')
    const t = await world({
      'board.html': page(
        'Board',
        '<form action="board.json" method="post"><input name="note"><button>Save</button></form>',
        '<link rel="alternate" type="application/json" href="board.json">',
      ),
      'questions/index.html': page(
        'Questions',
        '<form action="answers/" method="post"><input name="regions"><button>Send</button></form>',
      ),
    })
    const writer = await person('writer')
    await dataFile(t.treeId, 'board.json', { note: answer }, writer)
    await dataFile(
      t.treeId,
      `questions/answers/${writer.email}.json`,
      { regions: answer },
      writer,
    )
    // Pushing the board again indexes it while its alternate is data.
    const pushed = await pushAll(
      t.key,
      `${t.ws.name}/${t.name}`,
      {
        'board.html': page(
          'Board',
          '<form action="board.json" method="post"><input name="note"><button>Save it</button></form>',
          '<link rel="alternate" type="application/json" href="board.json">',
        ),
        'questions/index.html': page(
          'Questions',
          '<form action="answers/" method="post"><input name="regions"><button>Send</button></form>',
        ),
      },
      { force: true },
    )
    expect('number' in pushed).toBe(true)
    const [row] = await rows<{ companion: string | null }>(
      `select d.companion_node_id as companion from search_docs d
       join nodes n on n.id = d.node_id where n.tree_id = ? and n.path = ?`,
      t.treeId,
      'board.html',
    )
    expect(row).toEqual({ companion: null })
    expect((await search(t.key, answer, 'content')).results).toEqual([])
    expect((await search(t.key, answer)).results).toEqual([])
  })
})

describe('who finds what', () => {
  it('finds a public page for a signed-in person whose only grant is an anyone share, in a workspace they do not belong to', async () => {
    const tag = word('public')
    const t = await world({
      'public.html': page(`${tag} notice`, '<p>For everyone.</p>'),
      'private.html': page(`${tag} private`, '<p>Not for everyone.</p>'),
    })
    await share(
      t.treeId,
      (await nodeAt(t.treeId, 'public.html'))!.id,
      'anyone',
      '',
      'read',
      t.owner,
    )
    const stranger = await agent(await person('stranger'))
    expect(places(await search(stranger, tag))).toEqual([
      `${t.name}/public.html`,
    ])
  })

  it('finds what a write holder, a read-only key of theirs and a respondent may read, and nothing else', async () => {
    const tag = word('scope')
    const t = await world({
      [`mockups/${tag}-depot.html`]: page('Depot', '<p>Depot.</p>'),
      [`mockups/${tag}-yard.html`]: page('Yard', '<p>Yard.</p>'),
      [`${tag}-plan.html`]: page('Plan', '<p>Plan.</p>'),
    })
    const writer = await person('writer')
    const respondent = await person('respondent')
    await share(
      t.treeId,
      (await nodeAt(t.treeId, 'mockups'))!.id,
      'email',
      writer.email,
      'write',
      t.owner,
    )
    await share(
      t.treeId,
      (await nodeAt(t.treeId, `mockups/${tag}-depot.html`))!.id,
      'email',
      respondent.email,
      'respond',
      t.owner,
    )
    const folder = [
      `${t.name}/mockups/${tag}-depot.html`,
      `${t.name}/mockups/${tag}-yard.html`,
    ]
    expect(places(await search(await agent(writer), tag)).sort()).toEqual(
      folder,
    )
    expect(
      places(await search(await agent(writer, { readOnly: true }), tag)).sort(),
    ).toEqual(folder)
    expect(places(await search(await agent(respondent), tag))).toEqual([
      `${t.name}/mockups/${tag}-depot.html`,
    ])
    expect(places(await search(t.key, tag))).toHaveLength(3)
  })

  it('finds through a team share and a workspace share only for the people they reach', async () => {
    const tag = word('teamed')
    const t = await world({
      'team/a.html': page(`${tag} team page`, '<p>Team.</p>'),
      'all/b.html': page(`${tag} workspace page`, '<p>Workspace.</p>'),
    })
    const member = await person('member')
    await join(t.ws, member)
    const design = await team(t.ws, 'Design')
    const designer = await person('designer')
    await join(t.ws, designer)
    await inTeam(design, designer)
    await share(
      t.treeId,
      (await nodeAt(t.treeId, 'team'))!.id,
      'team',
      design.id,
      'read',
      t.owner,
    )
    await share(
      t.treeId,
      (await nodeAt(t.treeId, 'all'))!.id,
      'workspace',
      t.ws.id,
      'read',
      t.owner,
    )
    expect(places(await search(await agent(member), tag))).toEqual([
      `${t.name}/all/b.html`,
    ])
    expect(places(await search(await agent(designer), tag)).sort()).toEqual([
      `${t.name}/all/b.html`,
      `${t.name}/team/a.html`,
    ])
    expect(
      (await search(await agent(await person('nobody')), tag)).results,
    ).toEqual([])
  })

  it('loses a result at once when the share behind it is revoked', async () => {
    const tag = word('revoked')
    const t = await world({ 'page.html': page(`${tag} page`, '<p>Hi.</p>') })
    const reader = await person('reader')
    await share(
      t.treeId,
      (await nodeAt(t.treeId, 'page.html'))!.id,
      'email',
      reader.email,
      'read',
      t.owner,
    )
    const key = await agent(reader)
    expect(places(await search(key, tag))).toEqual([`${t.name}/page.html`])
    await exec(
      'delete from shares where tree_id = ? and target = ?',
      t.treeId,
      reader.email,
    )
    expect((await search(key, tag)).results).toEqual([])
  })

  it('searches only the tree a scoped key reaches, within its scope', async () => {
    const tag = word('scoped')
    const t = await world({
      'docs/a.html': page(`${tag} a`, '<p>A.</p>'),
      'other/b.html': page(`${tag} b`, '<p>B.</p>'),
    })
    const second = await pushAll(t.key, `${t.ws.name}/${t.name}-two`, {
      'c.html': page(`${tag} c`, '<p>C.</p>'),
    })
    expect('number' in second).toBe(true)
    expect(places(await search(t.key, tag))).toHaveLength(3)
    const scoped = await agent(t.owner, {
      scope: (await nodeAt(t.treeId, 'docs'))!.id as NodeId,
    })
    expect(places(await search(scoped, tag))).toEqual([`${t.name}/docs/a.html`])
  })

  it('asks a visitor to sign in', async () => {
    expect(
      await searchFailure(visitorCaller(), 'plan', 'titles'),
    ).toMatchObject({
      code: 'sign_in_required',
    })
  })

  it('refuses an empty query and one over 200 characters', async () => {
    const key = await agent(await person('asker'))
    expect(await searchFailure(key, ' \u064B ', 'content')).toMatchObject({
      code: 'invalid',
      path: 'q',
    })
    expect(await searchFailure(key, 'a'.repeat(201), 'titles')).toMatchObject({
      code: 'invalid',
      path: 'q',
    })
    // Punctuation alone matches nothing, and is no error.
    expect((await search(key, '!!!')).results).toEqual([])
  })

  it('pages through more than 20 results', async () => {
    const tag = word('many')
    const files: Record<string, string> = {}
    for (let n = 0; n < 25; n += 1) {
      files[`p${String(n).padStart(2, '0')}.html`] = page(
        `${tag} ${n}`,
        '<p>One of many.</p>',
      )
    }
    const t = await world(files)
    const first = await search(t.key, tag)
    expect(first.results).toHaveLength(20)
    expect(first.next).toBe(20)
    const second = await search(t.key, tag, 'titles', 20)
    expect(second.results).toHaveLength(5)
    expect(second.next).toBeNull()
    expect(new Set([...places(first), ...places(second)]).size).toBe(25)
  })
})

describe('the index follows the tree', () => {
  it('drops a deleted page, brings back a restored one, and shows a moved one at its new path', async () => {
    const tag = word('follow')
    const t = await world({
      'plan.html': page(`${tag} plan`, '<p>Plan.</p>'),
      'plan.md': `${tag}companion words\n`,
      'keep.html': page('Keep', '<a href="plan">Plan</a>'),
    })
    await runAs(
      t.key,
      Effect.flatMap(Files, (f) =>
        f.rm({ ref: ref(`${t.ws.name}/${t.name}/plan.html`) }),
      ),
    )
    expect((await search(t.key, tag)).results).toEqual([])
    expect((await search(t.key, `${tag}companion`, 'content')).results).toEqual(
      [],
    )
    await runAs(
      t.key,
      Effect.flatMap(Files, (f) =>
        f.restore({
          ref: ref(`${t.ws.name}/${t.name}/plan.html`),
          to: { push: 1 as PushNumber },
        }),
      ),
    )
    expect(places(await search(t.key, tag))).toEqual([`${t.name}/plan.html`])
    await runAs(
      t.key,
      Effect.flatMap(Files, (f) =>
        f.mv({
          from: ref(`${t.ws.name}/${t.name}/plan.html`),
          to: ref(`${t.ws.name}/${t.name}/plans/plan.html`),
        }),
      ),
    )
    const moved = await search(t.key, tag)
    expect(places(moved)).toEqual([`${t.name}/plans/plan.html`])
    expect(moved.results[0]!.link).toBe(
      `${ORIGIN}/${t.ws.name}/${t.name}/plans/plan`,
    )
    // The page whose link the move rewrote is still found at its version.
    expect(places(await search(t.key, 'Keep'))).toContain(`${t.name}/keep.html`)
    // The companion stayed behind: the moved page is no longer found by it.
    expect((await search(t.key, `${tag}companion`, 'content')).results).toEqual(
      [],
    )
  })

  it('indexes a page again when its companion alone is deleted, and takes its words out', async () => {
    const tag = word('lonely')
    const t = await world({
      'plan.html': page('Plan', '<p>Plan.</p>'),
      'plan.md': `${tag} words\n`,
    })
    expect(places(await search(t.key, tag, 'content'))).toEqual([
      `${t.name}/plan.html`,
    ])
    await runAs(
      t.key,
      Effect.flatMap(Files, (f) =>
        f.rm({ ref: ref(`${t.ws.name}/${t.name}/plan.md`) }),
      ),
    )
    expect((await search(t.key, tag, 'content')).results).toEqual([])
  })

  it('leaves nothing of a purged page in the index', async () => {
    const tag = word('purged')
    const owner = await person('owner')
    const ws = await workspace(owner)
    const key = await agent(owner)
    const T0 = Date.now()
    const name = `s${crypto.randomUUID().slice(0, 8)}`
    const pushed = await pushAt(T0, key, `${ws.name}/${name}`, {
      'gone.html': page(`${tag} gone`, `<p>${tag} body.</p>`),
      'stay.html': page('Stay', '<p>Stay.</p>'),
    })
    const gone = (await nodeAt(pushed.treeId, 'gone.html'))!.id
    expect(await count('search_docs', 'node_id = ?', gone)).toBe(1)
    await at(
      T0 + MINUTE,
      key,
      Effect.flatMap(Files, (f) =>
        f.rm({ ref: ref(`${ws.name}/${name}/gone.html`) }),
      ),
    )
    // Deleted: its row is gone with the change.
    expect(await count('search_docs', 'node_id = ?', gone)).toBe(0)
    await purgeAt(T0 + 31 * DAY)
    expect(await count('nodes', 'id = ?', gone)).toBe(0)
    const matches = await rows<{ rowid: number }>(
      `select rowid from search_pages where search_pages match ?`,
      `"${tag}"`,
    )
    expect(matches).toEqual([])
  })
})

describe('the search route', () => {
  it('answers an agent key, and refuses a query over 200 characters with 400 invalid', async () => {
    const tag = word('routed')
    const owner = await person('owner')
    const ws = await workspace(owner)
    const name = `s${crypto.randomUUID().slice(0, 8)}`
    const pushed = await pushAll(await agent(owner), `${ws.name}/${name}`, {
      'plan.html': page(`${tag} plan`, `<p>The ${tag} depot.</p>`),
    })
    expect('number' in pushed).toBe(true)
    const secret = await keySecretFor(owner)
    const get = (query: string) =>
      SELF.fetch(`${ORIGIN}/_/api/search?${query}`, {
        headers: { authorization: `Bearer ${secret}` },
      })
    const found = await get(`q=${tag}&mode=content`)
    expect(found.status).toBe(200)
    expect(await found.json()).toEqual({
      query: tag,
      mode: 'content',
      results: [
        {
          kind: 'page',
          title: `${tag} plan`,
          workspace: ws.name,
          tree: name,
          path: 'plan.html',
          link: `${ORIGIN}/${ws.name}/${name}/plan`,
          snippet: [
            { text: 'The ', match: false },
            { text: tag, match: true },
            { text: ' depot.', match: false },
          ],
        },
      ],
      next: null,
    })
    const long = await get(`q=${'a'.repeat(201)}&mode=titles`)
    expect(long.status).toBe(400)
    expect(await long.json()).toMatchObject({ error: { code: 'invalid' } })
    const anonymous = await SELF.fetch(
      `${ORIGIN}/_/api/search?q=${tag}&mode=titles`,
    )
    expect(anonymous.status).toBe(401)
  })
})

describe('agreement with the point check', () => {
  const FOLDERS = ['', 'a', 'a/b', 'c'] as const
  const pathOf = (folder: string, name: string) =>
    folder === '' ? name : `${folder}/${name}`

  let people: {
    admin: Person
    member: Person
    outsider: Person
    ws: { id: string; name: string }
    design: { id: string }
  } | null = null
  beforeAll(async () => {
    const admin = await person('admin')
    const ws = await workspace(admin)
    const member = await person('member')
    await join(ws, member)
    const outsider = await person('outsider')
    const design = await team(ws, 'Design', [member])
    people = { admin, member, outsider, ws, design }
  })

  it('returns only pages require(read) grants, and every one of them, on random trees, shares and callers', async () => {
    const { admin, member, outsider, ws, design } = people!
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          shares: fc.array(
            fc.record({
              at: fc.integer({ min: 0, max: FOLDERS.length * 2 - 1 }),
              kind: fc.constantFrom('email', 'workspace', 'anyone', 'team'),
              role: fc.constantFrom('read', 'respond', 'write'),
            }),
            { maxLength: 3 },
          ),
          caller: fc.constantFrom('member', 'outsider', 'readonly', 'scoped'),
          scopeAt: fc.integer({ min: 0, max: FOLDERS.length - 1 }),
        }),
        async (s) => {
          const tag = word('prop')
          const files: Record<string, string> = {}
          for (const folder of FOLDERS) {
            files[pathOf(folder, 'p.html')] = page(
              `${tag} page`,
              `<p>${tag} text.</p>`,
              '<link rel="alternate" type="text/markdown" href="notes.md">',
            )
            files[pathOf(folder, 'notes.md')] = `${tag}note\n`
          }
          const key = await agent(admin)
          const name = `s${crypto.randomUUID().slice(0, 8)}`
          const pushed = await pushAll(key, `${ws.name}/${name}`, files)
          if (!('number' in pushed)) throw new Error('no commit')
          const treeId = pushed.treeId
          // Shares on folders (even indexes) and pages (odd ones).
          for (const sh of s.shares) {
            const folder = FOLDERS[Math.floor(sh.at / 2)]!
            const path = sh.at % 2 === 0 ? folder : pathOf(folder, 'p.html')
            const node = (await nodeAt(treeId, path))!
            await exec(
              `insert into shares (id, tree_id, node_id, target_kind, target, role, created_by, created_at)
               values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
              crypto.randomUUID(),
              treeId,
              node.id,
              sh.kind,
              sh.kind === 'email'
                ? (s.caller === 'outsider'
                    ? outsider
                    : member
                  ).email.toLowerCase()
                : sh.kind === 'workspace'
                  ? ws.id
                  : sh.kind === 'team'
                    ? design.id
                    : '',
              sh.role,
              admin.id,
              Date.now(),
            )
          }
          const caller =
            s.caller === 'member'
              ? await agent(member)
              : s.caller === 'outsider'
                ? await agent(outsider)
                : s.caller === 'readonly'
                  ? await agent(member, { readOnly: true })
                  : await agent(member, {
                      scope: (await nodeAt(treeId, FOLDERS[s.scopeAt]!))!
                        .id as NodeId,
                    })
          const pages = await rows<Record<string, unknown>>(
            `select * from nodes where tree_id = ? and deleted_at is null
               and path like '%p.html'`,
            treeId,
          )
          const readable = new Set<string>()
          for (const row of pages) {
            const ok = await runAs(
              caller,
              Effect.flatMap(Access, (a) =>
                a.require('read', {
                  id: row.id,
                  treeId: row.tree_id,
                  parentId: row.parent_id,
                  name: row.name,
                  path: row.path,
                  depth: row.depth,
                  kind: row.kind,
                  origin: row.origin,
                  ownerId: null,
                  currentVersionId: row.current_version_id,
                  createdAt: row.created_at,
                  deletedAt: null,
                  underscoreFrom: null,
                } as never),
              ).pipe(Effect.isSuccess),
            )
            if (ok) readable.add(`${name}/${row.path as string}`)
          }
          const what = JSON.stringify(s)
          for (const mode of ['titles', 'content'] as const) {
            const found = await search(caller, tag, mode)
            expect(new Set(places(found)), `${mode} ${what}`).toEqual(readable)
          }
          // A companion's word finds exactly the readable pages whose
          // companion is readable too.
          const both = new Set<string>()
          for (const place of readable) {
            const notes = place
              .slice(name.length + 1)
              .replace(/p\.html$/, 'notes.md')
            const row = (
              await rows<Record<string, unknown>>(
                'select * from nodes where tree_id = ? and path = ? and deleted_at is null',
                treeId,
                notes,
              )
            )[0]!
            const ok = await runAs(
              caller,
              Effect.flatMap(Access, (a) =>
                a.require('read', {
                  id: row.id,
                  treeId: row.tree_id,
                  parentId: row.parent_id,
                  name: row.name,
                  path: row.path,
                  depth: row.depth,
                  kind: row.kind,
                  origin: row.origin,
                  ownerId: null,
                  currentVersionId: row.current_version_id,
                  createdAt: row.created_at,
                  deletedAt: null,
                  underscoreFrom: null,
                } as never),
              ).pipe(Effect.isSuccess),
            )
            if (ok) both.add(place)
          }
          const viaCompanion = await search(caller, `${tag}note`, 'content')
          expect(new Set(places(viaCompanion)), `companion ${what}`).toEqual(
            both,
          )
        },
      ),
      { numRuns: 25 },
    )
  }, 120_000)
})
