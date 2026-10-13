import type { Person } from '@dossier/contracts'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Data, Pages, type Caller } from '../../src/core/index.ts'
import { dataViews } from '../../src/server/responses.ts'
import { Browser, signedIn } from '../support/browser.ts'
import { count, exec, rows } from '../support/d1.ts'
import {
  formRef,
  liveValue,
  pageWith,
  pushForms,
  QUESTIONS,
  sendAs,
  uploadAs,
  uploadFailure,
  versionsAt,
  withdrawAs,
  withdrawFailure,
  type FormTree,
} from '../support/forms.ts'
import { harness } from '../support/harness.ts'
import { callerOf, fresh, runAs, sessionFor } from '../support/people.ts'
import {
  failureAs,
  nodeAt,
  person,
  ref,
  sha256Of,
  share,
  workspace,
} from '../support/trees.ts'

afterEach(() => harness.reset())

const FILES = {
  'questions/index.html': QUESTIONS,
  'ideas.html': pageWith(
    '<form action="ideas/" data-entries="many"><input name="idea"><input name="photo" type="file"><button>Add</button></form>',
  ),
  'board.html': pageWith(
    '<form action="board.json"><input name="status"></form>',
  ),
}

const PDF = '%PDF-1.7 a small cv'

let ownerBrowser: Browser
let owner: Person
let ws: { id: string; name: string }
let browser: Caller

beforeAll(async () => {
  ownerBrowser = await signedIn(fresh())
  browser = await callerOf(ownerBrowser)
  owner = browser.person!
  ws = await workspace(owner)
})

const questions = async (tree: FormTree) => ({
  page: 'questions/index.html',
  form: await formRef(tree, 'questions/index.html', 'questions/answers/'),
})

/** Uploads a CV and sends it with the answers. */
const sendWithCv = async (tree: FormTree, caller = browser) => {
  const q = await questions(tree)
  const stored = await uploadAs(caller, tree, {
    ...q,
    field: 'cv',
    name: 'my/../cv.pdf',
    bytes: PDF,
  })
  await sendAs(caller, tree, {
    ...q,
    entries: [
      ['role', 'Designer'],
      [
        'cv',
        {
          file: stored.file,
          name: stored.name,
          size: stored.size,
          type: stored.type,
        },
      ],
    ],
  })
  return stored
}

