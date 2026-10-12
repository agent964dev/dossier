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
import { exec } from './support/d1.ts'
import { runAs } from './support/people.ts'
import {
  agent,
  failureAs,
  join,
  nodeAt,
  person,
  pushAll,
  ref,
  share,
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

const DATA = new Set([
  'a/answers',
  'a/answers/p.json',
  'f/_old/notes.json',
  '_inbox',
  '_inbox/x.json',
])

interface Scenario {
  readonly shares: readonly {
    readonly at: number
    readonly kind: 'email' | 'workspace' | 'anyone'
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
}

const scenario: fc.Arbitrary<Scenario> = fc.record({
  shares: fc.array(
    fc.record({
      at: fc.integer({ min: -1, max: PATHS.length - 1 }),
      kind: fc.constantFrom('email', 'workspace', 'anyone'),
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
})

let built: {
  admin: Person
  member: Person
  outsider: Person
  ws: { id: string; name: string }
} | null = null

const base = async () => {
  if (built !== null) return built
  const admin = await person('admin')
  const ws = await workspace(admin)
  const member = await person('member')
  await join(ws, member)
  const outsider = await person('outsider')
  built = { admin, member, outsider, ws }
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
        `insert into nodes (id, tree_id, parent_id, name, path, depth, kind, origin, created_at,
           deleted_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        treeId,
        ids.get(parent) ?? rootId,
        path.slice(path.lastIndexOf('/') + 1),
        path,
        path.split('/').length,
        file ? 'file' : 'folder',
        DATA.has(path) ? 'data' : 'authored',
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
        sh.kind,
        sh.kind === 'email'
          ? (built?.outsider.email ?? '')
          : sh.kind === 'workspace'
            ? ws.id
            : '*',
        sh.role,
        creator.id,
        now,
      ),
    )
  }
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
  const matches = (kind: 'email' | 'workspace' | 'anyone') =>
    kind === 'anyone' ||
    (kind === 'email' && (s.caller === 'outsider' || s.caller === 'scoped')) ||
    (kind === 'workspace' && (s.caller === 'member' || s.caller === 'readonly'))
  const scope = s.caller === 'scoped' ? pathAt(s.scopeAt) : ''
  const direct = (path: string): boolean => {
    if (!live(scope) || !isUnder(path, scope)) return false
    if (s.caller === 'admin') return true
    return s.shares.some(
      (given) =>
        matches(given.kind) &&
        live(pathAt(given.at)) &&
        isUnder(path, pathAt(given.at)) &&
        (given.role !== 'respond' || origin(path) === 'authored'),
    )
  }
  const all = ['', ...PATHS].filter(live)
  const readable = new Set<string>()
  for (const path of all) {
    if (direct(path)) {
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
    expect([...reached].sort()).toEqual([
      '_layout.html',
      'a/_theme.css',
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
      { numRuns: 80 },
    )
    // The runs exercised reach, and it never gave read on data.
    expect(reachedSome).toBe(true)
    expect(reachedData).toBe(false)
  })
})
