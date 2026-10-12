import type {
  LinkRef,
  LogResponse,
  Person,
  PushNumber,
} from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { Effect } from 'effect'
import { beforeAll, describe, expect, it } from 'vitest'

import { Data, Files, type Caller } from '../src/core/index.ts'
import { rows } from './support/d1.ts'
import { formRef, pageWith, QUESTIONS } from './support/forms.ts'
import { ORIGIN } from './support/harness.ts'
import { keySecretFor } from './support/keys.ts'
import { sessionFor } from './support/people.ts'
import { at, DAY, failureAt, HOUR, purgeAt, pushAt } from './support/purge.ts'
import {
  agent,
  join,
  nodeAt,
  person,
  ref,
  share,
  workspace,
} from './support/trees.ts'

/** 8 Oct 2026, 09:00 UTC, and hours after it. */
const T0 = Date.UTC(2026, 9, 8, 9)
const h = (n: number) => T0 + n * HOUR

const PLAN_1 = pageWith(
  '<h2>Pricing</h2>\n<p>Per pallet, from 1 November.</p>\n<table class="rates"></table>\n',
  'Plan',
)
const PLAN_2 = pageWith(
  '<h2>Pricing</h2>\n<p>Per pallet until December, then per truck.</p>\n<p>Erbil and Basra start on 3 November.</p>\n<table class="rates"></table>\n',
  'Plan',
)
const INDEX = pageWith(
  '<a href="plan">Plan</a> <a href="questions/">Questions</a>',
  'Acme',
)
const MAP = '\u0089PNG\r\n\u001a\nnot really an image'

const FIRST = {
  'index.html': INDEX,
  'plan.html': PLAN_1,
  'questions/index.html': QUESTIONS,
  'img/map.png': MAP,
}

type FilesService = Effect.Effect.Success<typeof Files>

/** Files as `caller`, with the clock at a time. */
const files = (caller: Caller) => ({
  run: <A, E, R>(
    time: number,
    use: (f: FilesService) => Effect.Effect<A, E, R>,
  ) => at(time, caller, Effect.flatMap(Files, use) as never) as Promise<A>,
  fail: <A, E, R>(
    time: number,
    use: (f: FilesService) => Effect.Effect<A, E, R>,
  ) =>
    failureAt(time, caller, Effect.flatMap(Files, use) as never) as Promise<{
      code: string
      message: string
    }>,
})

/** A workspace admin who pushes a fresh tree, with a key of theirs. */
const acme = async () => {
  const owner = await person('owner')
  const ws = await workspace(owner)
  const ownerAgent = await agent(owner)
  const name = `h${crypto.randomUUID().slice(0, 8)}`
  const first = await pushAt(h(0), ownerAgent, `${ws.name}/${name}`, FIRST, {
    message: 'First questions',
  })
  const tree = first.treeId
  const link = (path: string): LinkRef => ref(`${ws.name}/${name}/${path}`)
  return { owner, ws, ownerAgent, name, tree, at: link }
}

const versions = (treeId: string, path: string) =>
  rows<{ state: string; revision: number; blob_sha256: string | null }>(
    `select v.state, v.revision, v.blob_sha256 from node_versions v
       join nodes n on n.id = v.node_id
     where n.tree_id = ? and n.path = ? order by n.created_at, v.revision`,
    treeId,
    path,
  )

const liveText = async (treeId: string, path: string) => {
  const [row] = await rows<{ sha: string | null; json: string | null }>(
    `select v.blob_sha256 as sha, v.json_value as json from nodes n
       join node_versions v on v.id = n.current_version_id
     where n.tree_id = ? and n.path = ? and n.deleted_at is null and v.state = 'live'`,
    treeId,
    path,
  )
  if (row === undefined) return null
  if (row.json !== null) return row.json
  const object = await (
    await import('cloudflare:workers')
  ).env.BLOBS.get(`blobs/${row.sha}`)
  return object === null ? null : await object.text()
}

