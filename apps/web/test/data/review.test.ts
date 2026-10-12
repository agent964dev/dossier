import type { Person } from '@dossier/contracts'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Access, Data, TreeStore, type Caller } from '../../src/core/index.ts'
import { count, rows } from '../support/d1.ts'
import {
  formRef,
  liveValue,
  pageWith,
  pushForms,
  QUESTIONS,
  repush,
  sendAs,
  sendFailure,
  uploadAs,
  uploadFailure,
  withdrawAs,
  type FormTree,
} from '../support/forms.ts'
import { env } from 'cloudflare:workers'
import { beforeBatch } from '../support/d1.ts'
import { harness, testRuntime } from '../support/harness.ts'
import { runAs, sessionFor } from '../support/people.ts'
import {
  nodeAt,
  person,
  ref,
  sha256Of,
  share,
  workspace,
} from '../support/trees.ts'

afterEach(() => harness.reset())

const FILES = {
  'questions/index.html': QUESTIONS,
  'board.html': pageWith(
    '<form action="board.json"><input name="status"><input name="owner"></form>',
  ),
  'poll.html': pageWith(
    '<form action="board.json"><input name="vote"><button>Vote</button></form>',
  ),
  'ideas.html': pageWith(
    '<form action="ideas/" data-entries="many"><input name="idea"><input name="photo" type="file" accept="image/*"><button>Add</button></form>',
  ),
}

let owner: Person
let ownerCaller: Caller
let ws: { id: string; name: string }

beforeAll(async () => {
  owner = await person('owner')
  ownerCaller = await sessionFor(owner)
  ws = await workspace(owner)
})

const respondent = async (tree: FormTree, kind: 'email' | 'anyone') => {
  const who = await person('respondent')
  await share(
    tree.treeId,
    (await nodeAt(tree.treeId, ''))!.id,
    kind,
    kind === 'email' ? who.email.toLowerCase() : '*',
    'respond',
    owner,
  )
  return { who, caller: await sessionFor(who) }
}

describe('a send into a shared file', () => {
  // A respondent through a private share reads the shared file their form
  // writes; one through an anyone share never reads other people's data.
  it.each(['email', 'anyone'] as const)(
    'answers a sender with the whole file only when they read it (%s respond)',
    async (kind) => {
      const tree = await pushForms(owner, ws, FILES)
      const board = await formRef(tree, 'board.html', 'board.json')
      const poll = await formRef(tree, 'poll.html', 'board.json')
      await sendAs(ownerCaller, tree, {
        page: 'board.html',
        form: board,
        entries: [
          ['status', 'SECRET-status'],
          ['owner', 'SECRET-owner'],
        ],
      })
      const { who, caller } = await respondent(tree, kind)
      const opId = crypto.randomUUID()
      const sent = await sendAs(caller, tree, {
        page: 'poll.html',
        form: poll,
        entries: [['vote', 'yes']],
        opId,
      })
      expect(sent.doc).toMatchObject({
        path: 'board.json',
        data: { vote: 'yes' },
        by: who.email,
      })
      const replayed = await sendAs(caller, tree, {
        page: 'poll.html',
        form: poll,
        entries: [['vote', 'yes']],
        opId,
      })
      if (kind === 'anyone') {
        expect(JSON.stringify(sent)).not.toContain('SECRET')
        expect(JSON.stringify(replayed)).not.toContain('SECRET')
      } else {
        expect(replayed.doc?.data).toEqual({
          status: 'SECRET-status',
          owner: 'SECRET-owner',
          vote: 'yes',
        })
      }
      // The file itself keeps everyone's fields.
      expect((await liveValue(tree.treeId, 'board.json'))?.value).toEqual({
        status: 'SECRET-status',
        owner: 'SECRET-owner',
        vote: 'yes',
      })
      // Someone who reads it gets the whole file back.
      const full = await sendAs(ownerCaller, tree, {
        page: 'poll.html',
        form: poll,
        entries: [['vote', 'no']],
      })
      expect(full.doc?.data).toMatchObject({ status: 'SECRET-status' })
    },
  )

  it('keeps both people’s fields when two first sends land together', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const board = await formRef(tree, 'board.html', 'board.json')
    const { caller } = await respondent(tree, 'email')
    await Promise.all([
      sendAs(ownerCaller, tree, {
        page: 'board.html',
        form: board,
        entries: [['status', 'Open']],
      }),
      sendAs(caller, tree, {
        page: 'board.html',
        form: board,
        entries: [['owner', 'Sara']],
      }),
    ])
    expect((await liveValue(tree.treeId, 'board.json'))?.value).toEqual({
      status: 'Open',
      owner: 'Sara',
    })
  })

  it('never writes into a file that belongs to someone', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await respondent(tree, 'email')
    const q = await formRef(tree, 'questions/index.html', 'questions/answers/')
    await sendAs(sara.caller, tree, {
      page: 'questions/index.html',
      form: q,
      entries: [['role', 'Driver']],
    })
    const theirs = `questions/answers/${sara.who.email.toLowerCase()}.json`
    await repush(tree, {
      ...FILES,
      'evil.html': pageWith(
        `<form action="questions/answers/${sara.who.email.toLowerCase()}.json"><input name="role"></form>`,
      ),
    })
    const omar = await respondent(tree, 'email')
    const failure = await sendFailure(omar.caller, tree, {
      page: 'evil.html',
      form: await formRef(tree, 'evil.html', theirs),
      entries: [['role', 'Overwritten by omar']],
    })
    expect(failure.code).toBe('forbidden')
    expect((await liveValue(tree.treeId, theirs))?.value).toMatchObject({
      role: 'Driver',
    })
  })
})

