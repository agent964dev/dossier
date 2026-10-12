import type { AuthoredSeq, TreeId } from '@dossier/contracts'
import { Effect, TestClock, TestContext } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CurrentCaller,
  Pages,
  type Caller,
  type CommitResult,
  type Served,
  type StageResult,
} from '../src/core/index.ts'
import { signedIn, type Browser } from './support/browser.ts'
import { count, exec, rows } from './support/d1.ts'
import { harness } from './support/harness.ts'
import { callerOf, fresh, run, runAs } from './support/people.ts'
import {
  agent,
  failureAs,
  nodeAt,
  pushAll,
  ref,
  share,
  treeOf,
  visitorCaller,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const HOUR = 60 * 60 * 1000

const FILES = {
  'plan.html': '<!doctype html><title>Plan</title><p>Plan one</p>',
  'notes/index.html': '<title>Notes</title><p>Notes</p>',
  'notes/today.html': '<p>Today</p>',
  'mockups/a.html': '<p>A</p>',
  'brief.pdf': '%PDF-1.7 brief',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
}

const committed = (result: CommitResult | StageResult): CommitResult => {
  if (!('number' in result)) throw new Error('the push did not commit')
  return result
}

/** An owner signed in with a browser, a workspace, and a pushed tree. */
const world = async () => {
  const ownerBrowser = await signedIn(fresh())
  const owner = await callerOf(ownerBrowser)
  const ws = await workspace(owner.person!)
  const key = await agent(owner.person!)
  committed(await pushAll(key, `${ws.name}/acme`, FILES))
  const tree = (await treeOf(ws.name, 'acme'))!
  return {
    ownerBrowser,
    owner,
    ws,
    key,
    treeId: tree.id as TreeId,
    at: (path: string) => `${ws.name}/acme/${path}`,
    /** Pushes the tree again with these files changed. */
    repush: async (changes: Record<string, string>) =>
      committed(
        await pushAll(
          key,
          `${ws.name}/acme`,
          { ...FILES, ...changes },
          { force: true },
        ),
      ),
  }
}

/** A second person signed in with a browser. */
const someone = async (): Promise<{ browser: Browser; caller: Caller }> => {
  const browser = await signedIn(fresh())
  return { browser, caller: await callerOf(browser) }
}

const open = (caller: Caller, target: string) =>
  runAs(
    caller,
    Effect.flatMap(Pages, (pages) =>
      pages.open({ ref: ref(target), wantsAgent: false }),
    ),
  )

const openFailure = (caller: Caller, target: string) =>
  failureAs(
    caller,
    Effect.flatMap(Pages, (pages) =>
      pages.open({ ref: ref(target), wantsAgent: false }),
    ),
  )

const view = (caller: Caller, treeId: TreeId, path: string) =>
  Effect.flatMap(Pages, (pages) => pages.view({ treeId, path })).pipe(
    Effect.provideService(CurrentCaller, caller),
  )

/** A frame request with this handle on this tree's host, or null if refused. */
const frame = (
  handle: string,
  treeId: TreeId,
  seq: number,
  path: string,
  folder = false,
) =>
  Effect.gen(function* () {
    const pages = yield* Pages
    const caller = yield* pages.handleCaller(handle, treeId)
    if (caller === null) return 'refused' as const
    return yield* pages
      .frame({
        treeId,
        seq: seq as AuthoredSeq,
        path,
        folder,
        range: null,
        ifNoneMatch: null,
        host: `${treeId}.content.test`,
      })
      .pipe(
        Effect.provideService(CurrentCaller, caller),
        Effect.catchAll((error) => Effect.succeed(error.code)),
      )
  })

const htmlOf = (served: Served | string): string => {
  if (typeof served === 'string' || served.kind !== 'framePage') {
    throw new Error(`not a page: ${JSON.stringify(served)}`)
  }
  return served.html
}

const atTime = <A, E>(effect: Effect.Effect<A, E, Pages>) =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now())
      return yield* effect
    }).pipe(Effect.provide(TestContext.TestContext)),
  )

