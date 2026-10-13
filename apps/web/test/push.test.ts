import type { PushId, Sha256 } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect, TestClock, TestContext } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  Access,
  CurrentCaller,
  Files,
  Push,
  TreeStore,
  type Caller,
  type CommitResult,
  type StageResult,
} from '../src/core/index.ts'
import { count, exec, rows } from './support/d1.ts'
import { harness, testRuntime } from './support/harness.ts'
import { runAs } from './support/people.ts'
import {
  agent,
  commit,
  failureAs,
  join,
  nodeAt,
  person,
  pushAll,
  ref,
  sha256Of,
  stage,
  treeOf,
  upload,
  workspace,
} from './support/trees.ts'

afterEach(() => {
  harness.reset()
  vi.restoreAllMocks()
})

const ACME = {
  'index.html': '<!doctype html><title>Acme</title><h1>Acme</h1>',
  'plans/index.html': '<title>Plans</title><p>Plans</p>',
  'plans/q3.html': '<title>Q3</title><p>Q3</p>',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  '_theme.css': ':root { --accent: teal; }',
}

/** A workspace with an admin and a member who creates trees in it. */
const setUp = async () => {
  const admin = await person('admin')
  const ws = await workspace(admin)
  const creator = await person('creator')
  await join(ws, creator)
  return { admin, ws, creator, key: await agent(creator) }
}

const committed = (result: CommitResult | StageResult): CommitResult => {
  if (!('number' in result)) throw new Error('the push did not commit')
  return result
}

const readAs = (caller: Caller, target: string) =>
  runAs(
    caller,
    Effect.gen(function* () {
      const store = yield* TreeStore
      const access = yield* Access
      const resolved = yield* store.locate(ref(target))
      return yield* access
        .require('read', 'missing' in resolved ? resolved : resolved.node)
        .pipe(Effect.either)
    }),
  )

const listAs = (caller: Caller, target: string) =>
  runAs(
    caller,
    Effect.flatMap(Files, (files) =>
      files.ls({ ref: ref(target), depth: 'all' }),
    ),
  )

