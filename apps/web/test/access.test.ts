import type { NodeId, Person, TreeId } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { and, eq, isNull } from 'drizzle-orm'
import { Effect, FastCheck as fc } from 'effect'
import { describe, expect, it } from 'vitest'

import { db, schema } from '../src/db/client.ts'
import {
  Access,
  TreeStore,
  type Caller,
  type NodeRow,
} from '../src/core/index.ts'
import { beforeBatch, exec } from './support/d1.ts'
import { harness, testRuntime } from './support/harness.ts'
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
  team,
  visitorCaller,
  workspace,
} from './support/trees.ts'

const TREE = {
  'index.html': '<title>Home</title>',
  'notes.txt': 'notes',
  'plans/index.html': '<title>Plans</title>',
  'plans/q3.html': '<title>Q3</title>',
  'plans/deep/brief.txt': 'brief',
}

/**
 * A workspace with two admins, a member who pushed one tree, another member
 * and someone from outside.
 */
const world = async () => {
  const admin = await person('admin')
  const ws = await workspace(admin)
  const otherAdmin = await person('other-admin')
  await join(ws, otherAdmin, 'admin')
  const creator = await person('creator')
  await join(ws, creator)
  const member = await person('member')
  await join(ws, member)
  const outsider = await person('outsider')
  const pushed = await pushAll(await agent(creator), `${ws.name}/acme`, TREE)
  if (!('treeId' in pushed)) throw new Error('no tree')
  const treeId = pushed.treeId
  const node = async (path: string) => {
    const found = await nodeAt(treeId, path)
    if (found === undefined) throw new Error(`no node at ${path}`)
    return found.id
  }
  return { admin, otherAdmin, creator, member, outsider, ws, treeId, node }
}

type World = Awaited<ReturnType<typeof world>>

const at = (w: World, path: string) => `${w.ws.name}/acme/${path}`

/** require(action) on a path, as the answer's code or 'ok'. */
const attempt = (
  caller: Caller,
  target: string,
  action: 'read' | 'write' | 'respond' | 'read-history' = 'read',
) =>
  runAs(
    caller,
    Effect.gen(function* () {
      const resolved = yield* (yield* TreeStore).locate(ref(target))
      return yield* (yield* Access).require(
        action,
        'missing' in resolved ? resolved : resolved.node,
      )
    }).pipe(
      Effect.map(() => 'ok' as const),
      Effect.catchAll((error) => Effect.succeed(error.code)),
    ),
  )

const rolesOf = (caller: Caller, target: string) =>
  runAs(
    caller,
    Effect.gen(function* () {
      const resolved = yield* (yield* TreeStore).locate(ref(target))
      if ('missing' in resolved) throw new Error(`missing ${target}`)
      return yield* (yield* Access).roleOn(resolved.node)
    }),
  )