describe('an upload', () => {
  it('is stored in the writer’s folder, referred to by the answers, and served only as a download', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const stored = await sendWithCv(tree)
    const email = owner.email
    expect(stored).toEqual({
      path: `questions/answers/${email}/files/cv.pdf`,
      file: 'files/cv.pdf',
      name: 'cv.pdf',
      size: PDF.length,
      type: 'application/pdf',
    })
    expect(
      (await liveValue(tree.treeId, `questions/answers/${email}.json`))?.value,
    ).toEqual({
      role: 'Designer',
      regions: [],
      cv: {
        file: 'files/cv.pdf',
        name: 'cv.pdf',
        size: PDF.length,
        type: 'application/pdf',
      },
    })
    const [owned] = await rows<{ owner_id: string; origin: string }>(
      'select owner_id, origin from nodes where tree_id = ? and path = ? and deleted_at is null',
      tree.treeId,
      stored.path,
    )
    expect(owned).toEqual({ owner_id: owner.id, origin: 'data' })

    // On the tree's content host, through a view handle: a download.
    const view = await ownerBrowser.fetch('/_/api/view', {
      method: 'POST',
      purpose: 'write',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree: tree.treeId, path: 'questions/' }),
    })
    const grant = (await view.json()) as {
      handle: string
      seq: number
      path: string
    }
    expect(grant.path).toBe('questions/index.html')
    // The grant names whom it is for, so a shell never goes on as another.
    expect((grant as unknown as { email: string }).email).toBe(owner.email)
    const framed = await ownerBrowser.fetch(
      `/_/v/${grant.handle}/${grant.seq}/questions/answers/${encodeURIComponent(email)}/files/cv.pdf`,
      { host: `${tree.treeId}.content.test`, purpose: 'none' },
    )
    expect(framed.status).toBe(200)
    expect(framed.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''cv.pdf",
    )
    expect(framed.headers.get('content-type')).toBe('application/octet-stream')
    expect(framed.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await framed.text()).toBe(PDF)

    // The JSON answers are served from D1 as JSON, never as a page.
    const answers = await ownerBrowser.fetch(
      `/_/v/${grant.handle}/${grant.seq}/questions/answers/${encodeURIComponent(email)}.json`,
      { host: `${tree.treeId}.content.test`, purpose: 'none' },
    )
    expect(answers.status).toBe(200)
    expect(answers.headers.get('content-type')).toBe('application/json')
    expect(await answers.json()).toMatchObject({ role: 'Designer' })

    // And on the main host, always as a download.
    const file = await ownerBrowser.fetch(
      `/_/api/file?path=${encodeURIComponent(`${ws.name}/${tree.name}/${stored.path}`)}`,
      { purpose: 'read' },
    )
    expect(file.status).toBe(200)
    expect(file.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''cv.pdf",
    )
    expect(file.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('is refused above 10 MiB, for a field that is not a file field, and while a purge holds its bytes', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const q = await questions(tree)
    const big = await uploadFailure(browser, tree, {
      ...q,
      field: 'cv',
      name: 'big.pdf',
      bytes: 'x',
      size: 10 * 1024 * 1024 + 1,
    })
    expect(big).toMatchObject({ code: 'too_large' })
    expect(big.message).toContain('10 MiB')
    expect(
      await uploadFailure(browser, tree, {
        ...q,
        field: 'role',
        name: 'a.pdf',
        bytes: PDF,
      }),
    ).toMatchObject({ code: 'invalid', path: 'role' })
    const bytes = `${PDF} reclaimed`
    await exec(
      `insert into blobs (sha256, size, ref_count, state, first_seen_at, reclaim_started_at)
       values (?, ?, 0, 'reclaiming', ?, ?)`,
      await sha256Of(bytes),
      bytes.length,
      Date.now(),
      Date.now(),
    )
    expect(
      await uploadFailure(browser, tree, {
        ...q,
        field: 'cv',
        name: 'r.pdf',
        bytes,
      }),
    ).toMatchObject({ code: 'blob_reclaiming' })
  })

  it('refuses a send naming a file the sender did not upload', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const q = await questions(tree)
    const { sendFailure } = await import('../support/forms.ts')
    expect(
      await sendFailure(browser, tree, {
        ...q,
        entries: [
          ['role', 'x'],
          [
            'cv',
            {
              file: 'files/nope.pdf',
              name: 'nope.pdf',
              size: 1,
              type: 'application/pdf',
            },
          ],
        ],
      }),
    ).toMatchObject({ code: 'invalid', path: 'cv' })
  })
})

