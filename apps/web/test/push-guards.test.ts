// Pushes against people without access, keys that reach less, forged
// manifests, and changes that land while another push commits.
import type { PushId, Sha256, WorkspaceId } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Cause, Effect, Runtime } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Files,
  Push,
  TreeStore,
  type Caller,
  type CommitResult,
  type Membership,
  type StageResult,
} from '../src/core/index.ts'
import { beforeBatch, exec, rows } from './support/d1.ts'
import { harness, testRuntime } from './support/harness.ts'
import { runAs } from './support/people.ts'
import {
  agent,
  commit,
  failureAs,
  join,
  nodeAt,
  person,
  pushAll,
  ref,
  sha256Of,
  stage,
  treeOf,
  upload,
  workspace,
  type Files as FileMap,
} from './support/trees.ts'

afterEach(() => harness.reset())

const committed = (result: CommitResult | StageResult): CommitResult => {
  if (!('number' in result)) throw new Error('the push did not commit')
  return result
}

/** A workspace with an admin and a member whose key pushes. */
const setUp = async () => {
  const admin = await person('admin')
  const ws = await workspace(admin)
  const creator = await person('creator')
  await join(ws, creator)
  return { admin, ws, creator, key: await agent(creator) }
}

const encoder = new TextEncoder()
const putBlob = (caller: Caller, pushId: PushId, text: string) =>
  Effect.promise(() => sha256Of(text)).pipe(
    Effect.flatMap((sha256) =>
      Effect.flatMap(Push, (push) =>
        push.putBlob({
          pushId,
          sha256,
          size: encoder.encode(text).length,
          body: new Blob([text]).stream(),
        }),
      ),
    ),
  )

/** The error a rejected run failed with. */
const unwrap = (error: unknown) =>
  (Runtime.isFiberFailure(error)
    ? Cause.squash(error[Runtime.FiberFailureCauseId])
    : error) as { code: string; message: string; path: string | null }

const stageFailure = (caller: Caller, target: string, files: FileMap) =>
  stage(caller, target, files).then(() => null, unwrap)

/** Commits `pushId` while `meanwhile` lands just before its batch. */
const commitWhile = async (
  caller: Caller,
  pushId: PushId,
  meanwhile: () => Promise<unknown>,
) => {
  harness.use(
    testRuntime({
      env: {
        DB: beforeBatch(
          env.DB,
          (sql) => sql.includes('insert into change_guards'),
          async () => {
            await meanwhile()
          },
        ),
      },
    }),
  )
  try {
    return await runAs(
      caller,
      Effect.flatMap(Push, (push) => push.commit(pushId)).pipe(Effect.either),
    )
  } finally {
    harness.reset()
  }
}

const childrenOfFiles = (treeId: string) =>
  rows<{ path: string }>(
    `select c.path from nodes c join nodes p on p.id = c.parent_id
     where c.tree_id = ? and c.deleted_at is null and p.kind = 'file'`,
    treeId,
  )

