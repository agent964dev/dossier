// The events route: only what the caller may read, a cursor that moves past
// the rest, pages, paths, and who acted by the Doc.by rule.
import type { OpId, Person, TreeId } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Data, TreeStore, type Caller } from '../src/core/index.ts'
import { pageWith, pushForms, seqOf, type FormTree } from './support/forms.ts'
import { harness, ORIGIN } from './support/harness.ts'
import { keySecretFor } from './support/keys.ts'
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

const FILES = {
  'open/page.html': pageWith('<p>Open</p>', 'Open'),
  'private/page.html': pageWith('<p>Private</p>', 'Private'),
}

let owner: Person
let ws: { id: string; name: string }
let tree: FormTree
let ownerBrowser: Caller

beforeAll(async () => {
  owner = await person('owner')
  ws = await workspace(owner)
  ownerBrowser = await sessionFor(owner)
  tree = await pushForms(owner, ws, FILES)
})

const writeAs = async (caller: Caller, path: string, page: string) => {
  const seq = await seqOf(tree)
  return runAs(
    caller,
    Effect.flatMap(Data, (data) =>
      data.write({
        tree: tree.treeId as TreeId,
        page,
        path,
        patch: { at: Date.now() },
        replace: false,
        opId: crypto.randomUUID() as OpId,
        seq,
      }),
    ),
  )
}

const eventsAs = (
  caller: Caller,
  i: { after: string | null; path?: string | null; tree?: string },
) =>
  runAs(
    caller,
    Effect.flatMap(TreeStore, (store) =>
      store.events({
        tree: i.tree ?? tree.treeId,
        after: i.after,
        path: i.path ?? null,
      }),
    ),
  )

/** The guest's cursor now, then everything they may read after it. */
const since = async (caller: Caller, run: () => Promise<unknown>) => {
  const start = (await eventsAs(caller, { after: null })).next
  await run()
  return eventsAs(caller, { after: start })
}

const guestOn = async (path: string, role: 'read' | 'respond' = 'read') => {
  const guest = await person('guest')
  await share(
    tree.treeId,
    (await nodeAt(tree.treeId, path))!.id,
    'email',
    guest.email.toLowerCase(),
    role,
    owner,
  )
  return { guest, caller: await sessionFor(guest) }
}

