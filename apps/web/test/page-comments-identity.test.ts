// A page's comments belong to that page: deleting it (rm, a push without
// it, a restore to before it) takes its comments folder with it, so a later
// page at the same path starts with none, and nobody who reads the new page
// learns anything of the old comments, through reads or events. Restoring
// the page brings its comments back.
import type {
  AuthoredSeq,
  OpId,
  Person,
  Thread,
  TreeId,
} from '@dossier/contracts'
import type { JsonObject } from '@dossier/contracts/bridge'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Data, Files, TreeStore, type Caller } from '../src/core/index.ts'
import { beforeBatch, recordingStatements, rows } from './support/d1.ts'
import { pageWith, pushForms, seqOf, type FormTree } from './support/forms.ts'
import { harness, testRuntime } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  nodeAt,
  person,
  pushAll,
  ref,
  share,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const PLAN = pageWith(
  '<p>Plan.</p><dossier-comments></dossier-comments>',
  'Plan',
)
const OTHER = pageWith('<p>Other.</p>', 'Other')

let owner: Person
let ws: { id: string; name: string }
let ownerBrowser: Caller

beforeAll(async () => {
  owner = await person('owner')
  ws = await workspace(owner)
  ownerBrowser = await sessionFor(owner)
})

const comment = (text: string): JsonObject => ({
  text,
  anchor: null,
  label: null,
  pin: null,
  replyTo: null,
  stance: null,
  mentions: [],
})

const commentAs = async (caller: Caller, tree: FormTree, text: string) => {
  const seq = await seqOf(tree)
  return runAs(
    caller,
    Effect.flatMap(Data, (data) =>
      data.write({
        tree: tree.treeId as TreeId,
        page: 'plan.html',
        path: 'plan.comments/',
        patch: comment(text),
        replace: false,
        opId: crypto.randomUUID() as OpId,
        seq: seq as AuthoredSeq,
      }),
    ),
  )
}

/** The comment texts a caller reads on plan.html, or the refusal. */
const textsAs = (caller: Caller, tree: FormTree) =>
  runAs(
    caller,
    Effect.flatMap(Data, (data) =>
      data.read({ treeId: tree.treeId as TreeId, path: 'plan.comments/' }),
    ).pipe(
      Effect.map((result) =>
        'files' in result
          ? (result.files as unknown as { data: Thread }[]).flatMap((t) =>
              [t.data.root, ...t.data.replies].map((c) => c.text),
            )
          : [],
      ),
      Effect.catchAll((error) => Effect.succeed(error.code)),
    ),
  )

/** The caller's cursor now: events after it come next. */
const cursorAs = async (caller: Caller, tree: FormTree) =>
  (
    await runAs(
      caller,
      Effect.flatMap(TreeStore, (store) =>
        store.events({ tree: tree.treeId, after: null, path: null }),
      ),
    )
  ).next

/** Every event after the cursor the caller may see, as `type path by`. */
const eventsAs = async (caller: Caller, tree: FormTree, from: string) => {
  const out: string[] = []
  let after: string = from
  for (;;) {
    const page = await runAs(
      caller,
      Effect.flatMap(TreeStore, (store) =>
        store.events({ tree: tree.treeId, after, path: null }),
      ),
    )
    for (const e of page.events) out.push(`${e.type} ${e.path} ${e.by}`)
    if (!page.more) return out
    after = page.next
  }
}

/** Someone given `role` on a node by email, signed in. */
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

const pushTree = (tree: FormTree, files: Record<string, string>) =>
  pushAll(tree.ownerAgent, `${ws.name}/${tree.name}`, files, { force: true })

const rm = (caller: Caller, tree: FormTree, path: string) =>
  runAs(
    caller,
    Effect.flatMap(Files, (f) =>
      f.rm({ ref: ref(`${ws.name}/${tree.name}/${path}`) }),
    ),
  )

const restore = (
  caller: Caller,
  tree: FormTree,
  path: string,
  to: { readonly push: number } | { readonly at: number },
) =>
  runAs(
    caller,
    Effect.flatMap(Files, (f) =>
      f.restore({
        ref: ref(`${ws.name}/${tree.name}/${path}`),
        to: to as never,
      }),
    ),
  )

/**
 * Someone who reads other.html from the start, and their cursor then: what
 * the tree's events show them from before any comment.
 */
const watcher = async (tree: FormTree) => {
  const rami = await given(tree, 'other.html', 'read', 'rami')
  return { ...rami, from: await cursorAs(rami.caller, tree) }
}

/**
 * After plan.html with Sara's private comment is gone, a new plan.html is
 * pushed and Rami may respond on it: he reads no old comment and sees no
 * old comment event, before and after he comments himself.
 */
const expectFreshPage = async (
  tree: FormTree,
  sara: Person,
  rami: Awaited<ReturnType<typeof watcher>> & { readonly ownerFrom: string },
) => {
  await share(
    tree.treeId,
    (await nodeAt(tree.treeId, 'plan.html'))!.id,
    'email',
    rami.who.email.toLowerCase(),
    'respond',
    owner,
  )
  expect(await textsAs(rami.caller, tree)).toEqual([])
  const comments = (events: readonly string[]) =>
    events.filter((e) => e.includes('plan.comments') || e.includes(sara.email))
  // The owner sees Sara's comment in the tree's events: it happened.
  expect(
    comments(await eventsAs(ownerBrowser, tree, rami.ownerFrom)).some((e) =>
      e.includes(sara.email.toLowerCase()),
    ),
  ).toBe(true)
  expect(comments(await eventsAs(rami.caller, tree, rami.from))).toEqual([])
  await commentAs(rami.caller, tree, 'A new thread')
  expect(await textsAs(rami.caller, tree)).toEqual(['A new thread'])
  const after = comments(await eventsAs(rami.caller, tree, rami.from))
  expect(after).toHaveLength(1)
  expect(after[0]).toContain(
    `comment plan.comments/${rami.who.email.toLowerCase()}/`,
  )
}

