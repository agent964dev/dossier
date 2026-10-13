// Comments: entries in each writer's folder of a page's comments folder,
// threads assembled on read, resolves and reopens, revisions, deletion that
// keeps the thread, who may comment and read, and mentions with "mentioned
// you" until the person opens the page.
import type {
  AuthoredSeq,
  OpId,
  Person,
  Thread,
  TreeId,
} from '@dossier/contracts'
import {
  commentOfFragment,
  threadsText,
  type JsonObject,
} from '@dossier/contracts/bridge'
import { env } from 'cloudflare:workers'
import { Effect, TestClock, TestContext } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  Data,
  mentionedInTree,
  Notifications,
  Pages,
  People,
  unseenMentions,
  type Caller,
} from '../src/core/index.ts'
import CAP_MIGRATION from '../drizzle/0028_notifications_cap.sql?raw'
import { NOTIFICATIONS_KEPT } from '../src/core/tree-store.ts'
import { homeModel } from '../src/server/home-model.ts'
import { listingModel } from '../src/server/listing-model.ts'
import { Browser, signedIn } from './support/browser.ts'
import { keySecretFor } from './support/keys.ts'
import { beforeBatch, count, exec, rows } from './support/d1.ts'
import {
  pageWith,
  pushForms,
  QUESTIONS,
  seqOf,
  type FormTree,
} from './support/forms.ts'
import { harness, testRuntime } from './support/harness.ts'
import { callerOf, fresh, runAs, sessionFor } from './support/people.ts'
import {
  agent,
  failureAs,
  join,
  nodeAt,
  person,
  pushAll,
  ref,
  share,
  team,
  visitorCaller,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const PLAN = pageWith(
  `<section id="pricing"><h2>Pricing</h2><p>Per truck.</p></section>
   <img id="mock" src="mock.png" alt="Mockup">
   <dossier-comments stances="reopen"></dossier-comments>`,
  'Plan',
)

const FILES = {
  'plan.html': PLAN,
  'other.html': pageWith('<p>Other.</p>', 'Other'),
  'questions/index.html': QUESTIONS,
}

/** 10 Oct 2026, 09:14:03 UTC, and minutes after it. */
const T0 = Date.UTC(2026, 9, 10, 9, 14, 3)
const minutes = (n: number) => T0 + n * 60_000

let owner: Person
let ws: { id: string; name: string }
let ownerBrowser: Caller

beforeAll(async () => {
  owner = await person('owner')
  ws = await workspace(owner)
  ownerBrowser = await sessionFor(owner)
})

type Run = Parameters<typeof runAs>[1]

/** Runs `effect` as `caller` with the clock at `time`. */
const at = <A>(time: number, caller: Caller, effect: Run) =>
  runAs(
    caller,
    Effect.gen(function* () {
      yield* TestClock.setTime(time)
      return yield* effect
    }).pipe(Effect.provide(TestContext.TestContext)),
  ) as Promise<A>

interface Write {
  readonly path: string
  readonly patch: JsonObject
  readonly page?: string
  readonly opId?: string
}

const writeInput = async (tree: FormTree, w: Write) => ({
  tree: tree.treeId as TreeId,
  page: w.page ?? 'plan.html',
  path: w.path,
  patch: w.patch,
  replace: false,
  opId: (w.opId ?? crypto.randomUUID()) as OpId,
  seq: (await seqOf(tree)) as AuthoredSeq,
})

const write = async (
  time: number,
  caller: Caller,
  tree: FormTree,
  w: Write,
) => {
  const input = await writeInput(tree, w)
  return at<{ path: string; data: unknown }>(
    time,
    caller,
    Effect.flatMap(Data, (data) => data.write(input)),
  )
}

const writeFailure = async (caller: Caller, tree: FormTree, w: Write) => {
  const input = await writeInput(tree, w)
  return failureAs(
    caller,
    Effect.flatMap(Data, (data) => data.write(input)),
  )
}

const comment = (text: string, more: JsonObject = {}): JsonObject => ({
  text,
  anchor: null,
  label: null,
  pin: null,
  replyTo: null,
  stance: null,
  mentions: [],
  ...more,
})

const threadsOf = async (
  caller: Caller,
  tree: FormTree,
  path = 'plan.comments/',
) => {
  const result = await runAs(
    caller,
    Effect.flatMap(Data, (data) =>
      data.read({ treeId: tree.treeId as TreeId, path }),
    ),
  )
  return 'files' in result
    ? (result.files as unknown as { path: string; data: Thread }[])
    : []
}

/** A person given `role` on a node of the tree by email, signed in. */
const given = async (
  tree: FormTree,
  role: 'read' | 'respond' | 'write',
  path = '',
  local: string = role,
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
  return { who, caller: await sessionFor(who), email: who.email.toLowerCase() }
}

const versionsOf = (treeId: string, path: string) =>
  rows<{ revision: number; json: string | null }>(
    `select v.revision, v.json_value as json from node_versions v
       join nodes n on n.id = v.node_id
     where n.tree_id = ? and n.path = ? order by v.revision`,
    treeId,
    path,
  )

const mentionRows = (treeId: string) => count('mentions', 'tree_id = ?', treeId)

const withdraw = (caller: Caller, tree: FormTree, path: string) =>
  runAs(
    caller,
    Effect.flatMap(Data, (data) =>
      data.withdraw({
        treeId: tree.treeId as TreeId,
        path,
        opId: crypto.randomUUID() as OpId,
      }),
    ),
  )

describe('writing a comment', () => {
  it('adds an entry in the writer’s own folder with a comment event and its operation ID, once', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const opId = crypto.randomUUID()
    const first = await write(T0, sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Per pallet or per truck?', {
        anchor: 'pricing',
        label: 'Pricing',
      }),
      opId,
    })
    expect(first.path).toBe(
      `plan.comments/${sara.email}/2026-10-10T09-14-03.json`,
    )
    expect(first.data).toEqual(
      comment('Per pallet or per truck?', {
        anchor: 'pricing',
        label: 'Pricing',
      }),
    )
    const again = await write(minutes(1), sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Per pallet or per truck?'),
      opId,
    })
    expect(again.path).toBe(first.path)
    expect(
      await count(
        'nodes',
        "tree_id = ? and origin = 'data' and kind = 'file'",
        tree.treeId,
      ),
    ).toBe(1)
    expect(await versionsOf(tree.treeId, first.path)).toHaveLength(1)
    const events = await rows<{ type: string; path: string }>(
      `select type, path from events where tree_id = ? and type = 'comment'`,
      tree.treeId,
    )
    expect(events).toEqual([{ type: 'comment', path: first.path }])
    const ops = await rows<{ op_id: string }>(
      'select op_id from operations where principal = ? and scope = ?',
      sara.who.id,
      `${tree.treeId}:plan.comments/`,
    )
    expect(ops).toEqual([{ op_id: opId }])
    // The writer's own folder is theirs; the comments folder nobody's.
    const owners = await rows<{ path: string; owner: string | null }>(
      `select path, owner_id as owner from nodes where tree_id = ? and origin = 'data'
         and kind = 'folder' order by path`,
      tree.treeId,
    )
    expect(owners).toEqual([
      { path: 'plan.comments', owner: null },
      { path: `plan.comments/${sara.email}`, owner: sara.who.id },
    ])
  })

  it('stores a reply to a reply under the root, and decides a thread by its newest resolve or reopen', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const lina = await given(tree, 'respond', '', 'lina')
    const root = await write(T0, sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Per pallet or per truck?', {
        anchor: 'pricing',
        label: 'Pricing',
      }),
    })
    const reply = await write(minutes(5), lina.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Per truck from December.', { replyTo: root.path }),
    })
    const replyToReply = await write(minutes(6), sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Thanks.', { replyTo: reply.path, stance: 'reopen' }),
    })
    expect((replyToReply.data as { replyTo: string }).replyTo).toBe(root.path)
    const whole = await write(minutes(7), lina.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Looks good overall.'),
    })
    await write(minutes(8), sara.caller, tree, {
      path: 'plan.comments/',
      patch: { resolves: root.path },
    })
    await write(minutes(9), lina.caller, tree, {
      path: 'plan.comments/',
      patch: { reopens: root.path },
    })
    await write(minutes(10), lina.caller, tree, {
      path: 'plan.comments/',
      patch: { resolves: root.path },
    })
    let threads = await threadsOf(ownerBrowser, tree)
    expect(threads.map((t) => t.path)).toEqual([root.path, whole.path])
    const first = threads[0]!
    expect(first.data.root).toMatchObject({
      path: root.path,
      text: 'Per pallet or per truck?',
      anchor: 'pricing',
      label: 'Pricing',
      by: sara.email,
      at: new Date(T0).toISOString(),
      edited: false,
      deleted: false,
    })
    expect(first.data.replies.map((r) => [r.by, r.text, r.stance])).toEqual([
      [lina.email, 'Per truck from December.', null],
      [sara.email, 'Thanks.', 'reopen'],
    ])
    expect(first.data).toMatchObject({
      resolved: true,
      resolvedBy: lina.email,
      resolvedAt: new Date(minutes(10)).toISOString(),
    })
    expect(threads[1]!.data.resolved).toBe(false)
    await write(minutes(12), sara.caller, tree, {
      path: 'plan.comments/',
      patch: { reopens: root.path },
    })
    threads = await threadsOf(ownerBrowser, tree)
    expect(threads[0]!.data).toMatchObject({
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
    })
    // A resolve names only a thread's root, and nothing beside it.
    expect(
      await writeFailure(sara.caller, tree, {
        path: 'plan.comments/',
        patch: { resolves: reply.path },
      }),
    ).toMatchObject({ code: 'invalid', path: 'resolves' })
    expect(
      await writeFailure(sara.caller, tree, {
        path: 'plan.comments/',
        patch: { resolves: root.path, text: 'Done' },
      }),
    ).toMatchObject({ code: 'invalid', path: 'text' })
  })

  it('refuses unknown keys, a pin without an anchor, and a reply to nothing in the folder', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const elsewhere = await write(T0, sara.caller, tree, {
      page: 'other.html',
      path: 'other.comments/',
      patch: comment('On the other page.'),
    })
    const cases: readonly (readonly [JsonObject, string])[] = [
      [{ ...comment('Hi'), colour: 'red' }, 'colour'],
      [comment('Hi', { pin: { x: 0.4, y: 0.2 } }), 'pin'],
      [comment('Hi', { anchor: 'mock', pin: { x: 1.4, y: 0.2 } }), 'pin'],
      [comment('Hi', { replyTo: elsewhere.path }), 'replyTo'],
      [comment('Hi', { replyTo: 'plan.comments/x@y.z/none.json' }), 'replyTo'],
      [comment('   '), 'text'],
      [comment('x'.repeat(10_001)), 'text'],
      [comment('Hi', { mentions: ['not an email'] }), 'mentions'],
      [comment('Hi', { stance: 'x'.repeat(41) }), 'stance'],
    ]
    for (const [patch, path] of cases) {
      expect(
        await writeFailure(sara.caller, tree, {
          path: 'plan.comments/',
          patch,
        }),
      ).toMatchObject({ code: 'invalid', path })
    }
    // A pin on an anchored element is fine.
    await write(minutes(1), sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Here.', { anchor: 'mock', pin: { x: 0.4, y: 0.2 } }),
    })
    expect(
      await writeFailure(sara.caller, tree, {
        path: 'nothing.comments/',
        patch: comment('Hi'),
      }),
    ).toMatchObject({
      code: 'invalid',
      message: 'nothing.comments/ belongs to no page.',
    })
    // Only the component's shape: a writer names no file of their own.
    expect(
      await writeFailure(sara.caller, tree, {
        path: `plan.comments/${sara.email}/mine.json`,
        patch: comment('Hi'),
      }),
    ).toMatchObject({ code: 'not_found' })
    expect(
      await writeFailure(sara.caller, tree, {
        path: 'plan.comments/notes/',
        patch: comment('Hi'),
      }),
    ).toMatchObject({ code: 'forbidden' })
  })

  it('lets respondents and page-share respondents comment, refuses readers with forbidden and visitors with sign_in_required', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const pageOnly = await given(tree, 'respond', 'plan.html', 'guest')
    const reader = await given(tree, 'read')
    const key = await agent(sara.who, { readOnly: true })
    await write(T0, sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('From a folder share.'),
    })
    const guest = await write(minutes(1), pageOnly.caller, tree, {
      path: 'plan.comments/',
      patch: comment('From a page share.'),
    })
    // A page-share respondent revises their own comment too.
    await write(minutes(2), pageOnly.caller, tree, {
      path: guest.path,
      patch: { text: 'From a page share, edited.' },
    })
    expect(
      await writeFailure(reader.caller, tree, {
        path: 'plan.comments/',
        patch: comment('Can I?'),
      }),
    ).toMatchObject({
      code: 'forbidden',
      message: 'You can open this but not change it.',
    })
    expect(
      await writeFailure(key, tree, {
        path: 'plan.comments/',
        patch: comment('Through a read-only key.'),
      }),
    ).toMatchObject({ code: 'forbidden' })
    expect(
      await writeFailure(visitorCaller(), tree, {
        path: 'plan.comments/',
        patch: comment('A visitor.'),
      }),
    ).toMatchObject({ code: 'sign_in_required' })
    // A page-share respondent comments on that page alone.
    expect(
      await writeFailure(pageOnly.caller, tree, {
        path: 'other.comments/',
        patch: comment('Elsewhere.'),
      }),
    ).toMatchObject({ code: 'invalid' })
    const readerThreads = await threadsOf(reader.caller, tree)
    expect(readerThreads.map((t) => t.data.root.text)).toEqual([
      'From a folder share.',
      'From a page share, edited.',
    ])
    expect(readerThreads[1]!.data.root.edited).toBe(true)
  })

  it('shows a public page’s comments to visitors, and no other data', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    await write(T0, sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Visible to everyone who opens the page.'),
    })
    await write(minutes(1), sara.caller, tree, {
      path: 'layout.json',
      patch: { secret: 1 },
    })
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, 'plan.html'))!.id,
      'anyone',
      'anyone',
      'read',
      owner,
    )
    const visitor = visitorCaller()
    expect(
      (await threadsOf(visitor, tree)).map((t) => t.data.root.text),
    ).toEqual(['Visible to everyone who opens the page.'])
    const file = await runAs(
      visitor,
      Effect.flatMap(Data, (data) =>
        data.read({ treeId: tree.treeId as TreeId, path: 'layout.json' }),
      ),
    )
    expect(file).toEqual({ file: null })
    expect(await threadsOf(visitor, tree, 'other.comments/')).toEqual([])
  })
})

