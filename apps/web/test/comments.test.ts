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
import { threadsText, type JsonObject } from '@dossier/contracts/bridge'
import { env } from 'cloudflare:workers'
import { Effect, TestClock, TestContext } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  Data,
  mentionedInTree,
  mentionedOnPage,
  Pages,
  People,
  Shares,
  unseenMentions,
  type Caller,
} from '../src/core/index.ts'
import { count, rows } from './support/d1.ts'
import {
  pageWith,
  pushForms,
  QUESTIONS,
  seqOf,
  type FormTree,
} from './support/forms.ts'
import { harness } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  agent,
  failureAs,
  join,
  nodeAt,
  person,
  ref,
  share,
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
    const tree = await pushForms(owner, ws, FILES)
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
    let mentions = await unseen(lina)
    expect(mentionedInTree(mentions, tree.treeId)).toBe(true)
    expect(mentionedOnPage(mentions, tree.treeId, 'plan.html')).toBe(true)
    expect(mentionedOnPage(mentions, tree.treeId, 'other.html')).toBe(false)
    await open(minutes(2))
    mentions = await unseen(lina)
    expect(mentionedInTree(mentions, tree.treeId)).toBe(false)
    expect(mentionedOnPage(mentions, tree.treeId, 'plan.html')).toBe(false)

    // Sara's email share shows on her home under Shared with me.
    const shared = async () =>
      (
        await runAs(
          sara.caller,
          Effect.flatMap(Shares, (s) => s.sharedWithMe()),
        )
      )
        .filter((row) => row.tree.id === tree.treeId)
        .map((row) => row.mentioned)
    expect(await shared()).toEqual([false])
    const toSara = await write(minutes(3), ownerBrowser, tree, {
      path: 'plan.comments/',
      patch: comment('Sara, see the plan.', { mentions: [sara.email] }),
    })
    expect(await shared()).toEqual([true])
    // Deleting the comment clears it.
    await withdraw(ownerBrowser, tree, toSara.path)
    expect(await shared()).toEqual([false])

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