describe('the events route', () => {
  it('returns only events the caller may read, and its cursor moves past the rest', async () => {
    const { guest, caller: guestBrowser } = await guestOn('open', 'respond')
    const own = `open/${guest.email.toLowerCase()}.json`
    const start = (await eventsAs(guestBrowser, { after: null })).next
    const ownerStart = (await eventsAs(ownerBrowser, { after: null })).next
    await writeAs(ownerBrowser, 'private/notes.json', 'private/page.html')
    await writeAs(guestBrowser, own, 'open/page.html')
    await writeAs(ownerBrowser, 'private/more.json', 'private/page.html')
    const all = await eventsAs(ownerBrowser, { after: ownerStart })
    expect(all.events.map((e) => e.path)).toEqual([
      'private/notes.json',
      own,
      'private/more.json',
    ])
    const seen = await eventsAs(guestBrowser, { after: start })
    expect(seen.events.map((e) => [e.type, e.path, e.by])).toEqual([
      ['data_write', own, guest.email],
    ])
    expect(seen.more).toBe(false)
    // From its cursor, nothing is left to see.
    expect((await eventsAs(guestBrowser, { after: seen.next })).events).toEqual(
      [],
    )
    expect(
      await failureAs(
        guestBrowser,
        Effect.flatMap(TreeStore, (store) =>
          store.events({ tree: tree.treeId, after: start, path: 'private/' }),
        ),
      ),
    ).toMatchObject({ code: 'not_found' })
  })

  it('shows a reader restricted to a folder a push above it that changed something they read, and no other', async () => {
    const { caller } = await guestOn('open')
    const key = await agent(owner)
    const quiet = await since(caller, async () => {
      await pushAll(
        key,
        `${ws.name}/${tree.name}`,
        { ...FILES, 'private/page.html': pageWith('<p>Two</p>', 'P') },
        { force: true },
      )
    })
    expect(quiet.events).toEqual([])
    const changed = await since(caller, async () => {
      await pushAll(
        key,
        `${ws.name}/${tree.name}`,
        { ...FILES, 'open/page.html': pageWith('<p>Two</p>', 'Open') },
        { force: true },
      )
    })
    expect(changed.events.map((e) => [e.type, e.path])).toEqual([['push', '']])
    // A path filter below the push meets it through what it changed.
    const start = (await eventsAs(caller, { after: null })).next
    await pushAll(
      key,
      `${ws.name}/${tree.name}`,
      { ...FILES, 'open/page.html': pageWith('<p>Three</p>', 'Open') },
      { force: true },
    )
    expect(
      (await eventsAs(caller, { after: start, path: 'open/page.html' })).events
        .length,
    ).toBe(1)
  })

  it('binds a cursor to its tree and its caller, and refuses any made up', async () => {
    const { caller } = await guestOn('open')
    const a = (await eventsAs(caller, { after: null })).next
    await writeAs(ownerBrowser, 'private/hidden.json', 'private/page.html')
    // The withheld write leaves nothing to see, and no `more`.
    expect(await eventsAs(caller, { after: a })).toMatchObject({
      events: [],
      more: false,
    })
    const other = await pushForms(owner, ws, FILES)
    const refused = (who: Caller, treeId: string, after: string) =>
      failureAs(
        who,
        Effect.flatMap(TreeStore, (store) =>
          store.events({ tree: treeId, after, path: null }),
        ),
      )
    const flipped = `${a.slice(0, 40)}${a[40] === 'A' ? 'B' : 'A'}${a.slice(41)}`
    for (const bad of ['5', 'not-a-cursor', flipped, a.slice(0, -4)]) {
      expect(await refused(caller, tree.treeId, bad), bad).toMatchObject({
        code: 'invalid',
      })
    }
    // Another tree's, or another person's, is not this caller's cursor here.
    expect(await refused(ownerBrowser, other.treeId, a)).toMatchObject({
      code: 'invalid',
    })
    expect(await refused(ownerBrowser, tree.treeId, a)).toMatchObject({
      code: 'invalid',
    })
  })

  it('says more only when a visible event follows, never for a withheld one', async () => {
    const paged = await pushForms(owner, ws, FILES)
    const guest = await person('looker')
    await share(
      paged.treeId,
      (await nodeAt(paged.treeId, 'open'))!.id,
      'email',
      guest.email.toLowerCase(),
      'read',
      owner,
    )
    const guestCaller = await sessionFor(guest)
    const read = (after: string | null) =>
      runAs(
        guestCaller,
        Effect.flatMap(TreeStore, (store) =>
          store.events({ tree: paged.treeId, after, path: null }),
        ),
      )
    const burst = (path: string, n: number) =>
      runAs(
        ownerBrowser,
        Effect.flatMap(TreeStore, (store) =>
          store.change(paged.treeId, (cs) =>
            Effect.sync(() => {
              for (let i = 0; i < n; i += 1) cs.event({ type: 'share', path })
              return {}
            }),
          ),
        ),
      )
    const start = (await read(null)).next
    await burst('open/page.html', 500)
    await burst('private/page.html', 1)
    const exactly = await read(start)
    expect(exactly.events).toHaveLength(500)
    expect(exactly.more).toBe(false)
    await burst('open/page.html', 1)
    const first = await read(start)
    expect(first.events).toHaveLength(500)
    expect(first.more).toBe(true)
    const second = await read(first.next)
    expect(second.events).toHaveLength(1)
    expect(second.more).toBe(false)
  })

  it('filters by path: at, below or above it', async () => {
    const result = await since(ownerBrowser, async () => {
      await writeAs(ownerBrowser, 'open/a/x.json', 'open/page.html')
      await writeAs(ownerBrowser, 'private/y.json', 'private/page.html')
    })
    expect(result.events.map((e) => e.path)).toEqual([
      'open/a/x.json',
      'private/y.json',
    ])
    const start = (await eventsAs(ownerBrowser, { after: null })).next
    await writeAs(ownerBrowser, 'open/a/z.json', 'open/page.html')
    await writeAs(ownerBrowser, 'private/w.json', 'private/page.html')
    expect(
      (
        await eventsAs(ownerBrowser, { after: start, path: 'open/' })
      ).events.map((e) => e.path),
    ).toEqual(['open/a/z.json'])
  })

  it('pages real events with more, and skips a long run of withheld ones without saying so', async () => {
    const paged = await pushForms(owner, ws, FILES)
    const guest = await person('pager')
    await share(
      paged.treeId,
      (await nodeAt(paged.treeId, 'open'))!.id,
      'email',
      guest.email.toLowerCase(),
      'read',
      owner,
    )
    const guestCaller = await sessionFor(guest)
    const read = (caller: Caller, after: string | null) =>
      runAs(
        caller,
        Effect.flatMap(TreeStore, (store) =>
          store.events({ tree: paged.treeId, after, path: null }),
        ),
      )
    const ownerStart = (await read(ownerBrowser, null)).next
    const guestStart = (await read(guestCaller, null)).next
    // Real events through one change each: 520 on private/, then 3 on open/.
    const burst = (path: string, n: number) =>
      runAs(
        ownerBrowser,
        Effect.flatMap(TreeStore, (store) =>
          store.change(paged.treeId, (cs) =>
            Effect.sync(() => {
              for (let i = 0; i < n; i += 1) cs.event({ type: 'share', path })
              return {}
            }),
          ),
        ),
      )
    await burst('private/page.html', 520)
    await burst('open/page.html', 3)
    const first = await read(ownerBrowser, ownerStart)
    expect(first.events).toHaveLength(500)
    expect(first.more).toBe(true)
    const second = await read(ownerBrowser, first.next)
    expect(second.events).toHaveLength(23)
    expect(second.more).toBe(false)
    const guestSees = await read(guestCaller, guestStart)
    expect(guestSees.events.map((e) => e.path)).toEqual([
      'open/page.html',
      'open/page.html',
      'open/page.html',
    ])
    expect(guestSees.more).toBe(false)
  })

  it('names an authored event pusher by email to members and by name to anyone else', async () => {
    const outsider = await person('outsider')
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, ''))!.id,
      'email',
      outsider.email.toLowerCase(),
      'read',
      owner,
    )
    const member = await person('member')
    await join(ws, member)
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, ''))!.id,
      'workspace',
      ws.id,
      'read',
      owner,
    )
    const callers = {
      outsider: await sessionFor(outsider),
      member: await sessionFor(member),
      owner: ownerBrowser,
    }
    const starts = {
      outsider: (await eventsAs(callers.outsider, { after: null })).next,
      member: (await eventsAs(callers.member, { after: null })).next,
      owner: (await eventsAs(callers.owner, { after: null })).next,
    }
    await pushAll(
      await agent(owner),
      `${ws.name}/${tree.name}`,
      { ...FILES, 'open/page.html': pageWith('<p>By name</p>', 'Open') },
      { force: true },
    )
    const pushEvent = async (who: keyof typeof callers) =>
      (await eventsAs(callers[who], { after: starts[who] })).events.find(
        (e) => e.type === 'push',
      )
    expect(await pushEvent('outsider')).toMatchObject({
      type: 'push',
      path: '',
      by: owner.name,
    })
    expect((await pushEvent('member'))?.by).toBe(owner.email)
    expect((await pushEvent('owner'))?.by).toBe(owner.email)
  })

  it('answers over HTTP by the tree name, and refuses a key that cannot read', async () => {
    const secret = await keySecretFor(owner)
    const url = `${ORIGIN}/_/api/events?tree=${encodeURIComponent(`${ws.name}/${tree.name}`)}`
    const first = await SELF.fetch(url, {
      headers: { authorization: `Bearer ${secret}` },
    })
    expect(first.status).toBe(200)
    const body = (await first.json()) as { next: string; events: unknown[] }
    expect(body.events).toEqual([])
    expect(typeof body.next).toBe('string')
    const after = await SELF.fetch(
      `${url}&after=${encodeURIComponent(body.next)}&path=open%2F`,
      { headers: { authorization: `Bearer ${secret}` } },
    )
    expect(after.status).toBe(200)
    const stranger = await keySecretFor(await person('stranger'))
    const refused = await SELF.fetch(`${url}&path=nope%2F`, {
      headers: { authorization: `Bearer ${stranger}` },
    })
    expect(refused.status).toBe(404)
    expect(await refused.json()).toMatchObject({ error: { code: 'not_found' } })
    const unknown = await SELF.fetch(url, {
      headers: { authorization: 'Bearer dsk_unknown' },
    })
    expect(unknown.status).toBe(401)
  })
})