describe('uploads', () => {
  const photo = async (tree: FormTree, bytes: string, caller = ownerCaller) => {
    const form = await formRef(tree, 'ideas.html', 'ideas/')
    const stored = await uploadAs(caller, tree, {
      page: 'ideas.html',
      form,
      field: 'photo',
      name: 'image.jpg',
      type: 'image/jpeg',
      bytes,
    })
    const sent = await sendAs(caller, tree, {
      page: 'ideas.html',
      form,
      entries: [
        ['idea', bytes],
        [
          'photo',
          {
            file: stored.file,
            name: stored.name,
            size: stored.size,
            type: stored.type,
          },
        ],
      ],
    })
    return { stored, sent }
  }

  it('never replaces an earlier upload of the same name', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const one = await photo(tree, 'bytes of the first photo')
    const two = await photo(tree, 'second')
    expect(two.stored.path).not.toBe(one.stored.path)
    const [first] = await rows<{ versions: number; sha: string }>(
      `select (select count(*) from node_versions v where v.node_id = n.id) as versions,
         (select v.blob_sha256 from node_versions v where v.id = n.current_version_id) as sha
       from nodes n where n.tree_id = ? and n.path = ? and n.deleted_at is null`,
      tree.treeId,
      one.stored.path,
    )
    expect(first).toEqual({
      versions: 1,
      sha: await sha256Of('bytes of the first photo'),
    })
  })

  it('stores a sent upload as the file it is, whatever the send says of it', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const form = await formRef(tree, 'ideas.html', 'ideas/')
    const stored = await uploadAs(ownerCaller, tree, {
      page: 'ideas.html',
      form,
      field: 'photo',
      name: 'cat.png',
      type: 'image/png',
      bytes: 'png!',
    })
    const sent = await sendAs(ownerCaller, tree, {
      page: 'ideas.html',
      form,
      entries: [
        ['idea', 'x'],
        [
          'photo',
          { file: stored.file, name: 'report.pdf', size: 1, type: 'image/png' },
        ],
      ],
    })
    expect(sent.doc).not.toBeNull()
    expect((sent.doc!.data as { photo: unknown }).photo).toEqual({
      file: stored.file,
      name: 'cat.png',
      size: 4,
      type: 'image/png',
    })
  })

  it('refuses a file of a type the field does not accept', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const failure = await uploadFailure(ownerCaller, tree, {
      page: 'ideas.html',
      form: await formRef(tree, 'ideas.html', 'ideas/'),
      field: 'photo',
      name: 'payload.exe',
      type: 'application/octet-stream',
      bytes: 'MZ',
    })
    expect(failure).toMatchObject({ code: 'invalid', path: 'photo' })
  })

  it('answers overlapping tries of one upload alike, stored once', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const form = await formRef(tree, 'ideas.html', 'ideas/')
    const opId = crypto.randomUUID()
    const tries = await Promise.all(
      [1, 2, 3].map(() =>
        uploadAs(ownerCaller, tree, {
          page: 'ideas.html',
          form,
          field: 'photo',
          name: 'same.png',
          type: 'image/png',
          bytes: 'same bytes',
          opId,
        }),
      ),
    )
    expect(new Set(tries.map((t) => t.path)).size).toBe(1)
    expect(
      await count('nodes', "tree_id = ? and path like '%same%'", tree.treeId),
    ).toBe(1)
    expect(await count('blob_holds', "holder_kind = 'upload'")).toBe(0)
  })

  it('takes real bytes: refuses past 10 MiB, and a body longer than it says', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const form = await formRef(tree, 'ideas.html', 'ideas/')
    const big = 'x'.repeat(10 * 1024 * 1024 + 1)
    expect(
      (
        await uploadFailure(ownerCaller, tree, {
          page: 'ideas.html',
          form,
          field: 'photo',
          name: 'big.png',
          type: 'image/png',
          bytes: big,
        })
      ).code,
    ).toBe('too_large')
    expect(
      (
        await uploadFailure(ownerCaller, tree, {
          page: 'ideas.html',
          form,
          field: 'photo',
          name: 'lies.png',
          type: 'image/png',
          bytes: 'a body much longer than declared',
          size: 4,
        })
      ).code,
    ).toBe('invalid')
  })
})