describe('a withdrawal', () => {
  it('keeps one content-free version and an event, and takes the uploads only that file referred to', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const stored = await sendWithCv(tree)
    const path = `questions/answers/${owner.email}.json`
    const sha = await sha256Of(PDF)
    const refsBefore = (
      await rows<{ ref_count: number }>(
        'select ref_count from blobs where sha256 = ?',
        sha,
      )
    )[0]?.ref_count
    await withdrawAs(browser, tree, path)
    expect(await versionsAt(tree.treeId, path)).toEqual([
      expect.objectContaining({
        revision: 1,
        state: 'withdrawn',
        json_value: null,
      }),
    ])
    expect(await liveValue(tree.treeId, path)).toBeNull()
    expect(await liveValue(tree.treeId, stored.path)).toBeNull()
    expect(
      (
        await rows<{ ref_count: number }>(
          'select ref_count from blobs where sha256 = ?',
          sha,
        )
      )[0]?.ref_count,
    ).toBe((refsBefore ?? 1) - 1)
    const [event] = await rows<{ type: string; path: string }>(
      "select type, path from events where tree_id = ? and type = 'withdrawal'",
      tree.treeId,
    )
    expect(event).toEqual({ type: 'withdrawal', path })
    expect(
      await count(
        'operations',
        "scope like ? and result_state = 'stored'",
        `${tree.treeId}:questions/answers/%`,
      ),
    ).toBe(0)
  })

  it('keeps an upload another live entry still refers to', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const form = await formRef(tree, 'ideas.html', 'ideas/')
    const photo = await uploadAs(browser, tree, {
      page: 'ideas.html',
      form,
      field: 'photo',
      name: 'truck.png',
      type: 'image/png',
      bytes: 'png bytes',
    })
    const value = {
      file: photo.file,
      name: photo.name,
      size: photo.size,
      type: photo.type,
    }
    const one = await sendAs(browser, tree, {
      page: 'ideas.html',
      form,
      entries: [
        ['idea', 'a'],
        ['photo', value],
      ],
    })
    await sendAs(browser, tree, {
      page: 'ideas.html',
      form,
      entries: [
        ['idea', 'b'],
        ['photo', value],
      ],
    })
    await withdrawAs(browser, tree, one.doc!.path)
    expect(await liveValue(tree.treeId, photo.path)).not.toBeNull()
  })

  it('refuses another person’s file and a shared file, and works after every share of the owner’s is gone', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await person('sara')
    const root = (await nodeAt(tree.treeId, ''))!.id
    await share(
      tree.treeId,
      root,
      'email',
      sara.email.toLowerCase(),
      'respond',
      owner,
    )
    const saraCaller = await sessionFor(sara)
    const q = await questions(tree)
    await sendAs(saraCaller, tree, { ...q, entries: [['role', 'Driver']] })
    await sendAs(browser, tree, { ...q, entries: [['role', 'Lead']] })
    await sendAs(browser, tree, {
      page: 'board.html',
      form: await formRef(tree, 'board.html', 'board.json'),
      entries: [['status', 'Open']],
    })
    const saraFile = `questions/answers/${sara.email.toLowerCase()}.json`
    expect((await withdrawFailure(browser, tree, saraFile)).code).toBe(
      'forbidden',
    )
    expect(
      (
        await withdrawFailure(
          saraCaller,
          tree,
          `questions/answers/${owner.email}.json`,
        )
      ).code,
    ).toBe('not_found')
    expect((await withdrawFailure(browser, tree, 'board.json')).code).toBe(
      'forbidden',
    )
    await exec(
      'delete from shares where tree_id = ? and target = ?',
      tree.treeId,
      sara.email.toLowerCase(),
    )
    await withdrawAs(saraCaller, tree, saraFile)
    expect(await liveValue(tree.treeId, saraFile)).toBeNull()
  })
})

