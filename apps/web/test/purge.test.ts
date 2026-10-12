// The purge: what it removes past the retention period, what it keeps, and
// how runs share the work. Times move with TestClock; every deletion is made
// the real way (a push that drops a file, a withdrawal, a deleted
// workspace).
import type {
  AuthoredSeq,
  OpId,
  Person,
  PushId,
  Sha256,
  TreeId,
} from '@dossier/contracts'
import { MARKDOWN_VERSION } from '@dossier/html'
import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  Data,
  Files,
  People,
  Purge,
  Push,
  Settings,
  TreeStore,
  type Caller,
} from '../src/core/index.ts'
import { WEEKLY_PURGE } from '../src/jobs/scheduled.ts'
import {
  beforeBatch,
  count,
  exec,
  failingStatements,
  rows,
} from './support/d1.ts'
import {
  formRef,
  pageWith,
  pushForms,
  QUESTIONS,
  sendAs,
  uploadAs,
  withdrawAs,
} from './support/forms.ts'
import { harness, testRuntime } from './support/harness.ts'
import { run, runAs, sessionFor } from './support/people.ts'
import {
  anyNodeAt,
  at,
  beforeDelete,
  blobRow,
  DAY,
  failureAt,
  HOUR,
  lastRunRow,
  MINUTE,
  purgeAt,
  purgeFailureAt,
  pushAt,
  putBlobOf,
  stageAt,
  stored,
  uploadAt,
} from './support/purge.ts'
import {
  agent,
  failureAs,
  join,
  nodeAt,
  person,
  ref,
  sha256Of,
  share,
  superAdmin,
  team,
  workspace,
} from './support/trees.ts'
import worker from './support/worker.ts'

afterEach(() => harness.reset())

let owner: Person
let ws: { id: string; name: string }

beforeAll(async () => {
  owner = await person('owner')
  ws = await workspace(owner)
})

/** A tree name and text no other test uses. */
const fresh = () => {
  const tag = crypto.randomUUID().slice(0, 8)
  return { tag, name: `p${tag}` }
}

const versionsOf = (nodeId: string) =>
  count('node_versions', 'node_id = ?', nodeId)

const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10)