describe('revising and deleting', () => {
  it('changes only text and mentions, and only the writer’s own', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const lina = await given(tree, 'respond', '', 'lina')
    const mine = await write(T0, sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('First thought.', { anchor: 'pricing', label: 'Pricing' }),
    })
    const revised = await write(minutes(3), sara.caller, tree, {
      path: mine.path,
      patch: { text: 'Second thought.', mentions: [lina.email] },
    })
    expect(revised.data).toEqual(
      comment('Second thought.', {
        anchor: 'pricing',
        label: 'Pricing',
        mentions: [lina.email],
      }),
    )
    expect(await mentionRows(tree.treeId)).toBe(1)
    expect(
      await writeFailure(sara.caller, tree, {
        path: mine.path,
        patch: { anchor: 'mock' },
      }),
    ).toMatchObject({ code: 'invalid', path: 'anchor' })
    expect(
      await writeFailure(lina.caller, tree, {
        path: mine.path,
        patch: { text: 'Not yours.' },
      }),
    ).toMatchObject({ code: 'forbidden' })
    const [thread] = await threadsOf(sara.caller, tree)
    expect(thread!.data.root).toMatchObject({
      text: 'Second thought.',
      anchor: 'pricing',
      edited: true,
      at: new Date(T0).toISOString(),
    })
  })

  it('leaves one blank version with every earlier one gone, replies kept, for a withdrawal, a write holder’s delete and account deletion', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const lina = await given(tree, 'respond', '', 'lina')
    const root = await write(T0, sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('To withdraw.', { mentions: [lina.email] }),
    })
    await write(minutes(1), sara.caller, tree, {
      path: root.path,
      patch: { text: 'To withdraw, revised.' },
    })
    await write(minutes(2), lina.caller, tree, {
      path: 'plan.comments/',
      patch: comment('A reply that stays.', { replyTo: root.path }),
    })
    const moderated = await write(minutes(3), lina.caller, tree, {
      path: 'plan.comments/',
      patch: comment('A write holder deletes this.'),
    })
    const accounted = await write(minutes(4), sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Account deletion blanks this.'),
    })
    const mark = await write(minutes(5), sara.caller, tree, {
      path: 'plan.comments/',
      patch: { resolves: moderated.path },
    })
    expect(await versionsOf(tree.treeId, root.path)).toHaveLength(2)
    expect(await mentionRows(tree.treeId)).toBe(1)

    await withdraw(sara.caller, tree, root.path)
    await runAs(
      ownerBrowser,
      Effect.flatMap(Data, (data) =>
        data.deleteComment({
          treeId: tree.treeId as TreeId,
          path: moderated.path,
        }),
      ),
    )
    // Only a write holder deletes someone else's comment; a respondent
    // reads it only as the page carries it, so it looks missing to change.
    expect(
      await failureAs(
        lina.caller,
        Effect.flatMap(Data, (data) =>
          data.deleteComment({
            treeId: tree.treeId as TreeId,
            path: accounted.path,
          }),
        ),
      ),
    ).toMatchObject({ code: 'not_found' })
    const preview = await runAs(
      sara.caller,
      Effect.flatMap(People, (p) => p.deletionPreview()),
    )
    expect(preview.comments).toBe(1)
    await runAs(
      sara.caller,
      Effect.flatMap(People, (p) => p.deleteAccount()),
    )

    for (const path of [root.path, moderated.path, accounted.path]) {
      const versions = await versionsOf(tree.treeId, path)
      expect(versions).toHaveLength(1)
      expect(JSON.parse(versions[0]!.json!)).toMatchObject({
        text: '',
        mentions: [],
      })
    }
    // The resolve stays, so the thread is as it was.
    expect(await versionsOf(tree.treeId, mark.path)).toHaveLength(1)
    expect(await mentionRows(tree.treeId)).toBe(0)
    const threads = await threadsOf(ownerBrowser, tree)
    expect(
      threads.map((t) => [
        t.data.root.by,
        t.data.root.deleted,
        t.data.root.text,
        t.data.replies.map((r) => r.text),
        t.data.resolved,
      ]),
    ).toEqual([
      [sara.email, true, '', ['A reply that stays.'], false],
      [lina.email, true, '', [], true],
      [sara.email, true, '', [], false],
    ])
    const events = await rows<{ type: string }>(
      `select type from events where tree_id = ? and type in ('comment', 'withdrawal')`,
      tree.treeId,
    )
    expect(events.every((e) => e.type === 'comment')).toBe(true)
  })
})