describe('who may push', () => {
  it('answers a path under a file the caller cannot open as missing, not as a file in the way', async () => {
    const { ws, key } = await setUp()
    committed(await pushAll(key, `${ws.name}/acme`, { 'secret.txt': 'x' }))
    const outsider = await agent(await person('outsider'))
    const files = { 'a.txt': 'a' }
    const underFile = await stageFailure(
      outsider,
      `${ws.name}/acme/secret.txt/sub`,
      files,
    )
    const underNothing = await stageFailure(
      outsider,
      `${ws.name}/acme/nothing.txt/sub`,
      files,
    )
    expect(underFile?.code).toBe('not_found')
    expect(underFile).toEqual(underNothing)
    // A writer learns what is in the way.
    const writer = await stageFailure(
      key,
      `${ws.name}/acme/secret.txt/sub`,
      files,
    )
    expect(writer?.code).toBe('invalid')
  })

  it('takes a file only from the key that staged the push, and only while it can still write', async () => {
    const { admin, ws, creator, key } = await setUp()
    const first = committed(
      await pushAll(key, `${ws.name}/acme`, { 'plans/a.txt': 'a' }),
    )
    const files = { 'plans/a.txt': 'a', 'private.txt': 'private' }
    const staged = await stage(key, `${ws.name}/acme`, files, {
      baseSeq: first.seq,
      baseTree: first.treeId,
    })
    const pushId = staged.pushId as PushId
    const plansNode = (await nodeAt(first.treeId, 'plans'))?.id ?? null
    for (const other of [
      await agent(creator, { readOnly: true }),
      await agent(creator, { scope: plansNode }),
      await agent(creator),
    ]) {
      const refused = await failureAs(other, putBlob(other, pushId, 'private'))
      expect(refused.code).toBe('not_found')
    }
    // An admin whose admin row goes after staging cannot upload any more.
    const adminKey = await agent(admin)
    const adminFiles = { ...files, 'admin.txt': 'by the admin' }
    const adminStaged = await stage(adminKey, `${ws.name}/acme`, adminFiles, {
      baseSeq: first.seq,
      baseTree: first.treeId,
    })
    await exec(
      'delete from workspace_members where workspace_id = ? and user_id = ?',
      ws.id,
      admin.id,
    )
    const revoked = await failureAs(
      adminKey,
      putBlob(adminKey, adminStaged.pushId as PushId, 'by the admin'),
    )
    expect(revoked.code).toBe('not_found')
    // The staging key itself still uploads.
    await upload(key, pushId, files, staged.missing)
    expect((await commit(key, pushId)).number).toBe(2)
  })
})

