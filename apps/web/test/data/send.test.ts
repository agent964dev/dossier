import type { Person } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { Caller } from '../../src/core/index.ts'
import { count, exec, rows } from '../support/d1.ts'
import {
  formRef,
  liveValue,
  pageWith,
  pushForms,
  QUESTIONS,
  repush,
  sendAs,
  sendFailure,
  seqOf,
  versionsAt,
  type FormTree,
} from '../support/forms.ts'
import { harness } from '../support/harness.ts'
import { sessionFor } from '../support/people.ts'
import { nodeAt, person, share, workspace } from '../support/trees.ts'

afterEach(() => harness.reset())

const LAYOUT = `<!doctype html><html><head><title>Acme</title></head><body>
<form action="feedback/" id="feedback"><input name="note"></form>
<slot></slot></body></html>`

const FILES = {
  'questions/index.html': QUESTIONS,
  'ideas.html': pageWith(
    '<form action="ideas/" data-entries="many"><input name="idea" required><button>Add</button></form>',
    'Ideas',
  ),
  'board.html': pageWith(
    '<form action="board.json"><input name="status"><input name="owner"></form>',
    'Board',
  ),
  '_layout.html': LAYOUT,
  'notes.html': '<title>Notes</title><p>Body only, so the layout wraps it.</p>',
  'plan.html': pageWith('<p>No forms.</p>', 'Plan'),
}

let owner: Person
let ws: { id: string; name: string }
let browser: Caller

beforeAll(async () => {
  owner = await person('owner')
  ws = await workspace(owner)
  browser = await sessionFor(owner)
})

const questions = async (tree: FormTree) => ({
  page: 'questions/index.html',
  form: await formRef(tree, 'questions/index.html', 'questions/answers/'),
})

describe('a push', () => {
  it('records the forms of pages and layouts by the version that holds them', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const recorded = await rows<{
      path: string
      target_path: string
      form_key: string
      kind: string
      title: string | null
      schema_json: string
    }>(
      `select n.path, f.target_path, f.form_key, f.kind, f.title, f.schema_json
       from forms f join nodes n on n.id = f.host_node_id
       where f.tree_id = ? order by n.path`,
      tree.treeId,
    )
    expect(
      recorded.map((r) => [r.path, r.target_path, r.form_key, r.kind]),
    ).toEqual([
      ['_layout.html', 'feedback/', 'feedback', 'person'],
      ['board.html', 'board.json', '', 'shared'],
      ['ideas.html', 'ideas/', '', 'entries'],
      ['questions/index.html', 'questions/answers/', '', 'person'],
    ])
    const schema = JSON.parse(recorded[3]!.schema_json) as {
      title: string
      fields: { name: string; type: string; label: string }[]
    }
    expect(schema.title).toBe('Delivery questions')
    expect(schema.fields.map((f) => [f.name, f.type])).toEqual([
      ['role', 'text'],
      ['trucks', 'number'],
      ['start', 'date'],
      ['regions', 'checkboxes'],
      ['size', 'select'],
      ['cv', 'file'],
    ])
    // A push that changes the page records its new version's forms beside
    // the old ones, which earlier sends are checked against.
    await repush(tree, {
      ...FILES,
      'questions/index.html': QUESTIONS.replace('name="role"', 'name="job"'),
    })
    expect(
      await count(
        'forms',
        "tree_id = ? and target_path = 'questions/answers/'",
        tree.treeId,
      ),
    ).toBe(2)
  })
})