describe('the URL forms of a link', () => {
  it('opens pages, redirects other forms, and lists folders without index.html', async () => {
    const w = await world()
    const plan = await open(w.owner, w.at('plan'))
    expect(plan).toMatchObject({
      kind: 'shell',
      boot: {
        path: 'plan.html',
        linkPath: 'plan',
        link: `https://dossier.test/${w.ws.name}/acme/plan`,
        contentOrigin: `https://${w.treeId}.content.test`,
        tree: { id: w.treeId, workspace: w.ws.name, name: 'acme' },
        base: 'test',
        me: { email: w.owner.person!.email },
      },
    })
    expect(await open(w.owner, w.at('plan.html'))).toEqual({
      kind: 'redirect',
      to: `/${w.ws.name}/acme/plan`,
      status: 301,
    })
    expect(await open(w.owner, w.at('notes'))).toEqual({
      kind: 'redirect',
      to: `/${w.ws.name}/acme/notes/`,
      status: 301,
    })
    expect(await open(w.owner, w.at('notes/index.html'))).toMatchObject({
      kind: 'redirect',
      to: `/${w.ws.name}/acme/notes/`,
    })
    expect(await open(w.owner, w.at('notes/'))).toMatchObject({
      kind: 'shell',
      boot: { path: 'notes/index.html', linkPath: 'notes/' },
    })
    expect(await open(w.owner, w.at('mockups/'))).toMatchObject({
      kind: 'listing',
    })
    expect(await open(w.owner, w.at(''))).toMatchObject({ kind: 'listing' })
    expect(await open(w.owner, w.at('brief.pdf'))).toMatchObject({
      kind: 'shell',
      boot: { path: 'brief.pdf', linkPath: 'brief.pdf' },
    })
    // A file named with a trailing slash is not a folder.
    expect((await openFailure(w.owner, w.at('brief.pdf/'))).code).toBe(
      'not_found',
    )
  })

  it('answers a redirect only after the access check, and missing like unreadable', async () => {
    const w = await world()
    const { caller: outsider } = await someone()
    for (const target of ['plan.html', 'notes', 'plan', 'mockups/']) {
      const refused = await openFailure(outsider, w.at(target))
      expect(refused.code, target).toBe('not_found')
    }
    const missing = await openFailure(outsider, w.at('salaries'))
    const hidden = await openFailure(outsider, w.at('plan'))
    expect({ ...missing, path: null }).toEqual({ ...hidden, path: null })
    const visitorMissing = await openFailure(visitorCaller(), w.at('salaries'))
    const visitorHidden = await openFailure(visitorCaller(), w.at('plan.html'))
    expect(visitorMissing.code).toBe('sign_in_required')
    expect({ ...visitorMissing, path: null }).toEqual({
      ...visitorHidden,
      path: null,
    })
  })
})