describe('who may do what on a node', () => {
  it('gives the creator write through their share, and every admin write', async () => {
    const w = await world()
    for (const who of [w.creator, w.admin, w.otherAdmin]) {
      const caller = await agent(who)
      expect(await attempt(caller, at(w, 'plans/q3.html'), 'write')).toBe('ok')
    }
    const creator = await rolesOf(await agent(w.creator), at(w, ''))
    expect(creator.basis).toEqual([
      expect.objectContaining({
        kind: 'share',
        role: 'write',
        targetKind: 'email',
      }),
    ])
    const admin = await rolesOf(await agent(w.admin), at(w, ''))
    expect(admin.basis).toEqual([
      { kind: 'admin', workspaceId: w.ws.id, userId: w.admin.id },
    ])
  })

  it('shows a new tree to nobody else', async () => {
    const w = await world()
    expect(await attempt(await agent(w.member), at(w, 'index.html'))).toBe(
      'not_found',
    )
    expect(await attempt(await agent(w.outsider), at(w, 'index.html'))).toBe(
      'not_found',
    )
    expect(await attempt(visitorCaller(), at(w, 'index.html'))).toBe(
      'sign_in_required',
    )
  })

  it('opens a workspace share to members only', async () => {
    const w = await world()
    await share(
      w.treeId,
      await w.node('plans'),
      'workspace',
      w.ws.id,
      'read',
      w.creator,
    )
    expect(await attempt(await agent(w.member), at(w, 'plans/q3.html'))).toBe(
      'ok',
    )
    expect(await attempt(await agent(w.member), at(w, 'index.html'))).toBe(
      'not_found',
    )
    expect(await attempt(await agent(w.outsider), at(w, 'plans/q3.html'))).toBe(
      'not_found',
    )
    expect(
      await attempt(await agent(w.member), at(w, 'plans/q3.html'), 'write'),
    ).toBe('forbidden')
  })

  it('opens an email share to that person only', async () => {
    const w = await world()
    await share(
      w.treeId,
      await w.node('notes.txt'),
      'email',
      w.outsider.email,
      'read',
      w.creator,
    )
    expect(await attempt(await agent(w.outsider), at(w, 'notes.txt'))).toBe(
      'ok',
    )
    expect(await attempt(await agent(w.outsider), at(w, 'index.html'))).toBe(
      'not_found',
    )
    expect(await attempt(await agent(w.member), at(w, 'notes.txt'))).toBe(
      'not_found',
    )
  })

  it('opens an anyone share to visitors, without private capabilities', async () => {
    const w = await world()
    await share(
      w.treeId,
      await w.node('index.html'),
      'anyone',
      '*',
      'read',
      w.creator,
    )
    expect(await attempt(visitorCaller(), at(w, 'index.html'))).toBe('ok')
    expect(await attempt(visitorCaller(), at(w, 'notes.txt'))).toBe(
      'sign_in_required',
    )
    const roles = await rolesOf(visitorCaller(), at(w, 'index.html'))
    expect([...roles.caps]).toEqual(['read'])
    expect([...roles.privateCaps]).toEqual([])
  })

  it('adds roles up', async () => {
    const w = await world()
    await share(
      w.treeId,
      await w.node('plans'),
      'email',
      w.outsider.email,
      'read',
      w.creator,
    )
    await share(
      w.treeId,
      await w.node('plans/q3.html'),
      'email',
      w.outsider.email,
      'respond',
      w.creator,
    )
    const roles = await rolesOf(await agent(w.outsider), at(w, 'plans/q3.html'))
    expect([...roles.roles].sort()).toEqual(['read', 'respond'])
    expect([...roles.caps].sort()).toEqual(['read', 'read-authored', 'respond'])
    expect(
      await attempt(await agent(w.outsider), at(w, 'plans/q3.html'), 'respond'),
    ).toBe('ok')
    expect(
      await attempt(
        await agent(w.outsider),
        at(w, 'plans/index.html'),
        'respond',
      ),
    ).toBe('forbidden')
  })

  it('lets a scoped key see nothing outside its node', async () => {
    const w = await world()
    const scoped = await agent(w.creator, { scope: await w.node('plans') })
    expect(await attempt(scoped, at(w, 'plans/q3.html'), 'write')).toBe('ok')
    expect(await attempt(scoped, at(w, 'plans/'))).toBe('ok')
    expect(await attempt(scoped, at(w, 'index.html'))).toBe('not_found')
    expect(await attempt(scoped, at(w, ''))).toBe('not_found')
  })

  it("refuses a read-only key every write, while the creator's and an admin's read-only keys still read", async () => {
    const w = await world()
    for (const who of [w.creator, w.admin]) {
      const readOnly = await agent(who, { readOnly: true })
      expect(await attempt(readOnly, at(w, 'plans/q3.html'))).toBe('ok')
      expect(
        await attempt(readOnly, at(w, 'plans/q3.html'), 'read-history'),
      ).toBe('ok')
      expect(await attempt(readOnly, at(w, 'plans/q3.html'), 'write')).toBe(
        'forbidden',
      )
    }
  })

  it('refuses a read-only key tree creation, in member and again in the commit', async () => {
    const w = await world()
    const readOnly = await agent(w.creator, { readOnly: true })
    const refused = await failureAs(
      readOnly,
      Effect.flatMap(Access, (access) =>
        Effect.flatMap(
          Effect.flatMap(TreeStore, (store) => store.workspace(w.ws.name)),
          (ws) => access.member(ws),
        ),
      ),
    )
    expect(refused.code).toBe('forbidden')
    // A key made read only after member let it through fails the batch.
    const key = await agent(w.creator)
    const failed = await failureAs(
      key,
      Effect.gen(function* () {
        const store = yield* TreeStore
        const access = yield* Access
        const membership = yield* access.member(
          yield* store.workspace(w.ws.name),
        )
        yield* Effect.promise(() =>
          exec(
            'update agent_keys set read_only = 1 where id = ?',
            key.via.kind === 'agent' ? key.via.keyId : '',
          ),
        )
        return yield* store.change(null, (cs) =>
          Effect.sync(() => {
            const root = cs.createTree(membership, 'sneaky')
            cs.event({ type: 'push', path: '', node: root })
          }),
        )
      }),
    )
    expect(failed.code).toBe('conflict')
    expect(
      await env.DB.prepare(
        'select count(*) as n from trees where name = ? and workspace_id = ?',
      )
        .bind('sneaky', w.ws.id)
        .first('n'),
    ).toBe(0)
  })

  it('answers missing and unreadable alike: not_found for a person, sign_in_required for a visitor', async () => {
    const w = await world()
    const outsider = await agent(w.outsider)
    const missing = await failureAs(
      outsider,
      Effect.gen(function* () {
        const resolved = yield* (yield* TreeStore).locate(
          ref(at(w, 'nope.html')),
        )
        return yield* (yield* Access).require(
          'read',
          'missing' in resolved ? resolved : resolved.node,
        )
      }),
    )
    const hidden = await failureAs(
      outsider,
      Effect.gen(function* () {
        const resolved = yield* (yield* TreeStore).locate(
          ref(at(w, 'notes.txt')),
        )
        return yield* (yield* Access).require(
          'read',
          'missing' in resolved ? resolved : resolved.node,
        )
      }),
    )
    expect(missing.code).toBe('not_found')
    expect({ ...hidden, path: null }).toEqual({ ...missing, path: null })
    expect(await attempt(visitorCaller(), at(w, 'nope.html'))).toBe(
      'sign_in_required',
    )
    expect(await attempt(visitorCaller(), at(w, 'notes.txt'))).toBe(
      'sign_in_required',
    )
  })
})