describe('mentions', () => {
  it('writes a row and a mention event for someone who can read the page, and neither for someone who cannot', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const lina = await given(tree, 'read', '', 'lina')
    const outsider = (await person('outsider')).email.toLowerCase()
    const nobody = 'nobody-yet@example.com'
    const written = await write(T0, sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment(`@${lina.email} @${outsider} have a look`, {
        mentions: [lina.email.toUpperCase(), outsider, nobody, sara.email],
      }),
    })
    // The text keeps every mention; only readers get a row.
    expect((written.data as { mentions: string[] }).mentions).toEqual([
      lina.email,
      outsider,
      nobody,
      sara.email,
    ])
    const mentioned = await rows<{ email: string; event_seq: number }>(
      'select email, event_seq from mentions where tree_id = ?',
      tree.treeId,
    )
    expect(mentioned.map((m) => m.email)).toEqual([lina.email])
    const events = await rows<{ seq: number; type: string; path: string }>(
      `select seq, type, path from events where tree_id = ?
         and type in ('comment', 'mention') order by seq`,
      tree.treeId,
    )
    expect(events.map((e) => [e.type, e.path])).toEqual([
      ['comment', written.path],
      ['mention', written.path],
    ])
    expect(mentioned[0]!.event_seq).toBe(events[1]!.seq)
  })

  it('says "mentioned you" on the tree row, the listing row and the Shared with me row until the page is opened or the comment is deleted', async () => {
    // No form here: "waiting for your answer" would stand before a mention.
    const tree = await pushForms(owner, ws, {
      'plan.html': PLAN,
      'other.html': FILES['other.html'],
    })
    const sara = await given(tree, 'respond')
    // Lina is a member, reading the tree through the workspace.
    const lina = await person('lina')
    await join(ws, lina)
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, ''))!.id,
      'workspace',
      ws.id,
      'read',
      owner,
    )
    const linaBrowser = await sessionFor(lina)
    const linaEmail = lina.email.toLowerCase()
    const unseen = (who: Person) =>
      runAs(ownerBrowser, unseenMentions(env.DB, who))
    const open = (time: number) =>
      at(
        time,
        linaBrowser,
        Effect.flatMap(Pages, (pages) =>
          pages.view({
            treeId: tree.treeId as TreeId,
            path: 'plan',
            renewal: false,
          }),
        ),
      )

    // Seen just before the mention, within the hour: it still shows.
    await open(T0)
    const toLina = await write(minutes(1), sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Lina, the price?', { mentions: [linaEmail] }),
    })
    // What Lina's home and the tree's listing show.
    const screens = async () => {
      const home = await runAs(linaBrowser, homeModel({ w: ws.name }))
      const listing = await runAs(
        linaBrowser,
        listingModel({ workspace: ws.name, tree: tree.name, path: '' }),
      )
      return {
        tree: home.trees.find((t) => t.name === tree.name)?.mentioned,
        pages: Object.fromEntries(
          listing.pages.map((page) => [page.path, page.mentioned]),
        ),
      }
    }
    expect(await screens()).toEqual({
      tree: true,
      pages: { 'other.html': false, 'plan.html': true },
    })
    await open(minutes(2))
    expect(await screens()).toEqual({
      tree: false,
      pages: { 'other.html': false, 'plan.html': false },
    })

    // Sara's email share shows on her home under Shared with me.
    // Her home's Shared with me row, from its read model.
    const shared = async () =>
      (await runAs(sara.caller, homeModel({ w: null }))).shared
        .filter((row) => row.from === ws.name && row.place === tree.name)
        .map((row) => row.label)
    expect(await shared()).toEqual([null])
    const toSara = await write(minutes(3), ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment('Sara, see the plan.', { mentions: [sara.email] }),
    })
    expect(await shared()).toEqual(['mentioned you'])
    // Deleting the comment clears it.
    await withdraw(ownerBrowser, tree, toSara.path)
    expect(await shared()).toEqual([null])

    // A mention edited away no longer counts either.
    const again = await write(minutes(70), sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Lina, once more.', { mentions: [linaEmail] }),
    })
    expect(mentionedInTree(await unseen(lina), tree.treeId)).toBe(true)
    await write(minutes(71), sara.caller, tree, {
      path: again.path,
      patch: { mentions: [] },
    })
    expect(mentionedInTree(await unseen(lina), tree.treeId)).toBe(false)
    expect(toLina.path).not.toBe(again.path)
  })
})

