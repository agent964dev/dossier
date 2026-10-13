// Watching a page's comments through real upgrades: whoever reads the page
// follows its comments folder, before the first comment makes it too.
import type { OpId, Person, TreeId } from '@dossier/contracts'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Data, type Caller } from '../../src/core/index.ts'
import { Browser, signedIn } from '../support/browser.ts'
import { pageWith, pushForms, seqOf, type FormTree } from '../support/forms.ts'
import { harness } from '../support/harness.ts'
import { callerOf, fresh, runAs } from '../support/people.ts'
import { open, upgradeAs, visitorBrowser } from '../support/sockets.ts'
import { nodeAt, share, workspace } from '../support/trees.ts'

afterEach(() => harness.reset())

let owner: Person
let ownerCaller: Caller
let guestBrowser: Browser
let tree: FormTree

beforeAll(async () => {
  const ownerBrowser = await signedIn(fresh())
  ownerCaller = await callerOf(ownerBrowser)
  owner = ownerCaller.person!
  const ws = await workspace(owner)
  tree = await pushForms(owner, ws, {
    'plan.html': pageWith('<p>Plan</p><dossier-comments></dossier-comments>'),
    'other.html': pageWith('<p>Other</p>'),
  })
  guestBrowser = await signedIn(fresh())
  const guest = (await callerOf(guestBrowser)).person!
  // The guest holds the page alone, and anyone may read it.
  const plan = (await nodeAt(tree.treeId, 'plan.html'))!.id
  await share(
    tree.treeId,
    plan,
    'email',
    guest.email.toLowerCase(),
    'respond',
    owner,
  )
  await share(tree.treeId, plan, 'anyone', 'anyone', 'read', owner)
})

const commentOn = async (folder: string) => {
  const seq = await seqOf(tree)
  return runAs(
    ownerCaller,
    Effect.flatMap(Data, (data) =>
      data.write({
        tree: tree.treeId as TreeId,
        page: 'plan.html',
        path: folder,
        patch: {
          text: 'A first comment.',
          anchor: null,
          label: null,
          pin: null,
          replyTo: null,
          stance: null,
          mentions: [],
        },
        replace: false,
        opId: crypto.randomUUID() as OpId,
        seq,
      }),
    ),
  )
}

describe('watching comments', () => {
  it('follows a comments folder the first comment has not made yet, for a page-share guest and a visitor', async () => {
    const guest = open(
      await upgradeAs(guestBrowser, tree.treeId, ['plan.comments/']),
    )
    const visitor = open(
      await upgradeAs(visitorBrowser(), tree.treeId, ['plan.comments/']),
    )
    await commentOn('plan.comments/')
    for (const socket of [guest, visitor]) {
      expect(await socket.next()).toEqual({
        type: 'changed',
        tree: tree.treeId,
        sub: 0,
      })
      socket.ws.close(1000, 'done')
    }
  })

  it('still refuses the comments of a page the caller cannot read', async () => {
    const response = await upgradeAs(guestBrowser, tree.treeId, [
      'other.comments/',
    ])
    expect(response.status).toBe(404)
  })
})
