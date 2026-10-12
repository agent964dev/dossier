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
    expect(
      await atTime(frame(grant.handle, w.treeId, grant.seq, 'notes', true)),
    ).toBe('not_found')
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