describe('what a purge removes', () => {
  it('removes only nodes deleted before the cutoff, with their versions, views, mentions and aliases, and keeps a live file’s every version', async () => {
    const { tag, name } = fresh()
    const T0 = Date.now()
    const pusher = await agent(owner)
    const browser = await sessionFor(owner)
    const reader = await person('reader')
    const target = `${ws.name}/${name}`
    const page = (title: string) =>
      pageWith(
        `<p>${title} ${tag}</p><dossier-comments></dossier-comments>`,
        title,
      )
    const first = await pushAt(T0, pusher, target, {
      'live.html': page('Live one'),
      'gone.html': page('Gone'),
      'later.html': page('Later'),
    })
    const treeId = first.treeId
    await share(
      treeId,
      (await nodeAt(treeId, ''))!.id,
      'email',
      reader.email.toLowerCase(),
      'read',
      owner,
    )
    // A comment on each page that will go, naming a reader.
    for (const p of ['gone', 'later']) {
      await at(
        T0 + MINUTE,
        browser,
        Effect.flatMap(Data, (data) =>
          data.write({
            tree: treeId as TreeId,
            page: `${p}.html`,
            path: `${p}.comments/`,
            patch: {
              text: `@${reader.email} look`,
              anchor: null,
              label: null,
              pin: null,
              replyTo: null,
              stance: null,
              mentions: [reader.email],
            },
            replace: false,
            opId: crypto.randomUUID() as OpId,
            seq: 1 as AuthoredSeq,
          }),
        ),
      )
    }
    const ids = {
      live: (await nodeAt(treeId, 'live.html'))!.id,
      gone: (await nodeAt(treeId, 'gone.html'))!.id,
      later: (await nodeAt(treeId, 'later.html'))!.id,
    }
    expect(await count('mentions', 'tree_id = ?', treeId)).toBe(2)
    // The live page changes; gone.html is dropped now, later.html in 20 days.
    await pushAt(
      T0 + 2 * MINUTE,
      pusher,
      target,
      { 'live.html': page('Live two'), 'later.html': page('Later') },
      { force: true },
    )
    await pushAt(
      T0 + 20 * DAY,
      pusher,
      target,
      { 'live.html': page('Live two') + ' ' },
      { force: true },
    )
    const goneSha = await sha256Of(page('Gone'))
    // Recent views, Seen by and old paths of each page, so only the node's
    // own purge removes them, never their age.
    const purgedAt = T0 + 31 * DAY
    for (const id of Object.values(ids)) {
      await exec(
        'insert into page_views (node_id, day, count) values (?, ?, 3)',
        id,
        dayOf(purgedAt),
      )
      await exec(
        'insert into seen_by (node_id, user_id, last_seen_at) values (?, ?, ?)',
        id,
        reader.id,
        purgedAt,
      )
      await exec(
        `insert into path_aliases (tree_id, old_path, node_id, moved_at_seq, created_at)
         values (?, ?, ?, 1, ?)`,
        treeId,
        `old-${id}.html`,
        id,
        T0,
      )
    }
    const events = await count('events', 'tree_id = ?', treeId)

    const outcome = await purgeAt(purgedAt)
    expect(outcome).toMatchObject({ trigger: 'weekly', remaining: false })
    expect(outcome.nodes).toBeGreaterThanOrEqual(1)
    expect(await count('nodes', 'id = ?', ids.gone)).toBe(0)
    expect(await versionsOf(ids.gone)).toBe(0)
    for (const table of ['page_views', 'seen_by', 'path_aliases']) {
      expect(await count(table, 'node_id = ?', ids.gone)).toBe(0)
      expect(await count(table, 'node_id = ?', ids.later)).toBe(1)
      expect(await count(table, 'node_id = ?', ids.live)).toBe(1)
    }
    expect(await count('mentions', 'page_node_id = ?', ids.gone)).toBe(0)
    expect(await count('mentions', 'page_node_id = ?', ids.later)).toBe(1)
    // The comment itself is someone's data and stays.
    expect(await nodeAt(treeId, 'gone.comments')).toBeDefined()
    // A deleted file within the retention period keeps its history.
    expect(await versionsOf(ids.later)).toBe(2)
    // A live file keeps every version.
    expect(await versionsOf(ids.live)).toBe(3)
    // The history keeps its sequence.
    expect(await count('events', 'tree_id = ?', treeId)).toBe(events)
    // gone.html's bytes were referenced by nothing else.
    expect(await blobRow(goneSha)).toBeNull()
    expect(await stored(`blobs/${goneSha}`)).toBe(false)

    // Twenty days on, later.html's deletion passes the cutoff too.
    await purgeAt(T0 + 51 * DAY)
    expect(await count('nodes', 'id = ?', ids.later)).toBe(0)
    expect(await count('mentions', 'tree_id = ?', treeId)).toBe(0)
    expect(await count('page_views', 'node_id = ?', ids.later)).toBe(0)
    expect(await versionsOf(ids.live)).toBe(3)
  })

  it('expires staged pushes past a day and lets go of their holds', async () => {
    const { tag, name } = fresh()
    const T0 = Date.now()
    const pusher = await agent(owner)
    const target = `${ws.name}/${name}`
    const kept = `kept ${tag}`
    const fresher = `new ${tag}`
    await pushAt(T0, pusher, target, { 'a.txt': kept })
    const files = { 'a.txt': kept, 'b.txt': fresher }
    const staged = await stageAt(T0 + MINUTE, pusher, target, files, {
      force: true,
    })
    const pushId = staged.pushId!
    await uploadAt(T0 + MINUTE, pusher, pushId, files, staged.missing)
    const holds = () =>
      count('blob_holds', "holder_kind = 'push' and holder_id = ?", pushId)
    expect(await holds()).toBe(2)

    await purgeAt(T0 + 23 * HOUR)
    expect(await holds()).toBe(2)
    expect(
      (
        await rows<{ state: string }>(
          'select state from pushes where id = ?',
          pushId,
        )
      )[0]?.state,
    ).toBe('staged')

    const outcome = await purgeAt(T0 + MINUTE + 25 * HOUR)
    expect(outcome.expiredPushes).toBeGreaterThanOrEqual(1)
    expect(
      (
        await rows<{ state: string }>(
          'select state from pushes where id = ?',
          pushId,
        )
      )[0]?.state,
    ).toBe('expired')
    expect(await holds()).toBe(0)
    expect(await count('push_files', 'push_id = ?', pushId)).toBe(0)
    expect(await count('push_folders', 'push_id = ?', pushId)).toBe(0)
    // The bytes only that push held go; the tree's own stay.
    expect(await blobRow(await sha256Of(fresher))).toBeNull()
    expect(await stored(`blobs/${await sha256Of(fresher)}`)).toBe(false)
    expect(await blobRow(await sha256Of(kept))).toMatchObject({
      ref_count: 1,
      state: 'live',
    })
    // The push can no longer commit.
    expect(
      await failureAt(
        T0 + 26 * HOUR,
        pusher,
        Effect.flatMap(Push, (push) => push.commit(pushId as PushId)),
      ),
    ).toMatchObject({ code: 'not_found' })
  })

  it('keeps a blob two trees share until neither references it, then removes its bytes and its Markdown of every version, and leaves fonts, looks and the base layer alone', async () => {
    const { tag, name } = fresh()
    const T0 = Date.now()
    const pusher = await agent(owner)
    const shared = pageWith(`<p>Shared ${tag}</p>`, 'Shared')
    const sha = await sha256Of(shared)
    const one = `${ws.name}/${name}`
    const two = `${ws.name}/${name}-2`
    await pushAt(T0, pusher, one, {
      'plan.html': shared,
      'keep.txt': `1 ${tag}`,
    })
    await pushAt(T0, pusher, two, {
      'plan.html': shared,
      'keep.txt': `2 ${tag}`,
    })
    expect(await blobRow(sha)).toMatchObject({ ref_count: 2 })
    // The push wrote this converter version's Markdown; older versions'
    // Markdown is planted as an earlier build left it.
    expect(await stored(`derived/markdown/${MARKDOWN_VERSION}/${sha}.md`)).toBe(
      true,
    )
    for (let v = 1; v < MARKDOWN_VERSION; v += 1) {
      await env.BLOBS.put(`derived/markdown/${v}/${sha}.md`, `# v${v}`)
    }
    // Objects under other prefixes, named by the same hash.
    const others = [`fonts/${sha}`, `looks/${sha}`, `base/test/${sha}.js`]
    for (const key of others) await env.BLOBS.put(key, 'not a blob')

    await pushAt(
      T0 + MINUTE,
      pusher,
      one,
      { 'keep.txt': `1 ${tag}` },
      { force: true },
    )
    await purgeAt(T0 + 32 * DAY)
    expect(
      await anyNodeAt(
        (
          await rows<{ id: string }>(
            'select id from trees where name = ?',
            name,
          )
        )[0]!.id,
        'plan.html',
      ),
    ).toBeUndefined()
    expect(await blobRow(sha)).toMatchObject({ ref_count: 1, state: 'live' })
    expect(await stored(`blobs/${sha}`)).toBe(true)

    await pushAt(
      T0 + 33 * DAY,
      pusher,
      two,
      { 'keep.txt': `2 ${tag}` },
      { force: true },
    )
    await purgeAt(T0 + 65 * DAY)
    expect(await blobRow(sha)).toBeNull()
    expect(await count('analyses', 'sha256 = ?', sha)).toBe(0)
    expect(await stored(`blobs/${sha}`)).toBe(false)
    for (let v = 1; v <= MARKDOWN_VERSION; v += 1) {
      expect(await stored(`derived/markdown/${v}/${sha}.md`)).toBe(false)
    }
    for (const key of others) expect(await stored(key)).toBe(true)
  })

  it('keeps a blob while any hold stands, verified or not', async () => {
    const { tag } = fresh()
    const text = `held ${tag}`
    const sha = await sha256Of(text)
    const holder = { kind: 'upload' as const, id: `test:${tag}` }
    const store = <A, E>(
      f: (s: Effect.Effect.Success<typeof TreeStore>) => Effect.Effect<A, E>,
    ) => run(Effect.flatMap(TreeStore, f))
    // An upload has taken its hold and is writing the bytes.
    await store((s) => s.holdBlob(holder, sha as Sha256, text.length))
    await env.BLOBS.put(`blobs/${sha}`, text)
    expect(
      (
        await rows<{ verified: number }>(
          'select verified from blob_holds where sha256 = ?',
          sha,
        )
      )[0]?.verified,
    ).toBe(0)
    const later = Date.now() + 40 * DAY
    await purgeAt(later)
    expect(await blobRow(sha)).toMatchObject({ state: 'live' })
    expect(await stored(`blobs/${sha}`)).toBe(true)
    await store((s) => s.confirmHold(holder, sha as Sha256, text.length))
    await purgeAt(later + MINUTE)
    expect(await blobRow(sha)).toMatchObject({ state: 'live' })
    // The change it was for never commits: the hold goes, then the bytes.
    await store((s) => s.releaseHold(holder, sha as Sha256))
    await purgeAt(later + 2 * MINUTE)
    expect(await blobRow(sha)).toBeNull()
    expect(await stored(`blobs/${sha}`)).toBe(false)
  })

  it('removes records past their life: old operations, Seen by and views, expired handles, day-old rate counts', async () => {
    const { tag, name } = fresh()
    const T0 = Date.now()
    const pusher = await agent(owner)
    const pushed = await pushAt(T0, pusher, `${ws.name}/${name}`, {
      'a.html': pageWith(`<p>${tag}</p>`),
    })
    const node = (await nodeAt(pushed.treeId, 'a.html'))!.id
    const now = T0 + 40 * DAY
    const cutoff = now - 30 * DAY
    const readers = [await person('old'), await person('new')]
    await exec(
      `insert into operations (principal, scope, op_id, result_node_id, result_version_id, result_state, created_at)
       values (?, ?, 'old', null, null, 'stored', ?), (?, ?, 'new', null, null, 'stored', ?)`,
      owner.id,
      `${pushed.treeId}:${tag}`,
      cutoff - 1,
      owner.id,
      `${pushed.treeId}:${tag}`,
      cutoff + 1,
    )
    await exec(
      `insert into seen_by (node_id, user_id, last_seen_at) values (?, ?, ?), (?, ?, ?)`,
      node,
      readers[0]!.id,
      cutoff - 1,
      node,
      readers[1]!.id,
      cutoff + 1,
    )
    await exec(
      `insert into page_views (node_id, day, count) values (?, ?, 1), (?, ?, 1)`,
      node,
      dayOf(cutoff - DAY),
      node,
      dayOf(cutoff + DAY),
    )
    for (const [hash, expires] of [
      [`old${tag}`, now - 1],
      [`new${tag}`, now + HOUR],
    ] as const) {
      await exec(
        `insert into view_handles (hash_sha256, generation, anon_session_id, tree_id, expires_at, renewed_at, created_at)
         values (?, 1, ?, ?, ?, ?, ?)`,
        hash,
        hash,
        pushed.treeId,
        expires,
        T0,
        T0,
      )
      await exec(
        'insert into view_handle_nodes (handle_hash, seq, node_id, created_at) values (?, 1, ?, ?)',
        hash,
        node,
        T0,
      )
      await exec(
        'insert into view_handle_firsts (handle_hash, seq, grant_order, created_at) values (?, 1, 0, ?)',
        hash,
        T0,
      )
    }
    await exec(
      `insert into rate_counters (key, window_start, count) values (?, ?, 1), (?, ?, 1)`,
      `old:${tag}`,
      now - 2 * DAY,
      `new:${tag}`,
      now - MINUTE,
    )

    await purgeAt(now)
    expect(
      await count('operations', 'scope = ?', `${pushed.treeId}:${tag}`),
    ).toBe(1)
    expect(
      await count(
        'operations',
        "scope = ? and op_id = 'new'",
        `${pushed.treeId}:${tag}`,
      ),
    ).toBe(1)
    expect(
      (
        await rows<{ user_id: string }>(
          'select user_id from seen_by where node_id = ?',
          node,
        )
      ).map((r) => r.user_id),
    ).toEqual([readers[1]!.id])
    expect(
      (
        await rows<{ day: string }>(
          'select day from page_views where node_id = ?',
          node,
        )
      ).map((r) => r.day),
    ).toEqual([dayOf(cutoff + DAY)])
    for (const table of [
      'view_handles',
      'view_handle_nodes',
      'view_handle_firsts',
    ]) {
      const column = table === 'view_handles' ? 'hash_sha256' : 'handle_hash'
      expect(await count(table, `${column} = ?`, `old${tag}`)).toBe(0)
      expect(await count(table, `${column} = ?`, `new${tag}`)).toBe(1)
    }
    expect(await count('rate_counters', 'key = ?', `old:${tag}`)).toBe(0)
    expect(await count('rate_counters', 'key = ?', `new:${tag}`)).toBe(1)
    // The page itself is live and untouched.
    expect(await versionsOf(node)).toBe(1)
  })
})

