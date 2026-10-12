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
import { env } from 'cloudflare:workers'

import { beforeBatch, beforeRead, count, exec, rows } from './support/d1.ts'
import { harness, testRuntime } from './support/harness.ts'
import { callerOf, fresh, run, runAs } from './support/people.ts'
import {
  agent,
  failureAs,
  join,
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
        wantsAgent: false,
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
    // The same denial, whole, for a path before and after it exists
    // privately: nothing in it names what the link resolved to.
    const before = await openFailure(outsider, w.at('salaries'))
    await w.repush({ 'salaries.html': '<p>Private</p>' })
    const after = await openFailure(outsider, w.at('salaries'))
    expect(after).toEqual(before)
    expect(after.path).toBe('salaries')
    const hidden = await openFailure(outsider, w.at('plan'))
    expect(hidden).toEqual(
      expect.objectContaining({
        code: before.code,
        message: before.message,
        fix: before.fix,
        path: 'plan',
      }),
    )
    const visitorBefore = await openFailure(visitorCaller(), w.at('budget'))
    await w.repush({ 'budget.html': '<p>Private</p>' })
    const visitorAfter = await openFailure(visitorCaller(), w.at('budget'))
    expect(visitorBefore.code).toBe('sign_in_required')
    expect(visitorAfter).toEqual(visitorBefore)
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
    // Never issued at the newer sequence, but that is the page as it is
    // now, so nothing is recovered by opening it there.
    expect(
      htmlOf(await atTime(frame(first.handle, w.treeId, 2, 'plan'))),
    ).toContain('Plan two')
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

  it('expires 24 hours after the last renewal, is renewed by view, and a new generation drops what the old one was issued', async () => {
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
        'view_handle_nodes',
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

  it('drops what the old generation was issued, so a reader cannot reopen it', async () => {
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
    expect(seen).toEqual({
      people: [expect.objectContaining({ email: reader.person!.email })],
      views: null,
    })
    const refused = await failureAs(
      reader,
      Effect.flatMap(Pages, (pages) => pages.seenBy(ref(w.at('plan')))),
    )
    expect(refused.code).toBe('forbidden')
  })
})

describe('what a handle may recover', () => {
  it('never lets a renewal that read the old generation undo a newer one', async () => {
    const w = await world()
    const start = Date.now()
    const first = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        return yield* view(w.owner, w.treeId, 'plan')
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    const atTimeOf = <A, E>(at: number, effect: Effect.Effect<A, E, Pages>) =>
      run(
        Effect.gen(function* () {
          yield* TestClock.setTime(at)
          return yield* effect
        }).pipe(Effect.provide(TestContext.TestContext)),
      )
    let newer: { handle: string } | null = null
    // A renewal reads the row just before it lapses; another view replaces
    // the lapsed generation before the first renewal's batch runs.
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (query) => /view_handles/.test(query) && !/^\s*select/i.test(query),
            async () => {
              newer = await atTimeOf(
                start + 24 * HOUR + 1,
                view(w.owner, w.treeId, 'plan'),
              )
            },
          ),
        },
      }),
    )
    const late = await atTimeOf(
      start + 24 * HOUR - 1,
      view(w.owner, w.treeId, 'plan'),
    )
    harness.reset()
    expect(newer).not.toBeNull()
    expect(newer!.handle).not.toBe(first.handle)
    const later = start + 24 * HOUR + 2
    // The newer generation stands; the lapsed one stays gone.
    expect(
      htmlOf(await atTimeOf(later, frame(newer!.handle, w.treeId, 1, 'plan'))),
    ).toContain('Plan one')
    expect(
      await atTimeOf(later, frame(first.handle, w.treeId, 1, 'plan')),
    ).toBe('refused')
    // The late renewal answers with the handle that stands.
    expect(late.handle).toBe(newer!.handle)
  })

  it("never serves another page's content from before it was shared", async () => {
    const w = await world()
    const secret = '<title>Notes</title><p>Unredacted salaries</p>'
    await w.repush({ 'notes/index.html': secret })
    const { caller: reader } = await someone()
    const plan = (await nodeAt(w.treeId, 'plan.html'))!
    await share(
      w.treeId,
      plan.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    const grant = await atTime(view(reader, w.treeId, 'plan'))
    const issued = grant.seq
    // The notes are redacted in a new push, then shared.
    await w.repush({
      'notes/index.html': '<title>Notes</title><p>Redacted</p>',
    })
    const notes = (await nodeAt(w.treeId, 'notes'))!
    await share(
      w.treeId,
      notes.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )

    expect(
      await atTime(frame(grant.handle, w.treeId, issued, 'notes', true)),
    ).toBe('not_found')
    // The page issued at that sequence still opens there.
    expect(
      htmlOf(await atTime(frame(grant.handle, w.treeId, issued, 'plan'))),
    ).toContain('Plan one')
    // Content unchanged since then is no history: the redacted notes at the
    // current sequence open with the same handle.
    expect(
      htmlOf(
        await atTime(frame(grant.handle, w.treeId, issued + 1, 'notes', true)),
      ),
    ).toContain('Redacted')
  })

  it('issues with a page the files it loads, so an open tab keeps its push', async () => {
    const w = await world()
    await w.repush({
      'plan.html':
        '<!doctype html><title>Plan</title><img src="logo.svg" alt=""><a href="notes/">Notes</a>',
    })
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
    const grant = await atTime(view(reader, w.treeId, 'plan'))
    await w.repush({
      'plan.html':
        '<!doctype html><title>Plan</title><img src="logo.svg" alt=""><a href="notes/">Notes</a>',
      'logo.svg':
        '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',
      'notes/index.html': '<title>Notes</title><p>Rewritten</p>',
    })
    const logo = await atTime(
      frame(grant.handle, w.treeId, grant.seq, 'logo.svg'),
    )
    expect(logo).toMatchObject({ kind: 'file' })
    // A page it only links to is not issued: following the link is a view.
    const notes = (await nodeAt(w.treeId, 'notes/index.html'))!
    expect(await count('view_handle_nodes', 'node_id = ?', notes.id)).toBe(0)
    // It still opens at that sequence: the reader's share predates the view,
    // so they could read it while it was current.
    expect(
      htmlOf(
        await atTime(frame(grant.handle, w.treeId, grant.seq, 'notes', true)),
      ),
    ).toContain('<p>Notes</p>')
  })

  it('issues what a page loads as it was at the sequence the view captured', async () => {
    const w = await world()
    const unredacted =
      '<svg xmlns="http://www.w3.org/2000/svg"><text>salaries</text></svg>'
    const page = {
      'plan.html':
        '<!doctype html><title>Plan</title><img src="secret.svg" alt="">',
      'secret.svg': unredacted,
    }
    await w.repush(page)
    const { caller: reader } = await someone()
    const plan = (await nodeAt(w.treeId, 'plan.html'))!
    await share(
      w.treeId,
      plan.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    const captured = (await treeOf(w.ws.name, 'acme'))!.authored_seq
    // After the view has read the tree, and before it looks up what the
    // page loads, the file is redacted in a new push and shared.
    harness.use(
      testRuntime({
        env: {
          DB: beforeRead(
            env.DB,
            (query) => /from\s+analyses/.test(query),
            async () => {
              await w.repush({
                ...page,
                'secret.svg':
                  '<svg xmlns="http://www.w3.org/2000/svg"><text>redacted</text></svg>',
              })
              const secret = (await nodeAt(w.treeId, 'secret.svg'))!
              await share(
                w.treeId,
                secret.id,
                'email',
                reader.person!.email,
                'read',
                w.owner.person!,
              )
            },
          ),
        },
      }),
    )
    const grant = await atTime(view(reader, w.treeId, 'plan'))
    harness.reset()
    const old = await atTime(
      frame(grant.handle, w.treeId, captured, 'secret.svg'),
    )
    expect(old).toBe('not_found')
    // The view answers with the sequence it could issue whole.
    expect(grant.seq).toBe(captured + 1)
    expect(
      await atTime(frame(grant.handle, w.treeId, grant.seq, 'secret.svg')),
    ).toMatchObject({
      kind: 'file',
    })
  })

  it('issues files named with character references, in src and srcset', async () => {
    const w = await world()
    const html =
      '<!doctype html><title>Plan</title><img src="lo&#103;o.svg" alt=""><img srcset="bri&#101;f.pdf 1x" alt="">'
    await w.repush({ 'plan.html': html })
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
    const grant = await atTime(view(reader, w.treeId, 'plan'))
    await w.repush({
      'plan.html': html,
      'logo.svg':
        '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>',
      'brief.pdf': '%PDF-1.7 changed',
    })
    for (const path of ['logo.svg', 'brief.pdf']) {
      expect(
        await atTime(frame(grant.handle, w.treeId, grant.seq, path)),
        path,
      ).toMatchObject({
        kind: 'file',
      })
    }
  })

  it('issues a layout’s `_` files from the page’s folder, as the page loads them', async () => {
    const w = await world()
    const kit = {
      '_layout.html':
        '<!doctype html><html><head><link rel="stylesheet" href="_theme.css"><link rel="icon" href="guides/icon.svg"></head><body><slot></slot></body></html>',
      '_theme.css': ':root { --accent: teal; }',
      'guides/_theme.css': ':root { --accent: crimson; }',
      'guides/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'guides/page.html': '<title>Guide</title><p>Guide</p>',
    }
    await w.repush(kit)
    const { caller: reader } = await someone()
    const page = (await nodeAt(w.treeId, 'guides'))!
    await share(
      w.treeId,
      page.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    const grant = await atTime(view(reader, w.treeId, 'guides/page'))
    await w.repush({
      ...kit,
      'guides/_theme.css': ':root { --accent: gold; }',
      'guides/icon.svg':
        '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    })
    // The page asks for _theme.css beside itself: guides/_theme.css answers.
    const theme = await atTime(
      frame(grant.handle, w.treeId, grant.seq, 'guides/_theme.css'),
    )
    expect(theme).toMatchObject({ kind: 'file' })
    if (typeof theme === 'string' || theme.kind !== 'file') return
    // The guides theme as it was, not the root's.
    expect(await new Response(theme.body).text()).toContain('crimson')
    // The layout's own URL reads from the layout's folder.
    expect(
      await atTime(frame(grant.handle, w.treeId, grant.seq, 'guides/icon.svg')),
    ).toMatchObject({ kind: 'file' })
  })

  it('answers not_found at an old sequence when the closest `_` file may not be opened, never a farther one', async () => {
    const w = await world()
    const kit = {
      '_theme.css': ':root { --accent: teal; }',
      'guides/_theme.css': ':root { --accent: crimson; }',
      // No page loads a theme, so no view issues one.
      'guides/page.html': '<title>Guide</title><p>Guide</p>',
    }
    await w.repush(kit)
    const { caller: reader } = await someone()
    const plan = (await nodeAt(w.treeId, 'plan.html'))!
    await share(
      w.treeId,
      plan.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    const grant = await atTime(view(reader, w.treeId, 'plan'))
    // The guides come to the reader only after the view, so at the viewed
    // sequence their theme was never the reader's.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const guides = (await nodeAt(w.treeId, 'guides'))!
    await share(
      w.treeId,
      guides.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    await w.repush({ ...kit, 'guides/_theme.css': ':root { --accent: gold; }' })
    expect(
      await atTime(
        frame(grant.handle, w.treeId, grant.seq, 'guides/_theme.css'),
      ),
    ).toBe('not_found')
    // From a folder below, guides/_theme.css is still the closest.
    expect(
      await atTime(
        frame(grant.handle, w.treeId, grant.seq, 'guides/deeper/_theme.css'),
      ),
    ).toBe('not_found')
    // Asked where the root's is the closest, the unchanged root theme opens.
    expect(
      await atTime(frame(grant.handle, w.treeId, grant.seq, '_theme.css')),
    ).toMatchObject({ kind: 'file' })
  })

  it('issues each srcset candidate when a separator is written as a character reference', async () => {
    const w = await world()
    const html =
      '<!doctype html><title>Plan</title><img srcset="logo.svg&#44; brief.pdf 2x" alt="">'
    await w.repush({ 'plan.html': html })
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
    const grant = await atTime(view(reader, w.treeId, 'plan'))
    await w.repush({
      'plan.html': html,
      'logo.svg':
        '<svg xmlns="http://www.w3.org/2000/svg"><circle r="3"/></svg>',
      'brief.pdf': '%PDF-1.7 changed again',
    })
    for (const path of ['logo.svg', 'brief.pdf']) {
      expect(
        await atTime(frame(grant.handle, w.treeId, grant.seq, path)),
        path,
      ).toMatchObject({ kind: 'file' })
    }
  })

  it('opens a file an open tab imports later for a reader whose share predates the view, never for one shared after', async () => {
    const w = await world()
    const page = {
      'module.html':
        '<!doctype html><title>Module</title><script type="module">import("./lazy.js")</script>',
      'lazy.js': 'export const v = 1',
    }
    await w.repush(page)
    const root = (await nodeAt(w.treeId, ''))!
    const moduleNode = (await nodeAt(w.treeId, 'module.html'))!
    const { caller: early } = await someone()
    await share(
      w.treeId,
      root.id,
      'email',
      early.person!.email,
      'read',
      w.owner.person!,
    )
    const { caller: late } = await someone()
    await share(
      w.treeId,
      moduleNode.id,
      'email',
      late.person!.email,
      'read',
      w.owner.person!,
    )
    const a = await atTime(view(early, w.treeId, 'module'))
    const b = await atTime(view(late, w.treeId, 'module'))
    expect(b.seq).toBe(a.seq)
    // The import is in script text, so no view issues it.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await share(
      w.treeId,
      root.id,
      'email',
      late.person!.email,
      'read',
      w.owner.person!,
    )
    await w.repush({ ...page, 'lazy.js': 'export const v = 2' })

    const kept = await atTime(frame(a.handle, w.treeId, a.seq, 'lazy.js'))
    expect(kept).toMatchObject({ kind: 'file' })
    expect(await atTime(frame(b.handle, w.treeId, b.seq, 'lazy.js'))).toBe(
      'not_found',
    )
  })

  it('never counts a grant committed after a later push, whatever time it carries', async () => {
    const w = await world()
    const page = {
      'module.html':
        '<!doctype html><title>Module</title><script type="module">import("./lazy.js")</script>',
      'lazy.js': 'export const v = 1',
    }
    await w.repush(page)
    const root = (await nodeAt(w.treeId, ''))!
    const moduleNode = (await nodeAt(w.treeId, 'module.html'))!
    const { caller: reader } = await someone()
    await share(
      w.treeId,
      moduleNode.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    const startedAt = Date.now()
    const grant = await atTime(view(reader, w.treeId, 'module'))
    await w.repush({ ...page, 'lazy.js': 'export const v = 2' })
    // A share whose request began before the view commits only now, with
    // the time it took at its start.
    await exec(
      `insert into shares (id, tree_id, node_id, target_kind, target, role, created_by, created_at)
       values (?, ?, ?, 'email', ?, 'read', ?, ?)`,
      crypto.randomUUID(),
      w.treeId,
      root.id,
      reader.person!.email,
      w.owner.person!.id,
      startedAt - 1000,
    )
    expect(
      await atTime(frame(grant.handle, w.treeId, grant.seq, 'lazy.js')),
    ).toBe('not_found')
  })

  it('keeps the first issuance of a sequence when a slower view of it commits later', async () => {
    const w = await world()
    const page = {
      'module.html':
        '<!doctype html><title>Module</title><script type="module">import("./lazy.js")</script>',
      'lazy.js': 'export const v = 1',
    }
    await w.repush(page)
    const root = (await nodeAt(w.treeId, ''))!
    const moduleNode = (await nodeAt(w.treeId, 'module.html'))!
    const plan = (await nodeAt(w.treeId, 'plan.html'))!
    const { caller: reader } = await someone()
    await share(
      w.treeId,
      plan.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    await share(
      w.treeId,
      moduleNode.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    const slowAt = Date.now()
    let fast: { handle: string; seq: number } | null = null
    // A slow view reads the clock and pauses; meanwhile the reader is given
    // the tree and a faster view in another tab, of another page, issues the same
    // sequence first.
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (query) => /insert into view_handle_nodes/.test(query),
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 5))
              await share(
                w.treeId,
                root.id,
                'email',
                reader.person!.email,
                'read',
                w.owner.person!,
              )
              await new Promise((resolve) => setTimeout(resolve, 5))
              fast = await run(
                Effect.gen(function* () {
                  yield* TestClock.setTime(Date.now())
                  return yield* view(reader, w.treeId, 'plan')
                }).pipe(Effect.provide(TestContext.TestContext)),
              )
            },
          ),
        },
      }),
    )
    const slow = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(slowAt)
        return yield* view(reader, w.treeId, 'module')
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    harness.reset()
    expect(fast).not.toBeNull()
    expect(slow.handle).toBe(fast!.handle)
    await w.repush({ ...page, 'lazy.js': 'export const v = 2' })
    // The tree share existed when the sequence was first issued.
    expect(
      await atTime(frame(slow.handle, w.treeId, slow.seq, 'lazy.js')),
    ).toMatchObject({ kind: 'file' })
  })

  it('counts a share whose role changed after the view, and a membership joined after it, as new', async () => {
    const w = await world()
    const page = {
      'module.html':
        '<!doctype html><title>Module</title><script type="module">import("./lazy.js")</script>',
      'lazy.js': 'export const v = 1',
    }
    await w.repush(page)
    const root = (await nodeAt(w.treeId, ''))!
    const moduleNode = (await nodeAt(w.treeId, 'module.html'))!
    // One reader's tree share changes role in place after the view.
    const { caller: changed } = await someone()
    await share(
      w.treeId,
      root.id,
      'email',
      changed.person!.email,
      'respond',
      w.owner.person!,
    )
    // Another reaches the tree through a workspace share, but joins the
    // workspace only after the view.
    const { caller: joiner } = await someone()
    await share(
      w.treeId,
      moduleNode.id,
      'email',
      joiner.person!.email,
      'read',
      w.owner.person!,
    )
    await share(
      w.treeId,
      root.id,
      'workspace',
      w.ws.id,
      'read',
      w.owner.person!,
    )
    const a = await atTime(view(changed, w.treeId, 'module'))
    const b = await atTime(view(joiner, w.treeId, 'module'))
    await exec(
      `update shares set role = 'read' where node_id = ? and target = ?`,
      root.id,
      changed.person!.email,
    )
    await join(w.ws, joiner.person!)
    await w.repush({ ...page, 'lazy.js': 'export const v = 2' })
    expect(await atTime(frame(a.handle, w.treeId, a.seq, 'lazy.js'))).toBe(
      'not_found',
    )
    expect(await atTime(frame(b.handle, w.treeId, b.seq, 'lazy.js'))).toBe(
      'not_found',
    )
  })

  it('counts a share revoked and made again after the view as new', async () => {
    const w = await world()
    const page = {
      'module.html':
        '<!doctype html><title>Module</title><script type="module">import("./lazy.js")</script>',
      'lazy.js': 'export const v = 1',
    }
    await w.repush(page)
    const root = (await nodeAt(w.treeId, ''))!
    const { caller: reader } = await someone()
    await share(
      w.treeId,
      root.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    const grant = await atTime(view(reader, w.treeId, 'module'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await exec(
      'delete from shares where node_id = ? and target = ?',
      root.id,
      reader.person!.email,
    )
    await share(
      w.treeId,
      root.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    await w.repush({ ...page, 'lazy.js': 'export const v = 2' })
    expect(
      await atTime(frame(grant.handle, w.treeId, grant.seq, 'lazy.js')),
    ).toBe('not_found')
  })

  it('answers an old redirect only when its target may be opened at that sequence', async () => {
    const w = await world()
    const { caller: reader } = await someone()
    const root = (await nodeAt(w.treeId, ''))!
    await w.repush({ 'obsolete.html': '<p>Old plan</p>' })
    // The page goes in the next push, and the reader is given the tree.
    committed(await pushAll(w.key, `${w.ws.name}/acme`, FILES, { force: true }))
    await share(
      w.treeId,
      root.id,
      'email',
      reader.person!.email,
      'read',
      w.owner.person!,
    )
    const grant = await atTime(view(reader, w.treeId, 'plan'))
    expect(grant.seq).toBe(3)
    const old = await atTime(frame(grant.handle, w.treeId, 2, 'obsolete.html'))
    const missing = await atTime(frame(grant.handle, w.treeId, 2, 'never.html'))
    expect(missing).toBe('not_found')
    expect(old).toBe(missing)
  })
})

describe('denials', () => {
  it('say nothing of the private path a view would have opened', async () => {
    const w = await world()
    const { caller: outsider } = await someone()
    const ask = () =>
      failureAs(
        outsider,
        Effect.flatMap(Pages, (pages) =>
          pages.view({ treeId: w.treeId, path: 'salary' }),
        ),
      )
    const before = await ask()
    await w.repush({ 'salary.html': '<p>Private</p>' })
    const after = await ask()
    expect(after).toEqual(before)
    expect(after.path).toBe('salary')
    const opened = await openFailure(outsider, w.at('salary'))
    expect(opened.path).toBe('salary')
  })
})