// The point check and the list check agree on random trees, shares and callers.

// `_` files and folders at several depths, so read through reach is part of
// what the two checks must agree on.
const PATHS = [
  'a',
  'a/b',
  'a/b/c.html',
  'a/d.txt',
  'e.html',
  'f',
  'f/g.txt',
  'f/h',
  'f/h/i.html',
  '_layout.html',
  'a/_theme.css',
  'a/b/_components',
  'a/b/_components/x-y.js',
  'f/_old',
  'f/_old/_z.txt',
  // People's data, including where a `_` name would otherwise reach it.
  'a/answers',
  'a/answers/p.json',
  'f/_old/notes.json',
  '_inbox',
  '_inbox/x.json',
]

/** People's data, by the writer each belongs to. */
const DATA = new Map<string, 'member' | 'outsider' | null>([
  ['a/answers', null],
  ['a/answers/p.json', 'outsider'],
  ['f/_old/notes.json', 'member'],
  ['_inbox', null],
  ['_inbox/x.json', 'outsider'],
])

type ShareKind = 'email' | 'workspace' | 'anyone' | 'team' | 'twin-team'

interface Scenario {
  readonly shares: readonly {
    readonly at: number
    /** 'twin-team': a team of the same name in another workspace. */
    readonly kind: ShareKind
    readonly role: 'read' | 'respond' | 'write'
  }[]
  readonly caller:
    | 'visitor'
    | 'member'
    | 'admin'
    | 'outsider'
    | 'scoped'
    | 'readonly'
  readonly scopeAt: number
  readonly deleted: number | null
  /** The workspace is suspended for this run. */
  readonly suspended?: boolean
}

const scenario: fc.Arbitrary<Scenario> = fc.record({
  shares: fc.array(
    fc.record({
      at: fc.integer({ min: -1, max: PATHS.length - 1 }),
      kind: fc.constantFrom<ShareKind>(
        'email',
        'workspace',
        'anyone',
        'team',
        'twin-team',
      ),
      role: fc.constantFrom('read', 'respond', 'write'),
    }),
    { maxLength: 4 },
  ),
  caller: fc.constantFrom(
    'visitor',
    'member',
    'admin',
    'outsider',
    'scoped',
    'readonly',
  ),
  scopeAt: fc.integer({ min: -1, max: PATHS.length - 1 }),
  deleted: fc.option(fc.integer({ min: 0, max: PATHS.length - 1 }), {
    nil: null,
  }),
  suspended: fc.constantFrom(false, false, false, true),
})

let built: {
  admin: Person
  member: Person
  outsider: Person
  ws: { id: string; name: string }
  design: { id: string }
  twin: { id: string }
} | null = null

/**
 * The member is in the workspace's Design team. Another workspace has a
 * Design team too, which the member and the outsider are in.
 */
const base = async () => {
  if (built !== null) return built
  const admin = await person('admin')
  const ws = await workspace(admin)
  const member = await person('member')
  await join(ws, member)
  const outsider = await person('outsider')
  const design = await team(ws, 'Design', [member])
  const elsewhere = await workspace(outsider)
  await join(elsewhere, member)
  const twin = await team(elsewhere, 'Design', [outsider, member])
  built = { admin, member, outsider, ws, design, twin }
  return built
}

