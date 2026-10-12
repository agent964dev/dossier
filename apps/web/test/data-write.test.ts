// Page code's writes through Data.write: merges, replaces, entries, the
// rules on whose file it is, forms, replay and the push the writer saw.
import type { AuthoredSeq, OpId, Person, TreeId } from '@dossier/contracts'
import type { JsonObject } from '@dossier/contracts/bridge'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Data, type Caller } from '../src/core/index.ts'
import { exec, rows } from './support/d1.ts'
import {
  formRef,
  liveValue,
  pageWith,
  pushForms,
  QUESTIONS,
  repush,
  seqOf,
  versionsAt,
  uploadAs,
  type FormTree,
} from './support/forms.ts'
import { harness } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  failureAs,
  nodeAt,
  person,
  share,
  visitorCaller,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const FILES = {
  'board.html': pageWith('<svg id="board"></svg>', 'Board'),
  'plan.html': pageWith('<p>The plan.</p>', 'Plan'),
  'questions/index.html': QUESTIONS,
  'ideas.html': pageWith(
    '<form action="ideas/" data-entries="many"><input name="idea" required><button>Add</button></form>',
    'Ideas',
  ),
  'status.html': pageWith(
    '<form action="status.json"><input name="state" required><input name="count" type="number" max="9"></form>',
    'Status',
  ),
  'closed.html': pageWith(
    '<form action="closed.json" data-closed><input name="state"></form>',
    'Closed',
  ),
  'apply.html': pageWith(
    '<form action="applications/"><input name="cv" type="file" accept=".pdf,application/pdf"><input name="other" type="file"></form>',
    'Apply',
  ),
  'late.html': pageWith(
    '<form action="late/" data-closed><input name="note"></form>',
    'Late',
  ),
  'notes.json': '{"authored":true}',
  '_theme.css': ':root { --accent: red }',
}

interface Write {
  readonly page?: string
  readonly path: string
  readonly patch: JsonObject
  readonly replace?: boolean
  readonly opId?: string
  readonly seq?: AuthoredSeq
  readonly as?: string | null
}

const inputOf = async (tree: FormTree, w: Write) => ({
  tree: tree.treeId as TreeId,
  page: w.page ?? 'board.html',
  path: w.path,
  patch: w.patch,
  replace: w.replace ?? false,
  opId: (w.opId ?? crypto.randomUUID()) as OpId,
  seq: w.seq ?? (await seqOf(tree)),
  as: w.as,
})

const writeAs = async (caller: Caller, tree: FormTree, w: Write) => {
  const input = await inputOf(tree, w)
  return runAs(
    caller,
    Effect.flatMap(Data, (data) => data.write(input)),
  )
}

const writeFailure = async (caller: Caller, tree: FormTree, w: Write) => {
  const input = await inputOf(tree, w)
  return failureAs(
    caller,
    Effect.flatMap(Data, (data) => data.write(input)),
  )
}

let owner: Person
let ws: { id: string; name: string }
let browser: Caller

beforeAll(async () => {
  owner = await person('owner')
  ws = await workspace(owner)
  browser = await sessionFor(owner)
})

/** A person given `role` on the tree's root, signed in. */
const given = async (tree: FormTree, role: 'read' | 'respond' | 'write') => {
  const who = await person(role)
  await share(
    tree.treeId,
    (await nodeAt(tree.treeId, ''))!.id,
    'email',
    who.email.toLowerCase(),
    role,
    owner,
  )
  return { who, caller: await sessionFor(who) }
}