describe('team mentions', () => {
  it('reach the team’s members who can open the page, for a writer in the workspace, and nobody for a guest or an unknown team', async () => {
    const tree = await pushForms(owner, ws, FILES)
    // Dana reads the page by email; Gus is in the team and reads nothing.
    const dana = await person('dana')
    const gus = await person('gus')
    await join(ws, dana)
    await join(ws, gus)
    await team(ws, 'Design Ops', [dana, gus, owner])
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, 'plan.html'))!.id,
      'email',
      dana.email.toLowerCase(),
      'read',
      owner,
    )
    const sara = await given(tree, 'respond')
    const danaEmail = dana.email.toLowerCase()
    const mentioned = () =>
      rows<{ email: string; via: string | null }>(
        'select email, via from mentions where tree_id = ? order by event_seq',
        tree.treeId,
      )

    // A guest's team mention stays text and reaches nobody.
    const guest = await write(T0, sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('@team:"Design Ops" look', {
        mentions: ['team:Design Ops', 'team:Nobody'],
      }),
    })
    expect((guest.data as { mentions: string[] }).mentions).toEqual([
      'team:Design Ops',
      'team:Nobody',
    ])
    expect(await mentioned()).toEqual([])

    // The owner's reaches Dana only, once, whatever the case it is written in.
    const written = await write(minutes(1), ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment('@team:"design ops" look', {
        mentions: ['team:design ops'],
      }),
    })
    expect(await mentioned()).toEqual([
      { email: danaEmail, via: 'team:design ops' },
    ])
    const events = await rows<{ type: string; path: string }>(
      `select type, path from events where tree_id = ? and type = 'mention'`,
      tree.treeId,
    )
    expect(events).toEqual([{ type: 'mention', path: written.path }])
    // "mentioned you" while the comment still names the team.
    expect(
      mentionedInTree(
        await runAs(ownerBrowser, unseenMentions(env.DB, dana)),
        tree.treeId,
      ),
    ).toBe(true)
    await write(minutes(2), ownerBrowser, tree, {
      path: written.path,
      patch: { mentions: [] },
    })
    expect(
      mentionedInTree(
        await runAs(ownerBrowser, unseenMentions(env.DB, dana)),
        tree.treeId,
      ),
    ).toBe(false)
    expect(
      await writeFailure(ownerBrowser, tree, {
        path: 'plan.comments/',
        patch: comment('x', { mentions: ['team: padded'] }),
      }),
    ).toMatchObject({ code: 'invalid', path: 'mentions' })
  })

  it('keep a person mentioned while any mention that reached them stands, by their email or by a team', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const dana = await person('dana2')
    await join(ws, dana)
    await team(ws, 'Writers', [dana])
    await team(ws, 'Readers', [dana])
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, 'plan.html'))!.id,
      'email',
      dana.email.toLowerCase(),
      'read',
      owner,
    )
    const danaEmail = dana.email.toLowerCase()
    const mentioned = async () =>
      mentionedInTree(
        await runAs(ownerBrowser, unseenMentions(env.DB, dana)),
        tree.treeId,
      )
    const written = await write(T0, ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment('Dana, writers and readers', {
        mentions: [danaEmail, 'team:Writers', 'team:Readers'],
      }),
    })
    expect(await mentioned()).toBe(true)
    // Her own email goes; both teams still name her.
    await write(minutes(1), ownerBrowser, tree, {
      path: written.path,
      patch: { mentions: ['team:Writers', 'team:Readers'] },
    })
    expect(await mentioned()).toBe(true)
    // One team goes; the other still names her.
    await write(minutes(2), ownerBrowser, tree, {
      path: written.path,
      patch: { mentions: ['team:Readers'] },
    })
    expect(await mentioned()).toBe(true)
    await write(minutes(3), ownerBrowser, tree, {
      path: written.path,
      patch: { mentions: [] },
    })
    expect(await mentioned()).toBe(false)
  })
})

