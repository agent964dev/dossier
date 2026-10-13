// A page's forms never carry more than the people behind the page hold.
import type { NodeId, OpId, TreeId } from '@dossier/contracts'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { Access, Data, Shares, TreeStore } from '../src/core/index.ts'
import type { Caller } from '../src/core/index.ts'
import { exec } from './support/d1.ts'
import { liveValue, pageWith, seqOf, type FormTree } from './support/forms.ts'
import { harness } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  agent,
  dataFile,
  nodeAt,
  person,
  pushAll,
  ref,
  share,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const attempt = (caller: Caller, target: string, action = 'read') =>
  runAs(
    caller,
    Effect.gen(function* () {
      const resolved = yield* (yield* TreeStore).locate(ref(target))
      return yield* (yield* Access).require(
        action as never,
        'missing' in resolved ? resolved : resolved.node,
      )
    }).pipe(
      Effect.map(() => 'ok' as const),
      Effect.catchAll((error) =>
        Effect.succeed((error as { code: string }).code),
      ),
    ),
  )

const listedPaths = (caller: Caller, treeId: string) =>
  runAs(
    caller,
    Effect.gen(function* () {
      const readable = yield* (yield* Access).readable(treeId as TreeId)
      const { db, schema } = yield* Effect.promise(
        () => import('../src/db/client.ts'),
      )
      const { env } = yield* Effect.promise(() => import('cloudflare:workers'))
      return yield* Effect.promise(() =>
        db({ DB: env.DB })
          .select({ path: schema.nodes.path })
          .from(schema.nodes)
          .where(readable.where as never)
          .all(),
      )
    }),
  ).then((rows) => rows.map((r) => r.path).sort())

const world = async () => {
  const admin = await person('admin')
  const ws = await workspace(admin)
  const adminAgent = await agent(admin)
  const a = await person('a')
  const pushed = await pushAll(adminAgent, `${ws.name}/acme`, {
    'index.html': '<title>Home</title>',
    'hr/index.html': pageWith(
      '<form action="salaries/"><input name="s"><button>Send</button></form>',
      'HR',
    ),
    'hr/vote.html': pageWith(
      '<form action="decisions.json"><input name="d"><button>Send</button></form>',
      'Vote',
    ),
    'team/w/index.html': '<title>W</title>',
  })
  if (!('treeId' in pushed)) throw new Error('no tree')
  const treeId = pushed.treeId
  await dataFile(treeId, 'hr/salaries/a.json', { salary: 999 }, a)
  await dataFile(treeId, 'hr/decisions.json', { d: 'secret decision' }, admin)
  await exec(
    "update nodes set owner_id = null where tree_id = ? and path = 'hr/decisions.json'",
    treeId,
  )
  // W: someone outside the workspace given write on team/w only.
  const w = await person('w')
  await share(
    treeId,
    (await nodeAt(treeId, 'team/w'))!.id,
    'email',
    w.email.toLowerCase(),
    'write',
    admin,
  )
  const wAgent = await agent(w)
  const at = (p: string) => `${ws.name}/acme/${p}`
  return { admin, adminAgent, ws, treeId, a, w, wAgent, at }
}