describe('a write', () => {
  it('merges as RFC 7396 says at every depth, replaces arrays and removes a key on null', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const first = await writeAs(browser, tree, {
      path: 'layout.json',
      patch: { a: { x: 1, y: { deep: true, keep: 1 } }, list: [1, 2], gone: 1 },
    })
    expect(first).toMatchObject({
      path: 'layout.json',
      data: { a: { x: 1, y: { deep: true, keep: 1 } }, list: [1, 2], gone: 1 },
      by: owner.email,
      push: 1,
    })
    const second = await writeAs(browser, tree, {
      path: 'layout.json',
      patch: { a: { y: { deep: false } }, list: [3], gone: null, b: 'new' },
    })
    expect(second.data).toEqual({
      a: { x: 1, y: { deep: false, keep: 1 } },
      list: [3],
      b: 'new',
    })
    expect(await liveValue(tree.treeId, 'layout.json')).toEqual({
      value: second.data,
      owner: null,
    })
    expect(await versionsAt(tree.treeId, 'layout.json')).toHaveLength(2)
  })

  it('replaces the whole value of the caller own file, and refuses that on a shared file', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const own = `notes/${owner.email.toLowerCase()}.json`
    await writeAs(browser, tree, { path: own, patch: { a: 1, b: 2 } })
    const replaced = await writeAs(browser, tree, {
      path: own,
      patch: { c: 3 },
      replace: true,
    })
    expect(replaced.data).toEqual({ c: 3 })
    expect(await liveValue(tree.treeId, own)).toEqual({
      value: { c: 3 },
      owner: owner.id,
    })
    await writeAs(browser, tree, { path: 'shared.json', patch: { a: 1 } })
    expect(
      await writeFailure(browser, tree, {
        path: 'shared.json',
        patch: { a: 2 },
        replace: true,
      }),
    ).toMatchObject({ code: 'forbidden' })
    expect(
      await writeFailure(browser, tree, {
        path: 'fresh.json',
        patch: { a: 2 },
        replace: true,
      }),
    ).toMatchObject({ code: 'forbidden' })
  })

  it('refuses an authored file, a _ file, a page and another person file, though the writer holds write', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const other = await given(tree, 'respond')
    await writeAs(other.caller, tree, {
      path: `notes/${other.who.email.toLowerCase()}.json`,
      patch: { mine: true },
    })
    for (const path of [
      'notes.json',
      '_theme.css',
      '_data.json',
      'plan.html',
      'questions/index.html',
      `notes/${other.who.email.toLowerCase()}.json`,
      `elsewhere/${other.who.email.toLowerCase()}/x.json`,
      `${other.who.email.toLowerCase()}.json`,
    ]) {
      expect(
        await writeFailure(browser, tree, { path, patch: { x: 1 } }),
        path,
      ).toMatchObject({ code: 'forbidden' })
    }
    // Still the pushed file: one authored version, no data written over it.
    expect(
      await rows<{ origin: string; versions: number }>(
        `select n.origin, (select count(*) from node_versions v where v.node_id = n.id) as versions
         from nodes n where n.tree_id = ? and n.path = 'notes.json'`,
        tree.treeId,
      ),
    ).toEqual([{ origin: 'authored', versions: 1 }])
  })

  it('adds a new entry owned by the writer for ideas/<email>/ and for plan.comments/', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const email = sara.who.email.toLowerCase()
    const a = await writeAs(sara.caller, tree, {
      path: `ideas/${email}/`,
      patch: { idea: 'one' },
    })
    const b = await writeAs(sara.caller, tree, {
      path: `ideas/${email}/`,
      patch: { idea: 'two' },
    })
    expect(a.path).toMatch(
      new RegExp(
        `^ideas/${email.replace('.', '\\.')}/\\d{4}-\\d\\d-\\d\\dT[\\d-]+\\.json$`,
      ),
    )
    expect(b.path).not.toBe(a.path)
    const comment = await writeAs(sara.caller, tree, {
      page: 'plan.html',
      path: 'plan.comments/',
      patch: { text: 'Looks good' },
    })
    expect(comment.path.startsWith(`plan.comments/${email}/`)).toBe(true)
    const owners = await rows<{ path: string; owner_id: string | null }>(
      `select path, owner_id from nodes where tree_id = ? and origin = 'data'
         and deleted_at is null order by path`,
      tree.treeId,
    )
    expect(
      owners.filter(
        (r) =>
          r.path.startsWith(`ideas/${email}`) ||
          r.path.startsWith(`plan.comments/${email}`),
      ),
    ).toEqual(
      [`ideas/${email}`, a.path, b.path, `plan.comments/${email}`, comment.path]
        .sort()
        .map((path) => ({ path, owner_id: sara.who.id })),
    )
    const events = await rows<{ type: string; path: string }>(
      'select type, path from events where tree_id = ? and seq > 1 order by seq',
      tree.treeId,
    )
    expect(events.map((e) => e.type)).toEqual(['entry', 'entry', 'entry'])
  })

  it('lets a respond holder write a shared file, and refuses a read holder', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const responder = await given(tree, 'respond')
    const reader = await given(tree, 'read')
    expect(
      await writeAs(responder.caller, tree, {
        path: 'layout.json',
        patch: { n1: { x: 1, y: 2 } },
      }),
    ).toMatchObject({ data: { n1: { x: 1, y: 2 } } })
    expect(
      await writeFailure(reader.caller, tree, {
        path: 'layout.json',
        patch: { n2: { x: 1 } },
      }),
    ).toMatchObject({ code: 'forbidden' })
    expect(
      await writeFailure(visitorCaller(), tree, {
        path: 'layout.json',
        patch: { n2: { x: 1 } },
      }),
    ).toMatchObject({ code: 'sign_in_required' })
  })

  it('checks a write into a form target against the form, and refuses it when every such form is closed', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const email = owner.email.toLowerCase()
    expect(
      await writeAs(browser, tree, {
        page: 'status.html',
        path: 'status.json',
        patch: { state: 'go', count: 3 },
      }),
    ).toMatchObject({ data: { state: 'go', count: 3 } })
    expect(
      await writeFailure(browser, tree, {
        page: 'status.html',
        path: 'status.json',
        patch: { count: 12 },
      }),
    ).toMatchObject({ code: 'invalid', path: 'count' })
    expect(
      await writeFailure(browser, tree, {
        page: 'status.html',
        path: 'status.json',
        patch: { other: 'x' },
      }),
    ).toMatchObject({ code: 'invalid', path: 'other' })
    expect(
      await writeFailure(browser, tree, {
        path: `questions/answers/${email}.json`,
        patch: { trucks: 'many' },
      }),
    ).toMatchObject({ code: 'invalid', path: 'trucks' })
    expect(
      await writeAs(browser, tree, {
        path: `questions/answers/${email}.json`,
        patch: { role: 'Driver', trucks: 4 },
      }),
    ).toMatchObject({ data: { role: 'Driver', trucks: 4 } })
    expect(
      await writeFailure(browser, tree, {
        path: `ideas/${email}/`,
        patch: { nope: 1 },
      }),
    ).toMatchObject({ code: 'invalid', path: 'nope' })
    expect(
      await writeFailure(browser, tree, {
        page: 'closed.html',
        path: 'closed.json',
        patch: { state: 'x' },
      }),
    ).toMatchObject({ code: 'closed' })
  })

  it('answers not_mergeable for a stored array', async () => {
    const tree = await pushForms(owner, ws, FILES)
    await writeAs(browser, tree, { path: 'list.json', patch: { a: 1 } })
    await exec(
      `update node_versions set json_value = '[1,2]' where id =
         (select current_version_id from nodes where tree_id = ? and path = 'list.json')`,
      tree.treeId,
    )
    expect(
      await writeFailure(browser, tree, { path: 'list.json', patch: { b: 2 } }),
    ).toMatchObject({ code: 'not_mergeable' })
  })

  it('stores a repeated op ID once and answers its first result, even after the minute rate is spent', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const opId = crypto.randomUUID()
    const first = await writeAs(browser, tree, {
      path: 'counter.json',
      patch: { n: 1 },
      opId,
    })
    await exec(
      `insert into rate_counters (key, window_start, count) values (?, ?, 30)
       on conflict (key) do update set window_start = excluded.window_start, count = 30`,
      `send:${owner.id}`,
      Math.floor(Date.now() / 60_000) * 60_000,
    )
    try {
      expect(
        await writeAs(browser, tree, {
          path: 'counter.json',
          patch: { n: 2 },
          opId,
        }),
      ).toEqual(first)
      expect(
        await writeFailure(browser, tree, {
          path: 'counter.json',
          patch: { n: 3 },
        }),
      ).toMatchObject({
        code: 'rate_limited',
        message: 'Too many sends. Try again in a minute.',
      })
    } finally {
      await exec('delete from rate_counters where key = ?', `send:${owner.id}`)
    }
    expect(await versionsAt(tree.treeId, 'counter.json')).toHaveLength(1)
  })

  it('records the push the writer saw: the older one its page was served at', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const seen = await seqOf(tree)
    await repush(tree, {
      ...FILES,
      'board.html': pageWith('<svg id="board"></svg><p>Two</p>', 'Board'),
    })
    const doc = await writeAs(browser, tree, {
      path: 'layout.json',
      patch: { a: 1 },
      seq: seen,
    })
    expect(doc.push).toBe(1)
    const [version] = await versionsAt(tree.treeId, 'layout.json')
    expect(version?.seen_push_number).toBe(1)
    const now = await writeAs(browser, tree, {
      path: 'layout.json',
      patch: { a: 2 },
    })
    expect(now.push).toBe(2)
  })

  it('goes on only as the person the page was shown to', async () => {
    const tree = await pushForms(owner, ws, FILES)
    expect(
      await writeFailure(browser, tree, {
        path: 'layout.json',
        patch: { a: 1 },
        as: 'someone-else@example.com',
      }),
    ).toMatchObject({ code: 'sign_in_required' })
    expect(await liveValue(tree.treeId, 'layout.json')).toBeNull()
    expect(
      await writeAs(browser, tree, {
        path: 'layout.json',
        patch: { a: 1 },
        as: owner.email.toUpperCase(),
      }),
    ).toMatchObject({ data: { a: 1 } })
  })

  it('refuses a page the caller cannot read at that sequence', async () => {
    const tree = await pushForms(owner, ws, FILES)
    expect(
      await writeFailure(browser, tree, {
        page: 'missing.html',
        path: 'layout.json',
        patch: { a: 1 },
      }),
    ).toMatchObject({ code: 'forbidden' })
  })
})

