// A file renamed into a page (or a layout) is a page from the move on: its
// forms take answers and a share of it carries what it renders with, as a
// push of it would have made them, by what its version's author could
// read, never by what the person renaming it can.
import type { NodeId } from '@dossier/contracts'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { Access, Files, TreeStore, type Caller } from '../src/core/index.ts'
import { rows } from './support/d1.ts'
import { formRef, sendAs, type FormTree } from './support/forms.ts'
import { harness } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
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

afterEach(() => harness.reset())

const NOTES = `<!doctype html><html><head><title>Notes</title></head><body>
<img src="pic.png"><img src="../private/secret.png">
<form action="answers/" method="post"><label>Role <input name="role"></label><button>Send</button></form>
</body></html>`

const readAs = (caller: Caller, target: string) =>
  runAs(
    caller,
    Effect.gen(function* () {
      const found = yield* (yield* TreeStore).locate(ref(target))
      if ('missing' in found) return 'missing'
      return yield* (yield* Access).require('read', found.node).pipe(
        Effect.map(() => 'ok' as const),
        Effect.catchAll((error) => Effect.succeed(error.code)),
      )
    }),
  )

/**
 * An admin's tree with a private image, and a writer of `team/` who pushed
 * an HTML text there as `notes.txt` and a layout as `_layout.txt`.
 */
const world = async () => {
  const admin = await person('admin')
  const ws = await workspace(admin)
  const adminKey = await agent(admin)
  const name = `r${crypto.randomUUID().slice(0, 8)}`
  const first = await pushAll(adminKey, `${ws.name}/${name}`, {
    'private/secret.png': 'secret png',
    'team/pic.png': 'pic png',
    'team/logo.png': 'logo png',
  })
  if (!('treeId' in first)) throw new Error('no tree')
  const treeId = first.treeId
  const writer = await person('writer')
  await join(ws, writer)
  await share(
    treeId,
    (await nodeAt(treeId, 'team'))!.id,
    'email',
    writer.email,
    'write',
    admin,
  )
  const writerKey = await agent(writer)
  const second = await pushAll(
    writerKey,
    `${ws.name}/${name}/team`,
    {
      'notes.txt': NOTES,
      '_layout.txt':
        '<header><img src="logo.png"><img src="../private/secret.png"></header><slot></slot>',
      'other.html': '<title>Other</title><p>Other</p>',
      'pic.png': 'pic png',
      'logo.png': 'logo png',
    },
    { force: true },
  )
  if (!('number' in second)) throw new Error(JSON.stringify(second))
  const at = (path: string) => `${ws.name}/${name}/${path}`
  const tree: FormTree = {
    owner: admin,
    ownerAgent: adminKey,
    ws,
    treeId,
    name,
  }
  return { admin, adminKey, ws, writer, writerKey, treeId, at, tree }
}

const mv = (caller: Caller, from: string, to: string) =>
  runAs(
    caller,
    Effect.flatMap(Files, (f) => f.mv({ from: ref(from), to: ref(to) })),
  )

