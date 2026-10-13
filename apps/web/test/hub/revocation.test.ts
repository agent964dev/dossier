// Losing access closes watching sockets before anything else reaches them,
// admission is fenced against a revocation landing meanwhile, and a hint goes
// only to a socket whose caller may read what changed.
import type { OpId, Person, PersonId, TreeId } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Access,
  Data,
  People,
  TreeStore,
  type Background,
  type Caller,
  type CoreServices,
  type CurrentCaller,
  type PeopleService,
} from '../../src/core/index.ts'
import { signedIn, type Browser } from '../support/browser.ts'
import { afterRead, exec, rows } from '../support/d1.ts'
import { pageWith, pushForms, seqOf, type FormTree } from '../support/forms.ts'
import { harness, testRuntime } from '../support/harness.ts'
import { callerOf, fresh, runAs } from '../support/people.ts'
import {
  open,
  upgradeAs,
  visitorBrowser,
  type Socket,
} from '../support/sockets.ts'
import {
  agent,
  join,
  nodeAt,
  pushAll,
  share,
  superAdmin,
  team,
  workspace,
} from '../support/trees.ts'

afterEach(() => harness.reset())

const FILES = {
  'open/page.html': pageWith('<p>Open</p>', 'Open'),
  'private/page.html': pageWith('<p>Private</p>', 'Private'),
}

interface World {
  readonly owner: Person
  readonly ownerCaller: Caller
  readonly ws: { id: string; name: string }
  readonly tree: FormTree
  readonly guest: Person
  readonly guestBrowser: Browser
  readonly guestCaller: Caller
}

const world = async (): Promise<World> => {
  const ownerBrowser = await signedIn(fresh())
  const ownerCaller = await callerOf(ownerBrowser)
  const owner = ownerCaller.person!
  const ws = await workspace(owner)
  const tree = await pushForms(owner, ws, FILES)
  const guestBrowser = await signedIn(fresh())
  const guestCaller = await callerOf(guestBrowser)
  return {
    owner,
    ownerCaller,
    ws,
    tree,
    guest: guestCaller.person!,
    guestBrowser,
    guestCaller,
  }
}

const node = async (w: World, path: string) =>
  (await nodeAt(w.tree.treeId, path))!.id