describe('a send', () => {
  it('writes a person file with who, when, the push seen and the op ID, then merges by field', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const q = await questions(tree)
    const first = await sendAs(browser, tree, {
      ...q,
      entries: [
        ['role', 'Designer'],
        ['trucks', '12'],
        ['start', '2026-11-03'],
        ['regions', 'Erbil'],
        ['regions', 'Basra'],
        ['size', 'Large'],
      ],
      opId: 'op-1',
    })
    const path = `questions/answers/${owner.email}.json`
    expect(first.replayed).toBe(false)
    expect(first.doc).toMatchObject({
      path,
      by: owner.email,
      push: 1,
      data: {
        role: 'Designer',
        trucks: 12,
        start: '2026-11-03',
        regions: ['Erbil', 'Basra'],
        size: 'Large',
      },
    })
    const second = await sendAs(browser, tree, {
      ...q,
      entries: [
        ['role', 'Lead'],
        ['trucks', ''],
        ['start', '2026-11-03'],
        ['size', 'Small'],
      ],
    })
    expect(second.doc?.data).toEqual({
      role: 'Lead',
      start: '2026-11-03',
      regions: [],
      size: 'Small',
    })
    const versions = await versionsAt(tree.treeId, path)
    expect(versions).toHaveLength(2)
    expect(versions[0]).toMatchObject({
      revision: 1,
      state: 'live',
      author_id: owner.id,
      seen_push_number: 1,
      op_id: 'op-1',
    })
    expect(await liveValue(tree.treeId, path)).toMatchObject({
      owner: owner.id,
    })
    // The folder the target names is a data folder nobody owns.
    const [folder] = await rows<{ origin: string; owner_id: string | null }>(
      "select origin, owner_id from nodes where tree_id = ? and path = 'questions/answers'",
      tree.treeId,
    )
    expect(folder).toEqual({ origin: 'data', owner_id: null })
    expect(
      await count(
        'events',
        "tree_id = ? and type = 'submission' and path = ?",
        tree.treeId,
        path,
      ),
    ).toBe(2)
  })

  it('stores a JSON field’s text as its object, nulls gone at every depth, and refuses text that is not an object', async () => {
    const tree = await pushForms(owner, ws, {
      ...FILES,
      'review.html': pageWith(
        '<form action="review/"><input type="hidden" name="notes" data-type="json"><button>Send</button></form>',
        'Review',
      ),
    })
    const form = await formRef(tree, 'review.html', 'review/')
    const sent = await sendAs(browser, tree, {
      page: 'review.html',
      form,
      entries: [['notes', '{"S-1":{"text":"Check","gone":null}}']],
    })
    expect(sent.doc?.data).toEqual({ notes: { 'S-1': { text: 'Check' } } })
    expect(
      await sendFailure(browser, tree, {
        page: 'review.html',
        form,
        entries: [['notes', '["not","an","object"]']],
      }),
    ).toMatchObject({ code: 'invalid', path: 'notes' })
  })

  it('keeps both people’s fields in a shared file, the respondent answering with respond alone', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await person('sara')
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, ''))!.id,
      'email',
      sara.email.toLowerCase(),
      'respond',
      owner,
    )
    const form = await formRef(tree, 'board.html', 'board.json')
    await sendAs(browser, tree, {
      page: 'board.html',
      form,
      entries: [
        ['status', 'Open'],
        ['owner', ''],
      ],
    })
    await sendAs(await sessionFor(sara), tree, {
      page: 'board.html',
      form,
      entries: [['owner', 'Sara']],
    })
    expect((await liveValue(tree.treeId, 'board.json'))?.value).toEqual({
      status: 'Open',
      owner: 'Sara',
    })
    expect((await liveValue(tree.treeId, 'board.json'))?.owner).toBeNull()
  })

  it('adds an entry each time to an entries form, in the writer’s own folder', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const form = await formRef(tree, 'ideas.html', 'ideas/')
    const one = await sendAs(browser, tree, {
      page: 'ideas.html',
      form,
      entries: [['idea', 'Night shifts']],
    })
    const two = await sendAs(browser, tree, {
      page: 'ideas.html',
      form,
      entries: [['idea', 'More trucks']],
    })
    expect(one.doc?.path).not.toBe(two.doc?.path)
    for (const doc of [one.doc, two.doc]) {
      expect(doc?.path).toMatch(
        new RegExp(
          `^ideas/${owner.email.replace('.', '\\.')}/\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}(-\\d+)?\\.json$`,
        ),
      )
    }
    const [folder] = await rows<{ owner_id: string }>(
      'select owner_id from nodes where tree_id = ? and path = ? and deleted_at is null',
      tree.treeId,
      `ideas/${owner.email}`,
    )
    expect(folder?.owner_id).toBe(owner.id)
    expect(
      await count('events', "tree_id = ? and type = 'entry'", tree.treeId),
    ).toBe(2)
  })

  it('is checked against the form as the person saw it, and refused once the form is gone', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const q = await questions(tree)
    const seen = await seqOf(tree)
    // A push renames a field: a send from the page as it was still passes.
    await repush(tree, {
      ...FILES,
      'questions/index.html': QUESTIONS.replace('name="role"', 'name="job"'),
    })
    const passed = await sendAs(browser, tree, {
      ...q,
      seq: seen,
      entries: [['role', 'Designer']],
    })
    expect(passed.doc?.data).toMatchObject({ role: 'Designer' })
    // Unknown names are refused against that same form.
    expect(
      await sendFailure(browser, tree, {
        ...q,
        seq: seen,
        entries: [
          ['role', 'x'],
          ['job', 'y'],
        ],
      }),
    ).toMatchObject({ code: 'invalid', path: 'job' })
    // A push that removes the form: later sends are form_changed.
    await repush(tree, {
      ...FILES,
      'questions/index.html': pageWith('<p>Closed for good.</p>'),
    })
    const gone = await sendFailure(browser, tree, {
      ...q,
      seq: seen,
      entries: [['role', 'Designer']],
    })
    expect(gone).toMatchObject({
      code: 'form_changed',
      message:
        'This form has changed. Reload the page to see the current version.',
    })
  })

  it('refuses a form of another page, of a layout outside the page’s composition, or with another target, writing nothing', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const before = await count(
      'node_versions',
      'tree_id = ? and authored_seq is null',
      tree.treeId,
    )
    const cases = [
      // The board's form, sent as if from the questions page.
      {
        page: 'questions/index.html',
        form: await formRef(tree, 'board.html', 'board.json'),
        entries: [['status', 'x']] as const,
      },
      // The root layout's form: questions/index.html is a complete page, so
      // no layout is composed into it.
      {
        page: 'questions/index.html',
        form: await formRef(tree, '_layout.html', 'feedback/', 'feedback'),
        entries: [['note', 'x']] as const,
      },
      // The page's own form with a target the server did not derive.
      {
        page: 'questions/index.html',
        form: await formRef(tree, 'questions/index.html', 'board.json'),
        entries: [['role', 'x']] as const,
      },
    ]
    for (const c of cases) {
      expect(
        (await sendFailure(browser, tree, { ...c, entries: [...c.entries] }))
          .code,
      ).toBe('form_changed')
    }
    expect(
      await count(
        'node_versions',
        'tree_id = ? and authored_seq is null',
        tree.treeId,
      ),
    ).toBe(before)
  })

  it('takes a layout’s form on a page it is composed into, until the layout leaves the page’s chain', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const form = await formRef(tree, '_layout.html', 'feedback/', 'feedback')
    const sent = await sendAs(browser, tree, {
      page: 'notes.html',
      form,
      entries: [['note', 'Nice']],
    })
    expect(sent.doc?.path).toBe(`feedback/${owner.email}.json`)
    const seen = await seqOf(tree)
    // The page becomes a complete document: the layout no longer wraps it.
    await repush(tree, {
      ...FILES,
      'notes.html': pageWith('<p>Whole now.</p>', 'Notes'),
    })
    expect(
      await sendFailure(browser, tree, {
        page: 'notes.html',
        form,
        seq: seen,
        entries: [['note', 'Again']],
      }),
    ).toMatchObject({ code: 'form_changed' })
  })

  it('refuses closed forms, by data-closed and by a passed data-closes', async () => {
    const tree = await pushForms(owner, ws, {
      'shut.html': pageWith(
        '<form action="a/" data-closed><input name="x"></form>',
      ),
      'past.html': pageWith(
        '<form action="b/" data-closes="2020-10-20T18:00+03:00"><input name="x"></form>',
      ),
    })
    expect(
      await sendFailure(browser, tree, {
        page: 'shut.html',
        form: await formRef(tree, 'shut.html', 'a/'),
        entries: [['x', '1']],
      }),
    ).toMatchObject({ code: 'closed', message: 'This form is closed.' })
    expect(
      await sendFailure(browser, tree, {
        page: 'past.html',
        form: await formRef(tree, 'past.html', 'b/'),
        entries: [['x', '1']],
      }),
    ).toMatchObject({
      code: 'closed',
      message: 'This form closed on 20 October',
    })
  })

  it('refuses a stored value that is not an object, and a merge over 1 MiB', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const form = await formRef(tree, 'board.html', 'board.json')
    await sendAs(browser, tree, {
      page: 'board.html',
      form,
      entries: [['status', 'Open']],
    })
    // A shared file page code replaced with a list (as a later write may).
    await exec(
      `update node_versions set json_value = '[1,2]' where id =
         (select current_version_id from nodes where tree_id = ? and path = 'board.json'
            and deleted_at is null)`,
      tree.treeId,
    )
    expect(
      await sendFailure(browser, tree, {
        page: 'board.html',
        form,
        entries: [['status', 'Done']],
      }),
    ).toMatchObject({ code: 'not_mergeable' })
    const q = await questions(tree)
    const huge = 'x'.repeat(1024 * 1024 + 10)
    const failure = await sendFailure(browser, tree, {
      ...q,
      entries: [['role', huge]],
    })
    expect(failure.code).toBe('too_large')
    expect(failure.message).toContain('1 MiB')
    expect(
      await count(
        'nodes',
        'tree_id = ? and path = ?',
        tree.treeId,
        `questions/answers/${owner.email}.json`,
      ),
    ).toBe(0)
  })

  it('stores a repeated op ID once, answers it with the first result even past the rate, and never recreates a withdrawn answer', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const q = await questions(tree)
    const opId = crypto.randomUUID()
    const first = await sendAs(browser, tree, {
      ...q,
      entries: [['role', 'Designer']],
      opId,
    })
    const again = await sendAs(browser, tree, {
      ...q,
      entries: [['role', 'Other']],
      opId,
    })
    expect(again).toEqual({ ...first, replayed: true })
    const path = `questions/answers/${owner.email}.json`
    expect(await versionsAt(tree.treeId, path)).toHaveLength(1)

    // Spend the minute's sends: the repeat still answers its first result.
    const minute = Math.floor(Date.now() / 60_000) * 60_000
    if (Date.now() - minute > 55_000) {
      await new Promise((resolve) => setTimeout(resolve, 6_000))
    }
    await exec(
      `insert into rate_counters (key, window_start, count) values (?, ?, 30)
       on conflict (key) do update set window_start = excluded.window_start, count = 30`,
      `send:${owner.id}`,
      Math.floor(Date.now() / 60_000) * 60_000,
    )
    expect(
      await sendAs(browser, tree, { ...q, entries: [['role', 'x']], opId }),
    ).toEqual({ ...first, replayed: true })
    const limited = await sendFailure(browser, tree, {
      ...q,
      entries: [['role', 'x']],
    })
    expect(limited).toMatchObject({
      code: 'rate_limited',
      message: 'Too many sends. Try again in a minute.',
    })
    await exec('delete from rate_counters where key = ?', `send:${owner.id}`)

    const { withdrawAs } = await import('../support/forms.ts')
    await withdrawAs(browser, tree, path)
    expect(
      await sendAs(browser, tree, { ...q, entries: [['role', 'x']], opId }),
    ).toEqual({ doc: null, replayed: true })
    expect(await liveValue(tree.treeId, path)).toBeNull()
  })

  it('answers the 31st send in a minute with rate_limited through the counter', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const someone = await person('fast')
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, ''))!.id,
      'email',
      someone.email.toLowerCase(),
      'respond',
      owner,
    )
    const caller = await sessionFor(someone)
    const form = await formRef(tree, 'board.html', 'board.json')
    const minute = Math.floor(Date.now() / 60_000) * 60_000
    if (Date.now() - minute > 40_000) {
      await new Promise((resolve) =>
        setTimeout(resolve, 61_000 - (Date.now() - minute)),
      )
    }
    for (let i = 0; i < 30; i += 1) {
      await sendAs(caller, tree, {
        page: 'board.html',
        form,
        entries: [['status', `s${i}`]],
      })
    }
    expect(
      await sendFailure(caller, tree, {
        page: 'board.html',
        form,
        entries: [['status', 'one more']],
      }),
    ).toMatchObject({
      code: 'rate_limited',
      message: 'Too many sends. Try again in a minute.',
    })
  }, 120_000)

  it('asks a visitor to sign in, and refuses someone who may only read', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const q = await questions(tree)
    const { visitorCaller } = await import('../support/trees.ts')
    expect(
      await sendFailure(visitorCaller(), tree, {
        ...q,
        entries: [['role', 'x']],
      }),
    ).toMatchObject({ code: 'sign_in_required' })
    const reader = await person('reader')
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, ''))!.id,
      'email',
      reader.email.toLowerCase(),
      'read',
      owner,
    )
    expect(
      await sendFailure(await sessionFor(reader), tree, {
        ...q,
        entries: [['role', 'x']],
      }),
    ).toMatchObject({ code: 'forbidden' })
    expect(env).toBeDefined()
  })
})