/** A tree written row by row, so each run is cheap. */
const plantTree = async (
  ws: { id: string; name: string },
  creator: Person,
  s: Scenario,
) => {
  const treeId = Array.from(crypto.getRandomValues(new Uint8Array(20)))
    .map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36])
    .join('') as TreeId
  const name = `t${treeId.slice(0, 10)}`
  const rootId = crypto.randomUUID() as NodeId
  const ids = new Map<string, NodeId>([['', rootId]])
  const now = Date.now()
  const statements = [
    env.DB.prepare(
      `insert into trees (id, workspace_id, name, root_node_id, created_by, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    ).bind(treeId, ws.id, name, rootId, creator.id, now),
    env.DB.prepare(
      `insert into nodes (id, tree_id, parent_id, name, path, depth, kind, origin, created_at)
       values (?, ?, null, '', '', 0, 'folder', 'authored', ?)`,
    ).bind(rootId, treeId, now),
  ]
  for (const [index, path] of PATHS.entries()) {
    const id = crypto.randomUUID() as NodeId
    ids.set(path, id)
    const parent = path.includes('/')
      ? path.slice(0, path.lastIndexOf('/'))
      : ''
    const file = path.slice(path.lastIndexOf('/') + 1).includes('.')
    statements.push(
      env.DB.prepare(
        `insert into nodes (id, tree_id, parent_id, name, path, depth, kind, origin, owner_id,
           created_at, deleted_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        treeId,
        ids.get(parent) ?? rootId,
        path.slice(path.lastIndexOf('/') + 1),
        path,
        path.split('/').length,
        file ? 'file' : 'folder',
        DATA.has(path) ? 'data' : 'authored',
        ((writer) => (writer == null ? null : (built?.[writer].id ?? null)))(
          DATA.get(path),
        ),
        now,
        s.deleted === index ? now : null,
      ),
    )
  }
  const pathAt = (i: number) => (i < 0 ? '' : (PATHS[i] ?? ''))
  for (const [i, sh] of s.shares.entries()) {
    statements.push(
      env.DB.prepare(
        `insert into shares (id, tree_id, node_id, target_kind, target, role, created_by, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
      ).bind(
        `${treeId}-${i}`,
        treeId,
        ids.get(pathAt(sh.at)),
        sh.kind === 'twin-team' ? 'team' : sh.kind,
        sh.kind === 'email'
          ? (built?.outsider.email ?? '')
          : sh.kind === 'workspace'
            ? ws.id
            : sh.kind === 'team'
              ? (built?.design.id ?? '')
              : sh.kind === 'twin-team'
                ? (built?.twin.id ?? '')
                : '*',
        sh.role,
        creator.id,
        now,
      ),
    )
  }
  statements.push(
    env.DB.prepare('update workspaces set suspended_at = ? where id = ?').bind(
      s.suspended === true ? now : null,
      ws.id,
    ),
  )
  await env.DB.batch(statements)
  return { treeId, ids, name, pathAt }
}

const isUnder = (path: string, prefix: string): boolean =>
  prefix === '' || path === prefix || path.startsWith(`${prefix}/`)

/**
 * Who reads what, written out on its own: the caller's shares and role on
 * live nodes, within an agent key's scope, plus read on an authored `_` node
 * through any node at or below the folder its `_` part starts in that those
 * grants cover. Never read through reach on people's data.
 */
const expectedReadable = (s: Scenario): ReadonlySet<string> => {
  const index = (path: string) => PATHS.indexOf(path)
  const live = (path: string) => path === '' || s.deleted !== index(path)
  const pathAt = (i: number) => (i < 0 ? '' : (PATHS[i] ?? ''))
  const origin = (path: string) => (DATA.has(path) ? 'data' : 'authored')
  const matches = (kind: ShareKind) =>
    kind === 'anyone' ||
    (kind === 'email' && (s.caller === 'outsider' || s.caller === 'scoped')) ||
    ((kind === 'workspace' || kind === 'team') &&
      (s.caller === 'member' || s.caller === 'readonly'))
  const scope = s.caller === 'scoped' ? pathAt(s.scopeAt) : ''
  // A node holds one share per target: a later one for the same node and
  // target is not planted, as the database keeps the first.
  const target = (kind: ShareKind) => (kind === 'twin-team' ? 'twin' : kind)
  const planted = s.shares.filter(
    (given, i) =>
      s.shares.findIndex(
        (other) =>
          other.at === given.at && target(other.kind) === target(given.kind),
      ) === i,
  )
  const direct = (path: string): boolean => {
    if (!live(scope) || !isUnder(path, scope)) return false
    if (s.caller === 'admin') return true
    return planted.some(
      (given) =>
        matches(given.kind) &&
        live(pathAt(given.at)) &&
        isUnder(path, pathAt(given.at)) &&
        (given.role !== 'respond' || origin(path) === 'authored') &&
        // Public grants read data only from a data node made public.
        (given.kind !== 'anyone' ||
          origin(path) === 'authored' ||
          origin(pathAt(given.at)) === 'data'),
    )
  }
  /** The person the caller is, for what they wrote. */
  const who =
    s.caller === 'member' || s.caller === 'readonly'
      ? 'member'
      : s.caller === 'outsider' || s.caller === 'scoped'
        ? 'outsider'
        : null
  const owns = (path: string): boolean =>
    who !== null &&
    origin(path) === 'data' &&
    DATA.get(path) === who &&
    live(scope) &&
    isUnder(path, scope)
  const all = ['', ...PATHS].filter(live)
  const readable = new Set<string>()
  // A suspended workspace reads as missing, for everyone.
  if (s.suspended === true) return readable
  for (const path of all) {
    if (direct(path) || owns(path)) {
      readable.add(path)
      continue
    }
    const first = path.split('/').findIndex((name) => name.startsWith('_'))
    if (first < 0 || origin(path) !== 'authored') continue
    const from = path.split('/').slice(0, first).join('/')
    if (all.some((other) => isUnder(other, from) && direct(other))) {
      readable.add(path)
    }
  }
  return readable
}

describe('teams', () => {
  it('opens a team share to the team’s members in its own workspace only', async () => {
    const w = await world()
    const design = await team(w.ws, 'Design', [w.member])
    // The same name in another workspace, with the outsider and the member.
    const elsewhere = await workspace(w.outsider)
    await join(elsewhere, w.member)
    const twin = await team(elsewhere, 'Design', [w.outsider, w.member])
    await share(
      w.treeId,
      await w.node('plans'),
      'team',
      design.id,
      'read',
      w.creator,
    )
    await share(
      w.treeId,
      await w.node('notes.txt'),
      'team',
      twin.id,
      'read',
      w.creator,
    )
    const member = await agent(w.member)
    expect(await attempt(member, at(w, 'plans/q3.html'))).toBe('ok')
    expect(await attempt(member, at(w, 'index.html'))).toBe('not_found')
    // A share to another workspace's team reaches nobody here.
    expect(await attempt(member, at(w, 'notes.txt'))).toBe('not_found')
    expect(await attempt(await agent(w.outsider), at(w, 'notes.txt'))).toBe(
      'not_found',
    )
    expect(await attempt(await agent(w.outsider), at(w, 'plans/q3.html'))).toBe(
      'not_found',
    )
    const roles = await rolesOf(member, at(w, 'plans/q3.html'))
    expect(roles.basis).toEqual([
      expect.objectContaining({ kind: 'share', targetKind: 'team' }),
      {
        kind: 'team-member',
        teamId: design.id,
        workspaceId: w.ws.id,
        userId: w.member.id,
      },
    ])
  })

  it('stops reaching a person removed from the team, or from the workspace, at once', async () => {
    const w = await world()
    const design = await team(w.ws, 'Design', [w.member, w.creator])
    await share(
      w.treeId,
      await w.node('plans'),
      'team',
      design.id,
      'write',
      w.admin,
    )
    const member = await agent(w.member)
    expect(await attempt(member, at(w, 'plans/q3.html'), 'write')).toBe('ok')
    await exec(
      'delete from team_members where team_id = ? and user_id = ?',
      design.id,
      w.member.id,
    )
    expect(await attempt(member, at(w, 'plans/q3.html'))).toBe('not_found')
    // A team place without the membership behind it reaches nothing.
    await inTeam(design, w.outsider)
    expect(await attempt(await agent(w.outsider), at(w, 'plans/q3.html'))).toBe(
      'not_found',
    )
  })

  it('fails a commit whose team place went between the check and the batch', async () => {
    const w = await world()
    const design = await team(w.ws, 'Design', [w.member])
    await share(
      w.treeId,
      await w.node('plans'),
      'team',
      design.id,
      'write',
      w.admin,
    )
    const member = await agent(w.member)
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) => sql.includes('insert into change_guards'),
            async () => {
              await exec(
                'delete from team_members where team_id = ? and user_id = ?',
                design.id,
                w.member.id,
              )
            },
          ),
        },
      }),
    )
    try {
      const failed = await failureAs(
        member,
        Effect.gen(function* () {
          const store = yield* TreeStore
          const located = yield* store.locate(ref(at(w, 'plans/q3.html')))
          if ('missing' in located) throw new Error('missing')
          const granted = yield* (yield* Access).require('share', located.node)
          return yield* store.change(w.treeId as TreeId, (cs) =>
            Effect.sync(() => {
              cs.grant(granted, {
                targetKind: 'email',
                target: 'x@example.com',
                role: 'read',
              })
              cs.event({ type: 'share', path: granted.path, node: granted })
              return {}
            }),
          )
        }),
      )
      expect(failed.code).toBe('conflict')
    } finally {
      harness.reset()
    }
  })

  it('counts a team place made after a view’s first issuance as new', async () => {
    const w = await world()
    const design = await team(w.ws, 'Design')
    await share(
      w.treeId,
      await w.node('plans'),
      'team',
      design.id,
      'read',
      w.admin,
    )
    const order = async () =>
      (await env.DB.prepare(
        'select value from grant_clock where id = 1',
      ).first<{
        value: number
      }>())!.value
    const before = await order()
    await inTeam(design, w.member)
    const after = await order()
    expect(after).toBeGreaterThan(before)
    const readsAsOf = (asOf: number) =>
      runAs(
        // A view handle on the tree, as the frame asks.
        {
          person: w.member,
          via: {
            kind: 'handle',
            treeId: w.treeId as TreeId,
            sessionId: null,
            anonSessionId: null,
            handleHash: 'h',
          },
          requestId: 'test',
        },
        Effect.gen(function* () {
          const located = yield* (yield* TreeStore).locate(
            ref(at(w, 'plans/q3.html')),
          )
          if ('missing' in located) throw new Error('missing')
          return yield* (yield* Access).readsAsOf(located.node, asOf)
        }),
      )
    expect(await readsAsOf(before)).toBe(false)
    expect(await readsAsOf(after)).toBe(true)
  })
})

describe('grant order', () => {
  it('stamps a grant anew when an update changes who or what it reaches', async () => {
    const w = await world()
    const design = await team(w.ws, 'Design', [w.member])
    const other = await team(w.ws, 'Other')
    await share(
      w.treeId,
      await w.node('plans'),
      'email',
      w.outsider.email,
      'read',
      w.admin,
    )
    const order = async (sql: string, ...binds: unknown[]) =>
      (await env.DB.prepare(sql)
        .bind(...binds)
        .first<{ o: number }>())!.o
    const changes: [string, string, string, unknown[]][] = [
      [
        'team place, person',
        'select grant_order as o from team_members where team_id = ?',
        'update team_members set user_id = ? where team_id = ?',
        [w.creator.id, design.id],
      ],
      [
        'team place, team',
        'select grant_order as o from team_members where team_id = ?',
        'update team_members set team_id = ? where team_id = ?',
        [other.id, design.id],
      ],
      [
        'membership, person',
        'select grant_order as o from workspace_members where workspace_id = ? and user_id = ?',
        'update workspace_members set user_id = ? where workspace_id = ? and user_id = ?',
        [w.outsider.id, w.ws.id, w.member.id],
      ],
      [
        'share, target',
        "select grant_order as o from shares where tree_id = ? and target_kind = 'email'",
        "update shares set target = ? where tree_id = ? and target_kind = 'email'",
        ['someone@example.com', w.treeId],
      ],
    ]
    for (const [what, read, update, binds] of changes) {
      const readBinds =
        what === 'team place, person'
          ? [design.id]
          : what === 'team place, team'
            ? [design.id]
            : what === 'membership, person'
              ? [w.ws.id, w.member.id]
              : [w.treeId]
      const before = await order(read, ...readBinds)
      await exec(update, ...binds)
      const afterBinds =
        what === 'team place, team'
          ? [other.id]
          : what === 'membership, person'
            ? [w.ws.id, w.outsider.id]
            : readBinds
      expect(await order(read, ...afterBinds), what).toBeGreaterThan(before)
    }
  })
})

describe('suspended and deleted workspaces', () => {
  const suspend = (w: World) =>
    exec(
      'update workspaces set suspended_at = ? where id = ?',
      Date.now(),
      w.ws.id,
    )

  it('reads every node of a suspended workspace as missing, and refuses its members changes with the suspension', async () => {
    const w = await world()
    await share(w.treeId, await w.node(''), 'anyone', '*', 'read', w.creator)
    await suspend(w)
    for (const who of [w.admin, w.creator, w.member, w.outsider]) {
      expect(await attempt(await agent(who), at(w, 'index.html'))).toBe(
        'not_found',
      )
    }
    expect(await attempt(visitorCaller(), at(w, 'index.html'))).toBe(
      'sign_in_required',
    )
    const refused = await failureAs(
      await agent(w.creator),
      Effect.gen(function* () {
        const located = yield* (yield* TreeStore).locate(
          ref(at(w, 'index.html')),
        )
        if ('missing' in located) throw new Error('missing')
        return yield* (yield* Access).require('write', located.node)
      }),
    )
    expect(refused).toMatchObject({
      code: 'forbidden',
      message: `${w.ws.name} is suspended. A super admin of ${env.DEPLOYMENT_NAME} can lift the suspension.`,
    })
    // Someone from outside learns nothing.
    expect(
      await attempt(await agent(w.outsider), at(w, 'index.html'), 'write'),
    ).toBe('not_found')
    const member = await failureAs(
      await agent(w.member),
      Effect.flatMap(Access, (access) =>
        access.member({
          id: w.ws.id,
          name: w.ws.name,
          createdBy: w.admin.id,
          createdAt: 0,
          suspendedAt: Date.now(),
          deletedAt: null,
        } as never),
      ),
    )
    expect(member.code).toBe('forbidden')
    await exec(
      'update workspaces set suspended_at = null where id = ?',
      w.ws.id,
    )
    expect(
      await attempt(await agent(w.creator), at(w, 'index.html'), 'write'),
    ).toBe('ok')
  })

  it('reads every node of a deleted workspace as missing, for everyone', async () => {
    const w = await world()
    await share(w.treeId, await w.node(''), 'anyone', '*', 'read', w.creator)
    await exec(
      'update workspaces set deleted_at = ? where id = ?',
      Date.now(),
      w.ws.id,
    )
    for (const who of [w.admin, w.creator, w.member]) {
      expect(
        await attempt(await agent(who), at(w, 'index.html'), 'write'),
      ).toBe('not_found')
    }
    expect(await attempt(visitorCaller(), at(w, 'index.html'))).toBe(
      'sign_in_required',
    )
  })
})

describe('people’s data', () => {
  /** A data node written straight into D1, as a send leaves one. */
  const plantData = async (
    w: World,
    path: string,
    owner: Person | null,
    kind: 'file' | 'folder' = 'file',
  ) => {
    const parent = path.slice(0, path.lastIndexOf('/'))
    const id = crypto.randomUUID()
    await exec(
      `insert into nodes (id, tree_id, parent_id, name, path, depth, kind, origin, owner_id,
         created_at)
       values (?, ?, (select id from nodes where tree_id = ? and path = ? and deleted_at is null),
         ?, ?, ?, ?, 'data', ?, ?)`,
      id,
      w.treeId,
      w.treeId,
      parent,
      path.slice(path.lastIndexOf('/') + 1),
      path,
      path.split('/').length,
      kind,
      owner?.id ?? null,
      Date.now(),
    )
    if (kind === 'file') {
      const version = crypto.randomUUID()
      await exec(
        `insert into node_versions (id, node_id, tree_id, revision, state, json_value, size,
           content_type, author_id, created_at)
         values (?, ?, ?, 1, 'live', '{}', 2, 'application/json', ?, ?)`,
        version,
        id,
        w.treeId,
        (owner ?? w.creator).id,
        Date.now(),
      )
      await exec(
        'update nodes set current_version_id = ? where id = ?',
        version,
        id,
      )
    }
    return id
  }

  it('lets the writer read and withdraw their own data with no share, and nobody else withdraw it', async () => {
    const w = await world()
    await plantData(w, 'plans/answers', null, 'folder')
    await plantData(w, 'plans/answers/o.json', w.outsider)
    const outsider = await agent(w.outsider)
    expect(await attempt(outsider, at(w, 'plans/answers/o.json'))).toBe('ok')
    expect(await attempt(outsider, at(w, 'plans/q3.html'))).toBe('not_found')
    const withdraws = (caller: Caller) =>
      runAs(
        caller,
        Effect.gen(function* () {
          const resolved = yield* (yield* TreeStore).locate(
            ref(at(w, 'plans/answers/o.json')),
          )
          if ('missing' in resolved) throw new Error('missing')
          return yield* (yield* Access).require('withdraw-own', resolved.node)
        }).pipe(
          Effect.map((granted) => granted.basis),
          Effect.catchAll((error) => Effect.succeed(error.code)),
        ),
      )
    expect(await withdraws(outsider)).toEqual([
      expect.objectContaining({ kind: 'owner', userId: w.outsider.id }),
    ])
    // The creator reads everything but withdraws only their own.
    expect(await withdraws(await agent(w.creator))).toBe('forbidden')
    expect(await withdraws(await agent(w.outsider, { readOnly: true }))).toBe(
      'forbidden',
    )
  })

  it('keeps answers from respondents and public readers, unless a data folder is itself public', async () => {
    const w = await world()
    const answers = await plantData(w, 'plans/answers', null, 'folder')
    await plantData(w, 'plans/answers/m.json', w.member)
    await share(
      w.treeId,
      await w.node(''),
      'email',
      w.outsider.email,
      'respond',
      w.creator,
    )
    await share(w.treeId, await w.node(''), 'anyone', '*', 'read', w.creator)
    const outsider = await agent(w.outsider)
    expect(await attempt(outsider, at(w, 'plans/q3.html'))).toBe('ok')
    expect(await attempt(outsider, at(w, 'plans/answers/m.json'))).toBe(
      'not_found',
    )
    expect(await attempt(visitorCaller(), at(w, 'plans/answers/m.json'))).toBe(
      'sign_in_required',
    )
    const readsData = (caller: Caller, path: string) =>
      runAs(
        caller,
        Effect.gen(function* () {
          const resolved = yield* (yield* TreeStore).locate(ref(at(w, path)))
          if ('missing' in resolved) throw new Error('missing')
          return yield* (yield* Access).require('read-data', resolved.node)
        }).pipe(
          Effect.map(() => 'ok' as const),
          Effect.catchAll((error) => Effect.succeed(error.code)),
        ),
      )
    expect(await readsData(outsider, 'plans/')).toBe('forbidden')
    expect(await readsData(await agent(w.creator), 'plans/')).toBe('ok')
    // The data folder made public: anyone reads it.
    await share(w.treeId, answers as NodeId, 'anyone', '*', 'read', w.creator)
    expect(await attempt(visitorCaller(), at(w, 'plans/answers/m.json'))).toBe(
      'ok',
    )
    expect(await readsData(outsider, 'plans/answers/')).toBe('ok')
  })
})

describe('the list check', () => {
  it('reaches the `_` files above a shared page, never a sibling folder’s or data', () => {
    const reached = expectedReadable({
      shares: [
        { at: PATHS.indexOf('a/b/c.html'), kind: 'email', role: 'read' },
      ],
      caller: 'outsider',
      scopeAt: -1,
      deleted: null,
    })
    // Their own answers are theirs to read, by ownership and not by reach.
    expect([...reached].sort()).toEqual([
      '_inbox/x.json',
      '_layout.html',
      'a/_theme.css',
      'a/answers/p.json',
      'a/b/_components',
      'a/b/_components/x-y.js',
      'a/b/c.html',
    ])
  })

  it('agrees with require(read) and the expected reach on random trees, shares and callers', async () => {
    const { admin, member, outsider, ws } = await base()
    const database = db(env)
    let reachedSome = false
    let reachedData = false
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const expected = expectedReadable(s)
        const tree = await plantTree(ws, admin, s)
        const caller: Caller =
          s.caller === 'visitor'
            ? visitorCaller()
            : s.caller === 'admin'
              ? await agent(admin)
              : s.caller === 'member'
                ? await agent(member)
                : s.caller === 'outsider'
                  ? await agent(outsider)
                  : s.caller === 'scoped'
                    ? await agent(outsider, {
                        scope: tree.ids.get(tree.pathAt(s.scopeAt)) ?? null,
                      })
                    : await agent(member, { readOnly: true })
        const live = await database
          .select()
          .from(schema.nodes)
          .where(
            and(
              eq(schema.nodes.treeId, tree.treeId),
              isNull(schema.nodes.deletedAt),
            ),
          )
          .all()
        const listed = await runAs(
          caller,
          Effect.gen(function* () {
            const readable = yield* (yield* Access).readable(tree.treeId)
            return yield* Effect.promise(() =>
              database
                .select({ id: schema.nodes.id })
                .from(schema.nodes)
                .where(
                  and(
                    eq(schema.nodes.treeId, tree.treeId),
                    isNull(schema.nodes.deletedAt),
                    readable.where,
                  ),
                )
                .all(),
            )
          }),
        )
        const listedIds = new Set(listed.map((row) => row.id))
        for (const node of live) {
          const point = await runAs(
            caller,
            Effect.flatMap(Access, (access) =>
              access.require('read', node as NodeRow),
            ).pipe(Effect.either),
          )
          const what = `${s.caller} on ${node.path} in ${JSON.stringify(s)}`
          expect(listedIds.has(node.id), what).toBe(point._tag === 'Right')
          expect(point._tag === 'Right', what).toBe(expected.has(node.path))
          if (
            point._tag === 'Right' &&
            point.right.basis[0]?.kind === 'reach'
          ) {
            reachedSome = true
            if (DATA.has(node.path)) reachedData = true
          }
        }
      }),
      {
        numRuns: 80,
        // Two shares on one node for one target: only the first is planted.
        examples: [
          [
            {
              shares: [
                { at: 15, kind: 'workspace', role: 'respond' },
                { at: 15, kind: 'workspace', role: 'read' },
              ],
              caller: 'member',
              scopeAt: 0,
              deleted: null,
            },
          ],
          // The same on the root for a read-only key: the respond share is
          // the one kept, and respond never reads the data file _inbox.
          [
            {
              shares: [
                { at: -1, kind: 'workspace', role: 'respond' },
                { at: -1, kind: 'workspace', role: 'read' },
              ],
              caller: 'readonly',
              scopeAt: 0,
              deleted: null,
            },
          ],
        ],
      },
    )
    // The runs exercised reach, and it never gave read on data.
    expect(reachedSome).toBe(true)
    expect(reachedData).toBe(false)
    // Eighty trees against real D1 take most of the default timeout when the
    // workspace's suites run in parallel.
  }, 90_000)
})