/** A tree with plan.html, and Sara's private comment on it. */
const commented = async () => {
  const tree = await pushForms(owner, ws, {
    'plan.html': PLAN,
    'other.html': OTHER,
  })
  const rami = {
    ...(await watcher(tree)),
    ownerFrom: await cursorAs(ownerBrowser, tree),
  }
  const sara = await given(tree, 'plan.html', 'respond', 'sara')
  await commentAs(sara.caller, tree, 'Private: the budget is 40k')
  expect(await textsAs(ownerBrowser, tree)).toEqual([
    'Private: the budget is 40k',
  ])
  return { tree, sara: sara.who, rami }
}

/** A moment before `run`, as `dossier rm` prints it for a restore. */
const momentBefore = async (run: () => Promise<unknown>) => {
  const before = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 5))
  await run()
  return before
}

describe('a page deleted and another pushed at its path', () => {
  it('starts with no comments after dossier rm', async () => {
    const { tree, sara, rami } = await commented()
    await rm(ownerBrowser, tree, 'plan.html')
    await pushTree(tree, { 'plan.html': PLAN, 'other.html': OTHER })
    await expectFreshPage(tree, sara, rami)
  })

  it('starts with no comments after a push without the page', async () => {
    const { tree, sara, rami } = await commented()
    await pushTree(tree, { 'other.html': OTHER })
    await pushTree(tree, { 'plan.html': PLAN, 'other.html': OTHER })
    await expectFreshPage(tree, sara, rami)
  })

  it('starts with no comments after a restore to before the page', async () => {
    const tree = await pushForms(owner, ws, { 'other.html': OTHER })
    const rami = {
      ...(await watcher(tree)),
      ownerFrom: await cursorAs(ownerBrowser, tree),
    }
    await pushTree(tree, { 'plan.html': PLAN, 'other.html': OTHER })
    const sara = await given(tree, 'plan.html', 'respond', 'sara')
    await commentAs(sara.caller, tree, 'Private: the budget is 40k')
    await restore(ownerBrowser, tree, '', { push: 1 })
    expect(await nodeAt(tree.treeId, 'plan.html')).toBeUndefined()
    await pushTree(tree, { 'plan.html': PLAN, 'other.html': OTHER })
    await expectFreshPage(tree, sara.who, rami)
  })

  it('takes a first comment written while the restore was on the way', async () => {
    const tree = await pushForms(owner, ws, { 'other.html': OTHER })
    await pushTree(tree, { 'plan.html': PLAN, 'other.html': OTHER })
    const sara = await given(tree, 'plan.html', 'respond', 'sara')
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) => sql.includes("json_extract(j.value, '$.from')"),
            async () => {
              await commentAs(sara.caller, tree, 'Private: written meanwhile')
            },
          ),
        },
      }),
    )
    await restore(ownerBrowser, tree, '', { push: 1 })
    expect(await nodeAt(tree.treeId, 'plan.html')).toBeUndefined()
    expect(
      await rows(
        `select path from nodes where tree_id = ? and deleted_at is null
           and (path = 'plan.comments' or path like 'plan.comments/%')`,
        tree.treeId,
      ),
    ).toEqual([])
  })

  it('removes 300 pages in one restore within D1’s limits', async () => {
    const tree = await pushForms(owner, ws, { 'other.html': OTHER })
    const pages: Record<string, string> = { 'other.html': OTHER }
    for (let n = 0; n < 300; n += 1) pages[`p/page-${n}.html`] = PLAN
    await pushTree(tree, pages)
    expect(await nodeAt(tree.treeId, 'p/page-299.html')).toBeDefined()
    const recorded = recordingStatements(env.DB)
    harness.use(testRuntime({ env: { DB: recorded.db } }))
    await restore(ownerBrowser, tree, '', { push: 1 })
    expect(await nodeAt(tree.treeId, 'p/page-0.html')).toBeUndefined()
    const bytes = (text: string) => new TextEncoder().encode(text).byteLength
    expect(
      recorded
        .seen()
        .filter((s) => s.binds.length > 100 || bytes(s.sql) > 100_000),
    ).toEqual([])
  }, 120_000)
})

describe('restoring a deleted page', () => {
  it('brings its comments back with it', async () => {
    const { tree } = await commented()
    const before = await momentBefore(() => rm(ownerBrowser, tree, 'plan.html'))
    expect(await textsAs(ownerBrowser, tree)).not.toEqual([
      'Private: the budget is 40k',
    ])
    await restore(ownerBrowser, tree, 'plan.html', { at: before })
    expect(await textsAs(ownerBrowser, tree)).toEqual([
      'Private: the budget is 40k',
    ])
  })

  it('brings them back with a restore of its folder', async () => {
    const { tree } = await commented()
    const before = await momentBefore(() => rm(ownerBrowser, tree, 'plan.html'))
    await restore(ownerBrowser, tree, '', { at: before })
    expect(await textsAs(ownerBrowser, tree)).toEqual([
      'Private: the budget is 40k',
    ])
  })
})