describe('the person a page was shown to', () => {
  it('refuses a send, an upload and a withdrawal made as someone else, and stores nothing', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const q = await questions(tree)
    const other = 'someone-else@example.com'
    expect(
      await sendFailure(browser, tree, {
        ...q,
        entries: [['role', 'x']],
        as: other,
      }),
    ).toMatchObject({ code: 'sign_in_required' })
    expect(
      await count('nodes', "tree_id = ? and origin = 'data'", tree.treeId),
    ).toBe(0)
    const { uploadFailure, withdrawAs } = await import('../support/forms.ts')
    const { Effect } = await import('effect')
    const { Data } = await import('../../src/core/index.ts')
    const { failureAs } = await import('../support/trees.ts')
    expect(
      (
        await failureAs(
          browser,
          Effect.flatMap(Data, (d) =>
            d.withdraw({
              treeId: tree.treeId as never,
              path: `questions/answers/${owner.email}.json`,
              opId: 'w1' as never,
              as: other,
            }),
          ),
        )
      ).code,
    ).toBe('sign_in_required')
    expect(
      await uploadFailure(browser, tree, {
        ...q,
        field: 'cv',
        name: 'cv.pdf',
        bytes: '%PDF cv',
        as: other,
      }),
    ).toMatchObject({ code: 'sign_in_required' })
    // The same person, in any case, goes through.
    const sent = await sendAs(browser, tree, {
      ...q,
      entries: [['role', 'x']],
      as: owner.email.toUpperCase(),
    })
    expect(sent.doc?.by).toBe(owner.email)
    await withdrawAs(browser, tree, `questions/answers/${owner.email}.json`)
  })
})