describe('reading answers', () => {
  it('gives each file of answers/ with its writer, time and the push they saw', async () => {
    const tree = await pushForms(owner, ws, FILES)
    await sendWithCv(tree)
    const read = await runAs(
      browser,
      Effect.flatMap(Pages, (pages) =>
        pages.read(ref(`${ws.name}/${tree.name}/questions/answers/`)),
      ),
    )
    expect(read.kind).toBe('data')
    if (read.kind !== 'data') return
    const answers = read.files.find((f) => f.path.endsWith('.json'))
    expect(answers).toMatchObject({
      path: `questions/answers/${owner.email}.json`,
      by: owner.email,
      push: 1,
      data: { role: 'Designer', cv: { file: 'files/cv.pdf' } },
    })
    expect(read.text).toContain(`## ${owner.email}.json`)
    expect(read.text).toContain('"file": "files/cv.pdf"')
    expect(read.text).toContain(`${owner.email} · `)
    expect(read.text).toContain('· push 1')
    const data = await runAs(
      browser,
      Effect.flatMap(Data, (d) =>
        d.read({ treeId: tree.treeId, path: 'questions/answers/' }),
      ),
    )
    expect('files' in data && data.files.length).toBe(2)
  })

  it('shows responses to a read holder and refuses a respond-only holder with forbidden', async () => {
    const tree = await pushForms(owner, ws, FILES)
    await sendWithCv(tree)
    const root = (await nodeAt(tree.treeId, ''))!.id
    const reader = await person('reader')
    const respondent = await person('respondent')
    await share(
      tree.treeId,
      root,
      'email',
      reader.email.toLowerCase(),
      'read',
      owner,
    )
    await share(
      tree.treeId,
      root,
      'email',
      respondent.email.toLowerCase(),
      'respond',
      owner,
    )
    const asked = ref(`${ws.name}/${tree.name}/questions/`)
    const seen = await runAs(
      await sessionFor(reader),
      Effect.flatMap(Data, (d) => d.responses(asked)),
    )
    expect(seen.page).toMatchObject({
      path: 'questions/index.html',
      title: 'Questions',
    })
    expect(seen.forms).toHaveLength(1)
    expect(seen.forms[0]).toMatchObject({
      people: 1,
      form: { title: 'Delivery questions', kind: 'person' },
      rows: [{ email: owner.email, revisions: 1, push: 1 }],
    })
    expect(seen.forms[0]!.form.fields.map((f) => f.label)).toEqual([
      'Role',
      'Trucks',
      'Start',
      'Regions',
      'Size',
      'CV',
    ])
    const refused = await failureAs(
      await sessionFor(respondent),
      Effect.flatMap(Data, (d) => d.responses(asked)),
    )
    expect(refused.code).toBe('forbidden')
    // An anyone read share on the page's folder reads the page, not the answers.
    const visitorish = await person('public')
    await share(tree.treeId, root, 'anyone', '*', 'read', owner)
    expect(
      (
        await failureAs(
          await sessionFor(visitorish),
          Effect.flatMap(Data, (d) => d.responses(asked)),
        )
      ).code,
    ).toBe('forbidden')
  })

  it('links a shared file’s upload to the folder it is stored in', async () => {
    const page = 'plan.html'
    const tree = await pushForms(owner, ws, {
      [page]: pageWith(
        '<form action="plan.json"><input name="doc" type="file"><button>Save</button></form>',
      ),
    })
    const form = await formRef(tree, page, 'plan.json')
    const stored = await uploadAs(browser, tree, {
      page,
      form,
      field: 'doc',
      name: 'plan.pdf',
      bytes: PDF,
    })
    const { path: _, ...value } = stored
    await sendAs(browser, tree, { page, form, entries: [['doc', value]] })
    const found = await runAs(
      browser,
      Effect.flatMap(Data, (d) =>
        d.responses(ref(`${ws.name}/${tree.name}/${page}`)),
      ),
    )
    const shared = found.forms[0]!
    const [doc] = shared.shared!
    const { cellOf, sharedOwnOf } = dataViews({
      workspace: ws.name,
      tree: tree.name,
    })
    const cell = cellOf(doc!.value, 'file', sharedOwnOf(shared.form, doc!.by))
    if (!('download' in cell)) throw new Error('no download link')
    expect(cell.file).toBe('plan.pdf')
    const file = await ownerBrowser.fetch(cell.download, { purpose: 'read' })
    expect(file.status).toBe(200)
    expect(await file.text()).toBe(PDF)
  })

  it('shows a JSON field’s object folded, with its keys counted, and other values as text', () => {
    const { cellOf } = dataViews({ workspace: 'w', tree: 't' })
    const notes = { 'S-1': { text: 'Check' }, 'S-2': { text: 'Fine' } }
    expect(cellOf(notes, 'json', '')).toEqual({
      summary: '2 keys',
      json: JSON.stringify(notes, null, 2),
    })
    expect(cellOf({ a: 1 }, 'hidden', '')).toEqual({ text: '{"a":1}' })
    expect(cellOf(undefined, 'json', '')).toEqual({ text: '' })
  })
})
