import type { Person, ShareSpec, ShareTarget } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect, TestClock, TestContext } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Push, Shares, type Role } from '../src/core/index.ts'
import {
  beforeBatch,
  count,
  exec,
  failingStatements,
  rows,
} from './support/d1.ts'
import { harness, ORIGIN, testRuntime } from './support/harness.ts'
import { keySecretFor } from './support/keys.ts'
import { runAs } from './support/people.ts'
import {
  agent,
  failureAs,
  inTeam,
  join,
  nodeAt,
  person,
  pushAll,
  ref,
  share,
  stage,
  team,
  upload,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const TREE = {
  'index.html': '<title>Home</title>',
  'questions/index.html': '<title>Questions</title>',
  'plans/q3.html': '<title>Q3</title>',
}

/** An admin's workspace with one tree, and people to share with. */
const world = async () => {
  const admin = await person('admin')
  const ws = await workspace(admin)
  const sara = await person('sara')
  const bob = await person('bob')
  const adminAgent = await agent(admin)
  const pushed = await pushAll(adminAgent, `${ws.name}/acme`, TREE)
  if (!('treeId' in pushed)) throw new Error('no tree')
  const node = async (path: string) => {
    const found = await nodeAt(pushed.treeId, path)
    if (found === undefined) throw new Error(`no node at ${path}`)
    return found.id
  }
  return { admin, adminAgent, ws, sara, bob, treeId: pushed.treeId, node }
}

const setAs = (
  caller: Awaited<ReturnType<typeof agent>>,
  path: string,
  target: ShareTarget,
  role: Role | null,
) =>
  runAs(
    caller,
    Effect.flatMap(Shares, (shares) =>
      shares.set({ ref: ref(path), target, role }),
    ),
  )

const shareEvents = (treeId: string) =>
  count('events', "tree_id = ? and type = 'share'", treeId)

describe('setting a share', () => {
  it('commits one share event and one log line for each change, and a new role replaces the old share', async () => {
    const w = await world()
    const log = vi.spyOn(console, 'log')
    const lines = () =>
      log.mock.calls.filter((call) =>
        String(call[0]).includes('"message":"share"'),
      ).length
    const sara = { kind: 'email', email: w.sara.email } as const
    const path = `${w.ws.name}/acme/questions/`
    const saraShares = () =>
      rows<{ id: string; role: string }>(
        "select id, role from shares where tree_id = ? and target_kind = 'email' and target = ?",
        w.treeId,
        w.sara.email.toLowerCase(),
      )

    const set = await setAs(w.adminAgent, path, sara, 'read')
    expect(set.shares.filter((s) => !s.inherited)).toEqual([
      expect.objectContaining({ target: sara, role: 'read', inherited: false }),
    ])
    expect(await shareEvents(w.treeId)).toBe(1)
    expect(lines()).toBe(1)
    const [first] = await saraShares()

    await setAs(w.adminAgent, path, sara, 'write')
    const changed = await saraShares()
    expect(changed).toEqual([{ id: expect.any(String), role: 'write' }])
    expect(changed[0]!.id).not.toBe(first!.id)
    expect(await shareEvents(w.treeId)).toBe(2)
    expect(lines()).toBe(2)

    await setAs(w.adminAgent, path, sara, null)
    expect(await saraShares()).toEqual([])
    expect(await shareEvents(w.treeId)).toBe(3)
    expect(lines()).toBe(3)

    // Nothing to change: no event, no line.
    await setAs(w.adminAgent, path, sara, null)
    expect(await shareEvents(w.treeId)).toBe(3)
    expect(lines()).toBe(3)
    const logged = log.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('"message":"share"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(logged[1]).toEqual(
      expect.objectContaining({
        path: 'questions',
        targetKind: 'email',
        role: 'write',
        before: 'read',
        actor: w.admin.id,
      }),
    )
    log.mockRestore()
  })

  it('lists shares above as inherited, and the `_` files above that are public with the node', async () => {
    const w = await world()
    await pushAll(
      w.adminAgent,
      `${w.ws.name}/acme`,
      {
        ...TREE,
        '_layout.html': '<slot></slot>',
        '_theme.css': ':root{}',
        'questions/_components/acme-x.js': 'export {}',
      },
      { force: true },
    )
    await share(
      w.treeId,
      await w.node(''),
      'workspace',
      w.ws.id,
      'read',
      w.admin,
    )
    const listed = await runAs(
      w.adminAgent,
      Effect.flatMap(Shares, (shares) =>
        shares.list(ref(`${w.ws.name}/acme/questions/`)),
      ),
    )
    expect(
      listed.shares.map((s) => [s.label, s.role, s.inherited, s.on.path]),
    ).toEqual(
      expect.arrayContaining([[`Everyone in ${w.ws.name}`, 'read', true, '']]),
    )
    // The folder's own `_` files are inside it; the root's are above it.
    expect(listed.publicReach).toEqual(['_layout.html', '_theme.css'])
  })

  it('refuses a respond holder with forbidden and a team from another workspace as invalid', async () => {
    const w = await world()
    await share(
      w.treeId,
      await w.node('questions'),
      'email',
      w.sara.email,
      'respond',
      w.admin,
    )
    const sara = await agent(w.sara)
    const path = `${w.ws.name}/acme/questions/`
    const refused = await failureAs(
      sara,
      Effect.flatMap(Shares, (shares) =>
        shares.set({
          ref: ref(path),
          target: { kind: 'email', email: w.bob.email },
          role: 'read',
        }),
      ),
    )
    expect(refused.code).toBe('forbidden')
    const listing = await failureAs(
      sara,
      Effect.flatMap(Shares, (shares) => shares.list(ref(path))),
    )
    expect(listing.code).toBe('forbidden')
    // Someone with nothing there hears it is missing.
    const bob = await failureAs(
      await agent(w.bob),
      Effect.flatMap(Shares, (shares) => shares.list(ref(path))),
    )
    expect(bob.code).toBe('not_found')

    const elsewhere = await workspace(w.bob)
    await team(elsewhere, 'Design', [w.bob])
    const invalid = await failureAs(
      w.adminAgent,
      Effect.flatMap(Shares, (shares) =>
        shares.set({
          ref: ref(path),
          target: { kind: 'team', team: 'Design' },
          role: 'read',
        }),
      ),
    )
    expect(invalid).toEqual(
      expect.objectContaining({
        code: 'invalid',
        message: `${w.ws.name} has no team called Design.`,
      }),
    )
    // The workspace's own team is found without regard to case.
    const own = await team(w.ws, 'Design', [])
    const shared = await setAs(
      w.adminAgent,
      path,
      { kind: 'team', team: 'design' },
      'read',
    )
    expect(shared.shares.map((s) => s.label)).toContain('Team Design')
    expect(
      await count(
        'shares',
        "tree_id = ? and target_kind = 'team' and target = ?",
        w.treeId,
        own.id,
      ),
    ).toBe(1)
  })

  it('answers list and set over the API as their contracts say', async () => {
    const w = await world()
    await share(
      w.treeId,
      await w.node('questions'),
      'email',
      w.sara.email,
      'respond',
      w.admin,
    )
    const adminKey = await keySecretFor(w.admin)
    const saraKey = await keySecretFor(w.sara)
    const path = `${w.ws.name}/acme/questions/`
    const listed = await SELF.fetch(
      `${ORIGIN}/_/api/shares?path=${encodeURIComponent(path)}`,
      { headers: { authorization: `Bearer ${adminKey}` } },
    )
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as Record<string, unknown>
    expect(body).toEqual({
      path: 'questions',
      link: `${ORIGIN}/${w.ws.name}/acme/questions/`,
      shares: expect.arrayContaining([
        {
          target: { kind: 'email', email: w.sara.email.toLowerCase() },
          role: 'respond',
          on: 'questions',
          inherited: false,
          createdAt: expect.any(String),
        },
      ]),
      publicReach: [],
    })
    const set = (key: string, payload: unknown) =>
      SELF.fetch(`${ORIGIN}/_/api/shares`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
    const refused = await set(saraKey, {
      path,
      target: { kind: 'anyone' },
      role: 'read',
    })
    expect(refused.status).toBe(403)
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe('forbidden')
    const invalid = await set(adminKey, {
      path,
      target: { kind: 'team', team: 'Sales' },
      role: 'read',
    })
    expect(invalid.status).toBe(400)
    const removed = await set(adminKey, {
      path,
      target: { kind: 'email', email: w.sara.email },
      role: null,
    })
    expect(removed.status).toBe(200)
    // Only the creator's own share on the root is left, inherited.
    expect(
      ((await removed.json()) as { shares: { inherited: boolean }[] }).shares,
    ).toEqual([expect.objectContaining({ inherited: true, on: '' })])
  })
})

describe('push --share', () => {
  const sara = (who: Person): ShareSpec => ({
    target: { kind: 'email', email: who.email },
    role: 'respond',
  })
  const anyone: ShareSpec = { target: { kind: 'anyone' }, role: 'read' }

  it('grants the shares in the commit’s batch, for a new tree and for an existing folder', async () => {
    const admin = await person('admin')
    const ws = await workspace(admin)
    const who = await person('sara')
    const adminAgent = await agent(admin)
    const created = await pushAll(adminAgent, `${ws.name}/fresh`, TREE, {
      share: [sara(who), anyone],
    })
    if (!('treeId' in created)) throw new Error('no tree')
    const root = await nodeAt(created.treeId, '')
    const onRoot = await rows<{ target_kind: string; role: string }>(
      "select target_kind, role from shares where node_id = ? and target_kind <> 'email' or (node_id = ? and target = ?) order by target_kind",
      root!.id,
      root!.id,
      who.email.toLowerCase(),
    )
    expect(onRoot).toEqual([
      { target_kind: 'anyone', role: 'read' },
      { target_kind: 'email', role: 'respond' },
    ])
    // One share event beside the push's.
    expect(
      await count('events', "tree_id = ? and type = 'share'", created.treeId),
    ).toBe(1)

    await pushAll(
      adminAgent,
      `${ws.name}/fresh/questions`,
      { 'index.html': '<title>Again</title>' },
      {
        share: [{ target: { kind: 'workspace' }, role: 'write' }],
        force: true,
      },
    )
    const questions = await nodeAt(created.treeId, 'questions')
    expect(
      await rows(
        'select target_kind, target, role from shares where node_id = ?',
        questions!.id,
      ),
    ).toEqual([{ target_kind: 'workspace', target: ws.id, role: 'write' }])

    // A new folder the push makes is shared too.
    await pushAll(
      adminAgent,
      `${ws.name}/fresh/brand/new`,
      { 'index.html': '<title>New</title>' },
      { share: [anyone] },
    )
    const made = await nodeAt(created.treeId, 'brand/new')
    expect(
      await count('shares', "node_id = ? and target_kind = 'anyone'", made!.id),
    ).toBe(1)
  })

  it('refuses a team from another workspace at stage, and grants nothing when the commit fails', async () => {
    const admin = await person('admin')
    const ws = await workspace(admin)
    const adminAgent = await agent(admin)
    const invalid = await failureAs(
      adminAgent,
      Effect.flatMap(Push, (push) =>
        push.stage({
          target: ref(`${ws.name}/t`),
          baseSeq: null,
          baseTree: null,
          force: false,
          dryRun: true,
          message: null,
          files: [],
          share: [{ target: { kind: 'team', team: 'Sales' }, role: 'read' }],
        }),
      ),
    )
    expect(invalid).toEqual(
      expect.objectContaining({
        code: 'invalid',
        message: `${ws.name} has no team called Sales.`,
      }),
    )

    const pushed = await pushAll(adminAgent, `${ws.name}/t`, TREE)
    if (!('treeId' in pushed)) throw new Error('no tree')
    const staged = await stage(
      adminAgent,
      `${ws.name}/t`,
      { ...TREE, 'extra.html': '<title>Extra</title>' },
      { share: [anyone], baseSeq: pushed.seq, baseTree: pushed.treeId },
    )
    if (staged.pushId === null) throw new Error('nothing staged')
    await upload(
      adminAgent,
      staged.pushId,
      { ...TREE, 'extra.html': '<title>Extra</title>' },
      staged.missing,
    )
    harness.use(
      testRuntime({
        env: {
          DB: failingStatements(env.DB, (sql) =>
            /insert into events/i.test(sql),
          ),
        },
      }),
    )
    const failed = await failureAs(
      adminAgent,
      Effect.flatMap(Push, (push) => push.commit(staged.pushId!)),
    )
    expect(failed.code).toBe('unavailable')
    harness.reset()
    expect(
      await count(
        'shares',
        "tree_id = ? and target_kind = 'anyone'",
        pushed.treeId,
      ),
    ).toBe(0)
  })
})

describe('shared with me', () => {
  const OPEN = '2026-10-20T00:00:00Z'
  const page = (form: string) =>
    `<!doctype html><html><head><title>Questions</title></head><body>${form}</body></html>`

  it('lists email and team shares only, newest first, with roles added up, leaving out the person’s own and suspended workspaces', async () => {
    const admin = await person('admin')
    const ws = await workspace(admin)
    const sara = await person('sara')
    await join(ws, sara)
    const design = await team(ws, 'Design', [sara])
    const adminAgent = await agent(admin)
    const pushed = await pushAll(adminAgent, `${ws.name}/acme`, TREE)
    if (!('treeId' in pushed)) throw new Error('no tree')
    const node = async (path: string) => (await nodeAt(pushed.treeId, path))!.id
    const at = async (
      path: string,
      kind: 'email' | 'team' | 'workspace' | 'anyone',
      target: string,
      role: Role,
      by: Person,
      createdAt: number,
    ) =>
      exec(
        `insert into shares (id, tree_id, node_id, target_kind, target, role, created_by, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        pushed.treeId,
        await node(path),
        kind,
        target,
        role,
        by.id,
        createdAt,
      )
    await at(
      'questions',
      'email',
      sara.email.toLowerCase(),
      'read',
      admin,
      1000,
    )
    await at('questions', 'team', design.id, 'respond', admin, 3000)
    await at(
      'plans/q3.html',
      'email',
      sara.email.toLowerCase(),
      'write',
      admin,
      2000,
    )
    await at('index.html', 'workspace', ws.id, 'read', admin, 4000)
    await at('index.html', 'anyone', '*', 'read', admin, 5000)
    // Sara's own share to herself is not something shared with her.
    await at('plans', 'email', sara.email.toLowerCase(), 'read', sara, 6000)

    // A suspended workspace's shares are left out.
    const other = await workspace(admin)
    const otherTree = await pushAll(adminAgent, `${other.name}/b`, TREE)
    if (!('treeId' in otherTree)) throw new Error('no tree')
    await share(
      otherTree.treeId,
      (await nodeAt(otherTree.treeId, ''))!.id,
      'email',
      sara.email.toLowerCase(),
      'read',
      admin,
    )
    await exec(
      'update workspaces set suspended_at = ? where id = ?',
      Date.now(),
      other.id,
    )

    const rowsFor = await runAs(
      await agent(sara),
      Effect.flatMap(Shares, (shares) => shares.sharedWithMe()),
    )
    expect(
      rowsFor.map((row) => [
        row.title,
        row.place,
        [...row.roles].sort(),
        row.sharedAt,
      ]),
    ).toEqual([
      // A folder with a page of its own goes by the page's title.
      ['Questions', 'acme/questions', ['read', 'respond'], 3000],
      ['Q3', 'acme/plans', ['write'], 2000],
    ])
    expect(rowsFor[0]!.link).toBe(`${ORIGIN}/${ws.name}/acme/questions/`)
    expect(rowsFor[1]!.link).toBe(`${ORIGIN}/${ws.name}/acme/plans/q3`)
    // A team share reaches only the team's members.
    await exec(
      'delete from team_members where team_id = ? and user_id = ?',
      design.id,
      sara.id,
    )
    await inTeam(design, admin)
    const after = await runAs(
      await agent(sara),
      Effect.flatMap(Shares, (shares) => shares.sharedWithMe()),
    )
    expect(after.map((row) => [...row.roles].sort())).toEqual([
      ['write'],
      ['read'],
    ])
  })

  it('marks an open form with nothing of the person’s in its target as waiting, and not a closed, answered or read-only one', async () => {
    const admin = await person('admin')
    const ws = await workspace(admin)
    const sara = await person('sara')
    const adminAgent = await agent(admin)
    const pushed = await pushAll(adminAgent, `${ws.name}/forms`, {
      'open/index.html': page(
        `<form action="answers/" data-closes="${OPEN}"><input name="a"><button>Send</button></form>`,
      ),
      'closed/index.html': page(
        '<form action="answers/" data-closed><input name="a"><button>Send</button></form>',
      ),
      'shared/index.html': page(
        '<form action="board.json"><input name="a"><button>Send</button></form>',
      ),
      'read/index.html': page(
        '<form action="answers/"><input name="a"><button>Send</button></form>',
      ),
    })
    if (!('treeId' in pushed)) throw new Error('no tree')
    const node = async (path: string) => (await nodeAt(pushed.treeId, path))!.id
    const give = async (path: string, role: Role) =>
      share(pushed.treeId, await node(path), 'email', sara.email, role, admin)
    await give('open', 'respond')
    await give('closed', 'respond')
    await give('shared', 'respond')
    await give('read', 'read')
    const saraAgent = await agent(sara)
    const waiting = (now: number) =>
      runAs(
        saraAgent,
        Effect.gen(function* () {
          yield* TestClock.setTime(now)
          const shared = yield* (yield* Shares).sharedWithMe()
          return Object.fromEntries(
            shared.map((row) => [
              `${row.place}/`.slice('forms/'.length),
              row.waiting,
            ]),
          )
        }).pipe(Effect.provide(TestContext.TestContext)),
      )
    expect(await waiting(Date.UTC(2026, 9, 12))).toEqual({
      'open/': true,
      'closed/': false,
      'shared/': true,
      'read/': false,
    })
    // Past its closing time the form is closed.
    expect((await waiting(Date.UTC(2026, 9, 21)))['open/']).toBe(false)
    // Answered: a file of Sara's in the folder target, a version of hers in
    // the shared file.
    const answer = async (path: string, owner: Person | null) => {
      const parent = path.slice(0, path.lastIndexOf('/'))
      const id = crypto.randomUUID()
      const version = crypto.randomUUID()
      await exec(
        `insert into nodes (id, tree_id, parent_id, name, path, depth, kind, origin, owner_id,
           current_version_id, created_at)
         values (?, ?, (select id from nodes where tree_id = ? and path = ?), ?, ?, ?, 'file',
           'data', ?, ?, ?)`,
        id,
        pushed.treeId,
        pushed.treeId,
        parent,
        path.slice(path.lastIndexOf('/') + 1),
        path,
        path.split('/').length,
        owner?.id ?? null,
        version,
        Date.now(),
      )
      await exec(
        `insert into node_versions (id, node_id, tree_id, revision, state, json_value, size,
           content_type, author_id, created_at)
         values (?, ?, ?, 1, 'live', '{}', 2, 'application/json', ?, ?)`,
        version,
        id,
        pushed.treeId,
        sara.id,
        Date.now(),
      )
    }
    await exec(
      `insert into nodes (id, tree_id, parent_id, name, path, depth, kind, origin, created_at)
       values (?, ?, (select id from nodes where tree_id = ? and path = 'open'), 'answers',
         'open/answers', 2, 'folder', 'data', ?)`,
      crypto.randomUUID(),
      pushed.treeId,
      pushed.treeId,
      Date.now(),
    )
    await answer(`open/answers/${sara.email}.json`, sara)
    await answer('shared/board.json', null)
    expect(await waiting(Date.UTC(2026, 9, 12))).toEqual({
      'open/': false,
      'closed/': false,
      'shared/': false,
      'read/': false,
    })
  })
})

describe('races around a share', () => {
  it('removes the target’s share even when another change replaced it after it was read', async () => {
    const w = await world()
    const path = `${w.ws.name}/acme/questions/`
    const target = { kind: 'email', email: w.sara.email } as const
    await setAs(w.adminAgent, path, target, 'read')
    // Between the read and the batch, someone else gives Sara write.
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) => /delete from shares/i.test(sql),
            async () => {
              await exec(
                "delete from shares where tree_id = ? and target_kind = 'email' and target = ?",
                w.treeId,
                w.sara.email.toLowerCase(),
              )
              await share(
                w.treeId,
                await w.node('questions'),
                'email',
                w.sara.email.toLowerCase(),
                'write',
                w.admin,
              )
            },
          ),
        },
      }),
    )
    await setAs(w.adminAgent, path, target, null)
    harness.reset()
    expect(
      await count(
        'shares',
        "tree_id = ? and target_kind = 'email' and target = ?",
        w.treeId,
        w.sara.email.toLowerCase(),
      ),
    ).toBe(0)
  })

  it('grants nothing to a team deleted between a push’s stage and its commit', async () => {
    const admin = await person('admin')
    const ws = await workspace(admin)
    const adminAgent = await agent(admin)
    const sales = await team(ws, 'Sales', [])
    const files = { 'index.html': '<title>Home</title>' }
    const staged = await stage(adminAgent, `${ws.name}/t`, files, {
      share: [{ target: { kind: 'team', team: 'Sales' }, role: 'read' }],
    })
    if (staged.pushId === null) throw new Error('nothing staged')
    await upload(adminAgent, staged.pushId, files, staged.missing)
    await exec('delete from teams where id = ?', sales.id)
    const failed = await failureAs(
      adminAgent,
      Effect.flatMap(Push, (push) => push.commit(staged.pushId!)),
    )
    expect(failed.code).toBe('conflict')
    expect(
      await count('shares', "target_kind = 'team' and target = ?", sales.id),
    ).toBe(0)
  })
})
