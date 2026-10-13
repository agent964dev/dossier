// A change rests on every basis that gave its actions, and its batch checks
// each still holds. Someone may hold a node through many bases (a member of
// 200 teams, each with write on the root): the checks are split into
// statements within D1's limits (100 bound values, 100 KB, expression depth
// 100), repeated bases are checked once, and one basis lost between the
// check and the batch still fails the whole change.
import type { AuthoredSeq, NodeId, OpId, TreeId } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { Access, Data, Files, Shares, TreeStore } from '../src/core/index.ts'
import { beforeBatch, exec, recordingStatements, rows } from './support/d1.ts'
import { formRef, pageWith, sendAs, type FormTree } from './support/forms.ts'
import { harness, testRuntime } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  agent,
  failureAs,
  join,
  nodeAt,
  person,
  pushAll,
  ref,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const TEAMS = 200

const PLAN = pageWith(
  `<p>Plan.</p><dossier-comments></dossier-comments>
   <form action="answers/" method="post"><input name="role"><button>Send</button></form>`,
  'Plan',
)

/**
 * A tree whose root each of 200 teams may write, and a member of all of
 * them, who holds the root only through those teams.
 */
const world = async () => {
  const admin = await person('admin')
  const ws = await workspace(admin)
  const adminKey = await agent(admin)
  const name = `g${crypto.randomUUID().slice(0, 8)}`
  const pushed = await pushAll(adminKey, `${ws.name}/${name}`, {
    'plan.html': PLAN,
    'notes/a.txt': 'a',
    'notes/b.txt': 'b',
    'docs/readme.txt': 'readme',
  })
  if (!('treeId' in pushed)) throw new Error('no tree')
  const treeId = pushed.treeId as TreeId
  const member = await person('member')
  await join(ws, member)
  const root = (await nodeAt(treeId, ''))!.id
  const now = Date.now()
  const statements: D1PreparedStatement[] = []
  const teams: string[] = []
  for (let n = 0; n < TEAMS; n += 1) {
    const teamId = crypto.randomUUID()
    teams.push(teamId)
    statements.push(
      env.DB.prepare(
        'insert into teams (id, workspace_id, name, created_by, created_at) values (?, ?, ?, ?, ?)',
      ).bind(teamId, ws.id, `Team ${n}`, admin.id, now),
      env.DB.prepare(
        'insert into team_members (team_id, user_id, created_at) values (?, ?, ?)',
      ).bind(teamId, member.id, now),
      env.DB.prepare(
        `insert into shares (id, tree_id, node_id, target_kind, target, role, created_by, created_at)
         values (?, ?, ?, 'team', ?, 'write', ?, ?)`,
      ).bind(crypto.randomUUID(), treeId, root, teamId, admin.id, now),
    )
  }
  await env.DB.batch(statements)
  const tree: FormTree = {
    owner: admin,
    ownerAgent: adminKey,
    ws,
    treeId,
    name,
  }
  return {
    admin,
    ws,
    name,
    treeId,
    member,
    teams,
    tree,
    at: (path: string) => `${ws.name}/${name}/${path}`,
  }
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength

describe('a change by someone who holds a node through 200 teams', () => {
  it('commits pushes, deletions, comments, sends and shares within D1’s limits', async () => {
    const w = await world()
    const recorded = recordingStatements(env.DB)
    harness.use(testRuntime({ env: { DB: recorded.db } }))
    const key = await agent(w.member)
    const scoped = await agent(w.member, {
      scope: (await nodeAt(w.treeId, 'docs'))!.id as NodeId,
    })
    const session = await sessionFor(w.member)
    const outcomes: Record<string, string> = {}
    const attempt = async (name: string, run: () => Promise<unknown>) => {
      try {
        await run()
        outcomes[name] = 'ok'
      } catch (error) {
        const text = String(error)
        outcomes[name] =
          /D1_ERROR[^\n]*/.exec(text)?.[0] ?? text.split('\n')[0]!
      }
    }
    await attempt('push', () =>
      pushAll(
        key,
        w.at('notes'),
        { 'a.txt': 'a2', 'b.txt': 'b' },
        {
          force: true,
        },
      ).then((r) => {
        if (!('number' in r)) throw new Error(JSON.stringify(r))
      }),
    )
    await attempt('push with a scoped key', () =>
      pushAll(
        scoped,
        w.at('docs'),
        { 'readme.txt': 'readme 2' },
        {
          force: true,
        },
      ).then((r) => {
        if (!('number' in r)) throw new Error(JSON.stringify(r))
      }),
    )
    await attempt('rm', () =>
      runAs(
        key,
        Effect.flatMap(Files, (f) => f.rm({ ref: ref(w.at('notes/b.txt')) })),
      ),
    )
    await attempt('comment', async () => {
      const seq = (
        await rows<{ s: number }>(
          'select authored_seq as s from trees where id = ?',
          w.treeId,
        )
      )[0]!.s
      await runAs(
        session,
        Effect.flatMap(Data, (data) =>
          data.write({
            tree: w.treeId,
            page: 'plan.html',
            path: 'plan.comments/',
            patch: {
              text: `Ask @${w.admin.email}`,
              anchor: null,
              label: null,
              pin: null,
              replyTo: null,
              stance: null,
              mentions: [w.admin.email],
            },
            replace: false,
            opId: crypto.randomUUID() as OpId,
            seq: seq as AuthoredSeq,
          }),
        ),
      )
    })
    await attempt('send', async () => {
      await sendAs(session, w.tree, {
        page: 'plan.html',
        form: await formRef(w.tree, 'plan.html', 'answers/'),
        entries: [['role', 'Driver']],
      })
    })
    await attempt('share', () =>
      runAs(
        session,
        Effect.flatMap(Shares, (s) =>
          s.set({
            ref: ref(w.at('docs/')),
            target: { kind: 'email', email: 'guest@example.com' },
            role: 'read',
          }),
        ),
      ),
    )
    const over = recorded
      .seen()
      .filter((s) => s.binds.length > 100 || bytes(s.sql) > 100_000)
      .map((s) => `${s.binds.length} binds, ${bytes(s.sql)} bytes`)
    expect({ outcomes, over }).toEqual({
      outcomes: {
        push: 'ok',
        'push with a scoped key': 'ok',
        rm: 'ok',
        comment: 'ok',
        send: 'ok',
        share: 'ok',
      },
      over: [],
    })
  }, 180_000)

  it('fails the whole change when any one of its bases is lost before the batch', async () => {
    const w = await world()
    const key = await agent(w.member)
    // The last team's share goes just before the batch: the change rested
    // on it too.
    const last = w.teams.at(-1)!
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) => sql.includes('change_guards'),
            async () => {
              await exec(
                "delete from shares where target_kind = 'team' and target = ?",
                last,
              )
            },
          ),
        },
      }),
    )
    const failure = await failureAs(
      key,
      Effect.gen(function* () {
        const store = yield* TreeStore
        const found = yield* store.locate(ref(w.at('notes/a.txt')))
        if ('missing' in found) return yield* Effect.die('missing')
        const granted = yield* (yield* Access).require('write', found.node)
        expect(granted.basis.length).toBe(2 * TEAMS)
        return yield* store.change(found.tree.id, (cs) =>
          Effect.sync(() => {
            cs.guardHead('', found.tree.authoredSeq as AuthoredSeq)
            cs.markDeleted(granted, 'deleted')
            cs.event({ type: 'delete', path: found.node.path, node: granted })
            return {}
          }),
        )
      }),
    )
    expect(failure).toMatchObject({ code: 'conflict' })
    expect(await nodeAt(w.treeId, 'notes/a.txt')).toBeDefined()
  }, 180_000)
})