describe('notifications', () => {
  const list = (
    caller: Caller,
    before: string | null = null,
    limit = 20,
    tree: string | null = null,
  ) =>
    runAs(
      caller,
      Effect.flatMap(Notifications, (n) =>
        n.list({ before, limit, tree: tree as TreeId | null }),
      ),
    )
  const markRead = (
    caller: Caller,
    which: { ids: readonly string[] } | { all: true },
    tree: string | null = null,
  ) =>
    runAs(
      caller,
      Effect.flatMap(Notifications, (n) =>
        n.markRead({ ...which, tree: tree as TreeId | null }),
      ),
    )
  /** Who is told of what, as rows, oldest first. */
  const told = (treeId: string) =>
    rows<{ email: string; type: string; via: string | null }>(
      `select email, type, via from notifications where tree_id = ?
       order by created_at, email`,
      treeId,
    )

  it('tell whom a comment mentions, a mentioned team’s members, and a thread’s other writers, never its writer', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const dana = await person('dana-n')
    await join(ws, dana)
    await team(ws, 'Brand', [dana, owner])
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, 'plan.html'))!.id,
      'email',
      dana.email.toLowerCase(),
      'read',
      owner,
    )
    const danaEmail = dana.email.toLowerCase()
    const sara = await given(tree, 'respond', '', 'sara-n')
    const lina = await given(tree, 'respond', '', 'lina-n')
    const ownerEmail = owner.email.toLowerCase()

    const root = await write(T0, ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment('@team:Brand @sara can you check the price?', {
        anchor: 'pricing',
        label: 'Pricing',
        mentions: ['team:Brand', sara.email],
      }),
    })
    // The owner is in Brand but wrote it.
    expect(await told(tree.treeId)).toEqual([
      { email: danaEmail, type: 'mention', via: 'team:Brand' },
      { email: sara.email, type: 'mention', via: null },
    ])
    await exec('delete from notifications where tree_id = ?', tree.treeId)

    // Sara's reply tells the owner, who started the thread.
    await write(minutes(1), sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Done, see the table.', { replyTo: root.path }),
    })
    // Lina's tells Sara of the reply and the owner of the mention, once.
    await write(minutes(2), lina.caller, tree, {
      path: 'plan.comments/',
      patch: comment(`@${ownerEmail} agreed`, {
        replyTo: root.path,
        mentions: [ownerEmail],
      }),
    })
    expect(await told(tree.treeId)).toEqual([
      { email: ownerEmail, type: 'reply', via: null },
      { email: ownerEmail, type: 'mention', via: null },
      { email: sara.email, type: 'reply', via: null },
    ])

    const page = await list(ownerBrowser)
    expect(page.unread).toBe(2)
    expect(page.next).toBeNull()
    expect(page.notifications).toHaveLength(2)
    const [mention, reply] = page.notifications
    expect(mention).toMatchObject({
      type: 'mention',
      team: null,
      actor: { email: lina.email, name: 'lina-n', image: null },
      workspace: ws.name,
      tree: tree.name,
      page: { path: 'plan.html', title: 'Plan' },
      anchor: 'pricing',
      label: 'Pricing',
      excerpt: `@${ownerEmail} agreed`,
      at: minutes(2),
      read: false,
    })
    // The link opens the comment on its page.
    const link = new URL(mention!.link)
    expect(link.pathname).toBe(`/${ws.name}/${tree.name}/plan`)
    expect(commentOfFragment(link.hash)).toEqual({
      comment: expect.stringMatching(
        new RegExp(`^plan\\.comments/${lina.email}/.+\\.json$`),
      ),
      anchor: 'pricing',
    })
    expect(reply).toMatchObject({ type: 'reply', actor: { email: sara.email } })

    // One page at a time, the newest first.
    const first = await list(ownerBrowser, null, 1)
    expect(first.notifications.map((n) => n.id)).toEqual([mention!.id])
    const second = await list(ownerBrowser, first.next, 1)
    expect(second.notifications.map((n) => n.id)).toEqual([reply!.id])
    expect(second.next).toBeNull()

    // Reading one, then all; opening the page reads Sara's.
    expect(await markRead(ownerBrowser, { ids: [mention!.id] })).toBe(1)
    expect(await markRead(ownerBrowser, { all: true })).toBe(0)
    expect((await list(ownerBrowser)).notifications.map((n) => n.read)).toEqual(
      [true, true],
    )
    // Nobody reads another's.
    expect(await markRead(sara.caller, { ids: [reply!.id] })).toBe(1)
    await at(
      minutes(3),
      sara.caller,
      Effect.flatMap(Pages, (pages) =>
        pages.view({
          treeId: tree.treeId as TreeId,
          path: 'plan',
          renewal: false,
        }),
      ),
    )
    expect((await list(sara.caller)).unread).toBe(0)
  })

  it('list only pages the person can open now, and go with their comment', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond', '', 'sara-g')
    const written = await write(T0, ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment('Sara, a look?', { mentions: [sara.email] }),
    })
    // A guest gets their own, for the page shared with them.
    expect((await list(sara.caller)).notifications).toHaveLength(1)
    expect(
      mentionedInTree(
        await runAs(ownerBrowser, unseenMentions(env.DB, sara.who)),
        tree.treeId,
      ),
    ).toBe(true)

    // Unshared, it is gone and uncounted; shared again, it is back.
    await exec(
      'delete from shares where tree_id = ? and target = ?',
      tree.treeId,
      sara.email,
    )
    expect(await list(sara.caller)).toEqual({
      notifications: [],
      unread: 0,
      next: null,
    })
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, ''))!.id,
      'email',
      sara.email,
      'read',
      owner,
    )
    expect((await list(sara.caller)).unread).toBe(1)

    // The comment deleted takes it along, and the label with it.
    await withdraw(ownerBrowser, tree, written.path)
    expect(await count('notifications', 'tree_id = ?', tree.treeId)).toBe(0)
    expect((await list(sara.caller)).unread).toBe(0)
  })

  it('count an older readable one past ten newer on a page no longer open', async () => {
    const open = await pushForms(owner, ws, FILES)
    const lost = await pushForms(owner, ws, FILES)
    const sara = await person('sara-c')
    const saraEmail = sara.email.toLowerCase()
    for (const tree of [open, lost]) {
      await share(
        tree.treeId,
        (await nodeAt(tree.treeId, ''))!.id,
        'email',
        saraEmail,
        'respond',
        owner,
      )
    }
    const saraBrowser = await sessionFor(sara)
    await write(T0, ownerBrowser, open, {
      path: 'plan.comments/',
      patch: comment('Older, still open', { mentions: [saraEmail] }),
    })
    // Ten newer ones on a page she then loses.
    for (let n = 0; n < 10; n += 1) {
      await write(minutes(1 + n), ownerBrowser, lost, {
        path: 'plan.comments/',
        patch: comment(`Newer ${n}`, { mentions: [saraEmail] }),
      })
    }
    await exec(
      'delete from shares where tree_id = ? and target = ?',
      lost.treeId,
      saraEmail,
    )
    const listed = await list(saraBrowser)
    expect(listed.notifications.map((n) => [n.excerpt, n.read])).toEqual([
      ['Older, still open', false],
    ])
    expect(listed.unread).toBe(1)
  })

  it('keep one per person and comment, however its mentions change', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const dana = await person('dana-u')
    await join(ws, dana)
    await team(ws, 'Uplift', [dana])
    const danaEmail = dana.email.toLowerCase()
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, ''))!.id,
      'email',
      danaEmail,
      'read',
      owner,
    )
    const danaBrowser = await sessionFor(dana)
    const written = await write(T0, ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment('Dana?', { mentions: [danaEmail] }),
    })
    // The team she is in, added beside her own email, tells her nothing new.
    await write(minutes(1), ownerBrowser, tree, {
      path: written.path,
      patch: { mentions: [danaEmail, 'team:Uplift'] },
    })
    expect(await count('notifications', 'email = ?', danaEmail)).toBe(1)
    await markRead(danaBrowser, { all: true })
    // Taken away and given back: told again, once.
    await write(minutes(2), ownerBrowser, tree, {
      path: written.path,
      patch: { mentions: [] },
    })
    await write(minutes(3), ownerBrowser, tree, {
      path: written.path,
      patch: { mentions: [danaEmail] },
    })
    const listed = await list(danaBrowser)
    expect(listed.notifications.map((n) => [n.read, n.at])).toEqual([
      [false, minutes(3)],
    ])
    expect(listed.unread).toBe(1)
    expect(await count('notifications', 'email = ?', danaEmail)).toBe(1)
  })

  it('keep a person’s newest few hundred', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond', '', 'sara-k')
    await write(T0, ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment('First.', { mentions: [sara.email] }),
    })
    const page = (await nodeAt(tree.treeId, 'plan.html'))!.id
    const folder = (await nodeAt(tree.treeId, 'plan.comments'))!.id
    // Older ones on as many comments, long deleted: rows to keep or drop.
    await exec(
      `insert into nodes (id, tree_id, parent_id, name, path, depth, kind,
         origin, created_at, deleted_at)
       with recursive n(i) as (select 0 union all select i + 1 from n where i < ?3 - 1)
       select 'old' || i, ?1, ?2, 'old' || i || '.json',
         'plan.comments/old' || i || '.json', 2, 'file', 'data', 0, 1 from n`,
      tree.treeId,
      folder,
      NOTIFICATIONS_KEPT,
    )
    await exec(
      `insert into notifications (id, email, type, tree_id, page_node_id,
         comment_node_id, actor_id, created_at)
       select id, ?1, 'mention', ?2, ?3, id, ?4, cast(substr(id, 4) as integer)
       from nodes where tree_id = ?2 and substr(id, 1, 3) = 'old'`,
      sara.email,
      tree.treeId,
      page,
      owner.id,
    )
    expect(await count('notifications', 'email = ?', sara.email)).toBe(
      NOTIFICATIONS_KEPT + 1,
    )
    // As the backfill left them, 0028 keeps the newest 300; Sara's own,
    // from the write above, is among them.
    await exec(CAP_MIGRATION)
    expect(await count('notifications', 'email = ?', sara.email)).toBe(
      NOTIFICATIONS_KEPT,
    )
    expect(await count('notifications', "id = 'old0'")).toBe(0)
    expect(await count('notifications', "id = 'old1'")).toBe(1)
    await write(minutes(1), ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment('Second.', { mentions: [sara.email] }),
    })
    expect(await count('notifications', 'email = ?', sara.email)).toBe(
      NOTIFICATIONS_KEPT,
    )
    expect(await count('notifications', "id = 'old0'")).toBe(0)
  })

  it('give a page only its own tree’s, while the screens get every tree’s', async () => {
    const a = await pushForms(owner, ws, FILES)
    const b = await pushForms(owner, ws, FILES)
    const sara = await person('sara-t')
    const saraEmail = sara.email.toLowerCase()
    for (const tree of [a, b]) {
      await share(
        tree.treeId,
        (await nodeAt(tree.treeId, ''))!.id,
        'email',
        saraEmail,
        'respond',
        owner,
      )
    }
    const saraBrowser = await sessionFor(sara)
    await write(T0, ownerBrowser, a, {
      path: 'plan.comments/',
      patch: comment('In A', { mentions: [saraEmail] }),
    })
    await write(minutes(1), ownerBrowser, b, {
      path: 'plan.comments/',
      patch: comment('In B', { mentions: [saraEmail] }),
    })
    const excerpts = async (tree: string | null) =>
      (await list(saraBrowser, null, 20, tree)).notifications.map(
        (n) => n.excerpt,
      )
    expect(await excerpts(null)).toEqual(['In B', 'In A'])
    expect(await excerpts(a.treeId)).toEqual(['In A'])
    expect((await list(saraBrowser, null, 0, a.treeId)).unread).toBe(1)
    // Marking from tree A, even by B's id, reads only A's.
    const inB = (await list(saraBrowser, null, 20, b.treeId)).notifications[0]!
    expect(await markRead(saraBrowser, { ids: [inB.id] }, a.treeId)).toBe(1)
    expect(await markRead(saraBrowser, { all: true }, a.treeId)).toBe(0)
    expect((await list(saraBrowser)).notifications.map((n) => n.read)).toEqual([
      false,
      true,
    ])
    expect((await list(saraBrowser)).unread).toBe(1)
  })

  it('give a key scoped to a page none of its comments, and let only a whole, writable key mark them read', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond', '', 'sara-s')
    await write(T0, ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment('Sara, a look?', { mentions: [sara.email] }),
    })
    const page = (await nodeAt(tree.treeId, 'plan.html'))!.id
    const scoped = await agent(sara.who, { scope: page })
    const readOnly = await agent(sara.who, { readOnly: true })
    const whole = await agent(sara.who)
    // The page is in its reach; the comments beside it are not.
    expect(await list(scoped)).toEqual({
      notifications: [],
      unread: 0,
      next: null,
    })
    expect((await list(whole)).unread).toBe(1)
    for (const key of [scoped, readOnly]) {
      expect(
        await failureAs(
          key,
          Effect.flatMap(Notifications, (n) =>
            n.markRead({ all: true, tree: null }),
          ),
        ),
      ).toMatchObject({ code: 'forbidden' })
    }
    expect((await list(sara.caller)).unread).toBe(1)
    expect(await markRead(whole, { all: true })).toBe(0)
  })

  it('answer the API for the signed-in person only', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const browser = await signedIn(fresh('example.com', 'api'))
    const them = (await callerOf(browser)).person!
    const email = them.email.toLowerCase()
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, 'plan.html'))!.id,
      'email',
      email,
      'respond',
      owner,
    )
    await write(T0, ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment(`@${email} hello`, { mentions: [email] }),
    })
    const listed = await browser.fetch('/_/api/notifications', {
      purpose: 'read',
    })
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as {
      notifications: { id: string; at: string; type: string }[]
      unread: number
      next: string | null
    }
    expect(body).toMatchObject({ unread: 1, next: null })
    expect(body.notifications[0]).toMatchObject({
      type: 'mention',
      at: new Date(T0).toISOString(),
    })
    const count_ = await browser.fetch('/_/api/notifications?limit=0', {
      purpose: 'read',
    })
    expect(await count_.json()).toEqual({
      notifications: [],
      unread: 1,
      next: null,
    })
    // A write without the CSRF header is a visitor's, refused.
    const forged = await browser.fetch('/_/api/notifications/read', {
      method: 'POST',
      purpose: 'read',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    expect(forged.status).toBe(401)
    const marked = await browser.fetch('/_/api/notifications/read', {
      method: 'POST',
      purpose: 'write',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [body.notifications[0]!.id] }),
    })
    expect(await marked.json()).toEqual({ unread: 0 })
    const visitor = await new Browser().fetch('/_/api/notifications', {
      purpose: 'read',
    })
    expect(visitor.status).toBe(401)
  })
})

