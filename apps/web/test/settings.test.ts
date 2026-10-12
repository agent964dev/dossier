import type { AuthoredSeq, OpId, Person } from '@dossier/contracts'
import { Effect, TestClock, TestContext } from 'effect'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  Data,
  DEFAULT_LIMITS,
  Limits,
  People,
  Push,
  Settings,
  type Caller,
  type CurrentCaller,
} from '../src/core/index.ts'
import { exec } from './support/d1.ts'
import { formRef, pushForms, QUESTIONS, sendFailure } from './support/forms.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  agent,
  failureAs,
  person,
  ref,
  sha256Of,
  superAdmin,
  upload,
  workspace,
} from './support/trees.ts'

const encoder = new TextEncoder()

/** A push's stage as the code it answers, or 'ok'. */
const stageAs = async (
  caller: Caller,
  target: string,
  files: Readonly<Record<string, string>>,
  dryRun = false,
) => {
  const manifest = await Promise.all(
    Object.entries(files).map(async ([path, text]) => ({
      path,
      sha256: await sha256Of(text),
      size: encoder.encode(text).length,
    })),
  )
  return Effect.flatMap(Push, (push) =>
    push.stage({
      target: ref(target),
      baseSeq: null,
      baseTree: null,
      force: true,
      dryRun,
      message: null,
      files: manifest,
    } as never),
  )
}

let chief: Person
let admin: Caller

beforeAll(async () => {
  // Nothing saved yet in this file's database.
  await exec('delete from deployment_settings')
  chief = await person('chief')
  await superAdmin(chief)
  admin = await sessionFor(chief)
})

const people = <A, E>(
  use: (p: typeof People.Service) => Effect.Effect<A, E, CurrentCaller>,
) => runAs(admin, Effect.flatMap(People, use))

