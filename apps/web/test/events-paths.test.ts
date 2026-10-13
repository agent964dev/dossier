// Events name the path each one recorded. Someone who reads a node only
// where it stands now never learns, through the events route, where it
// stood before: an event shows only when its path is one they see now (where
// a node they read stands, a folder above it, or a place they read), as the
// history does. Webhooks go only to workspace admins, who see the whole
// history, so their payloads name nothing more than that history does.
import type { AuthoredSeq, OpId, Person, TreeId } from '@dossier/contracts'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Data, Files, TreeStore, type Caller } from '../src/core/index.ts'
import { pageWith, pushForms, seqOf, type FormTree } from './support/forms.ts'
import { harness } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import { nodeAt, person, ref, share, workspace } from './support/trees.ts'

afterEach(() => harness.reset())

const PLAN = pageWith(
  '<p>Plan.</p><dossier-comments></dossier-comments>',
  'Plan',
)

let owner: Person
let ws: { id: string; name: string }
let ownerBrowser: Caller

beforeAll(async () => {
  owner = await person('owner')
  ws = await workspace(owner)
  ownerBrowser = await sessionFor(owner)
})

const commentAs = async (
  caller: Caller,
  tree: FormTree,
  page: string,
  text: string,
) => {
  const seq = await seqOf(tree)
  return runAs(
    caller,
    Effect.flatMap(Data, (data) =>
      data.write({
        tree: tree.treeId as TreeId,
        page,
        path: `${page.slice(0, -'.html'.length)}.comments/`,
        patch: {
          text,
          anchor: null,
          label: null,
          pin: null,
          replyTo: null,
          stance: null,
          mentions: [],
        },
        replace: false,
        opId: crypto.randomUUID() as OpId,
        seq: seq as AuthoredSeq,
      }),
    ),
  )
}

const cursorAs = async (caller: Caller, tree: FormTree) =>
  (
    await runAs(
      caller,
      Effect.flatMap(TreeStore, (store) =>
        store.events({ tree: tree.treeId, after: null, path: null }),
      ),
    )
  ).next

/** Every event after the cursor the caller sees, as `type path`. */
const eventsAs = async (
  caller: Caller,
  tree: FormTree,
  from: string,
  path: string | null = null,
) => {
  const out: string[] = []
  let after = from
  for (;;) {
    const page = await runAs(
      caller,
      Effect.flatMap(TreeStore, (store) =>
        store.events({ tree: tree.treeId, after, path }),
      ),
    )
    for (const e of page.events) out.push(`${e.type} ${e.path}`)
    if (!page.more) return out
    after = page.next
  }
}

const given = async (
  tree: FormTree,
  path: string,
  role: 'read' | 'respond',
  local: string,
) => {
  const who = await person(local)
  await share(
    tree.treeId,
    (await nodeAt(tree.treeId, path))!.id,
    'email',
    who.email.toLowerCase(),
    role,
    owner,
  )
  return { who, caller: await sessionFor(who) }
}

describe('events of a node that moved', () => {
  it('never name, to someone who reads it only where it is now, where it stood before', async () => {
    const tree = await pushForms(owner, ws, {
      'private/plan.html': PLAN,
      'private/notes.html': pageWith('<p>Notes.</p>', 'Notes'),
      'public/index.html': pageWith('<p>Public.</p>', 'Public'),
    })
    const rami = await given(tree, 'public', 'read', 'rami')
    const from = await cursorAs(rami.caller, tree)
    const ownerFrom = await cursorAs(ownerBrowser, tree)
    const sara = await given(tree, 'private/plan.html', 'respond', 'sara')
    await commentAs(sara.caller, tree, 'private/plan.html', 'Before the move')
    await runAs(
      ownerBrowser,
      Effect.flatMap(Files, (f) =>
        f.mv({
          from: ref(`${ws.name}/${tree.name}/private/plan.html`),
          to: ref(`${ws.name}/${tree.name}/public/plan.html`),
        }),
      ),
    )
    await commentAs(sara.caller, tree, 'public/plan.html', 'After the move')
    // The owner sees where it all happened.
    const all = await eventsAs(ownerBrowser, tree, ownerFrom)
    expect(
      all.some((e) => e.startsWith('comment private/plan.comments/')),
    ).toBe(true)
    expect(all).toContain('move private/plan.html')
    // Rami reads the page and its comments where they are now, and sees
    // only what happened there.
    const seen = await eventsAs(rami.caller, tree, from)
    expect(seen.filter((e) => e.includes('private'))).toEqual([])
    expect(
      seen.some((e) => e.startsWith('comment public/plan.comments/')),
    ).toBe(true)
    // Asking about the place he reads changes nothing.
    expect(
      (await eventsAs(rami.caller, tree, from, 'public')).filter((e) =>
        e.includes('private'),
      ),
    ).toEqual([])
  })

  it('still shows someone who reads the old place what happened there', async () => {
    const tree = await pushForms(owner, ws, {
      'private/plan.html': PLAN,
      'private/notes.html': pageWith('<p>Notes.</p>', 'Notes'),
      'public/index.html': pageWith('<p>Public.</p>', 'Public'),
    })
    const lina = await given(tree, '', 'read', 'lina')
    const from = await cursorAs(lina.caller, tree)
    const sara = await given(tree, 'private/plan.html', 'respond', 'sara')
    await commentAs(sara.caller, tree, 'private/plan.html', 'Before the move')
    await runAs(
      ownerBrowser,
      Effect.flatMap(Files, (f) =>
        f.mv({
          from: ref(`${ws.name}/${tree.name}/private/plan.html`),
          to: ref(`${ws.name}/${tree.name}/public/plan.html`),
        }),
      ),
    )
    const seen = await eventsAs(lina.caller, tree, from)
    expect(
      seen.some((e) => e.startsWith('comment private/plan.comments/')),
    ).toBe(true)
    expect(seen).toContain('move private/plan.html')
  })

  it('names in a webhook only what the workspace’s admins see in its history', async () => {
    const tree = await pushForms(owner, ws, {
      'private/plan.html': PLAN,
      'public/index.html': pageWith('<p>Public.</p>', 'Public'),
    })
    await runAs(
      ownerBrowser,
      Effect.flatMap(Files, (f) =>
        f.mv({
          from: ref(`${ws.name}/${tree.name}/private/plan.html`),
          to: ref(`${ws.name}/${tree.name}/public/plan.html`),
        }),
      ),
    )
    // A webhook's event is the events route's, and only admins register
    // them: an admin's history names the old path too.
    const log = await runAs(
      ownerBrowser,
      Effect.flatMap(Files, (f) =>
        f.log({ ref: ref(`${ws.name}/${tree.name}/`), cursor: null }),
      ),
    )
    expect(
      log.lines.some(
        (l) => l.kind === 'move' && l.path === 'private/plan.html',
      ),
    ).toBe(true)
  })
})