describe('a push', () => {
  it('creates a tree its creator and the admins hold write on, and nobody else sees', async () => {
    const { admin, ws, creator, key } = await setUp()
    const log = vi.spyOn(console, 'log')
    const result = committed(await pushAll(key, `${ws.name}/acme`, ACME))

    expect(result.number).toBe(1)
    expect(result.link).toBe(`https://dossier.test/${ws.name}/acme/`)
    expect(result.treeId).toMatch(/^[a-z0-9]{20}$/)
    expect(result.plan.createsTree).toBe(true)
    expect(result.plan.added).toEqual(Object.keys(ACME).sort())

    for (const writer of [key, await agent(admin)]) {
      const roles = await runAs(
        writer,
        Effect.gen(function* () {
          const resolved = yield* (yield* TreeStore).locate(
            ref(`${ws.name}/acme/`),
          )
          if ('missing' in resolved) throw new Error('no root')
          return yield* (yield* Access).roleOn(resolved.node)
        }),
      )
      expect(roles.caps.has('write')).toBe(true)
    }
    const member = await person('member')
    await join(ws, member)
    for (const other of [await agent(member), await agent(await person())]) {
      const answer = await readAs(other, `${ws.name}/acme/index.html`)
      expect(answer._tag).toBe('Left')
      if (answer._tag === 'Left') expect(answer.left.code).toBe('not_found')
    }

    const events = await rows<{ type: string; seq: number; push_id: string }>(
      'select type, seq, push_id from events where tree_id = ?',
      result.treeId,
    )
    expect(events).toEqual([
      { type: 'push', seq: 1, push_id: expect.any(String) },
    ])
    const lines = log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('"tree event"'))
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      tree: result.treeId,
      seq: 1,
      type: 'push',
      path: '',
      actor: creator.id,
      key: key.via.kind === 'agent' ? key.via.keyId : null,
    })
    expect(lines[0]).not.toContain('dsk_')
  })

  it('changes, adds and deletes files in one commit', async () => {
    const { ws, key } = await setUp()
    const first = committed(await pushAll(key, `${ws.name}/acme`, ACME))
    const next = {
      'index.html': '<!doctype html><title>Acme</title><h1>Acme 2</h1>',
      'logo.svg': ACME['logo.svg'],
      '_theme.css': ACME['_theme.css'],
      'notes/today.txt': 'today',
    }
    const second = committed(
      await pushAll(key, `${ws.name}/acme`, next, {
        baseSeq: first.seq,
        baseTree: first.treeId,
      }),
    )
    expect(second.number).toBe(2)
    expect(second.plan).toMatchObject({
      added: ['notes/today.txt'],
      changed: ['index.html'],
      deleted: ['plans/index.html', 'plans/q3.html'],
      unchanged: 2,
    })
    expect(await nodeAt(first.treeId, 'plans')).toBeUndefined()
    expect(await nodeAt(first.treeId, 'notes')).toMatchObject({
      kind: 'folder',
    })
    const listing = await listAs(key, `${ws.name}/acme`)
    expect(listing.entries.map((e) => e.path).sort()).toEqual([
      '_theme.css',
      'index.html',
      'logo.svg',
      'notes',
      'notes/today.txt',
    ])
    // Unchanged files keep their version.
    const logo = await rows<{ n: number }>(
      `select count(*) as n from node_versions v join nodes n on n.id = v.node_id
       where n.tree_id = ? and n.path = 'logo.svg'`,
      first.treeId,
    )
    expect(logo[0]?.n).toBe(1)
    expect(second.seq).toBe(2)
  })

  it('creates no push when nothing changes', async () => {
    const { ws, key } = await setUp()
    const first = committed(await pushAll(key, `${ws.name}/acme`, ACME))
    const again = await stage(key, `${ws.name}/acme`, ACME, {
      baseSeq: first.seq,
      baseTree: first.treeId,
    })
    expect(again.pushId).toBeNull()
    expect(again.tree).toEqual({ id: first.treeId, seq: 1, push: 1 })
    expect(
      await count(
        'pushes',
        'tree_name = ? and workspace_id = ?',
        'acme',
        ws.id,
      ),
    ).toBe(1)
  })

  it('creates the tree on a first push of an empty folder', async () => {
    const { ws, key } = await setUp()
    const result = committed(await pushAll(key, `${ws.name}/empty`, {}))
    expect(result.number).toBe(1)
    const tree = await treeOf(ws.name, 'empty')
    expect(tree?.id).toBe(result.treeId)
    const listing = await listAs(key, `${ws.name}/empty`)
    expect(listing.entries).toEqual([])
  })

  it('stops with stale_head after another push to the path, and goes ahead with --force', async () => {
    const { ws, key } = await setUp()
    const first = committed(await pushAll(key, `${ws.name}/acme`, ACME))
    const base = { baseSeq: first.seq, baseTree: first.treeId }
    committed(
      await pushAll(
        key,
        `${ws.name}/acme`,
        { ...ACME, 'index.html': '<p>someone else</p>' },
        base,
      ),
    )
    const mine = { ...ACME, 'plans/q3.html': '<p>mine</p>' }
    const stale = await failureAs(
      key,
      Effect.flatMap(Push, (push) =>
        push.stage({
          target: ref(`${ws.name}/acme`),
          baseSeq: first.seq,
          baseTree: first.treeId,
          force: false,
          dryRun: false,
          message: null,
          files: [],
        }),
      ),
    )
    expect(stale).toMatchObject({ code: 'stale_head', path: `${ws.name}/acme` })
    expect(stale.message).toContain('index.html')
    // A folder that never pulled or pushed the path has no base.
    const fresh = await failureAs(
      key,
      Effect.flatMap(Push, (push) =>
        push.stage({
          target: ref(`${ws.name}/acme`),
          baseSeq: null,
          baseTree: null,
          force: false,
          dryRun: true,
          message: null,
          files: [],
        }),
      ),
    )
    expect(fresh.code).toBe('stale_head')
    const forced = committed(
      await pushAll(key, `${ws.name}/acme`, mine, { force: true }),
    )
    expect(forced.number).toBe(3)
    expect(forced.plan.changed).toEqual(['index.html', 'plans/q3.html'])
  })

  it('keeps a staged push invisible until it commits', async () => {
    const { ws, key } = await setUp()
    const first = committed(await pushAll(key, `${ws.name}/acme`, ACME))
    const files = { ...ACME, 'new.txt': 'new' }
    const staged = await stage(key, `${ws.name}/acme`, files, {
      baseSeq: first.seq,
      baseTree: first.treeId,
    })
    await upload(key, staged.pushId as PushId, files, staged.missing)
    const before = await listAs(key, `${ws.name}/acme`)
    expect(before.entries.map((e) => e.path)).not.toContain('new.txt')
    expect(before.seq).toBe(1)
    await commit(key, staged.pushId as PushId)
    const after = await listAs(key, `${ws.name}/acme`)
    expect(after.entries.map((e) => e.path)).toContain('new.txt')
  })

  it('asks for a hash another tree holds, but not one this tree holds', async () => {
    const { ws, key } = await setUp()
    committed(
      await pushAll(key, `${ws.name}/other`, { 'shared.txt': 'same bytes' }),
    )
    const first = committed(
      await pushAll(key, `${ws.name}/acme`, { 'mine.txt': 'mine' }),
    )
    const staged = await stage(
      key,
      `${ws.name}/acme`,
      { 'mine.txt': 'mine', 'copy.txt': 'mine', 'shared.txt': 'same bytes' },
      { baseSeq: first.seq, baseTree: first.treeId },
    )
    expect(staged.missing).toEqual([await sha256Of('same bytes')])
  })

  it('refuses a commit naming a hash neither uploaded nor in the tree', async () => {
    const { ws, key } = await setUp()
    const staged = await stage(key, `${ws.name}/acme`, {
      'a.txt': 'never sent',
    })
    const refused = await failureAs(
      key,
      Effect.flatMap(Push, (push) => push.commit(staged.pushId as PushId)),
    )
    expect(refused).toMatchObject({ code: 'invalid', path: 'a.txt' })
    expect(await treeOf(ws.name, 'acme')).toBeUndefined()
  })

  it('answers blob_reclaiming while a purge holds the blob, and takes it after', async () => {
    const { ws, key } = await setUp()
    const files = { 'a.txt': `reclaimed ${crypto.randomUUID()}` }
    const sha = await sha256Of(files['a.txt'])
    const staged = await stage(key, `${ws.name}/acme`, files)
    await exec(
      `insert into blobs (sha256, size, ref_count, state, first_seen_at, reclaim_started_at)
       values (?, 1, 0, 'reclaiming', 0, 0)`,
      sha,
    )
    const pushId = staged.pushId as PushId
    const refused = await failureAs(
      key,
      Effect.flatMap(Push, (push) =>
        push.putBlob({
          pushId,
          sha256: sha,
          size: files['a.txt'].length,
          body: new Blob([files['a.txt']]).stream(),
        }),
      ),
    )
    expect(refused.code).toBe('blob_reclaiming')
    await exec(`update blobs set state = 'live' where sha256 = ?`, sha)
    await upload(key, pushId, files, [sha])
    expect((await commit(key, pushId)).number).toBe(1)
  })

  it('fails the whole commit with conflict when the admin row it rested on goes', async () => {
    const { admin, ws, key } = await setUp()
    const first = committed(await pushAll(key, `${ws.name}/acme`, ACME))
    const adminKey = await agent(admin)
    const files = { ...ACME, 'admin.txt': 'by the admin' }
    const staged = await stage(adminKey, `${ws.name}/acme`, files, {
      baseSeq: first.seq,
      baseTree: first.treeId,
    })
    await upload(adminKey, staged.pushId as PushId, files, staged.missing)
    // The row goes after the commit's own check and before its batch runs.
    const racing = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (statements.length > 10) {
              await target
                .prepare(
                  'delete from workspace_members where workspace_id = ? and user_id = ?',
                )
                .bind(ws.id, admin.id)
                .run()
            }
            return target.batch(statements)
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    harness.use(testRuntime({ env: { DB: racing } }))
    const refused = await failureAs(
      adminKey,
      Effect.flatMap(Push, (push) => push.commit(staged.pushId as PushId)),
    )
    expect(refused.code).toBe('conflict')
    harness.reset()
    expect(await nodeAt(first.treeId, 'admin.txt')).toBeUndefined()
    expect((await treeOf(ws.name, 'acme'))?.push_count).toBe(1)
    expect(await count('events', 'tree_id = ?', first.treeId)).toBe(1)
  })

  it('answers too_large for each push limit', async () => {
    const { ws, key } = await setUp()
    const MiB = 1024 * 1024
    const sha = '0'.repeat(64) as Sha256
    const attempt = (files: { path: string; size: number }[]) =>
      failureAs(
        key,
        Effect.flatMap(Push, (push) =>
          push.stage({
            target: ref(`${ws.name}/big`),
            baseSeq: null,
            baseTree: null,
            force: false,
            dryRun: false,
            message: null,
            files: files.map((f) => ({ ...f, sha256: sha })),
          }),
        ),
      )
    const tooBig = await attempt([{ path: 'video.mp4', size: 51 * MiB }])
    expect(tooBig).toMatchObject({ code: 'too_large', path: 'video.mp4' })
    expect(tooBig.message).toContain('50 MiB')
    expect(tooBig.fix).toBe('A super admin can raise it.')
    const tooMany = await attempt(
      Array.from({ length: 2001 }, (_, i) => ({ path: `f${i}.txt`, size: 1 })),
    )
    expect(tooMany.code).toBe('too_large')
    expect(tooMany.message).toContain('2,000')
    const tooMuch = await attempt(
      Array.from({ length: 11 }, (_, i) => ({
        path: `v${i}.mp4`,
        size: 50 * MiB,
      })),
    )
    expect(tooMuch.code).toBe('too_large')
    expect(tooMuch.message).toContain('500 MiB')
  })

  it('refuses the 31st push in a minute from one key, but not from another, and accepts again the next minute', async () => {
    const { ws, creator } = await setUp()
    const busy = await agent(creator)
    const other = await agent(creator)
    const dry = (caller: Caller) =>
      Effect.flatMap(Push, (push) =>
        push.stage({
          target: ref(`${ws.name}/rate`),
          baseSeq: null,
          baseTree: null,
          force: false,
          dryRun: true,
          message: null,
          files: [],
        }),
      ).pipe(
        Effect.map(() => 'ok'),
        Effect.catchAll((e) => Effect.succeed(e.code)),
        Effect.provideService(CurrentCaller, caller),
      )
    const answers = await runAs(
      busy,
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 9, 12, 9, 0, 5))
        const seen: string[] = []
        for (let i = 0; i < 31; i += 1) seen.push(yield* dry(busy))
        seen.push(yield* dry(other))
        yield* TestClock.adjust('60 seconds')
        seen.push(yield* dry(busy))
        return seen
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(answers.slice(0, 30).every((a) => a === 'ok')).toBe(true)
    expect(answers[30]).toBe('rate_limited')
    expect(answers[31]).toBe('ok')
    expect(answers[32]).toBe('ok')
    const counter = await rows<{ count: number }>(
      'select count from rate_counters where key = ?',
      `push:${busy.via.kind === 'agent' ? busy.via.keyId : ''}`,
    )
    expect(counter[0]?.count).toBe(1)
  })

  it('stops a page whose form has no action, naming the file, line and fix', async () => {
    const { ws, key } = await setUp()
    const files = {
      'plan.html':
        '<title>Plan</title>\n<p>Plan</p>\n<form method="post">\n<input name="a">\n</form>',
    }
    const staged = await stage(key, `${ws.name}/acme`, files)
    await upload(key, staged.pushId as PushId, files, staged.missing)
    const refused = await failureAs(
      key,
      Effect.flatMap(Push, (push) => push.commit(staged.pushId as PushId)),
    )
    expect(refused).toMatchObject({
      code: 'policy_rejected',
      message: 'plan.html: the form on line 3 has no action.',
      fix: 'Add action="decisions/" for one file per person, or action="decisions.json" for one shared file.',
      path: 'plan.html',
    })
    expect(await treeOf(ws.name, 'acme')).toBeUndefined()
  })
})

