// A change's hints reach hundreds of sockets with a few queries, and a
// fan-out that fails closes the tree's sockets so clients poll instead.
import type { OpId, TreeId } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { Data, type Caller } from '../../src/core/index.ts'
import { Browser, signedIn } from '../support/browser.ts'
import { countingStatements, exec, failingStatements } from '../support/d1.ts'
import { pageWith, pushForms, seqOf, type FormTree } from '../support/forms.ts'
import { harness, testRuntime } from '../support/harness.ts'
import { keySecretFor } from '../support/keys.ts'
import { callerOf, fresh, runAs } from '../support/people.ts'
import { open, watchUrl, type Socket } from '../support/sockets.ts'
import { nodeAt, person, workspace } from '../support/trees.ts'

afterEach(() => harness.reset())

const SOCKETS = 300

const setUp = async () => {
  const ownerBrowser = await signedIn(fresh())
  const ownerCaller = await callerOf(ownerBrowser)
  const ws = await workspace(ownerCaller.person!)
  const tree = await pushForms(ownerCaller.person!, ws, {
    'open/page.html': pageWith('<p>Open</p>', 'Open'),
  })
  const open_ = (await nodeAt(tree.treeId, 'open'))!.id
  const sockets: Socket[] = []
  for (let i = 0; i < SOCKETS; i += 1) {
    const who = await person(`reader${i}`)
    await exec(
      `insert into shares (id, tree_id, node_id, target_kind, target, role, created_by, created_at)
       values (?, ?, ?, 'email', ?, 'read', ?, ?)`,
      crypto.randomUUID(),
      tree.treeId,
      open_,
      who.email.toLowerCase(),
      ownerCaller.person!.id,
      Date.now(),
    )
    const secret = await keySecretFor(who)
    sockets.push(
      open(
        await new Browser().fetch(watchUrl(tree.treeId, ['open/']), {
          purpose: 'none',
          headers: { upgrade: 'websocket', authorization: `Bearer ${secret}` },
        }),
      ),
    )
  }
  return { ownerCaller, tree, sockets }
}

const write = async (caller: Caller, tree: FormTree) => {
  const seq = await seqOf(tree)
  return runAs(
    caller,
    Effect.flatMap(Data, (data) =>
      data.write({
        tree: tree.treeId as TreeId,
        page: 'open/page.html',
        path: 'open/board.json',
        patch: { at: Date.now() },
        replace: false,
        opId: crypto.randomUUID() as OpId,
        seq,
      }),
    ),
  )
}

describe('hint fan-out', () => {
  it(`hints ${SOCKETS} sockets of different callers with a few queries`, async () => {
    const { ownerCaller, tree, sockets } = await setUp()
    const counted = countingStatements(env.DB)
    harness.use(testRuntime({ env: { DB: counted.db } }))
    await write(ownerCaller, tree)
    harness.reset()
    const hints = await Promise.all(sockets.map((s) => s.next(5000)))
    expect(hints.filter((h) => h === null)).toHaveLength(0)
    // The write's own statements plus the fan-out: never one per socket.
    expect(counted.count()).toBeLessThan(60)
    for (const s of sockets) s.ws.close(1000, 'done')
  }, 240_000)

  it('closes the tree sockets when the fan-out fails, so clients poll', async () => {
    const { ownerCaller, tree, sockets } = await setUp()
    harness.use(
      testRuntime({
        env: {
          DB: failingStatements(env.DB, (sql) => sql.includes('watch hints')),
        },
      }),
    )
    await write(ownerCaller, tree)
    harness.reset()
    const closes = await Promise.all(sockets.map((s) => s.closedWithin(5000)))
    expect(closes.filter((c) => c === null)).toHaveLength(0)
  }, 240_000)
})