describe('deployment settings', () => {
  it('reads the defaults with nothing saved, and first run is not done', async () => {
    const current = await runAs(
      admin,
      Effect.flatMap(Settings, (s) => s.current()),
    )
    expect(current).toEqual({
      workspaceCreation: 'listed',
      limits: DEFAULT_LIMITS,
      retentionDays: 30,
      firstRunDone: false,
    })
    expect(DEFAULT_LIMITS).toEqual({
      fileBytes: 50 * 1024 ** 2,
      pushFiles: 2000,
      pushBytes: 500 * 1024 ** 2,
      pushesPerMinute: 30,
      sendsPerMinute: 30,
      uploadBytes: 10 * 1024 ** 2,
      dataFileBytes: 1024 ** 2,
      storageBytes: 10 * 1024 ** 3,
      webhooksPerWorkspace: 10,
    })
    const overview = await people((p) => p.adminOverview())
    expect(overview.firstRun).toBe(true)
    expect(overview.health.ok).toBe(true)
    expect(overview.health.checks.map((c) => c.name)).toEqual([
      'Database',
      'File storage',
      'Base layer',
      'Purge',
    ])
  })

  it('lists the super admin who first chooses listed people, and first run is done', async () => {
    await people((p) => p.setWorkspaceCreation('listed'))
    const overview = await people((p) => p.adminOverview())
    expect(overview.firstRun).toBe(false)
    expect(overview.creators).toEqual([
      { entry: chief.email.toLowerCase(), kind: 'email' },
    ])
  })

  it('applies a saved files-per-push limit and resets to the defaults', async () => {
    const ws = await workspace(chief)
    const key = await agent(chief)
    const two = { 'a.html': '<title>A</title>', 'b.html': '<title>B</title>' }
    expect(await people((p) => p.setLimits({ pushFiles: 1 }))).toMatchObject({
      pushFiles: 1,
      fileBytes: DEFAULT_LIMITS.fileBytes,
    })
    const refused = await failureAs(
      key,
      await stageAs(key, `${ws.name}/acme`, two),
    )
    expect(refused).toMatchObject({
      code: 'too_large',
      message: 'This push has 2 files; a push may hold at most 1 files.',
    })
    const overview = await people((p) => p.adminOverview())
    expect(overview.limits.pushFiles).toBe(1)
    expect(overview.defaults.pushFiles).toBe(2000)
    await people((p) => p.setLimits('defaults'))
    const staged = await runAs(
      key,
      await stageAs(key, `${ws.name}/acme`, two, true),
    )
    expect(staged.plan.added).toEqual(['a.html', 'b.html'])
    expect(
      (
        await failureAs(
          admin,
          Effect.flatMap(People, (p) => p.setLimits({ pushFiles: 0 })),
        )
      ).code,
    ).toBe('invalid')
  })

  it('counts pushes against a saved rate under the test clock', async () => {
    const ws = await workspace(chief)
    const key = await agent(chief)
    await people((p) => p.setLimits({ pushesPerMinute: 2 }))
    const files = { 'a.html': '<title>A</title>' }
    const stage = await stageAs(key, `${ws.name}/rate`, files, true)
    const answers = await runAs(
      key,
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 9, 12, 9, 0, 5))
        const seen: string[] = []
        for (let i = 0; i < 3; i += 1) {
          seen.push(
            yield* stage.pipe(
              Effect.as('ok'),
              Effect.catchAll((e) => Effect.succeed(e.code)),
            ),
          )
        }
        yield* TestClock.adjust('60 seconds')
        seen.push(
          yield* stage.pipe(
            Effect.as('ok'),
            Effect.catchAll((e) => Effect.succeed(e.code)),
          ),
        )
        return seen
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(answers).toEqual(['ok', 'ok', 'rate_limited', 'ok'])
    await people((p) => p.setLimits('defaults'))
  })

  it('refuses a push and a send past a saved storage limit with the limit named', async () => {
    const ws = await workspace(chief)
    const tree = await pushForms(chief, ws, {
      'questions/index.html': QUESTIONS,
      'notes.txt': 'n'.repeat(1100),
    })
    const key = await agent(chief)
    await people((p) => p.setLimits({ storageBytes: 1024 }))
    const sentence =
      'This workspace has reached its 1 KiB storage limit. A super admin can raise it.'
    const push = await failureAs(
      key,
      await stageAs(key, `${ws.name}/more`, { 'big.html': 'x'.repeat(2048) }),
    )
    expect(push).toMatchObject({ code: 'too_large', message: sentence })
    const send = await sendFailure(await sessionFor(chief), tree, {
      page: 'questions/index.html',
      form: await formRef(tree, 'questions/index.html', 'questions/answers/'),
      entries: [['role', 'Driver']],
    })
    expect(send).toMatchObject({ code: 'too_large', message: sentence })
    const used = await runAs(
      admin,
      Effect.flatMap(Limits, (l) => l.storageUsed(ws.id as never)),
    )
    expect(used).toBeGreaterThan(1024)
    await people((p) => p.setLimits('defaults'))
  })

  it('refuses a page-code write past a saved storage limit with the limit named', async () => {
    const ws = await workspace(chief)
    const tree = await pushForms(chief, ws, {
      'board.html': '<!doctype html><title>Board</title><p>Board</p>',
      'notes.txt': 'n'.repeat(1100),
    })
    await people((p) => p.setLimits({ storageBytes: 1024 }))
    try {
      const write = await failureAs(
        await sessionFor(chief),
        Effect.flatMap(Data, (data) =>
          data.write({
            tree: tree.treeId,
            page: 'board.html',
            path: 'layout.json',
            patch: { n1: { x: 1, y: 2 } },
            replace: false,
            opId: crypto.randomUUID() as OpId,
            seq: 1 as AuthoredSeq,
          }),
        ),
      )
      expect(write).toMatchObject({
        code: 'too_large',
        message:
          'This workspace has reached its 1 KiB storage limit. A super admin can raise it.',
      })
    } finally {
      await people((p) => p.setLimits('defaults'))
    }
  })

  it('charges a send the whole revision it stores, checked in the same batch', async () => {
    const ws = await workspace(chief)
    const tree = await pushForms(chief, ws, {
      'board.html':
        '<!doctype html><html><head><title>Board</title></head><body><form action="board.json"><input name="status"><input name="owner"></form></body></html>',
    })
    const caller = await sessionFor(chief)
    const form = await formRef(tree, 'board.html', 'board.json')
    await runAs(
      caller,
      Effect.flatMap(Data, (d) =>
        d.send({
          treeId: tree.treeId,
          page: 'board.html',
          seq: 1,
          form,
          entries: [['status', 's'.repeat(400)]],
          submitter: null,
          entry: null,
          opId: crypto.randomUUID(),
        } as never),
      ),
    )
    const used = await runAs(
      admin,
      Effect.flatMap(Limits, (l) => l.storageUsed(ws.id as never)),
    )
    // Room for the patch, not for another whole revision of the file.
    await people((p) => p.setLimits({ storageBytes: used + 100 }))
    const refused = await sendFailure(caller, tree, {
      page: 'board.html',
      form,
      entries: [['owner', 'Sara']],
    })
    expect(refused).toMatchObject({
      code: 'too_large',
      message: expect.stringContaining(
        'storage limit. A super admin can raise it.',
      ),
    })
    await people((p) => p.setLimits('defaults'))
  })

  it('checks files per push again at commit', async () => {
    const ws = await workspace(chief)
    const key = await agent(chief)
    const files = { 'a.html': '<title>A</title>', 'b.html': '<title>B</title>' }
    const staged = await runAs(
      key,
      await stageAs(key, `${ws.name}/late`, files),
    )
    if (staged.pushId === null) throw new Error('nothing staged')
    await upload(key, staged.pushId, files, staged.missing)
    await people((p) => p.setLimits({ pushFiles: 1 }))
    const refused = await failureAs(
      key,
      Effect.flatMap(Push, (push) => push.commit(staged.pushId!)),
    )
    expect(refused).toMatchObject({
      code: 'too_large',
      message: 'This push has 2 files; a push may hold at most 1 files.',
    })
    await people((p) => p.setLimits('defaults'))
  })

  it('keeps the retention period between 1 and 365 days', async () => {
    expect(
      (
        await failureAs(
          admin,
          Effect.flatMap(People, (p) => p.setRetention(0)),
        )
      ).code,
    ).toBe('invalid')
    expect(
      (
        await failureAs(
          admin,
          Effect.flatMap(People, (p) => p.setRetention(366)),
        )
      ).code,
    ).toBe('invalid')
    await people((p) => p.setRetention(7))
    expect((await people((p) => p.adminOverview())).retentionDays).toBe(7)
    await people((p) => p.setRetention(30))
  })
})

