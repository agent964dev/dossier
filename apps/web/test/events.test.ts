// The events route: only what the caller may read, a cursor that moves past
// the rest, pages, paths, and who acted by the Doc.by rule.
import type { OpId, Person, TreeId } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Data, TreeStore, type Caller } from '../src/core/index.ts'
import { exec } from './support/d1.ts'
import { pageWith, pushForms, seqOf, type FormTree } from './support/forms.ts'
import { harness, ORIGIN } from './support/harness.ts'
import { keySecretFor } from './support/keys.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  failureAs,
  join,
  nodeAt,
  person,
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
  i: { after: number | null; path?: string | null; tree?: string },
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

describe('the events route', () => {
  it('returns only events the caller may read, and moves next past the rest', async () => {
    const guest = await person('guest')
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, 'open'))!.id,
      'email',
      guest.email.toLowerCase(),
      'respond',
      owner,
    )
    const guestBrowser = await sessionFor(guest)
    const start = (await eventsAs(ownerBrowser, { after: null })).next
    await writeAs(ownerBrowser, 'private/notes.json', 'private/page.html')
    const own = `open/${guest.email.toLowerCase()}.json`
    await writeAs(guestBrowser, own, 'open/page.html')
    await writeAs(ownerBrowser, 'private/more.json', 'private/page.html')

    const all = await eventsAs(ownerBrowser, { after: start })
    expect(all.events.map((e) => e.path)).toEqual([
      'private/notes.json',
      own,
      'private/more.json',
    ])
    const seen = await eventsAs(guestBrowser, { after: start })
    expect(seen.events.map((e) => [e.type, e.path, e.by])).toEqual([
      ['data_write', own, guest.email],
    ])
    expect(seen.next).toBe(all.next)
    expect(seen.more).toBe(false)
    // The guest cannot follow a path it cannot read.
    expect(
      await failureAs(
        guestBrowser,
        Effect.flatMap(TreeStore, (store) =>
          store.events({ tree: tree.treeId, after: start, path: 'private/' }),
        ),
      ),
    ).toMatchObject({ code: 'not_found' })
  })

  it('filters by path: at, below or above it', async () => {
    const start = (await eventsAs(ownerBrowser, { after: null })).next
    await writeAs(ownerBrowser, 'open/a/x.json', 'open/page.html')
    await writeAs(ownerBrowser, 'private/y.json', 'private/page.html')
    const below = await eventsAs(ownerBrowser, {
      after: start,
      path: 'open/',
    })
    expect(below.events.map((e) => e.path)).toEqual(['open/a/x.json'])
    const exact = await eventsAs(ownerBrowser, {
      after: start,
      path: 'private/y.json',
    })
    expect(exact.events.map((e) => e.path)).toEqual(['private/y.json'])
  })

  it('pages with more after 500 scanned events', async () => {
    const paged = await pushForms(owner, ws, FILES)
    const { next } = await runAs(
      ownerBrowser,
      Effect.flatMap(TreeStore, (store) =>
        store.events({ tree: paged.treeId, after: null, path: null }),
      ),
    )
    // Events beyond the first page, written straight into the table.
    const values = Array.from(
      { length: 520 },
      (_, i) =>
        `('${paged.treeId}', ${next + i + 1}, 'data_write', null, 'open/n${i}.json', '${owner.id}', null, ${Date.now()})`,
    )
    await exec(
      `insert into events (tree_id, seq, type, node_id, path, actor_id, push_id, created_at)
       values ${values.join(', ')}`,
    )
    await exec(
      'update trees set event_seq = event_seq + 520 where id = ?',
      paged.treeId,
    )
    const page = (after: number) =>
      runAs(
        ownerBrowser,
        Effect.flatMap(TreeStore, (store) =>
          store.events({ tree: paged.treeId, after, path: null }),
        ),
      )
    const first = await page(next)
    expect(first.events).toHaveLength(500)
    expect(first.more).toBe(true)
    expect(first.next).toBe(next + 500)
    const second = await page(first.next)
    expect(second.events).toHaveLength(20)
    expect(second.more).toBe(false)
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
    const pushEvent = async (caller: Caller) =>
      (await eventsAs(caller, { after: 0 })).events.find(
        (e) => e.type === 'push',
      )
    expect(await pushEvent(await sessionFor(outsider))).toMatchObject({
      seq: 1,
      type: 'push',
      path: '',
      by: owner.name,
      push: 1,
    })
    expect((await pushEvent(await sessionFor(member)))?.by).toBe(owner.email)
    expect((await pushEvent(ownerBrowser))?.by).toBe(owner.email)
  })

  it('answers over HTTP by the tree name, and refuses a key that cannot read', async () => {
    const secret = await keySecretFor(owner)
    const url = `${ORIGIN}/_/api/events?tree=${encodeURIComponent(`${ws.name}/${tree.name}`)}`
    const first = await SELF.fetch(url, {
      headers: { authorization: `Bearer ${secret}` },
    })
    expect(first.status).toBe(200)
    const body = (await first.json()) as { next: number; events: unknown[] }
    expect(body.events).toEqual([])
    expect(body.next).toBeGreaterThan(0)
    const after = await SELF.fetch(`${url}&after=0&path=open%2F`, {
      headers: { authorization: `Bearer ${secret}` },
    })
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