describe('the push warnings', () => {
  it('carry B-13’s warning in the plan and still commit', async () => {
    const { ws, key } = await setUp()
    const first = committed(
      await pushAll(key, `${ws.name}/kit`, {
        'guides/_components/acme-card.js':
          'customElements.define("acme-card", class extends HTMLElement {})',
        'guides/page.html': '<acme-card>Inside guides</acme-card>',
      }),
    )
    expect(first.plan.warnings).toEqual([])
    const second = committed(
      await pushAll(key, `${ws.name}/kit/b13`, {
        'plan.html':
          '<h1>Delivery plan</h1><acme-card>Erbil depot</acme-card><p>Rates.</p>',
      }),
    )
    expect(second.plan.added).toEqual(['b13/plan.html'])
    expect(second.plan.warnings).toEqual([
      {
        code: 'component_missing',
        path: 'b13/plan.html',
        line: null,
        message:
          'b13/plan.html uses <acme-card>, but no _components/acme-card.js is above it.',
      },
    ])
    expect((await nodeAt(second.treeId, 'b13/plan.html'))?.kind).toBe('file')
  })

  it('name only files the push adds or changes, and layouts without a slot', async () => {
    const { ws, key } = await setUp()
    const files = {
      'old.html': '<other-tag>Old</other-tag>',
      '_layout.html': '<header>Acme</header>',
    }
    const first = committed(await pushAll(key, `${ws.name}/warn`, files))
    expect(first.plan.warnings.map((w) => [w.code, w.path])).toEqual([
      ['layout_without_slot', '_layout.html'],
      ['component_missing', 'old.html'],
    ])
    const again = committed(
      await pushAll(
        key,
        `${ws.name}/warn`,
        { ...files, 'new.html': '<p>New</p>' },
        { force: true },
      ),
    )
    expect(again.plan.added).toEqual(['new.html'])
    expect(again.plan.warnings).toEqual([])
  })
})