describe('bytes being reclaimed', () => {
  it('tells a push that meets a claimed blob to retry, and lets its upload succeed once the purge has finished with that hash', async () => {
    const { tag, name } = fresh()
    const T0 = Date.now()
    const pusher = await agent(owner)
    const text = `reused ${tag}`
    const sha = await sha256Of(text)
    await pushAt(T0, pusher, `${ws.name}/${name}`, {
      'a.txt': text,
      'b.txt': `b ${tag}`,
    })
    await pushAt(
      T0 + MINUTE,
      pusher,
      `${ws.name}/${name}`,
      { 'b.txt': `b ${tag}` },
      { force: true },
    )
    const other = await agent(owner)
    const target = `${ws.name}/${name}-again`
    let pushId: PushId | null = null
    let met: unknown = null
    const runtime = testRuntime({
      env: {
        BLOBS: beforeDelete(
          env.BLOBS,
          (keys) => keys.includes(`blobs/${sha}`),
          async () => {
            // While the purge holds the claim: a push of the same bytes.
            const staged = await stageAt(Date.now(), other, target, {
              'a.txt': text,
            })
            pushId = staged.pushId
            expect(staged.missing).toEqual([sha])
            met = await failureAs(other, await putBlobOf(pushId!, text))
            expect(await blobRow(sha)).toMatchObject({ state: 'reclaiming' })
          },
        ),
      },
    })
    await purgeAt(T0 + 32 * DAY, { runtime })
    expect(met).toMatchObject({ code: 'blob_reclaiming' })
    expect(await blobRow(sha)).toBeNull()
    // Pushed again, the bytes go up and the push commits.
    await runAs(other, await putBlobOf(pushId!, text))
    await runAs(
      other,
      Effect.flatMap(Push, (push) => push.commit(pushId!)),
    )
    expect(await blobRow(sha)).toMatchObject({ ref_count: 1, state: 'live' })
    expect(await (await env.BLOBS.get(`blobs/${sha}`))?.text()).toBe(text)
  })

  it('reclaims the bytes a withdrawal releases at once, without a run', async () => {
    const { tag } = fresh()
    const browser = await sessionFor(owner)
    const tree = await pushForms(owner, ws, {
      'questions/index.html': QUESTIONS,
    })
    const form = await formRef(
      tree,
      'questions/index.html',
      'questions/answers/',
    )
    const pdf = `%PDF-1.7 ${tag}`
    const sha = await sha256Of(pdf)
    const stored_ = await uploadAs(browser, tree, {
      page: 'questions/index.html',
      form,
      field: 'cv',
      name: 'cv.pdf',
      bytes: pdf,
    })
    await sendAs(browser, tree, {
      page: 'questions/index.html',
      form,
      entries: [
        ['role', 'Driver'],
        [
          'cv',
          {
            file: stored_.file,
            name: stored_.name,
            size: stored_.size,
            type: stored_.type,
          },
        ],
      ],
    })
    expect(await blobRow(sha)).toMatchObject({ ref_count: 1, state: 'live' })
    expect(await stored(`blobs/${sha}`)).toBe(true)
    const runs = await count('purge_runs')
    await withdrawAs(browser, tree, `questions/answers/${owner.email}.json`)
    expect(await blobRow(sha)).toBeNull()
    expect(await stored(`blobs/${sha}`)).toBe(false)
    expect(await count('purge_runs')).toBe(runs)
  })
})