describe('a write into a form target', () => {
  it('keeps a closed person form closed whatever shape the write takes', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const email = owner.email.toLowerCase()
    for (const path of [
      'late/',
      `late/${email}.json`,
      `late/${email}/x.json`,
    ]) {
      expect(
        await writeFailure(browser, tree, {
          path,
          patch: { nonexistent: 'bypass' },
        }),
        path,
      ).toMatchObject({ code: 'closed' })
    }
    expect(
      await rows(
        "select path from nodes where tree_id = ? and path like 'late/%'",
        tree.treeId,
      ),
    ).toEqual([])
  })

  it('refuses a shape an open form does not store: an entry under a person form, a file under its uploads', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const email = owner.email.toLowerCase()
    for (const path of [
      'questions/answers/',
      `questions/answers/${email}/`,
      `questions/answers/${email}/files/x.json`,
      'questions/answers/other.json',
      'ideas/x.json',
      `ideas/${email}.json`,
    ]) {
      expect(
        await writeFailure(browser, tree, {
          path,
          patch: { role: 'x', idea: 'x' },
        }),
        path,
      ).toMatchObject({ code: 'forbidden' })
    }
  })
})

describe('a first write', () => {
  it('removes nulls at every depth, as a merge patch into nothing does', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const doc = await writeAs(browser, tree, {
      path: 'nested.json',
      patch: { a: { gone: null, keep: 1, deeper: { also: null } }, top: null },
    })
    expect(doc.data).toEqual({ a: { keep: 1, deeper: {} } })
    expect(await liveValue(tree.treeId, 'nested.json')).toEqual({
      value: { a: { keep: 1, deeper: {} } },
      owner: null,
    })
  })
})

