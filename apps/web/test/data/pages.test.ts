import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Access, Data, TreeStore } from '../../src/core/index.ts'
import { signedIn, type Browser } from '../support/browser.ts'
import {
  formRef,
  pageWith,
  pushForms,
  QUESTIONS,
  sendAs,
  type FormTree,
} from '../support/forms.ts'
import { harness } from '../support/harness.ts'
import { callerOf, fresh, runAs, sessionFor } from '../support/people.ts'
import { nodeAt, person, ref, share, workspace } from '../support/trees.ts'

afterEach(() => harness.reset())

const LAYOUT = `<!doctype html><html><head><title>Acme</title></head><body>
<form action="feedback/" id="feedback"><input name="note"></form>
<slot></slot></body></html>`

let browser: Browser
let tree: FormTree

beforeAll(async () => {
  browser = await signedIn(fresh())
  const owner = (await callerOf(browser)).person!
  const ws = await workspace(owner)
  tree = await pushForms(owner, ws, {
    '_layout.html': LAYOUT,
    'questions/index.html': QUESTIONS,
    'notes.html':
      '<title>Notes</title><form action="notes.json"><input name="n"></form>',
    'plan.html': pageWith('<p>No forms.</p>', 'Plan'),
  })
})

const framed = async (path: string) => {
  const view = await browser.fetch('/_/api/view', {
    method: 'POST',
    purpose: 'write',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tree: tree.treeId, path }),
  })
  const grant = (await view.json()) as { handle: string; seq: number }
  const response = await browser.fetch(
    `/_/v/${grant.handle}/${grant.seq}/${path}`,
    { host: `${tree.treeId}.content.test`, purpose: 'none' },
  )
  const html = await response.text()
  const bootstrap = JSON.parse(
    /<script type="application\/json" id="dossier-bootstrap">(.*?)<\/script>/s
      .exec(html)![1]!
      .replaceAll('\\u003c', '<'),
  ) as { forms: unknown[] }
  return { html, bootstrap }
}

describe('a composed page', () => {
  it('marks each form and lists the forms Dossier manages, the layout’s first', async () => {
    const notes = await framed('notes')
    expect(notes.html).toContain(
      '<form data-dossier-form="0" action="feedback/"',
    )
    expect(notes.html).toContain(
      '<form data-dossier-form="1" action="notes.json"',
    )
    const layout = (await nodeAt(tree.treeId, '_layout.html'))!.id
    const page = (await nodeAt(tree.treeId, 'notes.html'))!.id
    expect(notes.bootstrap.forms).toEqual([
      {
        n: 0,
        host: layout,
        target: 'feedback/',
        id: 'feedback',
        kind: 'person',
        closesAt: null,
        closed: false,
      },
      {
        n: 1,
        host: page,
        target: 'notes.json',
        id: null,
        kind: 'shared',
        closesAt: null,
        closed: false,
      },
    ])
    const questions = await framed('questions/')
    expect(questions.bootstrap.forms).toEqual([
      expect.objectContaining({ n: 0, target: 'questions/answers/' }),
    ])
  })
})

describe('a listing', () => {
  it('counts the people who answered for those who read answers, and nothing for a respondent', async () => {
    const owner = await callerOf(browser)
    const sara = await person('sara')
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, ''))!.id,
      'email',
      sara.email.toLowerCase(),
      'respond',
      owner.person!,
    )
    const form = await formRef(
      tree,
      'questions/index.html',
      'questions/answers/',
    )
    const saraCaller = await sessionFor(sara)
    await sendAs(saraCaller, tree, {
      page: 'questions/index.html',
      form,
      entries: [['role', 'Driver']],
    })
    await sendAs(saraCaller, tree, {
      page: 'questions/index.html',
      form,
      entries: [['role', 'Lead']],
    })
    const formsAs = (caller: typeof owner) =>
      runAs(
        caller,
        Effect.gen(function* () {
          const located = yield* (yield* TreeStore).locate(
            ref(`${tree.ws.name}/${tree.name}/`),
          )
          if ('missing' in located) throw new Error('missing')
          const granted = yield* (yield* Access).require('read', located.node)
          return yield* (yield* Data).pageForms(granted)
        }),
      )
    const questions = (await nodeAt(tree.treeId, 'questions'))!.id
    const plan = (await nodeAt(tree.treeId, 'plan.html'))!.id
    const seen = await formsAs(owner)
    expect(seen.get(questions)).toEqual({
      targets: ['questions/answers/'],
      people: 1,
    })
    expect(seen.has(plan)).toBe(false)
    expect((await formsAs(saraCaller)).get(questions)?.people).toBeNull()
  })
})