describe('who may create workspaces', () => {
  /** Whether each person may create a workspace under the saved settings. */
  const mayCreate = (who: Caller) =>
    runAs(
      who,
      Effect.flatMap(People, (p) => p.mayCreateWorkspace()),
    )

  it('answers the matrix of settings, listed emails, listed domains and super admins', async () => {
    const listedEmail = await person('listed')
    const sameDomain = await person('colleague')
    const elsewhere = await person('elsewhere')
    // `person()` makes example.com addresses; this one is on another domain.
    await exec(
      'update "user" set email = ? where id = ?',
      `elsewhere-${crypto.randomUUID().slice(0, 6)}@other.org`,
      elsewhere.id,
    )
    // A domain entry counts for an address Google is not the authority for.
    await exec(
      "update people set email_authority = 'none' where user_id = ?",
      sameDomain.id,
    )
    const callers = {
      chief: admin,
      listed: await sessionFor(listedEmail),
      colleague: await sessionFor(sameDomain),
      elsewhere: await sessionFor(elsewhere),
    }
    const matrix = async () =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(callers).map(
            async ([name, caller]) => [name, await mayCreate(caller)] as const,
          ),
        ),
      )
    await people((p) => p.setWorkspaceCreation('listed'))
    await exec('delete from workspace_creators')
    await people((p) => p.addCreator(listedEmail.email.toUpperCase()))
    expect(await matrix()).toEqual({
      chief: true,
      listed: true,
      colleague: false,
      elsewhere: false,
    })
    await people((p) => p.addCreator('@example.com'))
    expect(await matrix()).toEqual({
      chief: true,
      listed: true,
      colleague: true,
      elsewhere: false,
    })
    expect(
      (
        await failureAs(
          admin,
          Effect.flatMap(People, (p) => p.addCreator('not a domain')),
        )
      ).code,
    ).toBe('invalid')
    await people((p) => p.setWorkspaceCreation('super_admins'))
    expect(await matrix()).toEqual({
      chief: true,
      listed: false,
      colleague: false,
      elsewhere: false,
    })
    await people((p) => p.setWorkspaceCreation('anyone'))
    expect(await matrix()).toEqual({
      chief: true,
      listed: true,
      colleague: true,
      elsewhere: true,
    })
    // A visitor never creates one.
    expect(
      await mayCreate({
        person: null,
        via: { kind: 'visitor', anonSessionId: null },
        requestId: 'test',
      }),
    ).toBe(false)
    await people((p) => p.setWorkspaceCreation('listed'))
    await people((p) => p.removeCreator('example.com'))
    expect((await matrix()).colleague).toBe(false)
  })
})