describe('an upload named by a write', () => {
  it('must be one of the writer own uploads for the form, recorded as stored', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const email = owner.email.toLowerCase()
    const path = `questions/answers/${email}.json`
    const forged = {
      file: 'files/someone-else.pdf',
      name: 'cv.pdf',
      size: 10,
      type: 'application/pdf',
    }
    expect(
      await writeFailure(browser, tree, {
        page: 'questions/index.html',
        path,
        patch: { role: 'Driver', cv: forged },
      }),
    ).toMatchObject({ code: 'invalid', path: 'cv' })
    const form = await formRef(
      tree,
      'questions/index.html',
      'questions/answers/',
    )
    const stored = await uploadAs(browser, tree, {
      page: 'questions/index.html',
      form,
      field: 'cv',
      name: 'cv.pdf',
      bytes: '%PDF real',
    })
    const doc = await writeAs(browser, tree, {
      page: 'questions/index.html',
      path,
      patch: {
        role: 'Driver',
        cv: {
          file: stored.file,
          name: 'renamed.exe',
          size: 1,
          type: 'text/html',
        },
      },
    })
    expect((doc.data as { cv: unknown }).cv).toEqual({
      file: stored.file,
      name: stored.name,
      size: stored.size,
      type: stored.type,
    })
  })
})

