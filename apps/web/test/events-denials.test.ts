// The events route names only the path that was asked when it refuses, so a
// visitor cannot learn which paths exist, and a path someone cannot read
// under a folder they read answers as a missing one does.
import type { DossierError, Person } from '@dossier/contracts'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { TreeStore, type Caller } from '../src/core/index.ts'
import {
  formRef,
  pageWith,
  pushForms,
  sendAs,
  type FormTree,
} from './support/forms.ts'
import { harness } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  nodeAt,
  person,
  share,
  visitorCaller,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

let owner: Person
let tree: FormTree
let respondent: Caller

beforeAll(async () => {
  owner = await person('owner')
  const ws = await workspace(owner)
  tree = await pushForms(owner, ws, {
    'secret/plan.html': pageWith('<p>Plan</p>', 'Plan'),
    'forms/questionnaire.html': pageWith(
      '<form action="answers/" method="post"><input name="n"></form>',
    ),
  })
  const who = await person('respondent')
  respondent = await sessionFor(who)
  const forms = await nodeAt(tree.treeId, 'forms')
  await share(tree.treeId, forms!.id, 'email', who.email, 'respond', owner)
  await sendAs(respondent, tree, {
    page: 'forms/questionnaire.html',
    form: await formRef(tree, 'forms/questionnaire.html', 'forms/answers/'),
    entries: [['n', 'mine']],
  })
})

const eventsAs = (caller: Caller, path: string) =>
  runAs(
    caller,
    Effect.flatMap(TreeStore, (store) =>
      store.events({ tree: tree.treeId, after: null, path }),
    ).pipe(
      Effect.match({
        onSuccess: () => 'followed',
        onFailure: (error: DossierError) => ({
          code: error.code,
          path: error.path,
        }),
      }),
    ),
  )

describe('a refused events request', () => {
  it('names only the asked path to a visitor, whether it exists or not', async () => {
    for (const path of [
      'secret/plan.html',
      'secret/qplan.html',
      'qsecret/x.html',
      'secret/',
      'qsecret/',
    ]) {
      expect(await eventsAs(visitorCaller(), path)).toEqual({
        code: 'sign_in_required',
        path,
      })
    }
  })

  it('answers a path the caller cannot read under a folder they read as a missing one', async () => {
    expect(await eventsAs(respondent, 'forms/answers/')).toEqual(
      await eventsAs(respondent, 'forms/qanswers/'),
    )
  })
})