const write = async (w: World, caller: Caller, path: string, page: string) => {
  const seq = await seqOf(w.tree)
  return runAs(
    caller,
    Effect.flatMap(Data, (data) =>
      data.write({
        tree: w.tree.treeId as TreeId,
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

/** A push by the owner's key that changes open/page.html. */
const repushOpen = async (w: World, text: string) =>
  pushAll(
    await agent(w.owner),
    `${w.ws.name}/${w.tree.name}/open`,
    { 'page.html': pageWith(`<p>${text}</p>`, 'Open') },
    { force: true },
  )

/** The socket closes for a change of access, and nothing came before it. */
const closedFirst = async (socket: Socket) => {
  const close = await socket.closedWithin(3000)
  expect(close).toEqual({ code: 4001, reason: 'access changed' })
  expect(socket.seen).toEqual([])
}

const people = <A, E>(
  caller: Caller,
  use: (
    p: PeopleService,
  ) => Effect.Effect<A, E, CoreServices | CurrentCaller | Background>,
) => runAs(caller, Effect.flatMap(People, use))

describe('losing access', () => {
  it('closes the sockets of a revoked email share before any hint of the change', async () => {
    const w = await world()
    await share(
      w.tree.treeId,
      await node(w, 'open'),
      'email',
      w.guest.email.toLowerCase(),
      'read',
      w.owner,
    )
    const socket = open(
      await upgradeAs(w.guestBrowser, w.tree.treeId, ['open/']),
    )
    const [{ id }] = await rows<{ id: string }>(
      'select id from shares where tree_id = ? and target = ?',
      w.tree.treeId,
      w.guest.email.toLowerCase(),
    )
    await runAs(
      w.ownerCaller,
      Effect.gen(function* () {
        const store = yield* TreeStore
        const access = yield* Access
        const granted = yield* access.require(
          'share',
          (yield* store.nearest(w.tree.treeId, 'open'))!,
        )
        return yield* store.change(w.tree.treeId, (cs) =>
          Effect.sync(() => {
            cs.revoke(granted, id as never)
            cs.event({ type: 'share', path: 'open' })
            return {}
          }),
        )
      }),
    )
    await closedFirst(socket)
  })

  it('closes a team member socket when they leave the team', async () => {
    const w = await world()
    const t = await team(w.ws, 'Design', [w.guest])
    await join(w.ws, w.guest)
    await share(
      w.tree.treeId,
      await node(w, 'open'),
      'team',
      t.id,
      'read',
      w.owner,
    )
    const socket = open(
      await upgradeAs(w.guestBrowser, w.tree.treeId, ['open/']),
    )
    await people(w.ownerCaller, (p) =>
      p.removeFromTeam({
        workspace: w.ws.name,
        teamId: t.id as never,
        userId: w.guest.id,
      }),
    )
    await closedFirst(socket)
  })

  it('closes a member socket when they are removed, and an admin one when demoted', async () => {
    const w = await world()
    await join(w.ws, w.guest)
    await share(
      w.tree.treeId,
      await node(w, 'open'),
      'workspace',
      w.ws.id,
      'read',
      w.owner,
    )
    const removed = open(
      await upgradeAs(w.guestBrowser, w.tree.treeId, ['open/']),
    )
    await people(w.ownerCaller, (p) =>
      p.removeMember({ workspace: w.ws.name, userId: w.guest.id }),
    )
    await closedFirst(removed)

    const second = await signedIn(fresh())
    const admin = (await callerOf(second)).person!
    await join(w.ws, admin, 'admin')
    const demoted = open(await upgradeAs(second, w.tree.treeId, ['private/']))
    await people(w.ownerCaller, (p) =>
      p.setRole({ workspace: w.ws.name, userId: admin.id, role: 'member' }),
    )
    await closedFirst(demoted)
  })

  it('closes the sockets of a person who deletes their account', async () => {
    const w = await world()
    await share(
      w.tree.treeId,
      await node(w, 'open'),
      'email',
      w.guest.email.toLowerCase(),
      'read',
      w.owner,
    )
    const socket = open(
      await upgradeAs(w.guestBrowser, w.tree.treeId, ['open/']),
    )
    await people(w.guestCaller, (p) => p.deleteAccount())
    await closedFirst(socket)
  })

  it('closes every socket on a workspace that is suspended or deleted', async () => {
    const w = await world()
    await join(w.ws, w.guest)
    await share(
      w.tree.treeId,
      await node(w, ''),
      'workspace',
      w.ws.id,
      'read',
      w.owner,
    )
    const chief = await signedIn(fresh())
    const chiefCaller = await callerOf(chief)
    await superAdmin(chiefCaller.person!)
    const suspended = open(
      await upgradeAs(w.guestBrowser, w.tree.treeId, ['open/']),
    )
    await people(chiefCaller, (p) => p.suspendWorkspace(w.ws.id as never))
    await closedFirst(suspended)
    await people(chiefCaller, (p) => p.liftSuspension(w.ws.id as never))

    const deleted = open(
      await upgradeAs(w.guestBrowser, w.tree.treeId, ['open/']),
    )
    await people(w.ownerCaller, (p) =>
      p.deleteWorkspace({ workspace: w.ws.name, confirm: w.ws.name }),
    )
    await closedFirst(deleted)
  })

  it('refuses a socket whose access is revoked while it is admitted', async () => {
    const w = await world()
    await share(
      w.tree.treeId,
      await node(w, 'open'),
      'email',
      w.guest.email.toLowerCase(),
      'read',
      w.owner,
    )
    // The revocation commits, and its invalidation reaches the hub, right
    // after the watch read the guest's share.
    harness.use(
      testRuntime({
        env: {
          DB: afterRead(
            env.DB,
            (sql) => /from shares s join nodes n/.test(sql),
            async () => {
              await exec(
                'delete from shares where tree_id = ? and target = ?',
                w.tree.treeId,
                w.guest.email.toLowerCase(),
              )
              // Inside the request: a stub belongs to the request using it.
              const hub = env.TREE_HUB.get(
                env.TREE_HUB.idFromName(w.tree.treeId),
              )
              await hub.close({ people: [w.guest.id as PersonId] })
            },
          ),
        },
      }),
    )
    const response = await upgradeAs(w.guestBrowser, w.tree.treeId, ['open/'])
    harness.reset()
    if (response.status === 101) {
      const socket = open(response)
      expect(await socket.closedWithin(2000)).not.toBeNull()
    } else {
      expect(response.status).toBe(404)
    }
  })
})

describe('a hint', () => {
  it('goes only for a change the socket caller may read, even below a readable folder', async () => {
    const w = await world()
    await share(
      w.tree.treeId,
      await node(w, 'open'),
      'email',
      w.guest.email.toLowerCase(),
      'respond',
      w.owner,
    )
    const socket = open(
      await upgradeAs(w.guestBrowser, w.tree.treeId, ['open/']),
    )
    // A shared data file below open/ the respondent cannot read.
    await write(w, w.ownerCaller, 'open/board.json', 'open/page.html')
    expect(await socket.next(800)).toBeNull()
    await repushOpen(w, 'Changed')
    expect(await socket.next()).toEqual({
      type: 'changed',
      tree: w.tree.treeId,
      sub: 0,
    })
    socket.ws.close(1000, 'done')
  })

  it('reaches a reader restricted to a folder for a push of the root that changed it', async () => {
    const w = await world()
    await share(
      w.tree.treeId,
      await node(w, 'open'),
      'email',
      w.guest.email.toLowerCase(),
      'read',
      w.owner,
    )
    const socket = open(
      await upgradeAs(w.guestBrowser, w.tree.treeId, ['open/']),
    )
    await pushAll(
      await agent(w.owner),
      `${w.ws.name}/${w.tree.name}`,
      { ...FILES, 'private/page.html': pageWith('<p>Secret two</p>', 'P') },
      { force: true },
    )
    expect(await socket.next(800)).toBeNull()
    await pushAll(
      await agent(w.owner),
      `${w.ws.name}/${w.tree.name}`,
      { ...FILES, 'open/page.html': pageWith('<p>Open two</p>', 'Open') },
      { force: true },
    )
    expect(await socket.next()).toMatchObject({ type: 'changed', sub: 0 })
    socket.ws.close(1000, 'done')
  })

  it('stops, and the socket closes, once the session behind it has ended', async () => {
    const w = await world()
    await share(
      w.tree.treeId,
      await node(w, 'open'),
      'email',
      w.guest.email.toLowerCase(),
      'read',
      w.owner,
    )
    const socket = open(
      await upgradeAs(w.guestBrowser, w.tree.treeId, ['open/']),
    )
    await exec('delete from "session" where user_id = ?', w.guest.id)
    await repushOpen(w, 'After sign out')
    expect(await socket.closedWithin(3000)).not.toBeNull()
    expect(socket.seen).toEqual([])
  })
})

describe('a visitor', () => {
  it('watches what anyone may read, and nothing else', async () => {
    const w = await world()
    await share(
      w.tree.treeId,
      await node(w, 'open'),
      'anyone',
      '*',
      'read',
      w.owner,
    )
    const socket = open(
      await upgradeAs(visitorBrowser(), w.tree.treeId, ['open/'], {}),
    )
    await repushOpen(w, 'For everyone')
    expect(await socket.next()).toMatchObject({ type: 'changed', sub: 0 })
    socket.ws.close(1000, 'done')
    const refused = await upgradeAs(
      visitorBrowser(),
      w.tree.treeId,
      ['private/'],
      {},
    )
    expect(refused.status).not.toBe(101)
  })
})