describe('an upload named by a write, as it is stored', () => {
  it('is checked against the field by what was stored, not what the write claims', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const email = owner.email.toLowerCase()
    const form = await formRef(tree, 'apply.html', 'applications/')
    const page = await uploadAs(browser, tree, {
      page: 'apply.html',
      form,
      field: 'other',
      name: 'page.html',
      type: 'text/html',
      bytes: '<script>alert(1)</script>',
    })
    expect(
      await writeFailure(browser, tree, {
        page: 'apply.html',
        path: `applications/${email}.json`,
        patch: {
          cv: {
            file: page.file,
            name: 'cv.pdf',
            size: page.size,
            type: 'application/pdf',
          },
        },
      }),
    ).toMatchObject({ code: 'invalid', path: 'cv' })
    expect(
      await liveValue(tree.treeId, `applications/${email}.json`),
    ).toBeNull()
  })
})

describe('what a write answers', () => {
  it('gives a respond holder who cannot read a shared file only what this write wrote', async () => {
    const tree = await pushForms(owner, ws, FILES)
    await writeAs(browser, tree, {
      path: 'layout.json',
      patch: { theirs: { x: 9 } },
    })
    const responder = await given(tree, 'respond')
    const opId = crypto.randomUUID()
    const answer = await writeAs(responder.caller, tree, {
      path: 'layout.json',
      patch: { mine: { x: 1 }, gone: null },
      opId,
    })
    expect(answer.data).toEqual({ mine: { x: 1 } })
    // A retry of the same write answers the same way.
    expect(
      (
        await writeAs(responder.caller, tree, {
          path: 'layout.json',
          patch: { mine: { x: 1 }, gone: null },
          opId,
        })
      ).data,
    ).toEqual({ mine: { x: 1 } })
    expect(await liveValue(tree.treeId, 'layout.json')).toEqual({
      value: { theirs: { x: 9 }, mine: { x: 1 } },
      owner: null,
    })
    // Someone who reads it gets the whole value.
    const writer = await given(tree, 'write')
    expect(
      (
        await writeAs(writer.caller, tree, {
          path: 'layout.json',
          patch: { more: 1 },
        })
      ).data,
    ).toEqual({ theirs: { x: 9 }, mine: { x: 1 }, more: 1 })
  })
})

