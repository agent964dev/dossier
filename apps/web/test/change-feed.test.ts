// Every change publishes once, after its batch commits, with its events and
// whose watching sockets it closes.
import type { AuthoredSeq, OpId, Person, TreeId } from '@dossier/contracts'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  Access,
  ChangeFeedRecorder,
  Data,
  TreeStore,
  type Caller,
  type Committed,
} from '../src/core/index.ts'
import { exec, rows } from './support/d1.ts'
import {
  formRef,
  pageWith,
  pushForms,
  QUESTIONS,
  seqOf,
  type FormTree,
} from './support/forms.ts'
import { harness, testRuntime } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  agent,
  failureAs,
  nodeAt,
  person,
  pushAll,
  share,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

const FILES = {
  'questions/index.html': QUESTIONS,
  'board.html': pageWith('<p>Board</p>', 'Board'),
}

let owner: Person
let ws: { id: string; name: string }
let browser: Caller

beforeAll(async () => {
  owner = await person('owner')
  ws = await workspace(owner)
  browser = await sessionFor(owner)
})

/** Serves with a recorder as the change feed while `body` runs. */
const recording = async (
  body: (published: () => readonly Committed[]) => Promise<void>,
) => {
  const recorder = ChangeFeedRecorder()
  harness.use(testRuntime({ overrides: { changeFeed: recorder.layer } }))
  await body(recorder.published)
}

const write = async (tree: FormTree, path: string, patch: object) => {
  const seq = await seqOf(tree)
  return runAs(
    browser,
    Effect.flatMap(Data, (data) =>
      data.write({
        tree: tree.treeId as TreeId,
        page: 'board.html',
        path,
        patch: patch as never,
        replace: false,
        opId: crypto.randomUUID() as OpId,
        seq,
      }),
    ),
  )
}

describe('the change feed', () => {
  it('publishes a push, a send, an upload, a withdrawal and a write once each, with their events', async () => {
    await recording(async (published) => {
      const tree = await pushForms(owner, ws, FILES)
      expect(published()).toHaveLength(1)
      expect(published()[0]).toMatchObject({
        treeId: tree.treeId,
        seq: 1,
        authoredSeq: 1,
        events: [{ seq: 1, type: 'push', path: '' }],
        close: null,
      })
      const form = await formRef(
        tree,
        'questions/index.html',
        'questions/answers/',
      )
      const seq = await seqOf(tree)
      const email = owner.email.toLowerCase()
      await runAs(
        browser,
        Effect.flatMap(Data, (data) =>
          data.upload({
            treeId: tree.treeId,
            page: 'questions/index.html',
            seq,
            form,
            field: 'cv',
            name: 'cv.pdf',
            type: 'application/pdf',
            size: 3,
            sha256:
              '55b8e4f6ba1b5d1bc5e1b4e6d4ec4a0dc8e3de51e4c0b70e0e0d2a8d44d7a6a6' as never,
            body: new Blob(['cv!']).stream() as ReadableStream<Uint8Array>,
            opId: crypto.randomUUID() as OpId,
          }),
        ),
      ).catch(() => null)
      // The hash above is wrong on purpose: a refused upload publishes nothing.
      expect(published()).toHaveLength(1)
      const bytes = new TextEncoder().encode('cv!')
      const sha = [
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      ]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      const stored = await runAs(
        browser,
        Effect.flatMap(Data, (data) =>
          data.upload({
            treeId: tree.treeId,
            page: 'questions/index.html',
            seq,
            form,
            field: 'cv',
            name: 'cv.pdf',
            type: 'application/pdf',
            size: bytes.length,
            sha256: sha as never,
            body: new Blob([bytes]).stream() as ReadableStream<Uint8Array>,
            opId: crypto.randomUUID() as OpId,
          }),
        ),
      )
      await runAs(
        browser,
        Effect.flatMap(Data, (data) =>
          data.send({
            treeId: tree.treeId,
            page: 'questions/index.html',
            seq,
            form,
            entries: [
              ['role', 'Driver'],
              ['cv', stored],
            ],
            submitter: null,
            entry: null,
            opId: crypto.randomUUID() as OpId,
          }),
        ),
      )
      const answers = `questions/answers/${email}.json`
      await runAs(
        browser,
        Effect.flatMap(Data, (data) =>
          data.withdraw({
            treeId: tree.treeId,
            path: answers,
            opId: crypto.randomUUID() as OpId,
          }),
        ),
      )
      await write(tree, 'layout.json', { a: 1 })
      expect(
        published()
          .slice(1)
          .map((c) => c.events.map((e) => [e.seq, e.type, e.path])),
      ).toEqual([
        [[2, 'data_write', stored.path]],
        [[3, 'submission', answers]],
        [[4, 'withdrawal', answers]],
        [[5, 'data_write', 'layout.json']],
      ])
      expect(published().map((c) => c.seq)).toEqual([1, 2, 3, 4, 5])
    })
  })

  it('publishes nothing when the batch fails', async () => {
    await recording(async (published) => {
      const tree = await pushForms(owner, ws, FILES)
      await write(tree, 'list.json', { a: 1 })
      const before = published().length
      await exec(
        `update node_versions set json_value = '[1]' where id =
           (select current_version_id from nodes where tree_id = ? and path = 'list.json')`,
        tree.treeId,
      )
      await expect(write(tree, 'list.json', { b: 1 })).rejects.toThrow()
      expect(published()).toHaveLength(before)
    })
  })

  it('closes the sockets of the person an email share named, and every socket for a workspace share', async () => {
    await recording(async (published) => {
      const key = await agent(owner)
      const pushed = await pushAll(key, `${ws.name}/revokes`, {
        'plan.html': pageWith('<p>Plan</p>', 'Plan'),
      })
      const treeId = (pushed as { treeId: TreeId }).treeId
      const root = (await nodeAt(treeId, ''))!.id
      const guest = await person('guest')
      await share(
        treeId,
        root,
        'email',
        guest.email.toLowerCase(),
        'read',
        owner,
      )
      await share(treeId, root, 'workspace', ws.id, 'read', owner)
      const shareOf = async (target: string) =>
        (
          await rows<{ id: string }>(
            'select id from shares where tree_id = ? and target = ?',
            treeId,
            target,
          )
        )[0]!.id
      const revoke = (shareId: string) =>
        runAs(
          browser,
          Effect.gen(function* () {
            const store = yield* TreeStore
            const access = yield* Access
            const node = yield* store.nearest(treeId, '')
            const granted = yield* access.require('share', node!)
            return yield* store.change(treeId, (cs) =>
              Effect.sync(() => {
                cs.revoke(granted, shareId as never)
                cs.event({ type: 'share', path: '' })
                return {}
              }),
            )
          }),
        )
      await revoke(await shareOf(guest.email.toLowerCase()))
      expect(published().at(-1)?.close).toEqual({ people: [guest.id] })
      await revoke(await shareOf(ws.id))
      expect(published().at(-1)?.close).toEqual({ all: true })
    })
  })

  it('publishes nothing for a change its guard refuses', async () => {
    await recording(async (published) => {
      const tree = await pushForms(owner, ws, FILES)
      const before = published().length
      const failed = await failureAs(
        browser,
        Effect.gen(function* () {
          const store = yield* TreeStore
          return yield* store.change(tree.treeId, (cs) =>
            Effect.sync(() => {
              cs.guardHead('', 0 as AuthoredSeq)
              cs.event({ type: 'share', path: '' })
              return {}
            }),
          )
        }),
      )
      expect(failed).toMatchObject({ code: 'stale_head' })
      expect(published()).toHaveLength(before)
    })
  })
})