describe('what a push checks', () => {
  it('checks pages outside the pushed folder against the tree the push makes', async () => {
    const { ws, key } = await setUp()
    const first = committed(
      await pushAll(key, `${ws.name}/acme`, {
        'question.html':
          '<title>Q</title>\n<form method="post" action="answers/"><input name="a"></form>',
      }),
    )
    const refused = await stageAndCommitFailure(
      key,
      `${ws.name}/acme/answers`,
      {
        'x.txt': 'authored',
      },
      { baseSeq: first.seq, baseTree: first.treeId },
    )
    expect(refused?.code).toBe('policy_rejected')
    expect(refused?.message).toContain('question.html')
    expect(await nodeAt(first.treeId, 'answers/x.txt')).toBeUndefined()
  })

  it('checks again when another push lands while it commits', async () => {
    const { ws, key } = await setUp()
    const first = committed(
      await pushAll(key, `${ws.name}/acme`, {
        'index.html': '<title>A</title>',
      }),
    )
    const base = { baseSeq: first.seq, baseTree: first.treeId }
    const formFiles = {
      'question.html':
        '<title>Q</title>\n<form method="post" action="../answers/"><input name="a"></form>',
    }
    const form = await stage(key, `${ws.name}/acme/plans`, formFiles, base)
    await upload(key, form.pushId as PushId, formFiles, form.missing)
    const authoredFiles = { 'x.txt': 'authored' }
    const authored = await stage(
      key,
      `${ws.name}/acme/answers`,
      authoredFiles,
      base,
    )
    await upload(
      key,
      authored.pushId as PushId,
      authoredFiles,
      authored.missing,
    )

    const outcome = await commitWhile(key, form.pushId as PushId, () =>
      commit(key, authored.pushId as PushId),
    )

    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left')
      expect(outcome.left.code).toBe('policy_rejected')
    expect(await nodeAt(first.treeId, 'plans/question.html')).toBeUndefined()
    expect(await nodeAt(first.treeId, 'answers/x.txt')).toBeDefined()
  })

  it('refuses a manifest that holds a file and a folder at one path', async () => {
    const { ws, key } = await setUp()
    const refused = await stageFailure(key, `${ws.name}/clash`, {
      'a.txt': 'file',
      'a.txt/b.txt': 'inside',
    })
    expect(refused?.code).toBe('invalid')
    expect(await treeOf(ws.name, 'clash')).toBeUndefined()
  })

  it('never puts a folder under a file another push wrote meanwhile', async () => {
    const { ws, key } = await setUp()
    const first = committed(
      await pushAll(key, `${ws.name}/acme`, {
        'index.html': '<title>A</title>',
      }),
    )
    const base = { baseSeq: first.seq, baseTree: first.treeId }
    const deep = { 'f.txt': 'deep' }
    const folder = await stage(key, `${ws.name}/acme/slot/deep`, deep, base)
    await upload(key, folder.pushId as PushId, deep, folder.missing)
    const root = { 'index.html': '<title>A</title>', slot: 'a file now' }
    const file = await stage(key, `${ws.name}/acme`, root, base)
    await upload(key, file.pushId as PushId, root, file.missing)

    const outcome = await commitWhile(key, folder.pushId as PushId, () =>
      commit(key, file.pushId as PushId),
    )

    expect(outcome._tag).toBe('Left')
    expect(await childrenOfFiles(first.treeId)).toEqual([])
    expect((await nodeAt(first.treeId, 'slot'))?.kind).toBe('file')
  })

  it('refuses a reused hash declared with another size', async () => {
    const { ws, key } = await setUp()
    const first = committed(
      await pushAll(key, `${ws.name}/acme`, { 'x.txt': 'hello world' }),
    )
    const sha256 = await sha256Of('hello world')
    const refused = await failureAs(
      key,
      Effect.flatMap(Push, (push) =>
        push.stage({
          target: ref(`${ws.name}/acme`),
          baseSeq: first.seq,
          baseTree: first.treeId,
          force: false,
          dryRun: false,
          message: null,
          files: [
            { path: 'x.txt', sha256, size: 11 },
            { path: 'y.txt', sha256, size: 0 },
          ],
        }),
      ),
    )
    expect(refused).toMatchObject({ code: 'invalid', path: 'y.txt' })
  })

  it('keeps the bytes a purge meets between upload and commit', async () => {
    const { ws, key } = await setUp()
    const text = `kept ${crypto.randomUUID()}`
    // A purge that runs right after each upload lands in R2: it removes any
    // blob nothing references or holds, bytes first, as the weekly purge will.
    const purging = new Proxy(env.BLOBS, {
      get(target, property) {
        if (property === 'put') {
          return async (...args: Parameters<R2Bucket['put']>) => {
            const stored = await target.put(...args)
            const sha = String(args[0]).slice('blobs/'.length)
            const gone = await env.DB.prepare(
              `delete from blobs where sha256 = ? and ref_count = 0
                 and not exists (select 1 from blob_holds where sha256 = ?)
               returning sha256`,
            )
              .bind(sha, sha)
              .first()
            if (gone !== null) await target.delete(String(args[0]))
            return stored
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    harness.use(testRuntime({ env: { BLOBS: purging } }))
    const done = committed(
      await pushAll(key, `${ws.name}/kept`, { 'a.txt': text }),
    )
    harness.reset()
    const body = await runAs(
      key,
      Effect.flatMap(Files, (files) =>
        files.content(ref(`${ws.name}/kept/a.txt`)),
      ).pipe(
        Effect.flatMap((file) =>
          Effect.promise(() => new Response(file.body).text()),
        ),
      ),
    )
    expect(done.number).toBe(1)
    expect(body).toBe(text)
  })

  it('lists and pulls folders whose names lie outside the basic plane', async () => {
    const { ws, key } = await setUp()
    committed(await pushAll(key, `${ws.name}/acme`, { '𝒜/b.txt': 'b' }))
    const listing = await runAs(
      key,
      Effect.flatMap(Files, (files) =>
        files.ls({ ref: ref(`${ws.name}/acme/𝒜`), depth: 'one' }),
      ),
    )
    expect(listing.entries.map((e) => e.path)).toEqual(['𝒜/b.txt'])
  })
})

describe('what a commit rests on', () => {
  it('fails when any basis of its access goes, even if another remains', async () => {
    const creator = await person('creator-admin')
    const ws = await workspace(creator)
    const key = await agent(creator)
    const first = committed(
      await pushAll(key, `${ws.name}/acme`, { 'a.txt': 'a' }),
    )
    const files = { 'a.txt': 'a', 'b.txt': 'b' }
    const staged = await stage(key, `${ws.name}/acme`, files, {
      baseSeq: first.seq,
      baseTree: first.treeId,
    })
    await upload(key, staged.pushId as PushId, files, staged.missing)
    const outcome = await commitWhile(key, staged.pushId as PushId, () =>
      exec(
        'delete from workspace_members where workspace_id = ? and user_id = ?',
        ws.id,
        creator.id,
      ),
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.code).toBe('conflict')
    expect(await nodeAt(first.treeId, 'b.txt')).toBeUndefined()
  })

  it('refuses tree creation in the batch to a scoped or read-only key, whatever reached it', async () => {
    const { ws, creator, key: writer } = await setUp()
    const other = committed(await pushAll(writer, `${ws.name}/other`, {}))
    const root = (await nodeAt(other.treeId, ''))?.id ?? null
    for (const options of [{ readOnly: true }, { scope: root }]) {
      const key = await agent(creator, options)
      const failed = await failureAs(
        key,
        Effect.gen(function* () {
          const store = yield* TreeStore
          const found = yield* store.workspace(ws.name)
          if (found === null) throw new Error('no workspace')
          const membership: Membership = {
            workspace: found,
            role: 'member',
            basis: {
              kind: 'member',
              workspaceId: ws.id as WorkspaceId,
              userId: creator.id,
            },
          }
          return yield* store.change(null, (cs) =>
            Effect.sync(() => {
              const made = cs.createTree(membership, 'sneaky')
              cs.event({ type: 'push', path: '', node: made })
            }),
          )
        }),
      )
      expect(failed.code).toBe('conflict')
    }
    expect(await treeOf(ws.name, 'sneaky')).toBeUndefined()
  })

  it('lets one of two pushes from the same base commit, and stops the other as stale', async () => {
    const { ws, key } = await setUp()
    const first = committed(
      await pushAll(key, `${ws.name}/acme`, { 'a.txt': 'a' }),
    )
    const base = { baseSeq: first.seq, baseTree: first.treeId }
    const mine = { 'a.txt': 'mine' }
    const theirs = { 'a.txt': 'theirs' }
    const a = await stage(key, `${ws.name}/acme`, mine, base)
    await upload(key, a.pushId as PushId, mine, a.missing)
    const b = await stage(key, `${ws.name}/acme`, theirs, base)
    await upload(key, b.pushId as PushId, theirs, b.missing)

    const outcome = await commitWhile(key, a.pushId as PushId, () =>
      commit(key, b.pushId as PushId),
    )

    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.code).toBe('stale_head')
    const text = await runAs(
      key,
      Effect.flatMap(Files, (files) =>
        files.content(ref(`${ws.name}/acme/a.txt`)),
      ).pipe(
        Effect.flatMap((file) =>
          Effect.promise(() => new Response(file.body).text()),
        ),
      ),
    )
    expect(text).toBe('theirs')
    expect((await treeOf(ws.name, 'acme'))?.push_count).toBe(2)
  })
})

/** Stages, uploads and commits, answering the failure of any step. */
const stageAndCommitFailure = async (
  caller: Caller,
  target: string,
  files: FileMap,
  options: { baseSeq?: number; baseTree?: string } = {},
) => {
  try {
    const staged = await stage(caller, target, files, options)
    if (staged.pushId === null) return null
    await upload(caller, staged.pushId, files, staged.missing as Sha256[])
    await commit(caller, staged.pushId)
    return null
  } catch (error) {
    return unwrap(error)
  }
}