describe('a withdrawal', () => {
  it('takes every upload of the person in that form that no answer still names, and the folders left empty', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await respondent(tree, 'email')
    const q = await formRef(tree, 'questions/index.html', 'questions/answers/')
    const orphan = await uploadAs(sara.caller, tree, {
      page: 'questions/index.html',
      form: q,
      field: 'cv',
      name: 'orphan.pdf',
      bytes: '%PDF orphan',
    })
    await sendAs(sara.caller, tree, {
      page: 'questions/index.html',
      form: q,
      entries: [['role', 'Driver']],
    })
    const email = sara.who.email.toLowerCase()
    await withdrawAs(sara.caller, tree, `questions/answers/${email}.json`)
    expect(await liveValue(tree.treeId, orphan.path)).toBeNull()
    expect(
      await count(
        'nodes',
        'tree_id = ? and deleted_at is null and substr(path, 1, length(?2)) = ?2',
        tree.treeId,
        `questions/answers/${email}`,
      ),
    ).toBe(0)
    const forms = await runAs(
      ownerCaller,
      Effect.gen(function* () {
        const located = yield* (yield* TreeStore).locate(
          ref(`${ws.name}/${tree.name}/`),
        )
        if ('missing' in located) throw new Error('missing')
        const granted = yield* (yield* Access).require('read', located.node)
        return yield* (yield* Data).pageForms(granted)
      }),
    )
    const questions = (await nodeAt(tree.treeId, 'questions'))!.id
    expect(forms.get(questions)?.people).toBe(0)
  })
})