describe('a subfolder writer and forms aimed outside their folder', () => {
  it('reads other people’s answers outside their reach through a read share on their own page', async () => {
    const x = await world()
    expect(await attempt(x.wAgent, x.at('hr/salaries/a.json'))).toBe(
      'not_found',
    )
    const pushed = await pushAll(
      x.wAgent,
      x.at('team/w'),
      {
        'index.html': '<title>W</title>',
        'p.html': pageWith(
          '<form action="../../hr/salaries/"><input name="s"><button>Send</button></form>',
          'P',
        ),
      },
      { force: true },
    )
    expect('number' in pushed).toBe(true)
    // W shares their own page with themselves.
    await runAs(
      x.wAgent,
      Effect.flatMap(Shares, (s) =>
        s.set({
          ref: ref(x.at('team/w/p.html')),
          target: { kind: 'email', email: x.w.email },
          role: 'read',
        }),
      ),
    )
    const point = await attempt(x.wAgent, x.at('hr/salaries/a.json'))
    const list = await listedPaths(x.wAgent, x.treeId)
    expect(point).toBe('not_found')
    expect(list).not.toContain('hr/salaries/a.json')
  })

  it('reads a shared file outside their reach through a respond share on their own subfolder', async () => {
    const x = await world()
    const pushed = await pushAll(
      x.wAgent,
      x.at('team/w'),
      {
        'index.html': '<title>W</title>',
        'sub/q.html': pageWith(
          '<form action="../../../hr/decisions.json"><input name="d"><button>Send</button></form>',
          'Q',
        ),
      },
      { force: true },
    )
    expect('number' in pushed).toBe(true)
    await runAs(
      x.wAgent,
      Effect.flatMap(Shares, (s) =>
        s.set({
          ref: ref(x.at('team/w/sub/')),
          target: { kind: 'email', email: x.w.email },
          role: 'respond',
        }),
      ),
    )
    const point = await attempt(x.wAgent, x.at('hr/decisions.json'))
    expect(point).toBe('not_found')
  })

  it('overwrites a shared file outside their reach through their own page', async () => {
    const x = await world()
    await pushAll(
      x.wAgent,
      x.at('team/w'),
      {
        'index.html': '<title>W</title>',
        'q.html': pageWith(
          '<form action="../../hr/decisions.json"><input name="d"><button>Send</button></form>',
          'Q',
        ),
      },
      { force: true },
    )
    await runAs(
      x.wAgent,
      Effect.flatMap(Shares, (s) =>
        s.set({
          ref: ref(x.at('team/w/q.html')),
          target: { kind: 'email', email: x.w.email },
          role: 'respond',
        }),
      ),
    )
    const browser = await sessionFor(x.w)
    const tree: FormTree = {
      owner: x.admin,
      ownerAgent: x.adminAgent,
      ws: x.ws,
      treeId: x.treeId as TreeId,
      name: 'acme',
    }
    const result = await runAs(
      browser,
      Effect.flatMap(Data, (data) =>
        Effect.gen(function* () {
          return data.write({
            tree: x.treeId as TreeId,
            page: 'team/w/q.html',
            path: 'hr/decisions.json',
            patch: { d: 'overwritten by w' },
            replace: false,
            opId: crypto.randomUUID() as OpId,
            seq: yield* Effect.promise(() => seqOf(tree)),
            as: null,
          } as never)
        }),
      ).pipe(Effect.flatten, Effect.either),
    )
    // W never answered in hr, so W's page carries no write there.
    expect(result._tag).toBe('Left')
    expect((await liveValue(x.treeId, 'hr/decisions.json'))?.value).toEqual({
      d: 'secret decision',
    })
  })

  it('creates a data file in a folder outside their reach through their own page, with no page share', async () => {
    const x = await world()
    await pushAll(
      x.wAgent,
      x.at('team/w'),
      {
        'index.html': '<title>W</title>',
        'p.html': pageWith(
          '<form action="../../hr/salaries/"><input name="s"><button>Send</button></form>',
          'P',
        ),
      },
      { force: true },
    )
    // hr/planted does not exist yet; hr is an authored folder W cannot write.
    const browser = await sessionFor(x.w)
    const tree: FormTree = {
      owner: x.admin,
      ownerAgent: x.adminAgent,
      ws: x.ws,
      treeId: x.treeId as TreeId,
      name: 'acme',
    }
    const host = (await nodeAt(x.treeId, 'team/w/p.html'))!.id as NodeId
    const sent = await runAs(
      browser,
      Effect.flatMap(Data, (data) =>
        Effect.gen(function* () {
          return data.send({
            treeId: x.treeId,
            page: 'team/w/p.html',
            seq: yield* Effect.promise(() => seqOf(tree)),
            form: { host, target: 'hr/salaries/', id: null },
            entries: [['s', 'planted']],
            submitter: null,
            entry: null,
            opId: crypto.randomUUID(),
            as: null,
          } as never)
        }),
      ).pipe(Effect.flatten, Effect.either),
    )
    // W never answered in hr, so a form on W's page sends nothing there.
    expect(sent._tag === 'Left' ? sent.left.code : 'sent').toBe('forbidden')
    expect(
      await nodeAt(x.treeId, 'hr/salaries/' + x.w.email + '.json'),
    ).toBeUndefined()
  })
})

describe('who may share', () => {
  it('refuses a read-only key and a key scoped elsewhere, and tells a guest only members name teams', async () => {
    const x = await world()
    const ro = await agent(x.w, { readOnly: true })
    const scoped = await agent(x.w, {
      scope: (await nodeAt(x.treeId, 'team/w/index.html'))!.id,
    })
    const setWith = (caller: Caller, path: string) =>
      runAs(
        caller,
        Effect.flatMap(Shares, (s) =>
          s.set({
            ref: ref(x.at(path)),
            target: { kind: 'anyone' },
            role: 'write',
          }),
        ).pipe(
          Effect.map(() => 'ok'),
          Effect.catchAll((e) => Effect.succeed((e as { code: string }).code)),
        ),
      )
    const out = {
      readOnly: await setWith(ro, 'team/w/'),
      scopedOutside: await setWith(scoped, 'team/w/'),
      nonMemberWorkspace: await runAs(
        x.wAgent,
        Effect.flatMap(Shares, (s) =>
          s.set({
            ref: ref(x.at('team/w/')),
            target: { kind: 'workspace' },
            role: 'write',
          }),
        ).pipe(
          Effect.map(() => 'ok'),
          Effect.catchAll((e) => Effect.succeed((e as { code: string }).code)),
        ),
      ),
    }
    // A guest with write may share with the whole workspace, as the plan
    // allows; a read-only key and a key scoped elsewhere may not.
    expect(out).toEqual({
      readOnly: 'forbidden',
      scopedOutside: 'not_found',
      nonMemberWorkspace: 'ok',
    })
    // Only a member names the workspace's teams.
    const team = await runAs(
      x.wAgent,
      Effect.flatMap(Shares, (s) =>
        s.set({
          ref: ref(x.at('team/w/')),
          target: { kind: 'team', team: 'Design' },
          role: 'read',
        }),
      ).pipe(Effect.flip),
    )
    expect(team.message).toBe(
      `Only members of ${x.ws.name} share with its teams.`,
    )
  })
})
