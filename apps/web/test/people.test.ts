import type { Person, PersonId, TeamId } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Access,
  People,
  Push,
  TreeStore,
  type Caller,
  type CoreServices,
  type Background,
  type CurrentCaller,
  type PeopleService,
} from '../src/core/index.ts'
import { Browser, signedIn } from './support/browser.ts'
import {
  beforeBatch,
  beforeRead,
  count,
  exec,
  failingStatements,
  rows,
} from './support/d1.ts'
import {
  formRef,
  pushForms,
  QUESTIONS,
  sendAs,
  uploadAs,
} from './support/forms.ts'
import { harness, ORIGIN, testRuntime } from './support/harness.ts'
import { callerOf, fresh, runAs, sessionFor } from './support/people.ts'
import {
  agent,
  failureAs,
  join,
  nodeAt,
  person,
  pushAll,
  ref,
  sha256Of,
  share,
  superAdmin,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const as = <A, E>(
  caller: Caller,
  use: (
    people: PeopleService,
  ) => Effect.Effect<A, E, CoreServices | CurrentCaller | Background>,
) => runAs(caller, Effect.flatMap(People, use))

const refusal = <A, E>(
  caller: Caller,
  use: (
    people: PeopleService,
  ) => Effect.Effect<A, E, CoreServices | CurrentCaller | Background>,
) => failureAs(caller, Effect.flatMap(People, use))

const userIdOf = async (email: string) =>
  (
    await rows<{ id: string }>('select id from "user" where email = ?', email)
  )[0]?.id as PersonId | undefined

const roleIn = async (ws: { id: string }, userId: string | undefined) =>
  (
    await rows<{ role: string }>(
      'select role from workspace_members where workspace_id = ? and user_id = ?',
      ws.id,
      userId ?? '',
    )
  )[0]?.role ?? null

const teamIdsOf = async (userId: string | undefined) =>
  (
    await rows<{ team_id: string }>(
      'select team_id from team_members where user_id = ? order by team_id',
      userId ?? '',
    )
  ).map((r) => r.team_id)

/** A workspace with its admin signed in, as the settings screens run. */
const adminWorld = async () => {
  const admin = await person('admin')
  const ws = await workspace(admin)
  return { admin, ws, browser: await sessionFor(admin) }
}

describe('invitations', () => {
  it('makes a new email a member with its teams at that person’s first sign-in', async () => {
    const { ws, browser } = await adminWorld()
    const design = await as(browser, (p) =>
      p.createTeam({ workspace: ws.name, name: 'Design' }),
    )
    const identity = fresh('gmail.com', 'sara')
    const invited = await as(browser, (p) =>
      p.invite({
        workspace: ws.name,
        email: identity.email.toUpperCase(),
        teamIds: [design.id],
      }),
    )
    expect(invited).toEqual({ joined: false })
    const listed = await as(browser, (p) => p.members(ws.name))
    expect(listed.invitations).toEqual([
      expect.objectContaining({
        email: identity.email,
        teams: [{ id: design.id, name: 'Design' }],
      }),
    ])
    expect(await userIdOf(identity.email)).toBeUndefined()

    await signedIn(identity)
    const id = await userIdOf(identity.email)
    expect(await roleIn(ws, id)).toBe('member')
    expect(await teamIdsOf(id)).toEqual([design.id])
    expect(
      await count(
        'invitations',
        'workspace_id = ? and email = ?',
        ws.id,
        identity.email,
      ),
    ).toBe(0)
    // The membership is a grant, stamped in commit order.
    const [stamped] = await rows<{ grant_order: number | null }>(
      'select grant_order from workspace_members where workspace_id = ? and user_id = ?',
      ws.id,
      id,
    )
    expect(stamped?.grant_order).toBeGreaterThan(0)
  })

  it('makes someone who has signed in a member at once', async () => {
    const { ws, browser } = await adminWorld()
    const sara = await person('sara')
    const sales = await as(browser, (p) =>
      p.createTeam({ workspace: ws.name, name: 'Sales' }),
    )
    expect(
      await as(browser, (p) =>
        p.invite({
          workspace: ws.name,
          email: sara.email,
          teamIds: [sales.id],
        }),
      ),
    ).toEqual({ joined: true })
    expect(await roleIn(ws, sara.id)).toBe('member')
    expect(await teamIdsOf(sara.id)).toEqual([sales.id])
    const again = await refusal(browser, (p) =>
      p.invite({ workspace: ws.name, email: sara.email, teamIds: [] }),
    )
    expect(again).toMatchObject({
      code: 'conflict',
      message: `${sara.email} is already a member.`,
    })
  })

  it('refuses a malformed email and a team of another workspace', async () => {
    const { ws, browser } = await adminWorld()
    const other = await adminWorld()
    const theirs = await as(other.browser, (p) =>
      p.createTeam({ workspace: other.ws.name, name: 'Theirs' }),
    )
    expect(
      (
        await refusal(browser, (p) =>
          p.invite({ workspace: ws.name, email: 'not an email', teamIds: [] }),
        )
      ).code,
    ).toBe('invalid')
    expect(
      (
        await refusal(browser, (p) =>
          p.invite({
            workspace: ws.name,
            email: 'x@example.com',
            teamIds: [theirs.id],
          }),
        )
      ).code,
    ).toBe('invalid')
  })
})

describe('admins only', () => {
  it('answers not_found to anyone but an admin of the workspace, from every admin method', async () => {
    const { admin, ws, browser } = await adminWorld()
    const member = await person('member')
    await join(ws, member)
    const design = await as(browser, (p) =>
      p.createTeam({ workspace: ws.name, name: 'Design' }),
    )
    const outsider = await sessionFor(await person('outsider'))
    const memberBrowser = await sessionFor(member)
    // An admin's agent key is no screen either.
    const adminKey = await agent(admin)
    const calls: ((
      p: PeopleService,
    ) => Effect.Effect<unknown, unknown, CurrentCaller | Background>)[] = [
      (p) => p.members(ws.name),
      (p) => p.invite({ workspace: ws.name, email: 'a@b.co', teamIds: [] }),
      (p) => p.cancelInvitation({ workspace: ws.name, email: 'a@b.co' }),
      (p) =>
        p.setRole({ workspace: ws.name, userId: member.id, role: 'admin' }),
      (p) => p.removeMember({ workspace: ws.name, userId: member.id }),
      (p) => p.teams(ws.name),
      (p) => p.team({ workspace: ws.name, teamId: design.id }),
      (p) => p.createTeam({ workspace: ws.name, name: 'Other' }),
      (p) => p.renameTeam({ workspace: ws.name, teamId: design.id, name: 'X' }),
      (p) => p.deleteTeam({ workspace: ws.name, teamId: design.id }),
      (p) =>
        p.addToTeam({
          workspace: ws.name,
          teamId: design.id,
          userId: member.id,
        }),
      (p) =>
        p.removeFromTeam({
          workspace: ws.name,
          teamId: design.id,
          userId: member.id,
        }),
      (p) =>
        p.moveToTeam({
          workspace: ws.name,
          from: design.id,
          to: design.id,
          userId: member.id,
        }),
      (p) => p.workspaceSettings(ws.name),
      (p) => p.deleteWorkspace({ workspace: ws.name, confirm: ws.name }),
    ]
    for (const caller of [memberBrowser, outsider, adminKey]) {
      for (const call of calls) {
        const failed = await refusal(caller, call as never)
        expect((failed as { code: string }).code).toBe('not_found')
      }
    }
    // Nothing changed.
    expect(await roleIn(ws, member.id)).toBe('member')
    expect(await count('teams', 'workspace_id = ?', ws.id)).toBe(1)
  })

  it('answers not_found to anyone but a super admin, from every super admin method', async () => {
    const { ws, browser } = await adminWorld()
    const calls = [
      (p: PeopleService) => p.adminOverview(),
      (p: PeopleService) => p.setWorkspaceCreation('anyone'),
      (p: PeopleService) => p.addCreator('acme.com'),
      (p: PeopleService) => p.removeCreator('acme.com'),
      (p: PeopleService) => p.setLimits({ pushFiles: 1 }),
      (p: PeopleService) => p.setRetention(10),
      (p: PeopleService) => p.addSuperAdmin('x@example.com'),
      (p: PeopleService) => p.removeSuperAdmin('x' as PersonId),
      (p: PeopleService) => p.suspendWorkspace(ws.id),
      (p: PeopleService) => p.liftSuspension(ws.id),
      (p: PeopleService) => p.restoreWorkspace(ws.id),
    ]
    for (const call of calls) {
      const failed = await refusal(browser, call as never)
      expect((failed as { code: string }).code).toBe('not_found')
    }
    expect(await as(browser, (p) => p.isSuperAdmin())).toBe(false)
  })
})

describe('roles, leaving and the last admin', () => {
  it('refuses demoting, removing or leaving as the last admin, and lets a member made admin take over', async () => {
    const { admin, ws, browser } = await adminWorld()
    const member = await person('member')
    await join(ws, member)
    const lastAdmin = {
      code: 'last_admin',
      message: `You're the last admin of ${ws.name}. Make another member an admin first.`,
    }
    expect(
      await refusal(browser, (p) =>
        p.setRole({ workspace: ws.name, userId: admin.id, role: 'member' }),
      ),
    ).toMatchObject(lastAdmin)
    expect(
      await refusal(browser, (p) =>
        p.removeMember({ workspace: ws.name, userId: admin.id }),
      ),
    ).toMatchObject(lastAdmin)
    expect(
      await refusal(browser, (p) => p.leave({ workspace: ws.name })),
    ).toMatchObject(lastAdmin)
    expect(await roleIn(ws, admin.id)).toBe('admin')

    await as(browser, (p) =>
      p.setRole({ workspace: ws.name, userId: member.id, role: 'admin' }),
    )
    await as(browser, (p) => p.leave({ workspace: ws.name }))
    expect(await roleIn(ws, admin.id)).toBeNull()
    expect(await roleIn(ws, member.id)).toBe('admin')
  })

  it('keeps an admin when two admins demote each other at once', async () => {
    const { admin, ws, browser } = await adminWorld()
    const other = await person('other')
    await join(ws, other, 'admin')
    const otherBrowser = await sessionFor(other)
    const results = await Promise.all([
      as(browser, (p) =>
        p.setRole({ workspace: ws.name, userId: admin.id, role: 'member' }),
      ).then(
        () => 'ok',
        () => 'refused',
      ),
      as(otherBrowser, (p) =>
        p.setRole({ workspace: ws.name, userId: other.id, role: 'member' }),
      ).then(
        () => 'ok',
        () => 'refused',
      ),
    ])
    expect(
      await count(
        'workspace_members',
        "workspace_id = ? and role = 'admin'",
        ws.id,
      ),
    ).toBe(1)
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
  })

  it('removes a member with their teams; shares to their email and their pages stay', async () => {
    const { admin, ws, browser } = await adminWorld()
    const member = await person('member')
    await join(ws, member)
    const design = await as(browser, (p) =>
      p.createTeam({ workspace: ws.name, name: 'Design' }),
    )
    await as(browser, (p) =>
      p.addToTeam({ workspace: ws.name, teamId: design.id, userId: member.id }),
    )
    const memberKey = await agent(member)
    const pushed = await pushAll(memberKey, `${ws.name}/mine`, {
      'index.html': '<title>Mine</title>',
    })
    if (!('treeId' in pushed)) throw new Error('no tree')
    const adminTree = await pushAll(await agent(admin), `${ws.name}/theirs`, {
      'index.html': '<title>Theirs</title>',
      'team.html': '<title>Team</title>',
    })
    if (!('treeId' in adminTree)) throw new Error('no tree')
    await share(
      adminTree.treeId,
      (await nodeAt(adminTree.treeId, 'index.html'))!.id,
      'email',
      member.email,
      'read',
      admin,
    )
    await share(
      adminTree.treeId,
      (await nodeAt(adminTree.treeId, 'team.html'))!.id,
      'team',
      design.id,
      'read',
      admin,
    )
    const reads = (target: string) =>
      runAs(
        memberKey,
        Effect.gen(function* () {
          const located = yield* (yield* TreeStore).locate(ref(target))
          if ('missing' in located) return 'missing'
          return yield* (yield* Access).require('read', located.node).pipe(
            Effect.as('ok'),
            Effect.catchAll((e) => Effect.succeed(e.code)),
          )
        }),
      )
    expect(await reads(`${ws.name}/theirs/team.html`)).toBe('ok')
    await as(browser, (p) =>
      p.removeMember({ workspace: ws.name, userId: member.id }),
    )
    expect(await roleIn(ws, member.id)).toBeNull()
    expect(await teamIdsOf(member.id)).toEqual([])
    expect(await reads(`${ws.name}/theirs/team.html`)).toBe('not_found')
    expect(await reads(`${ws.name}/theirs/index.html`)).toBe('ok')
    // The tree they pushed stays, theirs by its creator share.
    expect(
      await count('nodes', 'tree_id = ? and deleted_at is null', pushed.treeId),
    ).toBe(2)
  })
})

describe('teams', () => {
  it('keeps team names unique without regard to case, and renames', async () => {
    const { ws, browser } = await adminWorld()
    const design = await as(browser, (p) =>
      p.createTeam({ workspace: ws.name, name: '  Design ' }),
    )
    expect(design.name).toBe('Design')
    expect(
      await refusal(browser, (p) =>
        p.createTeam({ workspace: ws.name, name: 'design' }),
      ),
    ).toMatchObject({ code: 'conflict' })
    const sales = await as(browser, (p) =>
      p.createTeam({ workspace: ws.name, name: 'Sales' }),
    )
    expect(
      await refusal(browser, (p) =>
        p.renameTeam({ workspace: ws.name, teamId: sales.id, name: 'DESIGN' }),
      ),
    ).toMatchObject({ code: 'conflict' })
    await as(browser, (p) =>
      p.renameTeam({
        workspace: ws.name,
        teamId: sales.id,
        name: 'Sales EMEA',
      }),
    )
    expect(
      (await as(browser, (p) => p.teams(ws.name))).map((t) => t.name),
    ).toEqual(['Design', 'Sales EMEA'])
    expect(
      (
        await refusal(browser, (p) =>
          p.createTeam({ workspace: ws.name, name: '  ' }),
        )
      ).code,
    ).toBe('invalid')
    // Another workspace may have its own Design.
    const other = await adminWorld()
    await as(other.browser, (p) =>
      p.createTeam({ workspace: other.ws.name, name: 'Design' }),
    )
  })

  it('adds only members, moves between teams, and lists who is in each', async () => {
    const { admin, ws, browser } = await adminWorld()
    const member = await person('member')
    await join(ws, member)
    const stranger = await person('stranger')
    const design = await as(browser, (p) =>
      p.createTeam({ workspace: ws.name, name: 'Design' }),
    )
    const sales = await as(browser, (p) =>
      p.createTeam({ workspace: ws.name, name: 'Sales' }),
    )
    expect(
      (
        await refusal(browser, (p) =>
          p.addToTeam({
            workspace: ws.name,
            teamId: design.id,
            userId: stranger.id,
          }),
        )
      ).code,
    ).toBe('invalid')
    await as(browser, (p) =>
      p.addToTeam({ workspace: ws.name, teamId: design.id, userId: member.id }),
    )
    await as(browser, (p) =>
      p.addToTeam({ workspace: ws.name, teamId: sales.id, userId: admin.id }),
    )
    const detail = await as(browser, (p) =>
      p.team({ workspace: ws.name, teamId: design.id }),
    )
    expect(detail.members.map((m) => m.person.id)).toEqual([member.id])
    expect(detail.addable.map((p) => p.id)).toEqual([admin.id])
    await as(browser, (p) =>
      p.moveToTeam({
        workspace: ws.name,
        from: design.id,
        to: sales.id,
        userId: member.id,
      }),
    )
    expect(await teamIdsOf(member.id)).toEqual([sales.id])
    const summary = await as(browser, (p) => p.teams(ws.name))
    expect(summary).toEqual([
      { id: design.id, name: 'Design', members: 0 },
      { id: sales.id, name: 'Sales', members: 2 },
    ])
    const listed = await as(browser, (p) => p.members(ws.name))
    expect(listed.members[0]).toMatchObject({ isMe: true, role: 'admin' })
    expect(
      listed.members.find((m) => m.person.id === member.id)?.teams,
    ).toEqual([{ id: sales.id, name: 'Sales' }])
    // Teams any member may share with.
    expect(
      await runAs(
        await sessionFor(member),
        Effect.flatMap(People, (p) =>
          p.teamsForSharing({ id: ws.id, name: ws.name } as never),
        ),
      ),
    ).toEqual([
      { id: design.id, name: 'Design' },
      { id: sales.id, name: 'Sales' },
    ])
    expect(
      await runAs(
        await sessionFor(stranger),
        Effect.flatMap(People, (p) =>
          p.teamsForSharing({ id: ws.id, name: ws.name } as never),
        ),
      ),
    ).toEqual([])
  })

  it('revokes a deleted team’s shares in every tree, with one share event each', async () => {
    const { admin, ws, browser } = await adminWorld()
    const key = await agent(admin)
    const design = await as(browser, (p) =>
      p.createTeam({ workspace: ws.name, name: 'Design' }),
    )
    const trees: string[] = []
    for (const name of ['one', 'two']) {
      const pushed = await pushAll(key, `${ws.name}/${name}`, {
        'a.html': '<title>A</title>',
        'b.html': '<title>B</title>',
      })
      if (!('treeId' in pushed)) throw new Error('no tree')
      trees.push(pushed.treeId)
    }
    const [one = '', two = ''] = trees
    for (const path of ['a.html', 'b.html']) {
      await share(
        one,
        (await nodeAt(one, path))!.id,
        'team',
        design.id,
        'read',
        admin,
      )
    }
    await share(
      two,
      (await nodeAt(two, 'a.html'))!.id,
      'team',
      design.id,
      'write',
      admin,
    )
    const events = async (treeId: string) =>
      rows<{ path: string }>(
        "select path from events where tree_id = ? and type = 'share' order by seq",
        treeId,
      )
    const removed = await as(browser, (p) =>
      p.deleteTeam({ workspace: ws.name, teamId: design.id }),
    )
    expect(removed).toEqual({ sharesRemoved: 3 })
    expect(
      await count('shares', "target_kind = 'team' and target = ?", design.id),
    ).toBe(0)
    expect(await count('teams', 'id = ?', design.id)).toBe(0)
    expect((await events(one)).map((e) => e.path)).toEqual(['a.html', 'b.html'])
    expect((await events(two)).map((e) => e.path)).toEqual(['a.html'])
  })
})

describe('deleting a workspace', () => {
  it('needs its exact name, then reads every node as missing and keeps the name taken', async () => {
    const { admin, ws, browser } = await adminWorld()
    const key = await agent(admin)
    const pushed = await pushAll(key, `${ws.name}/acme`, {
      'index.html': '<title>A</title>',
    })
    if (!('treeId' in pushed)) throw new Error('no tree')
    expect(
      await refusal(browser, (p) =>
        p.deleteWorkspace({
          workspace: ws.name,
          confirm: ws.name.toUpperCase(),
        }),
      ),
    ).toMatchObject({ code: 'invalid', message: `Type ${ws.name} to confirm.` })
    await as(browser, (p) =>
      p.deleteWorkspace({ workspace: ws.name, confirm: ws.name }),
    )
    const read = await failureAs(
      key,
      Effect.gen(function* () {
        const root = yield* (yield* TreeStore).locate(ref(`${ws.name}/acme/`))
        return yield* (yield* Access).require(
          'read',
          'missing' in root ? root : root.node,
        )
      }),
    )
    expect(read.code).toBe('not_found')
    const response = await SELF.fetch(`${ORIGIN}/_/api/me`, {
      headers: { authorization: 'Bearer nothing' },
    })
    expect(response.status).toBe(401)
    await superAdmin(admin)
    const again = await refusal(browser, (p) =>
      p.createWorkspace({ name: ws.name }),
    )
    expect(again.code).toBe('conflict')
  })
})

/** Stages one index.html, answering the refusal. */
const stageRefusal = async (caller: Caller, target: string, text: string) => {
  const files = [
    {
      path: 'index.html',
      sha256: await sha256Of(text),
      size: new TextEncoder().encode(text).length,
    },
  ]
  return failureAs(
    caller,
    Effect.flatMap(Push, (push) =>
      push.stage({
        target: ref(target),
        baseSeq: null,
        baseTree: null,
        force: true,
        dryRun: false,
        message: null,
        files,
      } as never),
    ),
  )
}

describe('suspension', () => {
  it('makes a member’s push answer forbidden with the suspension, until it is lifted', async () => {
    const { admin, ws, browser } = await adminWorld()
    await superAdmin(admin)
    const member = await person('member')
    await join(ws, member)
    const key = await agent(member)
    await pushAll(key, `${ws.name}/acme`, { 'index.html': '<title>A</title>' })
    await as(browser, (p) => p.suspendWorkspace(ws.id as never))
    const refused = await stageRefusal(
      key,
      `${ws.name}/acme`,
      '<title>B</title>',
    )
    expect(refused).toMatchObject({
      code: 'forbidden',
      message: `${ws.name} is suspended. A super admin of ${env.DEPLOYMENT_NAME} can lift the suspension.`,
    })
    // A new tree is refused the same way.
    const created = await stageRefusal(
      key,
      `${ws.name}/fresh`,
      '<title>F</title>',
    )
    expect(created).toMatchObject({ code: 'forbidden' })
    const overview = await as(browser, (p) => p.adminOverview())
    expect(
      overview.workspaces.find((w) => w.id === ws.id)?.suspendedAt,
    ).not.toBeNull()
    await as(browser, (p) => p.liftSuspension(ws.id as never))
    const pushed = await pushAll(
      key,
      `${ws.name}/acme`,
      { 'index.html': '<title>B</title>' },
      { force: true },
    )
    expect('treeId' in pushed).toBe(true)
  })

  it('restores a deleted workspace within the retention period only', async () => {
    const { admin, ws, browser } = await adminWorld()
    await superAdmin(admin)
    await as(browser, (p) =>
      p.deleteWorkspace({ workspace: ws.name, confirm: ws.name }),
    )
    // Deleted 29 days ago: within the 30-day retention period.
    const deletedAgo = (days: number) =>
      exec(
        'update workspaces set deleted_at = ? where id = ?',
        Date.now() - days * 86_400_000,
        ws.id,
      )
    await deletedAgo(29)
    await as(browser, (p) => p.restoreWorkspace(ws.id as never))
    const restored = await as(browser, (p) => p.myWorkspaces())
    expect(restored.map((m) => m.workspace.name)).toContain(ws.name)
    await as(browser, (p) =>
      p.deleteWorkspace({ workspace: ws.name, confirm: ws.name }),
    )
    await deletedAgo(31)
    const late = await refusal(browser, (p) =>
      p.restoreWorkspace(ws.id as never),
    )
    expect(late.code).toBe('conflict')
  })
})

describe('super admins', () => {
  it('adds only someone who has signed in, and never removes the last one', async () => {
    const chief = await person('chief')
    await superAdmin(chief)
    const browser = await sessionFor(chief)
    const missing = await refusal(browser, (p) =>
      p.addSuperAdmin('nobody-here@example.com'),
    )
    expect(missing).toMatchObject({
      code: 'invalid',
      message: `nobody-here@example.com hasn't signed in to ${env.DEPLOYMENT_NAME} yet. Ask them to sign in once, then add them.`,
    })
    const sara = await person('sara')
    await as(browser, (p) => p.addSuperAdmin(sara.email))
    const overview = await as(browser, (p) => p.adminOverview())
    expect(
      overview.superAdmins.find((s) => s.person.id === sara.id),
    ).toMatchObject({
      configured: false,
      addedBy: chief.email,
    })
    // Leave exactly one super admin in the deployment.
    await exec('delete from super_admins where user_id <> ?', chief.id)
    expect(
      await refusal(browser, (p) => p.removeSuperAdmin(chief.id)),
    ).toMatchObject({
      code: 'last_admin',
      message: 'Name another super admin first.',
    })
    expect(await count('super_admins', 'user_id = ?', chief.id)).toBe(1)
  })
})

/** A guest who answered the questionnaire and holds an agent key. */
const guestWorld = async () => {
  const owner = await person('owner')
  const ws = await workspace(owner)
  const tree = await pushForms(owner, ws, {
    'questions/index.html': QUESTIONS,
    'ideas.html': `<!doctype html><html><head><title>Ideas</title></head><body>
<form action="ideas/" data-entries="many"><input name="idea" required><button>Add</button></form></body></html>`,
  })
  const identity = fresh('gmail.com', 'guest')
  const guestBrowser = await signedIn(identity)
  const guest = await callerOf(guestBrowser)
  await exec(
    `insert into shares (id, tree_id, node_id, target_kind, target, role, created_by, created_at)
     values (?, ?, ?, 'email', ?, 'respond', ?, ?)`,
    crypto.randomUUID(),
    tree.treeId,
    (await nodeAt(tree.treeId, ''))!.id,
    identity.email,
    owner.id,
    Date.now(),
  )
  await join(ws, guest.person as Person)
  const page = 'questions/index.html'
  await sendAs(guest, tree, {
    page,
    form: await formRef(tree, page, 'questions/answers/'),
    entries: [['role', 'Driver']],
  })
  const ideas = await formRef(tree, 'ideas.html', 'ideas/')
  for (const idea of ['Night shifts', 'Two trucks']) {
    await sendAs(guest, tree, {
      page: 'ideas.html',
      form: ideas,
      entries: [['idea', idea]],
    })
  }
  const key = await runAs(
    guest,
    Effect.flatMap(People, () => Effect.void),
  ).then(() => agent(guest.person as Person))
  const keyed = await exec(
    'update agent_keys set created_by_account_id = (select id from account where user_id = ?) where id = ?',
    guest.person!.id,
    key.via.kind === 'agent' ? key.via.keyId : '',
  )
  void keyed
  return { owner, ws, tree, identity, guest, guestBrowser, key }
}

describe('deleting an account', () => {
  it('previews what goes, withdraws every answer with an event each, and closes the account', async () => {
    const w = await guestWorld()
    const preview = await as(w.guest, (p) => p.deletionPreview())
    expect(preview).toEqual({
      submissions: 1,
      entries: 2,
      uploads: 0,
      comments: 0,
      keys: 1,
      sessions: 1,
      workspaces: [w.ws.name],
      blockedBy: null,
    })
    const id = w.guest.person!.id
    // A page the guest pushed stays.
    const pushed = await pushAll(w.key, `${w.ws.name}/guest-tree`, {
      'mine.html': '<title>Mine</title>',
    })
    if (!('treeId' in pushed)) throw new Error('no tree')
    await as(w.guest, (p) => p.deleteAccount())

    expect(
      await count(
        'nodes',
        "owner_id = ? and origin = 'data' and deleted_at is null",
        id,
      ),
    ).toBe(0)
    expect(
      await count(
        'events',
        "tree_id = ? and type = 'withdrawal' and actor_id = ?",
        w.tree.treeId,
        id,
      ),
    ).toBe(3)
    // Every revision's content is gone.
    expect(
      await count(
        'node_versions',
        'author_id = ? and json_value is not null and tree_id = ?',
        id,
        w.tree.treeId,
      ),
    ).toBe(0)
    expect(
      await count('agent_keys', 'user_id = ? and revoked_at is null', id),
    ).toBe(0)
    expect(await count('session', 'user_id = ?', id)).toBe(0)
    expect(await count('account', 'user_id = ?', id)).toBe(0)
    expect(await count('workspace_members', 'user_id = ?', id)).toBe(0)
    expect(
      await count(
        'nodes',
        "tree_id = ? and path = 'mine.html' and deleted_at is null",
        pushed.treeId,
      ),
    ).toBe(1)
    const [gone] = await rows<{ deleted_at: number | null }>(
      'select deleted_at from people where user_id = ?',
      id,
    )
    expect(gone?.deleted_at).not.toBeNull()
    const [history] = await rows<{ detail_json: string }>(
      "select detail_json from person_history where user_id = ? and kind = 'deleted'",
      id,
    )
    expect(JSON.parse(history?.detail_json ?? '{}')).toEqual({
      submissions: 1,
      entries: 2,
      uploads: 0,
      comments: 0,
      keys: 1,
      sessions: 1,
    })
    const me = await w.guestBrowser.fetch('/_/api/me', { purpose: 'read' })
    expect(me.status).toBe(401)
  })

  it('is refused for the last admin of a workspace, and for the only super admin', async () => {
    const { ws, browser } = await adminWorld()
    const preview = await as(browser, (p) => p.deletionPreview())
    expect(preview.blockedBy).toEqual({
      kind: 'last_admin',
      workspace: ws.name,
    })
    expect(await refusal(browser, (p) => p.deleteAccount())).toMatchObject({
      code: 'last_admin',
      message: `You're the last admin of ${ws.name}. Hand over admin to another member first. Then you can delete your answers and account.`,
    })
    const lone = await person('lone')
    await exec('delete from super_admins')
    await superAdmin(lone)
    const loneBrowser = await sessionFor(lone)
    expect(
      (await as(loneBrowser, (p) => p.deletionPreview())).blockedBy,
    ).toEqual({
      kind: 'last_super_admin',
    })
    expect(await refusal(loneBrowser, (p) => p.deleteAccount())).toMatchObject({
      code: 'last_admin',
      message: 'Name another super admin first.',
    })
  })

  it('is finished by a second press after a failure midway', async () => {
    const w = await guestWorld()
    const id = w.guest.person!.id
    harness.use(
      testRuntime({
        env: {
          DB: failingStatements(env.DB, (sql) =>
            sql.startsWith('delete from workspace_members where user_id'),
          ),
        },
      }),
    )
    const failed = await refusal(w.guest, (p) => p.deleteAccount())
    expect(failed.code).toBe('unavailable')
    harness.reset()
    // The answers went; the account did not.
    expect(
      await count(
        'nodes',
        "owner_id = ? and origin = 'data' and deleted_at is null",
        id,
      ),
    ).toBe(0)
    expect(await count('session', 'user_id = ?', id)).toBe(1)
    await as(w.guest, (p) => p.deleteAccount())
    expect(await count('session', 'user_id = ?', id)).toBe(0)
    expect(await count('workspace_members', 'user_id = ?', id)).toBe(0)
    expect(
      await count(
        'events',
        "tree_id = ? and type = 'withdrawal' and actor_id = ?",
        w.tree.treeId,
        id,
      ),
    ).toBe(3)
  })

  it('brings the person back with nothing at a new sign-in with the same email', async () => {
    for (const domain of ['gmail.com', 'workspace.example']) {
      const identity = {
        ...fresh(domain, 'back'),
        // Google is the authority for a Gmail address and a Workspace one.
        ...(domain === 'gmail.com' ? {} : { hd: 'workspace.example' }),
        email_verified: true,
      }
      const first = await signedIn(identity)
      const caller = await callerOf(first)
      const id = caller.person!.id
      await as(caller, (p) => p.deleteAccount())
      // An invitation made while they were gone waits for their sign-in.
      const { ws, browser } = await adminWorld()
      expect(
        await as(browser, (p) =>
          p.invite({ workspace: ws.name, email: identity.email, teamIds: [] }),
        ),
      ).toEqual({ joined: false })
      const again = await signedIn({
        ...identity,
        sub: `${identity.sub}-again`,
      })
      const back = await callerOf(again)
      expect(back.person?.id).toBe(id)
      const [row] = await rows<{ deleted_at: number | null }>(
        'select deleted_at from people where user_id = ?',
        id,
      )
      expect(row?.deleted_at).toBeNull()
      const kinds = (
        await rows<{ kind: string }>(
          'select kind from person_history where user_id = ? order by created_at, rowid',
          id,
        )
      ).map((r) => r.kind)
      expect(kinds.slice(-1)).toEqual(['returned'])
      expect(kinds).toContain('deleted')
      expect(
        await count('agent_keys', 'user_id = ? and revoked_at is null', id),
      ).toBe(0)
      // Only the invitation made since: nothing from before.
      expect(
        (
          await rows<{ workspace_id: string }>(
            'select workspace_id from workspace_members where user_id = ?',
            id,
          )
        ).map((r) => r.workspace_id),
      ).toEqual([ws.id])
    }
  })
})

void (null as unknown as TeamId)

/** Serves with a database that runs `before` just ahead of a matching batch. */
const raceBefore = (
  match: (sql: string) => boolean,
  before: () => Promise<unknown>,
) =>
  harness.use(
    testRuntime({
      env: {
        DB: beforeBatch(env.DB, match, async () => {
          await before()
        }),
      },
    }),
  )

describe('changes that race the check before them', () => {
  it('never lets an admin demoted meanwhile finish a role change', async () => {
    const { admin, ws, browser } = await adminWorld()
    const other = await person('other')
    await join(ws, other, 'admin')
    const member = await person('member')
    await join(ws, member)
    raceBefore(
      (sql) => sql.startsWith('update workspace_members set role'),
      () =>
        exec(
          "update workspace_members set role = 'member' where workspace_id = ? and user_id = ?",
          ws.id,
          admin.id,
        ),
    )
    const failed = await refusal(browser, (p) =>
      p.setRole({ workspace: ws.name, userId: member.id, role: 'admin' }),
    )
    expect(failed.code).toBe('not_found')
    expect(await roleIn(ws, member.id)).toBe('member')
    expect(await roleIn(ws, admin.id)).toBe('member')
  })

  it('never lets an admin demoted meanwhile delete a team', async () => {
    const { admin, ws, browser } = await adminWorld()
    const other = await person('other')
    await join(ws, other, 'admin')
    const design = await as(browser, (p) =>
      p.createTeam({ workspace: ws.name, name: 'Design' }),
    )
    raceBefore(
      (sql) => sql.startsWith('delete from teams'),
      () =>
        exec(
          "update workspace_members set role = 'member' where workspace_id = ? and user_id = ?",
          ws.id,
          admin.id,
        ),
    )
    const failed = await refusal(browser, (p) =>
      p.deleteTeam({ workspace: ws.name, teamId: design.id }),
    )
    expect(failed.code).toBe('not_found')
    expect(await count('teams', 'id = ?', design.id)).toBe(1)
  })

  it('makes no membership when the workspace is deleted between the invitation’s check and its batch', async () => {
    const { ws, browser } = await adminWorld()
    const sara = await person('sara')
    raceBefore(
      (sql) => sql.includes('insert into workspace_members'),
      () =>
        exec(
          'update workspaces set deleted_at = ? where id = ?',
          Date.now(),
          ws.id,
        ),
    )
    await refusal(browser, (p) =>
      p.invite({ workspace: ws.name, email: sara.email, teamIds: [] }),
    )
    expect(await roleIn(ws, sara.id)).toBeNull()
  })

  it('withdraws an answer sent between the withdrawal and the account’s closing', async () => {
    const w = await guestWorld()
    const id = w.guest.person!.id
    let late = false
    raceBefore(
      (sql) => sql.startsWith('delete from session where user_id'),
      async () => {
        if (late) return
        late = true
        await sendAs(w.guest, w.tree, {
          page: 'ideas.html',
          form: await formRef(w.tree, 'ideas.html', 'ideas/'),
          entries: [['idea', 'Sent late']],
        })
      },
    )
    await as(w.guest, (p) => p.deleteAccount())
    harness.reset()
    expect(late).toBe(true)
    expect(
      await count(
        'nodes',
        "owner_id = ? and origin = 'data' and deleted_at is null",
        id,
      ),
    ).toBe(0)
    expect(await count('session', 'user_id = ?', id)).toBe(0)
  })

  it('deletes an ordinary account in a deployment whose super admins have not signed in', async () => {
    const w = await guestWorld()
    await exec('delete from super_admins')
    await as(w.guest, (p) => p.deleteAccount())
    expect(await count('session', 'user_id = ?', w.guest.person!.id)).toBe(0)
  })

  it('leaves someone else’s file in a folder of the person’s alone', async () => {
    const w = await guestWorld()
    const id = w.guest.person!.id
    const folder = `ideas/${w.identity.email}`
    const other = await person('other')
    const parent = (await nodeAt(w.tree.treeId, folder))!.id
    const nodeId = crypto.randomUUID()
    const versionId = crypto.randomUUID()
    await env.DB.batch([
      env.DB.prepare(
        `insert into nodes (id, tree_id, parent_id, name, path, depth, kind, origin, owner_id,
           current_version_id, created_at)
         values (?, ?, ?, 'theirs.json', ?, 3, 'file', 'data', ?, ?, ?)`,
      ).bind(
        nodeId,
        w.tree.treeId,
        parent,
        `${folder}/theirs.json`,
        other.id,
        versionId,
        Date.now(),
      ),
      env.DB.prepare(
        `insert into node_versions (id, node_id, tree_id, revision, state, json_value, size,
           content_type, author_id, created_at)
         values (?, ?, ?, 1, 'live', '{}', 2, 'application/json', ?, ?)`,
      ).bind(versionId, nodeId, w.tree.treeId, other.id, Date.now()),
    ])
    await as(w.guest, (p) => p.deleteAccount())
    expect(await count('nodes', 'id = ? and deleted_at is null', nodeId)).toBe(
      1,
    )
    expect(await count('nodes', 'id = ? and deleted_at is null', parent)).toBe(
      1,
    )
    expect(
      await count(
        'nodes',
        "owner_id = ? and origin = 'data' and kind = 'file' and deleted_at is null",
        id,
      ),
    ).toBe(0)
  })

  it('refuses to restore a workspace that would come back with no admin', async () => {
    const { admin, ws, browser } = await adminWorld()
    const chief = await person('chief')
    await superAdmin(chief)
    const chiefBrowser = await sessionFor(chief)
    await as(browser, (p) =>
      p.deleteWorkspace({ workspace: ws.name, confirm: ws.name }),
    )
    // Its only admin deletes their account while it is deleted.
    await as(browser, (p) => p.deleteAccount())
    expect(await roleIn(ws, admin.id)).toBeNull()
    const failed = await refusal(chiefBrowser, (p) =>
      p.restoreWorkspace(ws.id as never),
    )
    expect(failed.code).toBe('conflict')
    expect(
      (
        await rows<{ deleted_at: number | null }>(
          'select deleted_at from workspaces where id = ?',
          ws.id,
        )
      )[0]?.deleted_at,
    ).not.toBeNull()
  })
})

describe('account deletion racing others', () => {
  it('keeps an admin when the other admin leaves while one deletes their account', async () => {
    const { admin, ws, browser } = await adminWorld()
    const other = await person('other')
    await join(ws, other, 'admin')
    const otherBrowser = await sessionFor(other)
    raceBefore(
      (sql) => sql.startsWith('delete from session where user_id'),
      () => as(otherBrowser, (p) => p.leave({ workspace: ws.name })),
    )
    const failed = await refusal(browser, (p) => p.deleteAccount())
    harness.reset()
    expect(failed.code).toBe('last_admin')
    expect(await roleIn(ws, admin.id)).toBe('admin')
    expect(await count('session', 'user_id = ?', admin.id)).toBe(1)
  })

  it('invites, rather than joins, a person whose account closes between the check and the batch', async () => {
    const { ws, browser } = await adminWorld()
    const identity = fresh('gmail.com', 'closing')
    const target = await callerOf(await signedIn(identity))
    raceBefore(
      (sql) => sql.includes('insert into workspace_members'),
      () =>
        exec(
          'update people set deleted_at = ? where user_id = ?',
          Date.now(),
          target.person!.id,
        ),
    )
    const result = await as(browser, (p) =>
      p.invite({ workspace: ws.name, email: identity.email, teamIds: [] }),
    )
    harness.reset()
    expect(result).toEqual({ joined: false })
    expect(await roleIn(ws, target.person!.id)).toBeNull()
    expect(
      await count(
        'invitations',
        'workspace_id = ? and email = ?',
        ws.id,
        identity.email,
      ),
    ).toBe(1)
  })

  it('withdraws uploads and answers in every tree, a suspended workspace’s included', async () => {
    const w = await guestWorld()
    const id = w.guest.person!.id
    const page = 'questions/index.html'
    await uploadAs(w.guest, w.tree, {
      page,
      form: await formRef(w.tree, page, 'questions/answers/'),
      field: 'cv',
      name: 'cv.pdf',
      bytes: '%PDF-1.4 cv',
    })
    // A second workspace, suspended, holds an answer of theirs too.
    const owner2 = await person('owner2')
    const ws2 = await workspace(owner2)
    const tree2 = await pushForms(owner2, ws2, {
      'questions/index.html': QUESTIONS,
    })
    await exec(
      `insert into shares (id, tree_id, node_id, target_kind, target, role, created_by, created_at)
       values (?, ?, ?, 'email', ?, 'respond', ?, ?)`,
      crypto.randomUUID(),
      tree2.treeId,
      (await nodeAt(tree2.treeId, ''))!.id,
      w.identity.email,
      owner2.id,
      Date.now(),
    )
    await sendAs(w.guest, tree2, {
      page,
      form: await formRef(tree2, page, 'questions/answers/'),
      entries: [['role', 'Driver']],
    })
    await exec(
      'update workspaces set suspended_at = ? where id = ?',
      Date.now(),
      ws2.id,
    )
    const preview = await as(w.guest, (p) => p.deletionPreview())
    expect(preview).toMatchObject({ submissions: 2, entries: 2, uploads: 1 })
    await as(w.guest, (p) => p.deleteAccount())
    expect(
      await count(
        'nodes',
        "owner_id = ? and origin = 'data' and deleted_at is null",
        id,
      ),
    ).toBe(0)
    expect(
      await count(
        'events',
        "tree_id = ? and type = 'withdrawal' and actor_id = ?",
        tree2.treeId,
        id,
      ),
    ).toBe(1)
  })
})

describe('configured super admins', () => {
  it('are super admins again when they come back after deleting their account', async () => {
    const identity = {
      sub: `sub-root-${Date.now()}`,
      email: 'root@example.com',
      email_verified: true,
      // A Workspace account, so Google vouches for the address.
      hd: 'example.com',
    }
    const root = await callerOf(await signedIn(identity))
    expect(await count('super_admins', 'user_id = ?', root.person!.id)).toBe(1)
    const spare = await person('spare')
    await superAdmin(spare)
    await as(root, (p) => p.deleteAccount())
    expect(await count('super_admins', 'user_id = ?', root.person!.id)).toBe(0)
    const back = await callerOf(
      await signedIn({ ...identity, sub: `${identity.sub}-2` }),
    )
    expect(back.person?.id).toBe(root.person?.id)
    expect(await count('super_admins', 'user_id = ?', root.person!.id)).toBe(1)
  })
})

describe('review: requests that outlive what they rested on', () => {
  it('never lets an older deletion request close the account of a person who came back', async () => {
    const identity = {
      ...fresh('gmail.com', 'delete-twice'),
      email_verified: true,
    }
    const oldCaller = await callerOf(await signedIn(identity))
    const id = oldCaller.person!.id
    const owner = await person('other-owner')
    const ws = await workspace(owner)
    raceBefore(
      (sql) => sql.startsWith('delete from session where user_id'),
      async () => {
        // Another press finishes first, and the person comes back and joins.
        await as(oldCaller, (p) => p.deleteAccount())
        const back = await callerOf(
          await signedIn({ ...identity, sub: `${identity.sub}-back` }),
        )
        await join(ws, back.person!)
      },
    )
    const failed = await refusal(oldCaller, (p) => p.deleteAccount())
    harness.reset()
    expect(failed.code).toBe('sign_in_required')
    expect(await count('session', 'user_id = ?', id)).toBe(1)
    expect(await roleIn(ws, id)).toBe('member')
    const [row] = await rows<{ deleted_at: number | null }>(
      'select deleted_at from people where user_id = ?',
      id,
    )
    expect(row?.deleted_at).toBeNull()
  })

  it('makes no workspace for a person whose account closes before its batch', async () => {
    const chief = await person('chief')
    await superAdmin(chief)
    await as(await sessionFor(chief), (p) => p.setWorkspaceCreation('anyone'))
    const who = await person('creating')
    const caller = await sessionFor(who)
    const name = `p8-${crypto.randomUUID().slice(0, 8)}`
    raceBefore(
      (sql) => /insert into "?workspaces"?/.test(sql),
      async () => {
        await as(caller, (p) => p.deleteAccount())
      },
    )
    await refusal(caller, (p) => p.createWorkspace({ name }))
    harness.reset()
    expect(await count('workspaces', 'name = ?', name)).toBe(0)
    expect(await count('workspace_members', 'user_id = ?', who.id)).toBe(0)
  })

  it('makes no workspace for a super admin removed before its batch under super-admins-only creation', async () => {
    const chief = await person('chief')
    await superAdmin(chief)
    await as(await sessionFor(chief), (p) =>
      p.setWorkspaceCreation('super_admins'),
    )
    const who = await person('creating-policy')
    await superAdmin(who)
    const caller = await sessionFor(who)
    const name = `p8-${crypto.randomUUID().slice(0, 8)}`
    raceBefore(
      (sql) => /insert into "?workspaces"?/.test(sql),
      async () => {
        await exec('delete from super_admins where user_id = ?', who.id)
      },
    )
    const failed = await refusal(caller, (p) => p.createWorkspace({ name }))
    harness.reset()
    expect(failed.code).toBe('forbidden')
    expect(await count('workspaces', 'name = ?', name)).toBe(0)
  })

  it('revokes no team share for an admin demoted before the shares are read, though they created the tree', async () => {
    const { admin, ws, browser } = await adminWorld()
    const other = await person('other')
    await join(ws, other, 'admin')
    const pushed = await pushAll(await agent(admin), `${ws.name}/tree`, {
      'index.html': '<p>Hi</p>',
    })
    if (!('treeId' in pushed)) throw new Error('no tree')
    const root = (await nodeAt(pushed.treeId, ''))!
    const design = await as(browser, (p) =>
      p.createTeam({ workspace: ws.name, name: 'Design' }),
    )
    await share(pushed.treeId, root.id, 'team', design.id, 'read', admin)
    harness.use(
      testRuntime({
        env: {
          DB: beforeRead(
            env.DB,
            (sql) => sql.includes('select s.id, s.node_id as nodeId'),
            async () => {
              await exec(
                "update workspace_members set role = 'member' where workspace_id = ? and user_id = ?",
                ws.id,
                admin.id,
              )
            },
          ),
        },
      }),
    )
    const failed = await refusal(browser, (p) =>
      p.deleteTeam({ workspace: ws.name, teamId: design.id }),
    )
    harness.reset()
    expect(failed.code).toBe('not_found')
    expect(
      await count('shares', "target_kind = 'team' and target = ?", design.id),
    ).toBe(1)
  })

  it('brings a person back only through the guarded linking of any sign-in', async () => {
    // Google is not the authority for this address: a new account cannot
    // join the person who holds it, deleted or not.
    const identity = {
      ...fresh('example.com', 'unvouched'),
      email_verified: true,
    }
    const caller = await callerOf(await signedIn(identity))
    const id = caller.person!.id
    await as(caller, (p) => p.deleteAccount())
    const browser = new Browser()
    const response = await browser.signIn({
      ...identity,
      sub: `${identity.sub}-again`,
    })
    expect(response.headers.get('location')).toContain(
      'error=email_unconfirmed',
    )
    expect(browser.sessionToken()).toBeUndefined()
    const [row] = await rows<{ deleted_at: number | null }>(
      'select deleted_at from people where user_id = ?',
      id,
    )
    expect(row?.deleted_at).not.toBeNull()
  })
})