describe('an upload from page code', () => {
  const uploadBeside = async (
    caller: Caller,
    tree: FormTree,
    name: string,
    bytes: string,
    opId = crypto.randomUUID(),
  ) => {
    const body = new TextEncoder().encode(bytes)
    const digest = await crypto.subtle.digest('SHA-256', body)
    const sha256 = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const seq = await seqOf(tree)
    return runAs(
      caller,
      Effect.flatMap(Data, (data) =>
        data.upload({
          treeId: tree.treeId,
          page: 'plan.html',
          seq,
          form: null,
          field: null,
          name,
          type: 'application/pdf',
          size: body.length,
          sha256: sha256 as never,
          body: new Blob([body]).stream() as ReadableStream<Uint8Array>,
          opId: opId as OpId,
        }),
      ),
    )
  }

  it('is stored beside the page under a free name, never as a new version of another upload', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const email = sara.who.email.toLowerCase()
    const opId = crypto.randomUUID()
    const first = await uploadBeside(sara.caller, tree, 'cv.pdf', 'one', opId)
    expect(first).toEqual({
      path: `plan.uploads/${email}/cv.pdf`,
      file: 'cv.pdf',
      name: 'cv.pdf',
      size: 3,
      type: 'application/pdf',
    })
    expect(
      await uploadBeside(sara.caller, tree, 'cv.pdf', 'one', opId),
    ).toEqual(first)
    const second = await uploadBeside(sara.caller, tree, 'cv.pdf', 'two')
    expect(second.path).toBe(`plan.uploads/${email}/cv-2.pdf`)
    expect(
      await versionsAt(tree.treeId, `plan.uploads/${email}/cv.pdf`),
    ).toHaveLength(1)
    const owners = await rows<{ path: string; owner_id: string | null }>(
      `select path, owner_id from nodes where tree_id = ? and path like 'plan.uploads/%'
         order by path`,
      tree.treeId,
    )
    expect(owners).toEqual(
      [
        { path: `plan.uploads/${email}`, owner_id: sara.who.id },
        { path: `plan.uploads/${email}/cv-2.pdf`, owner_id: sara.who.id },
        { path: `plan.uploads/${email}/cv.pdf`, owner_id: sara.who.id },
      ].sort((a, b) => (a.path < b.path ? -1 : 1)),
    )
  })

  it('needs respond on the page', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const reader = await given(tree, 'read')
    await expect(
      uploadBeside(reader.caller, tree, 'x.pdf', 'x'),
    ).rejects.toThrow()
  })
})

describe('a read', () => {
  it('gives authored files too: JSON parsed, text as text, other files as null, and a folder without its _ files', async () => {
    const tree = await pushForms(owner, ws, {
      ...FILES,
      'docs/a.json': '{"x":1}',
      'docs/b.md': '# B',
      'docs/broken.json': '{nope',
      'docs/c.bin': 'binary?',
      'docs/_kit.css': 'p {}',
    })
    await writeAs(browser, tree, { path: 'docs/d.json', patch: { y: 2 } })
    const read = (path: string) =>
      runAs(
        browser,
        Effect.flatMap(Data, (data) =>
          data.read({ treeId: tree.treeId, path }),
        ),
      )
    expect(await read('notes.json')).toMatchObject({
      file: { path: 'notes.json', data: { authored: true }, push: 1 },
    })
    const folder = await read('docs/')
    expect(
      'files' in folder && folder.files.map((f) => [f.path, f.data]),
    ).toEqual([
      ['docs/a.json', { x: 1 }],
      ['docs/b.md', '# B'],
      ['docs/broken.json', '{nope'],
      ['docs/c.bin', null],
      ['docs/d.json', { y: 2 }],
    ])
    expect(await read('docs/missing.json')).toEqual({ file: null })
    expect(await read('nowhere/')).toEqual({ files: [] })
  })
})

describe('a respondent through a page share alone', () => {
  it('writes the first value of a shared file the page’s form targets, and reads it back', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const who = await person('page-respondent')
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, 'status.html'))!.id,
      'email',
      who.email.toLowerCase(),
      'respond',
      owner,
    )
    const caller = await sessionFor(who)
    const doc = await writeAs(caller, tree, {
      page: 'status.html',
      path: 'status.json',
      patch: { state: 'open' },
    })
    expect(doc.data).toEqual({ state: 'open' })
    expect((await liveValue(tree.treeId, 'status.json'))?.value).toEqual({
      state: 'open',
    })
    // A file no form of the page writes stays out of reach, as if missing.
    const refused = await writeFailure(caller, tree, {
      page: 'status.html',
      path: 'other.json',
      patch: { state: 'open' },
    })
    expect(refused.code).toBe('not_found')
  })
})