describe('view handles', () => {
  it('serves the files of an older push to a frame at the sequence it was issued', async () => {
    const w = await world()
    const { caller: reader } = await someone()
    const root = (await nodeAt(w.treeId, ''))!
    await share(
      w.treeId,
      root.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    const first = await atTime(view(reader, w.treeId, 'plan'))
    expect(first).toMatchObject({ role: 'read', seq: 1 })
    expect(first.handle).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await w.repush({
      'plan.html': '<!doctype html><title>Plan</title><p>Plan two</p>',
    })

    const old = await atTime(frame(first.handle, w.treeId, 1, 'plan'))
    expect(htmlOf(old)).toContain('Plan one')
    // The newer sequence was never issued to this handle.
    expect(await atTime(frame(first.handle, w.treeId, 2, 'plan'))).toBe(
      'not_found',
    )
    const second = await atTime(view(reader, w.treeId, 'plan'))
    expect(second).toMatchObject({ handle: first.handle, seq: 2 })
    expect(
      htmlOf(await atTime(frame(first.handle, w.treeId, 2, 'plan'))),
    ).toContain('Plan two')
    // Still the same push's files for a page already open.
    expect(
      htmlOf(await atTime(frame(first.handle, w.treeId, 1, 'plan'))),
    ).toContain('Plan one')
  })

  it('refuses a reader a sequence from before they were given access, and opens it for a write holder', async () => {
    const w = await world()
    await w.repush({ 'plan.html': '<!doctype html><p>Plan two</p>' })
    const { caller: reader } = await someone()
    const root = (await nodeAt(w.treeId, ''))!
    await share(
      w.treeId,
      root.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    const readerGrant = await atTime(view(reader, w.treeId, 'plan'))
    expect(readerGrant.seq).toBe(2)
    expect(await atTime(frame(readerGrant.handle, w.treeId, 1, 'plan'))).toBe(
      'not_found',
    )
    const ownerGrant = await atTime(view(w.owner, w.treeId, 'plan'))
    expect(ownerGrant).toMatchObject({ role: 'write', seq: 2 })
    expect(
      htmlOf(await atTime(frame(ownerGrant.handle, w.treeId, 1, 'plan'))),
    ).toContain('Plan one')
  })

  it('expires 24 hours after the last renewal, is renewed by view, and a new generation drops the old sequences', async () => {
    const w = await world()
    const outcome = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now())
        const first = yield* view(w.owner, w.treeId, 'plan')
        yield* TestClock.adjust(23 * HOUR)
        const renewed = yield* view(w.owner, w.treeId, 'plan')
        yield* TestClock.adjust(23 * HOUR)
        const stillOpen = yield* frame(first.handle, w.treeId, 1, 'plan')
        yield* TestClock.adjust(2 * HOUR)
        const lapsed = yield* frame(first.handle, w.treeId, 1, 'plan')
        const replaced = yield* view(w.owner, w.treeId, 'plan')
        const oldAfter = yield* frame(first.handle, w.treeId, 1, 'plan')
        const reopened = yield* frame(replaced.handle, w.treeId, 1, 'plan')
        return {
          first,
          renewed,
          stillOpen,
          lapsed,
          replaced,
          oldAfter,
          reopened,
        }
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(outcome.renewed.handle).toBe(outcome.first.handle)
    expect(htmlOf(outcome.stillOpen)).toContain('Plan one')
    expect(outcome.lapsed).toBe('refused')
    expect(outcome.replaced.handle).not.toBe(outcome.first.handle)
    expect(outcome.oldAfter).toBe('refused')
    expect(htmlOf(outcome.reopened)).toContain('Plan one')
    expect(
      await count(
        'view_handle_seqs',
        `handle_hash not in (select hash_sha256 from view_handles)`,
      ),
    ).toBe(0)
    expect(
      await count(
        'view_handles',
        'session_id = ? and tree_id = ?',
        (w.owner.via as { sessionId: string }).sessionId,
        w.treeId,
      ),
    ).toBe(1)
  })

  it('drops the sequences of the old generation, so a reader cannot reopen them', async () => {
    const w = await world()
    const { caller: reader } = await someone()
    const root = (await nodeAt(w.treeId, ''))!
    await share(
      w.treeId,
      root.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    const outcome = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now())
        const first = yield* view(reader, w.treeId, 'plan')
        yield* Effect.promise(() =>
          w.repush({ 'plan.html': '<!doctype html><p>Plan two</p>' }),
        )
        yield* TestClock.adjust(25 * HOUR)
        const next = yield* view(reader, w.treeId, 'plan')
        return {
          first,
          next,
          old: yield* frame(next.handle, w.treeId, 1, 'plan'),
          current: yield* frame(next.handle, w.treeId, 2, 'plan'),
        }
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(outcome.next.handle).not.toBe(outcome.first.handle)
    expect(outcome.old).toBe('not_found')
    expect(htmlOf(outcome.current)).toContain('Plan two')
  })

  it('refuses a handle after its session signs out, after access is lost, and on another tree', async () => {
    const w = await world()
    const reader = await someone()
    const root = (await nodeAt(w.treeId, ''))!
    await share(
      w.treeId,
      root.id,
      'email',
      reader.caller.person!.email,
      'read',
      w.owner.person!,
    )
    const grant = await atTime(view(reader.caller, w.treeId, 'plan'))
    expect(
      htmlOf(await atTime(frame(grant.handle, w.treeId, 1, 'plan'))),
    ).toContain('Plan one')
    // Another tree's host.
    const other = committed(
      await pushAll(w.key, `${w.ws.name}/beta`, { 'b.html': '<p>B</p>' }),
    )
    expect(await atTime(frame(grant.handle, other.treeId, 1, 'b'))).toBe(
      'refused',
    )

    await exec(
      'delete from shares where node_id = ? and target = ?',
      root.id,
      reader.caller.person!.email,
    )
    expect(await atTime(frame(grant.handle, w.treeId, 1, 'plan'))).toBe(
      'not_found',
    )

    const own = await atTime(view(w.owner, w.treeId, 'plan'))
    const out = await w.ownerBrowser.postAuth('/_/auth/sign-out', {})
    expect(out.status).toBe(200)
    expect(await atTime(frame(own.handle, w.treeId, 1, 'plan'))).toBe('refused')
  })

  it('refuses agent keys and asks visitors to sign in', async () => {
    const w = await world()
    const byKey = await failureAs(
      w.key,
      Effect.flatMap(Pages, (pages) =>
        pages.view({ treeId: w.treeId, path: 'plan' }),
      ),
    )
    expect(byKey.code).toBe('not_found')
    const byVisitor = await failureAs(
      visitorCaller(),
      Effect.flatMap(Pages, (pages) =>
        pages.view({ treeId: w.treeId, path: 'plan' }),
      ),
    )
    expect(byVisitor.code).toBe('sign_in_required')
    // A folder without index.html has no frame: the link shows its listing.
    const listing = await failureAs(
      w.owner,
      Effect.flatMap(Pages, (pages) =>
        pages.view({ treeId: w.treeId, path: 'mockups/' }),
      ),
    )
    expect(listing.code).toBe('not_found')
  })
})

describe('Seen by', () => {
  it('records an open at most once an hour per person and page, for write holders to see', async () => {
    const w = await world()
    const { caller: reader } = await someone()
    const root = (await nodeAt(w.treeId, ''))!
    await share(
      w.treeId,
      root.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    const plan = (await nodeAt(w.treeId, 'plan.html'))!
    const seenAt = async () =>
      (
        await rows<{ last_seen_at: number }>(
          'select last_seen_at from seen_by where node_id = ? and user_id = ?',
          plan.id,
          reader.person!.id,
        )
      ).map((row) => row.last_seen_at)
    const start = Date.now()
    const times: number[][] = []
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        yield* view(reader, w.treeId, 'plan')
        times.push(yield* Effect.promise(seenAt))
        yield* TestClock.adjust(30 * 60 * 1000)
        yield* view(reader, w.treeId, 'plan')
        times.push(yield* Effect.promise(seenAt))
        yield* TestClock.adjust(31 * 60 * 1000)
        yield* view(reader, w.treeId, 'plan')
        times.push(yield* Effect.promise(seenAt))
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(times).toEqual([[start], [start], [start + 61 * 60 * 1000]])
    // A folder's listing and a file record nothing.
    await atTime(view(reader, w.treeId, 'brief.pdf'))
    expect(await count('seen_by', 'user_id = ?', reader.person!.id)).toBe(1)

    const seen = await runAs(
      w.owner,
      Effect.flatMap(Pages, (pages) => pages.seenBy(ref(w.at('plan')))),
    )
    expect(seen).toEqual([
      expect.objectContaining({ email: reader.person!.email }),
    ])
    const refused = await failureAs(
      reader,
      Effect.flatMap(Pages, (pages) => pages.seenBy(ref(w.at('plan')))),
    )
    expect(refused.code).toBe('forbidden')
  })
})