describe('a file renamed into a page', () => {
  it('takes answers through its forms from the move on', async () => {
    const w = await world()
    await mv(w.adminKey, w.at('team/notes.txt'), w.at('team/notes.html'))
    const forms = await rows<{ target_path: string }>(
      `select f.target_path from forms f join nodes n on n.id = f.host_node_id
       where n.tree_id = ? and n.path = 'team/notes.html'
         and f.host_version_id = n.current_version_id`,
      w.treeId,
    )
    expect(forms.map((f) => f.target_path)).toEqual(['team/answers/'])
    const sent = await sendAs(await sessionFor(w.writer), w.tree, {
      page: 'team/notes.html',
      form: await formRef(w.tree, 'team/notes.html', 'team/answers/'),
      entries: [['role', 'Driver']],
    })
    expect(JSON.stringify(sent)).toContain(
      `team/answers/${w.writer.email}.json`,
    )
  })

  it('carries for a page share what its version’s author could read, never what the person renaming it can', async () => {
    const w = await world()
    await mv(w.adminKey, w.at('team/notes.txt'), w.at('team/notes.html'))
    await mv(w.adminKey, w.at('team/_layout.txt'), w.at('team/_layout.html'))
    const needs = await rows<{
      page: string
      need: string
      host: string
      reads: number
    }>(
      `select page_path as page, need_path as need, host_path as host, reads
       from page_needs where tree_id = ? and kind = 'render'
       order by page, host, need`,
      w.treeId,
    )
    expect(needs).toEqual([
      // The whole page takes no layout; the layout renders on the other
      // page of team/, with its author's reach.
      {
        page: 'team/notes.html',
        need: 'private/secret.png',
        host: 'team/notes.html',
        reads: 0,
      },
      {
        page: 'team/notes.html',
        need: 'team/pic.png',
        host: 'team/notes.html',
        reads: 1,
      },
      {
        page: 'team/other.html',
        need: 'private/secret.png',
        host: 'team/_layout.html',
        reads: 0,
      },
      {
        page: 'team/other.html',
        need: 'team/logo.png',
        host: 'team/_layout.html',
        reads: 1,
      },
    ])
    await share(
      w.treeId,
      (await nodeAt(w.treeId, 'team/notes.html'))!.id as NodeId,
      'anyone',
      '*',
      'read',
      w.admin,
    )
    expect(await readAs(visitorCaller(), w.at('team/pic.png'))).toBe('ok')
    // The layout's image comes with a share of the page it composes into.
    expect(await readAs(visitorCaller(), w.at('team/logo.png'))).toBe(
      'sign_in_required',
    )
    await share(
      w.treeId,
      (await nodeAt(w.treeId, 'team/other.html'))!.id as NodeId,
      'anyone',
      '*',
      'read',
      w.admin,
    )
    expect(await readAs(visitorCaller(), w.at('team/logo.png'))).toBe('ok')
    expect(await readAs(visitorCaller(), w.at('private/secret.png'))).toBe(
      'sign_in_required',
    )
  })

  it('applies a push’s page rules to it: a form may not send into a page’s comments folder', async () => {
    const w = await world()
    await pushAll(
      w.writerKey,
      `${w.tree.ws.name}/${w.tree.name}/team`,
      {
        'notes.txt': NOTES,
        '_layout.txt': '<slot></slot>',
        'other.html': '<title>Other</title><p>Other</p>',
        'pic.png': 'pic png',
        'logo.png': 'logo png',
        'trap.txt':
          '<title>Trap</title><form action="other.comments/" method="post"><input name="a"></form>',
      },
      { force: true },
    )
    const refused = await failureAs(
      w.adminKey,
      Effect.flatMap(Files, (f) =>
        f.mv({
          from: ref(w.at('team/trap.txt')),
          to: ref(w.at('team/trap.html')),
        }),
      ),
    )
    expect(refused).toMatchObject({
      code: 'policy_rejected',
      message: expect.stringContaining('comments folder') as never,
    })
    expect(await nodeAt(w.treeId, 'team/trap.txt')).toBeDefined()
    expect(
      await rows(
        `select 1 from forms where tree_id = ? and target_path like '%comments%'`,
        w.treeId,
      ),
    ).toEqual([])
  })
})

describe('a page moved', () => {
  it('keeps its forms taking answers, and so does a layout moved', async () => {
    const w = await world()
    const formsOf = (path: string) =>
      rows<{ target_path: string }>(
        `select f.target_path from forms f join nodes n on n.id = f.host_node_id
         where n.tree_id = ? and n.path = ? and n.deleted_at is null
           and f.host_version_id = n.current_version_id`,
        w.treeId,
        path,
      )
    await pushAll(
      w.writerKey,
      `${w.tree.ws.name}/${w.tree.name}/team`,
      {
        'plan.html': NOTES,
        '_layout.html':
          '<header><form action="answers/" method="post"><input name="note"><button>Send</button></form></header><slot></slot>',
        'pic.png': 'pic png',
        'logo.png': 'logo png',
      },
      { force: true },
    )
    expect(await formsOf('team/plan.html')).toHaveLength(1)
    expect(await formsOf('team/_layout.html')).toHaveLength(1)
    await mv(w.adminKey, w.at('team/plan.html'), w.at('team/renamed.html'))
    await mv(
      w.adminKey,
      w.at('team/_layout.html'),
      w.at('team/inner/_layout.html'),
    )
    expect(await formsOf('team/renamed.html')).toEqual([
      { target_path: 'team/answers/' },
    ])
    expect(await formsOf('team/inner/_layout.html')).toEqual([
      { target_path: 'team/answers/' },
    ])
    const sent = await sendAs(await sessionFor(w.writer), w.tree, {
      page: 'team/renamed.html',
      form: await formRef(w.tree, 'team/renamed.html', 'team/answers/'),
      entries: [['role', 'Driver']],
    })
    expect(JSON.stringify(sent)).toContain(
      `team/answers/${w.writer.email}.json`,
    )

    // A page renamed out of being a page has no forms left.
    await mv(w.adminKey, w.at('team/renamed.html'), w.at('team/renamed.txt'))
    expect(await formsOf('team/renamed.txt')).toEqual([])
  })
})
