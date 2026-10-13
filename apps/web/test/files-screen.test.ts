// A folder with index.html opens as its page at its link, so the Files
// screen lists it anyway, with the listing's own answers: who may see it,
// what they may do there, and a way into a page folder's own Files. The
// home's tree menu offers the same actions on a tree's root.
import { afterEach, describe, expect, it } from 'vitest'

import type { CommitResult } from '../src/core/index.ts'
import { homeModel } from '../src/server/home-model.ts'
import { listingModel } from '../src/server/listing-model.ts'
import { harness } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  agent,
  failureAs,
  join,
  nodeAt,
  person,
  pushAll,
  share,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const setUp = async () => {
  const admin = await person('admin')
  const ws = await workspace(admin)
  const reader = await person('reader')
  await join(ws, reader)
  const pushed = (await pushAll(await agent(admin), `${ws.name}/site`, {
    'index.html': '<title>Home</title>',
    'guide/index.html': '<title>Guide</title>',
    'guide/setup.html': '<title>Setup</title>',
    'notes.html': '<title>Notes</title>',
    'drafts/idea.html': '<title>Idea</title>',
  })) as CommitResult
  const root = (await nodeAt(pushed.treeId, ''))!.id
  await share(pushed.treeId, root, 'email', reader.email, 'read', admin)
  return {
    ws,
    admin: await sessionFor(admin),
    reader: await sessionFor(reader),
    stranger: await sessionFor(await person('stranger')),
  }
}

describe('the Files screen', () => {
  it("lists a folder that has index.html, with the listing's actions", async () => {
    const { ws, admin, reader, stranger } = await setUp()
    const files = (path: string) =>
      listingModel({ workspace: ws.name, tree: 'site', path, files: true })

    const owners = await runAs(admin, files(''))
    expect(owners.can.share).toBe(true)
    expect(owners.history).toBe(`/_/history/${ws.name}/site/`)
    const guide = owners.pages.find((p) => p.path === 'guide/')!
    expect(guide.files).toBe(`/_/files/${ws.name}/site/guide/`)
    expect(owners.pages.find((p) => p.path === 'notes.html')!.files).toBeNull()
    // An ordinary folder's row keeps to Files; the listing's row opens its link.
    expect(owners.folders.find((f) => f.name === 'drafts')!.files).toBe(
      `/_/files/${ws.name}/site/drafts/`,
    )
    const listed = await runAs(
      admin,
      listingModel({ workspace: ws.name, tree: 'site', path: '' }),
    )
    expect(listed.folders.find((f) => f.name === 'drafts')!.files).toBeNull()

    // The folder's own page is listed, and its crumbs stay in Files: the
    // folders above open as pages.
    const inGuide = await runAs(admin, files('guide'))
    expect(inGuide.pages.map((p) => p.path)).toEqual([
      'index.html',
      'setup.html',
    ])
    expect(inGuide.crumbs.at(-1)?.href).toBe(`/_/files/${ws.name}/site/`)

    // A reader sees it as the listing shows them, without its write actions.
    const readers = await runAs(reader, files(''))
    expect(readers.can).toEqual({
      seenBy: false,
      kit: false,
      share: false,
      history: false,
      delete: false,
    })
    expect(readers.history).toBeNull()

    // Anyone else is told nothing is here, as a missing folder answers.
    const refused = await failureAs(stranger, files(''))
    const missing = await failureAs(stranger, files('nowhere'))
    expect(refused.code).toBe('not_found')
    expect(missing.code).toBe(refused.code)
  })
})

describe("a tree's menu on the home", () => {
  it('offers Share and History to write holders, Files to everyone', async () => {
    const { ws, admin, reader } = await setUp()
    const treeFor = async (caller: typeof admin) =>
      (await runAs(caller, homeModel({ w: ws.name }))).trees.find(
        (t) => t.name === 'site',
      )!

    const owners = await treeFor(admin)
    expect(owners.can).toEqual({ share: true, history: true })
    expect(owners.history).toBe(`/_/history/${ws.name}/site/`)
    expect(owners.files).toBe(`/_/files/${ws.name}/site/`)

    const readers = await treeFor(reader)
    expect(readers.can).toEqual({ share: false, history: false })
    expect(readers.history).toBeNull()
    expect(readers.files).toBe(`/_/files/${ws.name}/site/`)
  })
})