describe('whom a comment may mention', () => {
  const mentionable = (
    caller: Caller,
    tree: FormTree,
    page: string,
    query = '',
  ) =>
    runAs(
      caller,
      Effect.flatMap(Data, (data) =>
        data.mentionable({ treeId: tree.treeId as TreeId, page, query }),
      ),
    )

  it('gives a member the people and teams who can open the page, and nobody to a guest, a visitor, or for a page they cannot open', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const dana = await person('dana')
    const gus = await person('gus')
    await join(ws, dana)
    await join(ws, gus)
    await exec(
      'update "user" set name = ?, image = ? where id = ?',
      'Dana Haddad',
      'https://lh3.googleusercontent.test/dana',
      dana.id,
    )
    // Design opens the whole tree; Ops has no share; Gus is in Ops alone.
    const design = await team(ws, 'Design', [dana])
    await team(ws, 'Ops', [gus])
    const rootId = (await nodeAt(tree.treeId, ''))!.id
    await share(tree.treeId, rootId, 'team', design.id, 'read', owner)
    // A guest shared the tree by email, and one shared only a folder beside the page.
    const guest = await given(tree, 'read', '', 'guest')
    await given(tree, 'read', 'questions', 'aside')
    const danaBrowser = await sessionFor(dana)

    const all = await mentionable(danaBrowser, tree, 'plan.html')
    expect(all.people.map((p) => p.email).sort()).toEqual(
      [owner.email.toLowerCase(), guest.email].sort(),
    )
    expect(all.teams).toEqual([{ name: 'Design', members: 1 }])
    // What follows the @ narrows it, by name or email.
    const ownerSees = await mentionable(ownerBrowser, tree, '/plan.html', 'dan')
    expect(ownerSees).toEqual({
      people: [
        {
          email: dana.email.toLowerCase(),
          name: 'Dana Haddad',
          image: 'https://lh3.googleusercontent.test/dana',
        },
      ],
      teams: [],
    })
    expect(
      (await mentionable(danaBrowser, tree, 'plan.html', 'des')).teams,
    ).toEqual([{ name: 'Design', members: 1 }])
    // Gus is a member who cannot open the page: nobody, as for a guest,
    // a visitor, a missing page and something that is not a page.
    const nobody = { people: [], teams: [] }
    expect(await mentionable(await sessionFor(gus), tree, 'plan.html')).toEqual(
      nobody,
    )
    expect(await mentionable(guest.caller, tree, 'plan.html')).toEqual(nobody)
    expect(await mentionable(visitorCaller(), tree, 'plan.html')).toEqual(
      nobody,
    )
    expect(await mentionable(danaBrowser, tree, 'missing.html')).toEqual(nobody)
    expect(await mentionable(danaBrowser, tree, 'plan.comments/')).toEqual(
      nobody,
    )
  })

  it('finds the people who can open the page past many members who cannot', async () => {
    const tree = await pushForms(owner, ws, FILES)
    // Sixty members match first and open nothing; the one reader sorts last.
    for (let n = 0; n < 60; n += 1) {
      await join(ws, await person(`pad-${String(n).padStart(2, '0')}`))
    }
    const reader = await person('pad-zz')
    await join(ws, reader)
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, 'plan.html'))!.id,
      'email',
      reader.email.toLowerCase(),
      'read',
      owner,
    )
    const found = await mentionable(ownerBrowser, tree, 'plan.html', 'pad')
    expect(found.people.map((p) => p.email)).toEqual([
      reader.email.toLowerCase(),
    ])
  })
})