describe('runs', () => {
  /** A deleted file whose bytes nothing else holds, `days` ago from T0. */
  const droppedFile = async (T0: number) => {
    const { tag, name } = fresh()
    const pusher = await agent(owner)
    const text = `dropped ${tag}`
    await pushAt(T0, pusher, `${ws.name}/${name}`, {
      'a.txt': text,
      'b.txt': `b ${tag}`,
    })
    await pushAt(
      T0 + MINUTE,
      pusher,
      `${ws.name}/${name}`,
      { 'b.txt': `b ${tag}` },
      { force: true },
    )
    return { sha: await sha256Of(text), name }
  }

  it('finishes in the next run what a run stopped after its claim left, and health says so meanwhile', async () => {
    const T0 = Date.now()
    const { sha } = await droppedFile(T0)
    const runtime = testRuntime({
      env: {
        BLOBS: new Proxy(env.BLOBS, {
          get(target, property) {
            if (property === 'delete') {
              return async () => {
                throw new Error('R2 is unavailable')
              }
            }
            const value = Reflect.get(target, property, target) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
      },
    })
    expect(await purgeFailureAt(T0 + 32 * DAY, { runtime })).toMatchObject({
      code: 'unavailable',
    })
    const failed = (await lastRunRow())!
    expect(failed.state).toBe('failed')
    expect(failed.error).toContain('File storage')
    const checkpoint = JSON.parse(failed.checkpoint_json) as {
      step: string
      claimed: string[]
    }
    expect(checkpoint.step).toBe('blobs')
    expect(checkpoint.claimed).toContain(sha)
    expect(await blobRow(sha)).toMatchObject({ state: 'reclaiming' })
    expect(await stored(`blobs/${sha}`)).toBe(true)
    const health = await run(Effect.flatMap(Settings, (s) => s.health()))
    expect(health.checks.find((c) => c.name === 'Purge')).toMatchObject({
      ok: false,
    })
    expect(health.ok).toBe(false)

    const outcome = await purgeAt(T0 + 32 * DAY + MINUTE)
    expect(outcome.blobs).toBeGreaterThanOrEqual(1)
    expect(await blobRow(sha)).toBeNull()
    expect(await stored(`blobs/${sha}`)).toBe(false)
    expect((await lastRunRow())!.state).toBe('done')
    const after = await run(Effect.flatMap(Settings, (s) => s.health()))
    expect(after.checks.find((c) => c.name === 'Purge')).toMatchObject({
      ok: true,
    })
    expect(after.checks.find((c) => c.name === 'Purge')?.detail).toContain(
      'The weekly purge finished',
    )
  })

  it('waits out the lease of a run that stopped without a word, then finishes its claims', async () => {
    const T0 = Date.now()
    const { sha } = await droppedFile(T0)
    const runtime = testRuntime({
      env: {
        // The bytes cannot be deleted, and the failure cannot be recorded:
        // as if the Worker had stopped mid-run.
        DB: failingStatements(env.DB, (sql) =>
          sql.includes("set state = 'failed', error = ?"),
        ),
        BLOBS: new Proxy(env.BLOBS, {
          get(target, property) {
            if (property === 'delete') {
              return async () => {
                throw new Error('R2 is unavailable')
              }
            }
            const value = Reflect.get(target, property, target) as unknown
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
      },
    })
    const stopped = T0 + 32 * DAY
    await purgeFailureAt(stopped, { runtime })
    const left = (await lastRunRow())!
    expect(left.state).toBe('running')

    expect(await purgeFailureAt(stopped + MINUTE)).toMatchObject({
      code: 'conflict',
      message: 'A purge is running.',
    })
    expect(await blobRow(sha)).toMatchObject({ state: 'reclaiming' })

    await purgeAt(stopped + 11 * MINUTE)
    expect(
      (
        await rows<{ state: string; error: string }>(
          'select state, error from purge_runs where id = ?',
          left.id,
        )
      )[0],
    ).toEqual({ state: 'failed', error: 'It stopped before it finished.' })
    expect(await blobRow(sha)).toBeNull()
    expect(await stored(`blobs/${sha}`)).toBe(false)
  })

  it('stops at its budget as partial, and the next run goes on from there', async () => {
    const { tag, name } = fresh()
    const T0 = Date.now()
    const pusher = await agent(owner)
    const files: Record<string, string> = { 'keep.txt': `keep ${tag}` }
    for (let i = 0; i < 110; i += 1) files[`many/f${i}.txt`] = `same ${tag}`
    const pushed = await pushAt(T0, pusher, `${ws.name}/${name}`, files)
    await pushAt(
      T0 + MINUTE,
      pusher,
      `${ws.name}/${name}`,
      { 'keep.txt': `keep ${tag}` },
      { force: true },
    )
    const left = () =>
      count('nodes', "tree_id = ? and path like 'many%'", pushed.treeId)
    expect(await left()).toBe(111)

    // Room for the lease, the expiry step and one batch of nodes.
    const partial = await purgeAt(T0 + 32 * DAY, {
      budget: { statements: 3 + 7 + 1 + 43, millis: 25_000 },
    })
    expect(partial).toMatchObject({ remaining: true, nodes: 100 })
    const row = (await lastRunRow())!
    expect(row.state).toBe('partial')
    expect(JSON.parse(row.checkpoint_json)).toMatchObject({ step: 'nodes' })
    expect(await left()).toBeGreaterThan(0)
    expect(await blobRow(await sha256Of(`same ${tag}`))).toMatchObject({
      state: 'live',
    })

    const rest = await purgeAt(T0 + 32 * DAY + MINUTE)
    expect(rest.remaining).toBe(false)
    expect((await lastRunRow())!.state).toBe('done')
    expect(await left()).toBe(0)
    expect(await blobRow(await sha256Of(`same ${tag}`))).toBeNull()
    expect(await nodeAt(pushed.treeId, 'keep.txt')).toBeDefined()
  })

  it('makes a second run wait while the first holds its lease', async () => {
    const T0 = Date.now()
    const { name } = await droppedFile(T0)
    const admin = await person('chief')
    await superAdmin(admin)
    const chief = await sessionFor(admin)
    const when = T0 + 32 * DAY
    let second: unknown = null
    let pressed: unknown = null
    const runtime = testRuntime({
      env: {
        DB: beforeBatch(
          env.DB,
          (sql) => sql.includes('delete from nodes where'),
          async () => {
            second = await purgeFailureAt(when)
            pressed = await failureAs(
              chief,
              Effect.flatMap(Purge, (p) => p.runNow()),
            )
          },
        ),
      },
    })
    const first = await purgeAt(when, { runtime })
    expect(second).toMatchObject({
      code: 'conflict',
      message: 'A purge is running.',
    })
    expect(pressed).toMatchObject({ code: 'conflict' })
    expect(first.nodes).toBeGreaterThanOrEqual(1)
    expect(await count('trees', 'name = ?', name)).toBe(1)
    expect((await lastRunRow())!.state).toBe('done')
  })

  it('answers Purge now only for a super admin in a browser, and runs as the weekly run does', async () => {
    const admin = await person('root')
    await superAdmin(admin)
    const member = await person('member')
    await join(ws, member)
    const runNow = Effect.flatMap(Purge, (p) => p.runNow())
    const runs = await count('purge_runs')
    const memberBrowser = await sessionFor(member)
    expect(await failureAs(memberBrowser, runNow)).toMatchObject({
      code: 'not_found',
    })
    expect(await failureAs(await agent(admin), runNow)).toMatchObject({
      code: 'not_found',
    })
    expect(
      await failureAs(
        {
          person: null,
          via: { kind: 'visitor', anonSessionId: null },
          requestId: 'test',
        },
        runNow,
      ),
    ).toMatchObject({ code: 'not_found' })
    const ended = await sessionFor(admin)
    await exec(
      'update session set expires_at = ? where id = ?',
      Date.now() - 1,
      (ended.via as { sessionId: string }).sessionId,
    )
    expect(await failureAs(ended, runNow)).toMatchObject({ code: 'not_found' })
    // None of them started a run.
    expect(await count('purge_runs')).toBe(runs)

    const outcome = await runAs(await sessionFor(admin), runNow)
    expect(outcome).toMatchObject({ trigger: 'manual', remaining: false })
    expect(await lastRunRow()).toMatchObject({
      id: outcome.runId,
      trigger: 'manual',
      state: 'done',
      started_by: admin.id,
    })
    const last = await run(Effect.flatMap(Purge, (p) => p.lastRun()))
    expect(last).toMatchObject({
      trigger: 'manual',
      state: 'done',
      outcome: { runId: outcome.runId },
    })
  })

  it('runs one weekly purge when the weekly schedule fires, and nothing on another', async () => {
    const before = await count('purge_runs', "trigger = 'weekly'")
    await worker.scheduled(
      createScheduledController({
        scheduledTime: new Date(),
        cron: WEEKLY_PURGE,
      }),
    )
    expect(await count('purge_runs', "trigger = 'weekly'")).toBe(before + 1)
    expect(await lastRunRow()).toMatchObject({
      trigger: 'weekly',
      state: 'done',
    })
    await worker.scheduled(
      createScheduledController({
        scheduledTime: new Date(),
        cron: '0 0 * * *',
      }),
    )
    expect(await count('purge_runs', "trigger = 'weekly'")).toBe(before + 1)
  })
})

describe('workspaces and keys', () => {
  it('purges a deleted workspace’s trees, its people and teams, and keeps its name taken', async () => {
    const { tag, name } = fresh()
    const T0 = Date.now()
    const admin = await person('admin')
    const gone = await workspace(admin, `w${tag}`)
    const helper = await person('helper')
    await join(gone, helper)
    await team(gone, 'Design', [helper])
    const adminBrowser = await sessionFor(admin)
    await at(
      T0,
      adminBrowser,
      Effect.flatMap(People, (p) =>
        p.invite({
          workspace: gone.name,
          email: `invited-${tag}@example.com`,
          teamIds: [],
        }),
      ),
    )
    const pusher = await agent(admin)
    const pushed = await pushAt(T0, pusher, `${gone.name}/${name}`, {
      'plan.html': pageWith(`<p>${tag}</p>`),
      'notes/a.txt': `a ${tag}`,
    })
    // A push that would make a new tree, still staged.
    const staged = await stageAt(T0, pusher, `${gone.name}/${name}-new`, {
      'x.txt': `x ${tag}`,
    })
    await uploadAt(
      T0,
      pusher,
      staged.pushId!,
      { 'x.txt': `x ${tag}` },
      staged.missing,
    )
    await at(
      T0 + MINUTE,
      adminBrowser,
      Effect.flatMap(People, (p) =>
        p.deleteWorkspace({ workspace: gone.name, confirm: gone.name }),
      ),
    )

    // Within the retention period nothing goes.
    await purgeAt(T0 + 29 * DAY)
    expect(await count('nodes', 'tree_id = ?', pushed.treeId)).toBeGreaterThan(
      0,
    )

    const purgedAt = T0 + 31 * DAY
    const outcome = await purgeAt(purgedAt)
    expect(outcome.trees).toBeGreaterThanOrEqual(1)
    expect(outcome.workspaces).toBeGreaterThanOrEqual(1)
    expect(await count('nodes', 'tree_id = ?', pushed.treeId)).toBe(0)
    expect(await count('trees', 'workspace_id = ?', gone.id)).toBe(0)
    expect(await count('events', 'tree_id = ?', pushed.treeId)).toBe(0)
    expect(await count('pushes', 'workspace_id = ?', gone.id)).toBe(0)
    expect(await count('workspace_members', 'workspace_id = ?', gone.id)).toBe(
      0,
    )
    expect(await count('teams', 'workspace_id = ?', gone.id)).toBe(0)
    expect(await count('invitations', 'workspace_id = ?', gone.id)).toBe(0)
    expect(await count('blob_holds', 'holder_id = ?', staged.pushId)).toBe(0)
    expect(
      (
        await rows<{ name: string; deleted_at: number; purged_at: number }>(
          'select name, deleted_at, purged_at from workspaces where id = ?',
          gone.id,
        )
      )[0],
    ).toEqual({ name: gone.name, deleted_at: T0 + MINUTE, purged_at: purgedAt })
    expect(await blobRow(await sha256Of(`a ${tag}`))).toBeNull()

    const root = await person('root')
    await superAdmin(root)
    const rootBrowser = await sessionFor(root)
    expect(
      await failureAs(
        rootBrowser,
        Effect.flatMap(People, (p) => p.createWorkspace({ name: gone.name })),
      ),
    ).toMatchObject({
      code: 'conflict',
      message: `The name ${gone.name} is taken.`,
    })
    expect(
      await failureAt(
        purgedAt + MINUTE,
        rootBrowser,
        Effect.flatMap(People, (p) => p.restoreWorkspace(gone.id)),
      ),
    ).toMatchObject({ code: 'conflict' })
  })

  it('revokes a key scoped to a purged folder and clears its scope in the batch that removes the folder, and leaves a key on a live node alone', async () => {
    const { tag, name } = fresh()
    const T0 = Date.now()
    const pusher = await agent(owner)
    const target = `${ws.name}/${name}`
    const pushed = await pushAt(T0, pusher, target, {
      'plans/a.txt': `a ${tag}`,
      'notes/b.txt': `b ${tag}`,
    })
    const plans = (await nodeAt(pushed.treeId, 'plans'))!.id
    const notes = (await nodeAt(pushed.treeId, 'notes'))!.id
    const onPlans = await agent(owner, { scope: plans as never })
    const onNotes = await agent(owner, { scope: notes as never })
    await pushAt(
      T0 + MINUTE,
      pusher,
      target,
      { 'notes/b.txt': `b ${tag}` },
      { force: true },
    )
    const keyOf = async (caller: Caller) =>
      (
        await rows<{ scope_node_id: string | null; revoked_at: number | null }>(
          'select scope_node_id, revoked_at from agent_keys where id = ?',
          (caller.via as { keyId: string }).keyId,
        )
      )[0]

    // A batch that fails removes nothing and clears nothing.
    const when = T0 + 32 * DAY
    await purgeFailureAt(when, {
      runtime: testRuntime({
        env: {
          DB: failingStatements(env.DB, (sql) =>
            sql.includes('delete from nodes where'),
          ),
        },
      }),
    })
    expect(await count('nodes', 'id = ?', plans)).toBe(1)
    expect(await keyOf(onPlans)).toEqual({
      scope_node_id: plans,
      revoked_at: null,
    })

    await purgeAt(when + MINUTE)
    expect(await count('nodes', 'id = ?', plans)).toBe(0)
    expect(await keyOf(onPlans)).toEqual({
      scope_node_id: null,
      revoked_at: when + MINUTE,
    })
    expect(await keyOf(onNotes)).toEqual({
      scope_node_id: notes,
      revoked_at: null,
    })
  })
})

describe('restoring and purging', () => {
  /** A tree whose page `gone.html` a push deleted an hour in. */
  const deletedPage = async () => {
    const { tag, name } = fresh()
    const key = await agent(owner)
    const t0 = Date.UTC(2026, 8, 1, 9)
    const text = pageWith(`<p>Gone ${tag}</p>`, 'Gone')
    const first = await pushAt(t0, key, `${ws.name}/${name}`, {
      'gone.html': text,
      'keep.html': pageWith('<p>Keep</p>', 'Keep'),
    })
    await pushAt(
      t0 + HOUR,
      key,
      `${ws.name}/${name}`,
      { 'keep.html': pageWith('<p>Keep</p>', 'Keep') },
      { force: true },
    )
    const node = await anyNodeAt(first.treeId, 'gone.html')
    return {
      key,
      treeId: first.treeId,
      name,
      node: node!.id,
      sha: await sha256Of(text),
      text,
      /** Past the retention period of the deletion. */
      later: t0 + HOUR + 31 * DAY,
    }
  }

  /**
   * A restore to push 1. With no time, on the real clock: a restore that
   * loses its batch waits before it reads again, which a test clock never
   * lets pass.
   */
  const restore = (
    t: Awaited<ReturnType<typeof deletedPage>>,
    time: number | null,
  ) =>
    (time === null
      ? (e: Effect.Effect<never, never, never>) => runAs(t.key, e)
      : (e: Effect.Effect<never, never, never>) => at(time, t.key, e))(
      Effect.flatMap(Files, (f) =>
        f
          .restore({
            ref: ref(`${ws.name}/${t.name}/gone.html`),
            to: { push: 1 as never },
          })
          .pipe(Effect.either),
      ) as never,
    ) as Promise<
      import('effect').Either.Either<unknown, { readonly code: string }>
    >

  /** The file is live with its bytes, or gone with no version left. */
  const restoredWithBytes = async (
    t: Awaited<ReturnType<typeof deletedPage>>,
  ) => {
    expect(await nodeAt(t.treeId, 'gone.html')).toBeDefined()
    expect(await blobRow(t.sha)).toMatchObject({ state: 'live' })
    expect(await (await env.BLOBS.get(`blobs/${t.sha}`))?.text()).toBe(t.text)
  }
  const refusedAndGone = async (t: Awaited<ReturnType<typeof deletedPage>>) => {
    expect(await versionsOf(t.node)).toBe(0)
    expect(await count('node_versions', 'blob_sha256 = ?', t.sha)).toBe(0)
    expect(await blobRow(t.sha)).toBeNull()
    expect(await stored(`blobs/${t.sha}`)).toBe(false)
  }

  it('keeps a file restored before the purge, with its blob', async () => {
    const t = await deletedPage()
    const done = await restore(t, t.later)
    expect(done._tag).toBe('Right')
    await purgeAt(t.later)
    await restoredWithBytes(t)
  })

  it('refuses a restore after the purge, and leaves no version behind', async () => {
    const t = await deletedPage()
    await purgeAt(t.later)
    const refused = await restore(t, t.later)
    expect(refused._tag === 'Left' && refused.left.code).toBe('not_found')
    await refusedAndGone(t)
  })

  it('refuses a restore whose batch a purge got to first', async () => {
    const t = await deletedPage()
    // The purge runs after the restore has read the tree, before it commits.
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) =>
              sql.includes('json_each') &&
              sql.includes("'live', pv.blob_sha256"),
            async () => {
              await purgeAt(t.later)
            },
          ),
        },
      }),
    )
    const refused = await restore(t, null)
    harness.reset()
    expect(refused._tag === 'Left' && refused.left.code).toBe('not_found')
    await refusedAndGone(t)
  })

  it('keeps a file a restore brought back while the purge was reading', async () => {
    const t = await deletedPage()
    // The restore commits after the purge chose its nodes, before it removes them.
    const DB = beforeBatch(
      env.DB,
      (sql) => sql.includes('delete from nodes where'),
      async () => {
        const done = await restore(t, t.later)
        expect(done._tag).toBe('Right')
      },
    )
    await purgeAt(t.later, { runtime: testRuntime({ env: { DB } }) })
    await restoredWithBytes(t)
  })
})
