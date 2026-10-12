// A folder read agrees with what the reader may open: a respondent reads
// their own answers through the form's answers folder as they do one by one,
// the kit folder `_components/` answers a link and `dossier read` as `ls`
// lists it, and the listing of an answers folder never invites a push while
// it holds answers.
import type { Person, TreeId } from '@dossier/contracts'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Data, Files, Pages, type Caller } from '../src/core/index.ts'
import { listingModel } from '../src/server/listing-model.ts'
import {
  formRef,
  pageWith,
  pushForms,
  sendAs,
  type FormTree,
} from './support/forms.ts'
import { harness } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import { nodeAt, person, ref, share, workspace } from './support/trees.ts'

afterEach(() => harness.reset())

const QUESTIONNAIRE = pageWith(`<form action="answers/" method="post">
  <label>Notes <input name="notes"></label><button>Send</button></form>`)

let owner: Person
let ownerBrowser: Caller
let respondent: Caller
let tree: FormTree
let ownAnswer: string

const sendNote = async (caller: Caller, notes: string) =>
  sendAs(caller, tree, {
    page: 'forms/questionnaire.html',
    form: await formRef(tree, 'forms/questionnaire.html', 'forms/answers/'),
    entries: [['notes', notes]],
  })

beforeAll(async () => {
  owner = await person('owner')
  const ws = await workspace(owner)
  ownerBrowser = await sessionFor(owner)
  tree = await pushForms(owner, ws, {
    'forms/questionnaire.html': QUESTIONNAIRE,
    '_components/pv-badge.js': 'export const badge = 1',
    'index.html': pageWith('<p>Home</p>', 'Home'),
  })
  const who = await person('respondent')
  respondent = await sessionFor(who)
  const forms = await nodeAt(tree.treeId, 'forms')
  await share(tree.treeId, forms!.id, 'email', who.email, 'respond', owner)
  ownAnswer = (await sendNote(respondent, 'mine')).doc!.path
  await sendNote(ownerBrowser, 'the owner too')
})

const target = (path: string) => `${tree.ws.name}/${tree.name}/${path}`

const dataRead = (caller: Caller, path: string) =>
  runAs(
    caller,
    Effect.flatMap(Data, (data) =>
      data.read({ treeId: tree.treeId as TreeId, path }),
    ),
  )

describe("a respondent's read of the answers folder", () => {
  it('holds their own answer, as reading it directly does', async () => {
    const direct = await dataRead(respondent, ownAnswer)
    expect('file' in direct && direct.file?.path).toBe(ownAnswer)

    const folder = await dataRead(respondent, 'forms/answers/')
    expect('files' in folder && folder.files.map((f) => f.path)).toEqual([
      ownAnswer,
    ])
  })
})

describe('the kit folder', () => {
  it('answers a link and dossier read as ls lists it', async () => {
    for (const caller of [ownerBrowser, respondent]) {
      const listed = await runAs(
        caller,
        Effect.flatMap(Files, (files) =>
          files.ls({ ref: ref(target('_components/')), depth: 'one' }),
        ),
      )
      const read = await runAs(
        caller,
        Effect.flatMap(Pages, (pages) =>
          pages.read(ref(target('_components/'))),
        ).pipe(Effect.either),
      )
      expect(read._tag).toBe('Right')
      if (read._tag !== 'Right' || read.right.kind !== 'folder') {
        throw new Error(`not a folder: ${JSON.stringify(read)}`)
      }
      expect(read.right.entries.map((e) => e.path)).toEqual(
        listed.entries.map((e) => e.path),
      )
      const opened = await runAs(
        caller,
        Effect.flatMap(Pages, (pages) =>
          pages.open({ ref: ref(target('_components/')), wantsAgent: false }),
        ),
      )
      expect(opened.kind).toBe('listing')
    }
  })
})

describe('the listing of an answers folder', () => {
  it('says it holds answers, not that it is empty and waits for a push', async () => {
    const listing = await runAs(
      ownerBrowser,
      listingModel({
        workspace: tree.ws.name,
        tree: tree.name,
        path: 'forms/answers',
      }),
    )
    expect(listing.empty).not.toBeNull()
    expect(listing.empty?.text).not.toBe('Nothing here yet.')
    expect(listing.empty?.hint).toBeNull()
  })
})