describe('comments agents write', () => {
  const ask = (
    caller: Caller,
    i: { path: string; text: string } & JsonObject,
  ) =>
    runAs(
      caller,
      Effect.flatMap(Data, (data) =>
        data.comment({
          ref: ref(i.path),
          text: i.text,
          anchor: typeof i.on === 'string' ? i.on : null,
          replyTo: typeof i.replyTo === 'string' ? i.replyTo : null,
          stance: null,
          opId: crypto.randomUUID() as OpId,
        }),
      ),
    )

  it('are marked as an agent’s from the key alone, never from what a browser sends', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond', '', 'sara-a')
    const lina = await given(tree, 'respond', '', 'lina-a')
    const saraKey = await agent(sara.who)
    // Lina starts a thread in the browser.
    const root = await write(T0, lina.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Per pallet or per truck?', {
        anchor: 'pricing',
        label: 'Pricing',
      }),
    })
    // Sara's agent replies, mentioning the owner, through the CLI's route.
    const reply = await ask(saraKey, {
      path: `${ws.name}/${tree.name}/plan`,
      text: `Per truck. @${owner.email.toLowerCase()}`,
      replyTo: root.path,
    })
    expect(reply.page).toBe('plan.html')
    expect(reply.comment).toMatch(
      new RegExp(`^plan\\.comments/${sara.email}/.+\\.json$`),
    )
    expect(reply.doc.data).toMatchObject({
      agent: true,
      replyTo: root.path,
      mentions: [owner.email.toLowerCase()],
    })
    const [thread] = await threadsOf(lina.caller, tree)
    expect(thread!.data.root.agent).toBe(false)
    expect(thread!.data.replies.map((r) => [r.by, r.agent])).toEqual([
      [sara.email, true],
    ])
    // Lina hears of the reply and the owner of the mention; Sara of nothing.
    expect(
      await rows<{ email: string; type: string; via: string | null }>(
        `select email, type, via from notifications where tree_id = ?
         order by type desc`,
        tree.treeId,
      ),
    ).toEqual([
      { email: lina.email, type: 'reply', via: null },
      { email: owner.email.toLowerCase(), type: 'mention', via: null },
    ])
    const linaHears = await runAs(
      lina.caller,
      Effect.flatMap(Notifications, (n) =>
        n.list({ before: null, limit: 20, tree: null }),
      ),
    )
    expect(linaHears.notifications.map((n) => [n.type, n.agent])).toEqual([
      ['reply', true],
    ])
    expect(
      threadsText({ folder: 'plan.comments', threads: [thread!] }),
    ).toContain(`Reply from ${sara.email} (agent) · `)

    // A browser cannot claim it; an agent's edit keeps it.
    expect(
      await writeFailure(lina.caller, tree, {
        path: 'plan.comments/',
        patch: comment('I am an agent.', { agent: true }),
      }),
    ).toMatchObject({ code: 'invalid', path: 'agent' })
    await write(minutes(5), sara.caller, tree, {
      path: reply.doc.path,
      patch: { text: 'Per truck, from December.' },
    })
    const [after] = await threadsOf(lina.caller, tree)
    expect(after!.data.replies[0]).toMatchObject({
      agent: true,
      text: 'Per truck, from December.',
    })
  })

  it('answer a page the key cannot open as not found, and take the route with a key', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const outsider = await person('outsider-a')
    const failure = await failureAs(
      await agent(outsider),
      Effect.flatMap(Data, (data) =>
        data.comment({
          ref: ref(`${ws.name}/${tree.name}/plan`),
          text: 'Hello?',
          anchor: null,
          replyTo: null,
          stance: null,
          opId: crypto.randomUUID() as OpId,
        }),
      ),
    )
    expect(failure).toMatchObject({ code: 'not_found' })
    expect(
      await count('nodes', "tree_id = ? and origin = 'data'", tree.treeId),
    ).toBe(0)

    const key = await keySecretFor(owner)
    const response = await new Browser().fetch('/_/api/comment', {
      method: 'POST',
      purpose: 'none',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: `${ws.name}/${tree.name}/plan`,
        text: 'From the CLI.',
        on: 'pricing',
        opId: crypto.randomUUID(),
      }),
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      comment: string
      link: string
      doc: { data: { agent: boolean; anchor: string } }
    }
    expect(body.doc.data).toMatchObject({ agent: true, anchor: 'pricing' })
    expect(commentOfFragment(new URL(body.link).hash)).toEqual({
      comment: body.comment,
      anchor: 'pricing',
    })
  })
})

describe('threads agents resolve and reopen', () => {
  const mark = (page: string, thread: string, resolved: boolean) =>
    Effect.flatMap(Data, (data) =>
      data.markThread({
        ref: ref(page),
        thread,
        resolved,
        opId: crypto.randomUUID() as OpId,
      }),
    )

  /** POST /_/api/comment/thread with a key, as the CLI sends it. */
  const route = async (secret: string, body: Record<string, unknown>) => {
    const response = await new Browser().fetch('/_/api/comment/thread', {
      method: 'POST',
      purpose: 'none',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...body, opId: crypto.randomUUID() }),
    })
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    }
  }

  it('resolve and reopen as the component does, for whoever may comment, once each', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const lina = await given(tree, 'respond', '', 'lina-m')
    const sara = await given(tree, 'respond', '', 'sara-m')
    const root = await write(T0, lina.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Per pallet or per truck?', {
        anchor: 'pricing',
        label: 'Pricing',
      }),
    })
    const saraKey = await keySecretFor(sara.who)
    const page = `${ws.name}/${tree.name}/plan`

    // Named on its own, by its tree path, through the CLI's route.
    const resolved = await route(saraKey, {
      thread: `${ws.name}/${tree.name}/${root.path}`,
      resolved: true,
    })
    expect(resolved.status).toBe(200)
    expect(resolved.body).toMatchObject({
      thread: root.path,
      page: 'plan.html',
      resolved: true,
      changed: true,
    })
    expect(
      commentOfFragment(new URL(resolved.body.link as string).hash),
    ).toEqual({ comment: root.path, anchor: 'pricing' })
    const [after] = await threadsOf(lina.caller, tree)
    expect(after!.data).toMatchObject({
      resolved: true,
      resolvedBy: sara.email,
    })

    // Again: nothing more is written.
    const before = await count(
      'nodes',
      "tree_id = ? and origin = 'data' and kind = 'file'",
      tree.treeId,
    )
    const again = await route(saraKey, {
      page,
      thread: root.path,
      resolved: true,
    })
    expect(again.body).toMatchObject({ resolved: true, changed: false })
    expect(
      await count(
        'nodes',
        "tree_id = ? and origin = 'data' and kind = 'file'",
        tree.treeId,
      ),
    ).toBe(before)

    // Reopened with the page and its path from the page's folder.
    const reopened = await runAs(
      await agent(sara.who),
      mark(page, root.path, false),
    )
    expect(reopened).toMatchObject({ thread: root.path, changed: true })
    const [open] = await threadsOf(lina.caller, tree)
    expect(open!.data.resolved).toBe(false)
  })

  it('refuse a reader, a read-only key and a key that does not reach the comments; a stranger finds nothing', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const lina = await given(tree, 'respond', '', 'lina-r')
    const reader = await given(tree, 'read', '', 'reader-r')
    const root = await write(T0, lina.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Per pallet or per truck?'),
    })
    const page = `${ws.name}/${tree.name}/plan`
    const failure = async (caller: Caller) =>
      failureAs(caller, mark(page, root.path, true))

    expect(await failure(await agent(reader.who))).toMatchObject({
      code: 'forbidden',
    })
    expect(
      await failure(await agent(lina.who, { readOnly: true })),
    ).toMatchObject({
      code: 'forbidden',
      fix: 'This agent key is read only. Use a key that can write.',
    })
    const planNode = (await nodeAt(tree.treeId, 'plan.html'))!.id
    expect(
      await failure(await agent(lina.who, { scope: planNode })),
    ).toMatchObject({ code: 'forbidden' })
    const stranger = await failure(await agent(await person('stranger-r')))
    expect(stranger).toMatchObject({ code: 'not_found' })
    const missing = await failureAs(
      await agent(lina.who),
      mark(`${ws.name}/${tree.name}/nothing`, root.path, true),
    )
    expect(missing).toMatchObject({ code: 'not_found' })
    // A key whose reach holds the whole tree resolves.
    const rootNode = (await nodeAt(tree.treeId, ''))!.id
    expect(
      await runAs(
        await agent(lina.who, { scope: rootNode }),
        mark(page, root.path, true),
      ),
    ).toMatchObject({ changed: true })
    const [thread] = await threadsOf(lina.caller, tree)
    expect(thread!.data.resolved).toBe(true)

    // Already resolved: those who may not resolve are still refused, rather
    // than told nothing changed.
    expect(await failure(await agent(reader.who))).toMatchObject({
      code: 'forbidden',
    })
    expect(
      await failure(await agent(lina.who, { readOnly: true })),
    ).toMatchObject({
      code: 'forbidden',
    })
    expect(
      await failure(await agent(lina.who, { scope: planNode })),
    ).toMatchObject({
      code: 'forbidden',
    })
    expect(
      await failure(await agent(await person('stranger-r2'))),
    ).toMatchObject({ code: 'not_found' })

    // The workspace's admin holds write on the tree, and reopens it.
    expect(
      await runAs(await agent(owner), mark(page, root.path, false)),
    ).toMatchObject({ changed: true })
    const [reopened] = await threadsOf(lina.caller, tree)
    expect(reopened!.data.resolved).toBe(false)
  })

  it('refuse what is not a thread, and find a page’s threads in a folder below the root', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const lina = await given(tree, 'respond', '', 'lina-t')
    const root = await write(T0, lina.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Per pallet or per truck?'),
    })
    const reply = await write(minutes(1), lina.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Per truck.', { replyTo: root.path }),
    })
    const key = await keySecretFor(lina.who)
    const base = `${ws.name}/${tree.name}`

    const ofReply = await route(key, {
      thread: `${base}/${reply.path}`,
      resolved: true,
    })
    expect(ofReply.status).toBe(400)
    expect(ofReply.body.error).toMatchObject({ code: 'invalid' })
    const notComments = await route(key, {
      thread: `${base}/questions/index.html`,
      resolved: true,
    })
    expect(notComments.status).toBe(400)

    const asked = await write(minutes(2), lina.caller, tree, {
      page: 'questions/index.html',
      path: 'questions/index.comments/',
      patch: comment('When is this due?'),
    })
    expect(asked.path).toMatch(/^questions\/index\.comments\//)
    const resolved = await route(key, {
      thread: `${base}/${asked.path}`,
      resolved: true,
    })
    expect(resolved.status).toBe(200)
    expect(resolved.body).toMatchObject({
      page: 'questions/index.html',
      thread: asked.path.slice('questions/'.length),
      changed: true,
    })
    expect(new URL(resolved.body.link as string).pathname).toBe(
      `/${base}/questions/`,
    )
    const [thread] = await threadsOf(
      lina.caller,
      tree,
      'questions/index.comments/',
    )
    expect(thread!.data.resolved).toBe(true)
  })
})