const api = (secret: string, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${secret}`)
  return SELF.fetch(`${ORIGIN}/_/api${path}`, { ...init, headers })
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let respondent: Person

beforeAll(async () => {
  respondent = await person('sara')
})

describe('history', () => {
  it('lists pushes, deletions, restores, moves and withdrawals, newest first', async () => {
    const t = await acme()
    const f = files(t.ownerAgent)
    await pushAt(
      h(1),
      t.ownerAgent,
      `${t.ws.name}/${t.name}`,
      { ...FIRST, 'plan.html': PLAN_2, 'questions/extra.html': PLAN_1 },
      { force: true, message: 'Erbil mockups' },
    )
    await f.run(h(2), (x) => x.rm({ ref: t.at('plan.html') }))
    await f.run(h(3), (x) =>
      x.restore({ ref: t.at('plan.html'), to: { push: 2 as PushNumber } }),
    )
    await f.run(h(4), (x) =>
      x.mv({
        from: t.at('questions/extra.html'),
        to: t.at('questions/more/extra.html'),
      }),
    )
    // A respondent answers, then withdraws.
    const sara = await sessionFor(respondent)
    const qs = await nodeAt(t.tree, 'questions')
    await share(t.tree, qs!.id, 'email', respondent.email, 'respond', t.owner)
    const form = await formRef(
      { treeId: t.tree } as never,
      'questions/index.html',
      'questions/answers/',
    )
    const seq = (
      await rows<{ authored_seq: number }>(
        'select authored_seq from trees where id = ?',
        t.tree,
      )
    )[0]!.authored_seq
    await at(
      h(5),
      sara,
      Effect.flatMap(Data, (d) =>
        d.send({
          treeId: t.tree,
          page: 'questions/index.html',
          seq: seq as never,
          form: form as never,
          entries: [['role', 'Ops']],
          submitter: null,
          entry: null,
          opId: crypto.randomUUID() as never,
        }),
      ),
    )
    await at(
      h(6),
      sara,
      Effect.flatMap(Data, (d) =>
        d.withdraw({
          treeId: t.tree,
          path: `questions/answers/${respondent.email}.json`,
          opId: crypto.randomUUID() as never,
        }),
      ),
    )

    const root = await f.run(h(7), (x) =>
      x.log({ ref: t.at(''), cursor: null }),
    )
    expect(root.lines.map((l) => [l.kind, l.path])).toEqual([
      ['withdrawal', `questions/answers/${respondent.email}.json`],
      ['move', 'questions/extra.html'],
      ['restore', 'plan.html'],
      ['delete', 'plan.html'],
      ['push', ''],
      ['push', ''],
    ])
    expect(root.retentionDays).toBe(30)
    expect(root.next).toBeNull()
    const [withdrawal, move, restored, deleted, second, first] = root.lines
    expect(withdrawal!.by).toBe(respondent.email)
    expect(move!.to).toBe('questions/more/extra.html')
    expect(restored!.to).toBe('push 2')
    // Restored since, so nothing is left to restore.
    expect(deleted!.restorable).toBe(false)
    expect(deleted!.by).toBe(t.owner.email)
    expect(second!.push).toEqual({
      number: 2,
      message: 'Erbil mockups',
      files: 2,
    })
    expect(first!.push).toEqual({
      number: 1,
      message: 'First questions',
      files: 4,
    })
    expect(first!.at).toBe(new Date(h(0)).toISOString())

    // Under a folder: what happened there, and the pushes that changed it.
    const questions = await f.run(h(7), (x) =>
      x.log({ ref: t.at('questions/'), cursor: null }),
    )
    expect(questions.lines.map((l) => l.kind)).toEqual([
      'withdrawal',
      'move',
      'push',
      'push',
    ])
    expect(questions.lines[2]!.push?.files).toBe(1)
    // A file: its own pushes, deletion and restore.
    const plan = await f.run(h(7), (x) =>
      x.log({ ref: t.at('plan.html'), cursor: null }),
    )
    expect(plan.lines.map((l) => l.kind)).toEqual([
      'restore',
      'delete',
      'push',
      'push',
    ])
  })

  it('names authors by email to members and by name to a write holder outside the workspace', async () => {
    const t = await acme()
    const outsider = await person('lina')
    const root = await nodeAt(t.tree, '')
    await share(t.tree, root!.id, 'email', outsider.email, 'write', t.owner)
    const theirs = await agent(outsider)
    const page = await files(theirs).run(h(1), (x) =>
      x.log({ ref: t.at(''), cursor: null }),
    )
    expect(page.lines[0]!.by).toBe('owner')
    const mine = await files(t.ownerAgent).run(h(1), (x) =>
      x.log({ ref: t.at(''), cursor: null }),
    )
    expect(mine.lines[0]!.by).toBe(t.owner.email)
  })

  it('pages 50 lines at a time, newest first', async () => {
    const t = await acme()
    const f = files(t.ownerAgent)
    for (let n = 0; n < 26; n += 1) {
      await f.run(h(1) + n * 2, (x) => x.rm({ ref: t.at('plan.html') }))
      await f.run(h(1) + n * 2 + 1, (x) =>
        x.restore({ ref: t.at('plan.html'), to: { push: 1 as PushNumber } }),
      )
    }
    const first = await f.run(h(2), (x) =>
      x.log({ ref: t.at(''), cursor: null }),
    )
    expect(first.lines).toHaveLength(50)
    expect(first.lines[0]!.kind).toBe('restore')
    expect(first.next).not.toBeNull()
    const rest = await f.run(h(2), (x) =>
      x.log({ ref: t.at(''), cursor: first.next }),
    )
    expect(rest.lines.map((l) => l.kind)).toEqual(['restore', 'delete', 'push'])
    expect(rest.next).toBeNull()
    const seqs = [...first.lines, ...rest.lines].map((l) => l.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a))
  })

  it('is for write holders: readers and respondents get forbidden', async () => {
    const t = await acme()
    const reader = await person('reader')
    const root = await nodeAt(t.tree, '')
    await share(t.tree, root!.id, 'email', reader.email, 'read', t.owner)
    await share(t.tree, root!.id, 'email', respondent.email, 'respond', t.owner)
    for (const who of [reader, respondent]) {
      const refused = await files(await agent(who)).fail(h(1), (x) =>
        x.log({ ref: t.at(''), cursor: null }),
      )
      expect(refused.code).toBe('forbidden')
    }
    const stranger = await files(await agent(await person('nobody'))).fail(
      h(1),
      (x) => x.log({ ref: t.at(''), cursor: null }),
    )
    expect(stranger.code).toBe('not_found')
  })

  it('lets read-only keys of the creator and an admin read history but change nothing, and keeps a scoped key in its scope', async () => {
    const admin = await person('admin')
    const ws = await workspace(admin)
    const creator = await person('creator')
    await join(ws, creator)
    const name = `h${crypto.randomUUID().slice(0, 8)}`
    await pushAt(h(0), await agent(creator), `${ws.name}/${name}`, FIRST)
    await pushAt(
      h(1),
      await agent(creator),
      `${ws.name}/${name}`,
      { ...FIRST, 'plan.html': PLAN_2 },
      { force: true },
    )
    const target = `${ws.name}/${name}`
    for (const who of [creator, admin]) {
      const secret = await keySecretFor(who, {
        name: 'ro',
        reach: { kind: 'everything' },
        readOnly: true,
      })
      const log = await api(
        secret,
        `/log?path=${encodeURIComponent(`${target}/`)}`,
      )
      expect(log.status).toBe(200)
      expect(((await log.json()) as LogResponse).lines).toHaveLength(2)
      const detail = await api(
        secret,
        `/push?path=${encodeURIComponent(`${target}/`)}&number=2`,
      )
      expect(detail.status).toBe(200)
      const diff = await api(
        secret,
        `/diff?path=${encodeURIComponent(`${target}/plan.html`)}`,
      )
      expect(diff.status).toBe(200)
      for (const [path, body] of [
        ['/restore', { path: `${target}/plan.html`, to: { push: 1 } }],
        ['/rm', { path: `${target}/plan.html` }],
        [
          '/mv',
          { from: `${target}/plan.html`, to: `${target}/plans/plan.html` },
        ],
      ] as const) {
        const refused = await api(secret, path, post(body))
        expect(refused.status).toBe(403)
      }
    }
    const scoped = await keySecretFor(creator, {
      name: 'scoped',
      reach: { kind: 'node', ref: ref(`${target}/questions/`) },
      readOnly: false,
    })
    expect(
      (await api(scoped, `/log?path=${encodeURIComponent(`${target}/`)}`))
        .status,
    ).toBe(404)
    expect(
      (
        await api(
          scoped,
          `/log?path=${encodeURIComponent(`${target}/questions/`)}`,
        )
      ).status,
    ).toBe(200)
  })

  it('opens a push with its files and line counts, and diffs a file', async () => {
    const t = await acme()
    await pushAt(
      h(1),
      t.ownerAgent,
      `${t.ws.name}/${t.name}`,
      {
        'index.html': INDEX,
        'plan.html': PLAN_2,
        'questions/index.html': QUESTIONS,
        'questions/extra.html': PLAN_1,
      },
      { force: true, message: 'Erbil mockups' },
    )
    const secret = await keySecretFor(t.owner)
    const q = (path: string) =>
      encodeURIComponent(`${t.ws.name}/${t.name}/${path}`)
    const first = (await (
      await api(secret, `/push?path=${q('')}&number=1`)
    ).json()) as {
      files: {
        path: string
        change: string
        text: boolean
        lines: number | null
      }[]
    }
    expect(first.files.find((x) => x.path === 'img/map.png')).toMatchObject({
      change: 'added',
      text: false,
      lines: null,
    })
    const second = (await (
      await api(secret, `/push?path=${q('')}&number=2`)
    ).json()) as {
      number: number
      message: string
      by: string
      files: unknown[]
    }
    expect(second).toMatchObject({
      number: 2,
      message: 'Erbil mockups',
      by: t.owner.email,
    })
    expect(second.files).toEqual([
      {
        path: 'img/map.png',
        change: 'deleted',
        text: false,
        added: null,
        removed: null,
        lines: null,
      },
      {
        path: 'plan.html',
        change: 'changed',
        text: true,
        added: 2,
        removed: 1,
        lines: 5,
      },
      {
        path: 'questions/extra.html',
        change: 'added',
        text: true,
        added: 4,
        removed: 0,
        lines: 4,
      },
    ])
    const diff = (await (
      await api(secret, `/diff?path=${q('plan.html')}`)
    ).json()) as {
      from: string
      to: string
      binary: boolean
      before: string
      after: string
      patch: string
    }
    expect(diff).toMatchObject({
      from: 'push 1',
      to: 'push 2',
      binary: false,
      before: PLAN_1,
      after: PLAN_2,
    })
    expect(diff.patch).toContain('--- a/plan.html\n+++ b/plan.html\n@@')
    expect(diff.patch).toContain('-<p>Per pallet, from 1 November.</p>')
    expect(diff.patch).toContain(
      '+<p>Per pallet until December, then per truck.</p>',
    )
    const explicit = (await (
      await api(secret, `/diff?path=${q('plan.html')}&from=1&to=2`)
    ).json()) as { patch: string }
    expect(explicit.patch).toBe(diff.patch)
  })
})

describe('deleting', () => {
  it('writes a deleted version and keeps the old ones, and a writer of data needs write to delete it', async () => {
    const t = await acme()
    const f = files(t.ownerAgent)
    const done = await f.run(h(1), (x) => x.rm({ ref: t.at('plan.html') }))
    expect(done.changed).toEqual(['plan.html'])
    expect((await versions(t.tree, 'plan.html')).map((v) => v.state)).toEqual([
      'live',
      'deleted',
    ])
    expect(await liveText(t.tree, 'plan.html')).toBeNull()
    // People's data: its writer withdraws it; deleting needs write.
    const sara = await sessionFor(respondent)
    const qs = await nodeAt(t.tree, 'questions')
    await share(t.tree, qs!.id, 'email', respondent.email, 'respond', t.owner)
    const form = await formRef(
      { treeId: t.tree } as never,
      'questions/index.html',
      'questions/answers/',
    )
    const seq = (
      await rows<{ authored_seq: number }>(
        'select authored_seq from trees where id = ?',
        t.tree,
      )
    )[0]!.authored_seq
    await at(
      h(2),
      sara,
      Effect.flatMap(Data, (d) =>
        d.send({
          treeId: t.tree,
          page: 'questions/index.html',
          seq: seq as never,
          form: form as never,
          entries: [['role', 'Ops']],
          submitter: null,
          entry: null,
          opId: crypto.randomUUID() as never,
        }),
      ),
    )
    const answer = t.at(`questions/answers/${respondent.email}.json`)
    const refused = await files(sara).fail(h(3), (x) => x.rm({ ref: answer }))
    expect(refused.code).toBe('forbidden')
    await f.run(h(3), (x) => x.rm({ ref: answer }))
    expect(
      (
        await versions(t.tree, `questions/answers/${respondent.email}.json`)
      ).map((v) => v.state),
    ).toEqual(['live', 'deleted'])
  })

  it('takes a folder with everything in it', async () => {
    const t = await acme()
    const done = await files(t.ownerAgent).run(h(1), (x) =>
      x.rm({ ref: t.at('questions/') }),
    )
    expect(done.changed).toEqual(['questions/index.html'])
    expect(await nodeAt(t.tree, 'questions')).toBeUndefined()
    expect(await nodeAt(t.tree, 'questions/index.html')).toBeUndefined()
  })
})

describe('restoring', () => {
  it('brings a deleted file back at its link', async () => {
    const t = await acme()
    const f = files(t.ownerAgent)
    await f.run(h(1), (x) => x.rm({ ref: t.at('plan.html') }))
    const done = await f.run(h(2), (x) =>
      x.restore({ ref: t.at('plan.html'), to: { at: h(1) - 1 } }),
    )
    expect(done.changed).toEqual(['plan.html'])
    expect(await liveText(t.tree, 'plan.html')).toBe(PLAN_1)
    const page = await f.run(h(2), (x) =>
      x.ls({ ref: t.at('plan'), depth: 'one' }),
    )
    expect(page.folder.path).toBe('plan.html')
    const log = await f.run(h(3), (x) => x.log({ ref: t.at(''), cursor: null }))
    expect(log.lines[0]).toMatchObject({
      kind: 'restore',
      path: 'plan.html',
      to: new Date(h(1) - 1).toISOString(),
    })
  })

  it('takes a file back to a push and to a time', async () => {
    const t = await acme()
    const f = files(t.ownerAgent)
    await pushAt(
      h(2),
      t.ownerAgent,
      `${t.ws.name}/${t.name}`,
      { ...FIRST, 'plan.html': PLAN_2 },
      { force: true },
    )
    await f.run(h(3), (x) =>
      x.restore({ ref: t.at('plan.html'), to: { push: 1 as PushNumber } }),
    )
    expect(await liveText(t.tree, 'plan.html')).toBe(PLAN_1)
    await f.run(h(4), (x) =>
      x.restore({ ref: t.at('plan.html'), to: { at: h(2) } }),
    )
    expect(await liveText(t.tree, 'plan.html')).toBe(PLAN_2)
    // Already as it was: nothing changes.
    const again = await f.run(h(5), (x) =>
      x.restore({ ref: t.at('plan.html'), to: { at: h(2) } }),
    )
    expect(again.changed).toEqual([])
    const missing = await f.fail(h(5), (x) =>
      x.restore({ ref: t.at('img/new.png'), to: { push: 1 as PushNumber } }),
    )
    expect(missing.code).toBe('not_found')
    const never = await f.fail(h(5), (x) =>
      x.restore({ ref: t.at('plan.html'), to: { push: 9 as PushNumber } }),
    )
    expect(never.code).toBe('invalid')
  })

  it('takes a folder back to a push: later files go, data a write holder deleted comes back, data written later stays', async () => {
    const t = await acme()
    const f = files(t.ownerAgent)
    const sara = await sessionFor(respondent)
    const other = await person('omar')
    const qs = await nodeAt(t.tree, 'questions')
    await share(t.tree, qs!.id, 'email', respondent.email, 'respond', t.owner)
    await share(t.tree, qs!.id, 'email', other.email, 'respond', t.owner)
    const form = await formRef(
      { treeId: t.tree } as never,
      'questions/index.html',
      'questions/answers/',
    )
    const send = (who: Caller, time: number) =>
      Effect.flatMap(Data, (d) =>
        d.send({
          treeId: t.tree,
          page: 'questions/index.html',
          seq: 1 as never,
          form: form as never,
          entries: [['role', 'Ops']],
          submitter: null,
          entry: null,
          opId: crypto.randomUUID() as never,
        }),
      ).pipe((e) => at(time, who, e))
    await send(sara, h(1))
    await pushAt(
      h(2),
      t.ownerAgent,
      `${t.ws.name}/${t.name}`,
      { ...FIRST, 'plan.html': PLAN_2 },
      { force: true },
    )
    await pushAt(
      h(3),
      t.ownerAgent,
      `${t.ws.name}/${t.name}/questions`,
      {
        'index.html': QUESTIONS,
        'later.html': PLAN_2,
      },
      { force: true },
    )
    // After push 2: the owner deletes Sara's answer, Omar answers.
    await f.run(h(4), (x) =>
      x.rm({ ref: t.at(`questions/answers/${respondent.email}.json`) }),
    )
    await send(await sessionFor(other), h(5))
    const done = await f.run(h(6), (x) =>
      x.restore({ ref: t.at('questions/'), to: { push: 2 as PushNumber } }),
    )
    expect(done.changed).toEqual([
      `questions/answers/${respondent.email}.json`,
      'questions/later.html',
    ])
    expect(await nodeAt(t.tree, 'questions/later.html')).toBeUndefined()
    expect(
      await liveText(t.tree, `questions/answers/${respondent.email}.json`),
    ).not.toBeNull()
    expect(
      await liveText(t.tree, `questions/answers/${other.email}.json`),
    ).not.toBeNull()
    expect(await liveText(t.tree, 'questions/index.html')).toBe(QUESTIONS)
  })

  it('refuses a path a newer node holds, and versions past the retention period', async () => {
    const t = await acme()
    const f = files(t.ownerAgent)
    await f.run(h(1), (x) => x.rm({ ref: t.at('plan.html') }))
    await pushAt(
      h(2),
      t.ownerAgent,
      `${t.ws.name}/${t.name}`,
      { ...FIRST, 'plan.html': PLAN_2 },
      { force: true },
    )
    const taken = await f.fail(h(3), (x) =>
      x.restore({ ref: t.at('plan.html'), to: { at: h(1) - 1 } }),
    )
    expect(taken).toMatchObject({
      code: 'conflict',
      message: 'A newer plan.html is there now. Move it first.',
    })

    await f.run(h(3), (x) => x.rm({ ref: t.at('img/map.png') }))
    const before = await f.run(h(4), (x) =>
      x.log({ ref: t.at(''), cursor: null }),
    )
    expect(before.lines[0]).toMatchObject({ kind: 'delete', restorable: true })
    await purgeAt(h(3) + 31 * DAY)
    const after = await f.run(h(3) + 31 * DAY, (x) =>
      x.log({ ref: t.at(''), cursor: null }),
    )
    expect(after.lines[0]).toMatchObject({ kind: 'delete', restorable: false })
    const gone = await f.fail(h(3) + 31 * DAY, (x) =>
      x.restore({ ref: t.at('img/map.png'), to: { push: 1 as PushNumber } }),
    )
    expect(gone.code).toBe('not_found')
  })
})