describe('a withdrawal after review', () => {
  it('reads each answer’s uploads against its own folder, so another form’s answer never keeps this one’s', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const sara = await respondent(tree, 'email')
    const email = sara.who.email.toLowerCase()
    const q = await formRef(tree, 'questions/index.html', 'questions/answers/')
    const cv = await uploadAs(sara.caller, tree, {
      page: 'questions/index.html',
      form: q,
      field: 'cv',
      name: 'image.png',
      type: 'image/png',
      bytes: 'cv bytes',
    })
    await sendAs(sara.caller, tree, {
      page: 'questions/index.html',
      form: q,
      entries: [
        ['role', 'Driver'],
        ['cv', { file: cv.file, name: cv.name, size: cv.size, type: cv.type }],
      ],
    })
    // An entry in another form names `files/image.png` too, in its own folder.
    const ideas = await formRef(tree, 'ideas.html', 'ideas/')
    const photo = await uploadAs(sara.caller, tree, {
      page: 'ideas.html',
      form: ideas,
      field: 'photo',
      name: 'image.png',
      type: 'image/png',
      bytes: 'photo bytes',
    })
    expect(photo.file).toBe(cv.file)
    await sendAs(sara.caller, tree, {
      page: 'ideas.html',
      form: ideas,
      entries: [
        ['idea', 'x'],
        [
          'photo',
          {
            file: photo.file,
            name: photo.name,
            size: photo.size,
            type: photo.type,
          },
        ],
      ],
    })
    await withdrawAs(sara.caller, tree, `questions/answers/${email}.json`)
    expect(await liveValue(tree.treeId, cv.path)).toBeNull()
    expect(await liveValue(tree.treeId, photo.path)).not.toBeNull()
  })

  it('never takes an upload that an entry written meanwhile names', async () => {
    const tree = await pushForms(owner, ws, FILES)
    const form = await formRef(tree, 'ideas.html', 'ideas/')
    const photo = await uploadAs(ownerCaller, tree, {
      page: 'ideas.html',
      form,
      field: 'photo',
      name: 'shared.png',
      type: 'image/png',
      bytes: 'one photo',
    })
    const value = {
      file: photo.file,
      name: photo.name,
      size: photo.size,
      type: photo.type,
    }
    const first = await sendAs(ownerCaller, tree, {
      page: 'ideas.html',
      form,
      entries: [
        ['idea', 'first'],
        ['photo', value],
      ],
    })
    const own = first.doc!.path.slice(0, first.doc!.path.lastIndexOf('/'))
    // Just before the withdrawal's batch, another entry naming the photo lands.
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (query) => query.includes("'withdrawn'"),
            async () => {
              const node = crypto.randomUUID()
              const version = crypto.randomUUID()
              const now = Date.now()
              await env.DB.batch([
                env.DB.prepare(
                  `insert into nodes (id, tree_id, parent_id, name, path, depth, kind, origin,
                     owner_id, current_version_id, created_at)
                   select ?, ?, (select id from nodes where tree_id = ? and path = ?
                     and deleted_at is null), 'later.json', ?, ?, 'file', 'data', ?, ?, ?`,
                ).bind(
                  node,
                  tree.treeId,
                  tree.treeId,
                  own,
                  `${own}/later.json`,
                  own.split('/').length + 1,
                  owner.id,
                  version,
                  now,
                ),
                env.DB.prepare(
                  `insert into node_versions (id, node_id, tree_id, revision, state, json_value,
                     size, content_type, author_id, created_at)
                   values (?, ?, ?, 1, 'live', ?, 1, 'application/json', ?, ?)`,
                ).bind(
                  version,
                  node,
                  tree.treeId,
                  JSON.stringify({ idea: 'later', photo: value }),
                  owner.id,
                  now,
                ),
              ])
            },
          ),
        },
      }),
    )
    await withdrawAs(ownerCaller, tree, first.doc!.path)
    harness.reset()
    expect(await liveValue(tree.treeId, first.doc!.path)).toBeNull()
    expect(await liveValue(tree.treeId, photo.path)).not.toBeNull()
  })
})