describe('what an agent reads', () => {
  it('reads a comments folder as its threads, and counts a page’s comments', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const root = await write(T0, sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Per pallet or per truck?', {
        anchor: 'pricing',
        label: 'Pricing',
      }),
    })
    await write(minutes(1), ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment('Per truck.', { replyTo: root.path }),
    })
    const gone = await write(minutes(2), sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Never mind.'),
    })
    await withdraw(sara.caller, tree, gone.path)
    const read = (target: string) =>
      runAs(
        sara.caller,
        Effect.flatMap(Pages, (pages) => pages.read(ref(target))),
      )
    const folder = await read(`${ws.name}/${tree.name}/plan.comments/`)
    expect(folder.kind).toBe('comments')
    if (folder.kind !== 'comments') return
    expect(folder.page).toBe('plan.html')
    expect(folder.threads.map((t) => t.path)).toEqual([root.path, gone.path])
    expect(folder.text).toBe(
      threadsText({
        folder: 'plan.comments',
        threads: folder.threads as never,
      }),
    )
    expect(folder.text).toContain('## On Pricing · open')
    expect(folder.text).toContain('Comment deleted.')
    const page = await read(`${ws.name}/${tree.name}/plan`)
    expect(page.kind === 'page' && page.pointer.comments).toBe(2)
  })
})

describe('what page code reads for a handoff', () => {
  it('gives a page-share respondent each thread with its root, replies, resolved and every comment’s fields', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond', 'plan.html', 'handoff')
    const root = await write(T0, sara.caller, tree, {
      path: 'plan.comments/',
      // A stance on a thread's first comment, as a new comment offers it.
      patch: comment('Hand the pricing to the agent', {
        anchor: 'pricing',
        label: 'Pricing',
        stance: 'reopen',
      }),
    })
    await write(minutes(1), ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment('Agreed.', { replyTo: root.path }),
    })
    const [only, ...rest] = await threadsOf(sara.caller, tree)
    expect(rest).toEqual([])
    expect(only?.path).toBe(root.path)
    expect(only?.data).toMatchObject({
      resolved: false,
      root: {
        path: root.path,
        by: sara.email,
        // The writer's display name beside their email.
        name: 'handoff',
        at: new Date(T0).toISOString(),
        text: 'Hand the pricing to the agent',
        anchor: 'pricing',
        stance: 'reopen',
        deleted: false,
      },
      replies: [
        {
          by: owner.email.toLowerCase(),
          text: 'Agreed.',
          anchor: null,
          stance: null,
          deleted: false,
        },
      ],
    })
  })
})

describe('changes that race a comment', () => {
  it('never brings back a comment deleted while its edit was on the way', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const mine = await write(T0, sara.caller, tree, {
      path: 'plan.comments/',
      patch: comment('Soon deleted.'),
    })
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) => sql.includes('json_patch('),
            () => withdraw(sara.caller, tree, mine.path).then(() => {}),
          ),
        },
      }),
    )
    expect(
      await writeFailure(sara.caller, tree, {
        path: mine.path,
        patch: { text: 'Edited after all?' },
      }),
    ).toMatchObject({ code: 'invalid', message: 'This comment was deleted.' })
    const versions = await versionsOf(tree.treeId, mine.path)
    expect(versions).toHaveLength(1)
    expect(JSON.parse(versions[0]!.json!)).toMatchObject({ text: '' })
  })

  it('writes no mention for someone whose access went while the comment was on the way', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const lina = await given(tree, 'read', '', 'lina')
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) => sql.includes('insert into mentions'),
            async () => {
              await exec(
                'delete from shares where tree_id = ? and target = ?',
                tree.treeId,
                lina.email,
              )
            },
          ),
        },
      }),
    )
    // On the real clock: the write starts again after a short wait.
    const input = await writeInput(tree, {
      path: 'plan.comments/',
      patch: comment('Lina?', { mentions: [lina.email] }),
    })
    const written = await runAs(
      sara.caller,
      Effect.flatMap(Data, (data) => data.write(input)),
    )
    expect((written.data as { mentions: string[] }).mentions).toEqual([
      lina.email,
    ])
    expect(await mentionRows(tree.treeId)).toBe(0)
    expect(
      await count('events', "tree_id = ? and type = 'mention'", tree.treeId),
    ).toBe(0)
  })
})

describe('where a comment may go', () => {
  it('keeps an agent key to its scope, and a page to its own comments', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await given(tree, 'respond')
    const scoped = await agent(sara.who, {
      scope: (await nodeAt(tree.treeId, 'plan.html'))!.id,
    })
    expect(
      await writeFailure(scoped, tree, {
        path: 'plan.comments/',
        patch: comment('From a key scoped to the page alone.'),
      }),
    ).toMatchObject({ code: 'forbidden' })
    expect(
      await count('nodes', "tree_id = ? and origin = 'data'", tree.treeId),
    ).toBe(0)
    // Another page writes no comments of this one, nor records its push.
    expect(
      await writeFailure(sara.caller, tree, {
        page: 'other.html',
        path: 'plan.comments/',
        patch: comment('From the other page.'),
      }),
    ).toMatchObject({ code: 'forbidden' })
  })

  it('refuses a push of authored files into a page’s comments folder', async () => {
    const ownerKey = await agent(owner)
    const name = `c${crypto.randomUUID().slice(0, 8)}`
    const refused = await pushAll(ownerKey, `${ws.name}/${name}`, {
      'plan.html': PLAN,
      'plan.comments/readme.txt': 'Squatting the comments.',
    }).then(
      () => null,
      (error: unknown) => String(error),
    )
    expect(refused).toContain(
      "plan.comments/readme.txt is inside plan.comments/, a page's comments folder",
    )
    expect(
      await count('trees', 'name = ? and workspace_id = ?', name, ws.id),
    ).toBe(0)
  })
})
