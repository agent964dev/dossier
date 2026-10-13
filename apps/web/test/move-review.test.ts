import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it, afterEach } from 'vitest'
import { Data, Files, Pages } from '../src/core/index.ts'
import { rows, exec, beforeBatch } from './support/d1.ts'
import { harness, testRuntime, withRuntime } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import { at, HOUR, pushAt } from './support/purge.ts'
import {
  agent,
  dataFile,
  join,
  nodeAt,
  person,
  ref,
  share,
  workspace,
} from './support/trees.ts'

const T = Date.UTC(2026, 9, 8, 9)
const call = <A>(
  who: any,
  n: number,
  use: (f: any) => Effect.Effect<A, any, any>,
) => at(T + n * HOUR, who, Effect.flatMap(Files, use) as never) as Promise<A>
afterEach(() => harness.reset())

describe('independent tree move probes', () => {
  it('gives an unreadable source the same refusal whether it exists or not', async () => {
    const owner = await person('oracle-owner')
    const ws = await workspace(owner)
    const writer = await agent(owner)
    const target = `${ws.name}/oracle${crypto.randomUUID().slice(0, 8)}`
    const pushed = await pushAt(T, writer, target, {
      'shared/keep.txt': 'shared\n',
      'private/keep.txt': 'private\n',
    })
    await dataFile(
      pushed.treeId,
      'private/payroll.json',
      { payroll: 'secret' },
      owner,
    )
    const guest = await person('oracle-guest')
    await share(
      pushed.treeId,
      (await nodeAt(pushed.treeId, 'shared'))!.id,
      'email',
      guest.email,
      'write',
      owner,
    )
    const caller = await agent(guest)
    const existing: any = await call(caller, 1, (f) =>
      Effect.either(
        f.mv({
          from: ref(`${target}/private/payroll.json`),
          to: ref(`${target}/shared/copied.json`),
        }),
      ),
    )
    const missing: any = await call(caller, 1, (f) =>
      Effect.either(
        f.mv({
          from: ref(`${target}/private/missing.json`),
          to: ref(`${target}/shared/copied.json`),
        }),
      ),
    )
    expect(existing.left.code).toBe(missing.left.code)
  })
  it('refuses restore of plan.html when plan/index.html now has the same canonical link', async () => {
    const owner = await person('clash-owner')
    const ws = await workspace(owner)
    const writer = await agent(owner)
    const target = `${ws.name}/clash${crypto.randomUUID().slice(0, 8)}`
    await pushAt(T, writer, target, {
      'plan.html':
        '<!doctype html><html><head><title>Plan</title></head><body>Plan</body></html>',
    })
    await call(writer, 1, (f) => f.rm({ ref: ref(`${target}/plan.html`) }))
    await pushAt(
      T + 2 * HOUR,
      writer,
      target,
      {
        'plan/index.html':
          '<!doctype html><html><head><title>New plan</title></head><body>New plan</body></html>',
      },
      { force: true },
    )
    const result: any = await call(writer, 3, (f) =>
      Effect.either(
        f.restore({ ref: ref(`${target}/plan.html`), to: { push: 1 } }),
      ),
    )
    expect(result._tag).toBe('Left')
  })

  it('refuses a move creating plan/index.html next to plan.html', async () => {
    const owner = await person('move-clash-owner')
    const ws = await workspace(owner)
    const writer = await agent(owner)
    const target = `${ws.name}/moveclash${crypto.randomUUID().slice(0, 8)}`
    const html =
      '<!doctype html><html><head><title>Plan</title></head><body>Plan</body></html>'
    await pushAt(T, writer, target, {
      'plan.html': html,
      'docs/page.html': html,
    })
    const result: any = await call(writer, 1, (f) =>
      Effect.either(
        f.mv({
          from: ref(`${target}/docs/page.html`),
          to: ref(`${target}/plan/index.html`),
        }),
      ),
    )
    expect(result._tag).toBe('Left')
  })

  it('accounts for longer thread JSON when a page is renamed', async () => {
    const owner = await person('rename-size-owner')
    const ws = await workspace(owner)
    const writer = await agent(owner)
    const target = `${ws.name}/renamesize${crypto.randomUUID().slice(0, 8)}`
    const pushed = await pushAt(T, writer, target, {
      'plan.html':
        '<!doctype html><html><head><title>Plan</title></head><body>Plan</body></html>',
    })
    const patch = {
      text: 'root',
      anchor: null,
      label: null,
      pin: null,
      replyTo: null,
      stance: null,
      mentions: [],
    }
    const root = await at(
      T + HOUR,
      writer,
      Effect.flatMap(Data, (d) =>
        d.write({
          tree: pushed.treeId,
          page: 'plan.html',
          path: 'plan.comments/',
          patch,
          replace: false,
          opId: crypto.randomUUID() as never,
          seq: 1 as never,
        }),
      ),
    )
    await at(
      T + 2 * HOUR,
      writer,
      Effect.flatMap(Data, (d) =>
        d.write({
          tree: pushed.treeId,
          page: 'plan.html',
          path: 'plan.comments/',
          patch: { ...patch, text: 'reply', replyTo: root.path },
          replace: false,
          opId: crypto.randomUUID() as never,
          seq: 1 as never,
        }),
      ),
    )
    const longName = 'much-longer-page-name'.repeat(4)
    await call(writer, 3, (f) =>
      f.mv({
        from: ref(`${target}/plan.html`),
        to: ref(`${target}/${longName}.html`),
      }),
    )
    const sizes = await rows<{ size: number; actual: number }>(
      'select v.size, length(cast(v.json_value as blob)) as actual from node_versions v where v.tree_id = ? and v.json_value is not null',
      pushed.treeId,
    )
    expect(sizes.every((x) => x.size === x.actual)).toBe(true)
  })
  it('does not recreate an orphan comments folder after a page moved and the commenter lost access', async () => {
    const owner = await person('comment-move-owner')
    const ws = await workspace(owner)
    const writer = await agent(owner)
    const target = `${ws.name}/comments${crypto.randomUUID().slice(0, 8)}`
    const pushed = await pushAt(T, writer, target, {
      'shared/plan.html':
        '<!doctype html><html><head><title>Plan</title></head><body>Plan</body></html>',
      'private/keep.txt': 'private\n',
    })
    const guest = await person('late-commenter')
    await share(
      pushed.treeId,
      (await nodeAt(pushed.treeId, 'shared'))!.id,
      'email',
      guest.email,
      'respond',
      owner,
    )
    const reader = await sessionFor(guest)
    const seq = (
      await rows<{ authored_seq: number }>(
        'select authored_seq from trees where id = ?',
        pushed.treeId,
      )
    )[0]!.authored_seq
    let moved = false
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) => sql.includes('insert into operations'),
            async () => {
              await withRuntime(testRuntime(), () =>
                runAs(
                  writer,
                  Effect.flatMap(Files, (f) =>
                    f.mv({
                      from: ref(`${target}/shared/plan.html`),
                      to: ref(`${target}/private/plan.html`),
                    }),
                  ),
                ),
              )
              moved = true
            },
          ),
        },
      }),
    )
    const result: any = await runAs(
      reader,
      Effect.flatMap(Data, (d) =>
        Effect.either(
          d.write({
            tree: pushed.treeId,
            page: 'shared/plan.html',
            path: 'shared/plan.comments/',
            patch: {
              text: 'late comment',
              anchor: null,
              label: null,
              pin: null,
              replyTo: null,
              stance: null,
              mentions: [],
            },
            replace: false,
            opId: crypto.randomUUID() as never,
            seq: seq as never,
          }),
        ),
      ),
    )
    const paths = await rows<{ path: string }>(
      'select path from nodes where tree_id = ? and deleted_at is null order by path',
      pushed.treeId,
    )
    expect(moved).toBe(true)
    expect(result._tag).toBe('Left')
    expect(paths.map((p) => p.path)).not.toContain('shared/plan.comments')
  })
  it('carries a workspace share to the destination membership', async () => {
    const owner = await person('share-owner')
    const a = await workspace(owner)
    const b = await workspace(owner)
    const sourceMember = await person('source-member')
    const destinationMember = await person('destination-member')
    await join(a, sourceMember)
    await join(b, destinationMember)
    const writer = await agent(owner)
    const name = `share${crypto.randomUUID().slice(0, 8)}`
    const pushed = await pushAt(T, writer, `${a.name}/${name}`, {
      'plan.txt': 'plan\n',
    })
    await share(
      pushed.treeId,
      (await nodeAt(pushed.treeId, ''))!.id,
      'workspace',
      a.id,
      'read',
      owner,
    )
    await call(writer, 1, (f) =>
      f.moveTree({
        tree: ref(`${a.name}/${name}/`),
        to: { workspace: b.name, tree: name },
      }),
    )
    const result: any = await call(await agent(destinationMember), 2, (f) =>
      Effect.either(f.content(ref(`${b.name}/${name}/plan.txt`))),
    )
    expect(result._tag).toBe('Right')
  })

  it('lets a member who writes the whole tree move it, carrying its workspace share, and a source member loses it', async () => {
    const owner = await person('nonadmin-owner')
    const a = await workspace(owner)
    const b = await workspace(owner)
    const mover = await person('nonadmin-mover')
    await join(a, mover)
    await join(b, mover)
    const sourceMember = await person('nonadmin-source-member')
    await join(a, sourceMember)
    const destinationMember = await person('nonadmin-destination-member')
    await join(b, destinationMember)
    const writer = await agent(owner)
    const name = `nonadmin${crypto.randomUUID().slice(0, 8)}`
    const pushed = await pushAt(T, writer, `${a.name}/${name}`, {
      'plan.txt': 'plan\n',
    })
    const root = (await nodeAt(pushed.treeId, ''))!.id
    await share(pushed.treeId, root, 'email', mover.email, 'write', owner)
    await share(pushed.treeId, root, 'workspace', a.id, 'read', owner)
    const moved: any = await call(await agent(mover), 1, (f) =>
      Effect.either(
        f.moveTree({
          tree: ref(`${a.name}/${name}/`),
          to: { workspace: b.name, tree: name },
        }),
      ),
    )
    expect(moved._tag).toBe('Right')
    const shares = await rows<{ target_kind: string; target: string }>(
      'select target_kind, target from shares where tree_id = ? order by target_kind',
      pushed.treeId,
    )
    expect(shares).toContainEqual({
      target_kind: 'email',
      target: mover.email.toLowerCase(),
    })
    expect(shares.filter((r) => r.target_kind === 'workspace')).toEqual([
      { target_kind: 'workspace', target: b.id },
    ])
    const destination: any = await call(
      await agent(destinationMember),
      2,
      (f) => Effect.either(f.content(ref(`${b.name}/${name}/plan.txt`))),
    )
    expect(destination._tag).toBe('Right')
    const source: any = await call(await agent(sourceMember), 2, (f) =>
      Effect.either(f.content(ref(`${b.name}/${name}/plan.txt`))),
    )
    expect(source._tag).toBe('Left')
  })

  it('keeps a workspace share when a tree is renamed in its workspace', async () => {
    const owner = await person('rename-owner')
    const a = await workspace(owner)
    const member = await person('rename-member')
    await join(a, member)
    const writer = await agent(owner)
    const name = `rename${crypto.randomUUID().slice(0, 8)}`
    const pushed = await pushAt(T, writer, `${a.name}/${name}`, {
      'plan.txt': 'plan\n',
    })
    await share(
      pushed.treeId,
      (await nodeAt(pushed.treeId, ''))!.id,
      'workspace',
      a.id,
      'read',
      owner,
    )
    await call(writer, 1, (f) =>
      f.moveTree({
        tree: ref(`${a.name}/${name}/`),
        to: { workspace: a.name, tree: `${name}-new` },
      }),
    )
    const result: any = await call(await agent(member), 2, (f) =>
      Effect.either(f.content(ref(`${a.name}/${name}-new/plan.txt`))),
    )
    expect(result._tag).toBe('Right')
  })

  it('refuses a tree move to someone who writes only a subfolder, as if it were not there', async () => {
    const owner = await person('subfolder-owner')
    const a = await workspace(owner)
    const b = await workspace(owner)
    const guest = await person('subfolder-writer')
    await join(b, guest)
    const writer = await agent(owner)
    const name = `subfolder${crypto.randomUUID().slice(0, 8)}`
    const pushed = await pushAt(T, writer, `${a.name}/${name}`, {
      'shared/plan.txt': 'plan\n',
    })
    await share(
      pushed.treeId,
      (await nodeAt(pushed.treeId, 'shared'))!.id,
      'email',
      guest.email,
      'write',
      owner,
    )
    const result: any = await call(await agent(guest), 1, (f) =>
      Effect.either(
        f.moveTree({
          tree: ref(`${a.name}/${name}/`),
          to: { workspace: b.name, tree: name },
        }),
      ),
    )
    expect(result._tag).toBe('Left')
    expect(result.left.code).toBe('not_found')
    expect(
      (
        await rows<{ n: number }>(
          'select count(*) as n from trees where id = ? and workspace_id = ?',
          pushed.treeId,
          a.id,
        )
      )[0]!.n,
    ).toBe(1)
  })

  it('keeps old tree links for a reader shared only a subfolder', async () => {
    const owner = await person('alias-owner')
    const a = await workspace(owner)
    const b = await workspace(owner)
    const writer = await agent(owner)
    const name = `alias${crypto.randomUUID().slice(0, 8)}`
    const pushed = await pushAt(T, writer, `${a.name}/${name}`, {
      'shared/plan.html':
        '<!doctype html><html><head><title>Plan</title></head><body>Plan</body></html>',
    })
    const guest = await person('alias-guest')
    await share(
      pushed.treeId,
      (await nodeAt(pushed.treeId, 'shared'))!.id,
      'email',
      guest.email,
      'read',
      owner,
    )
    const reader = await sessionFor(guest)
    await call(writer, 1, (f) =>
      f.moveTree({
        tree: ref(`${a.name}/${name}/`),
        to: { workspace: b.name, tree: name },
      }),
    )
    const newLink: any = await runAs(
      reader,
      Effect.flatMap(Pages, (p) =>
        Effect.either(
          p.open({
            ref: ref(`${b.name}/${name}/shared/plan`),
            wantsAgent: false,
          }),
        ),
      ),
    )
    const oldLink: any = await runAs(
      reader,
      Effect.flatMap(Pages, (p) =>
        Effect.either(
          p.open({
            ref: ref(`${a.name}/${name}/shared/plan`),
            wantsAgent: false,
          }),
        ),
      ),
    )
    expect(newLink._tag).toBe('Right')
    expect(oldLink._tag).toBe('Right')
  })

  it('checks destination workspace storage when moving a whole tree', async () => {
    const owner = await person('quota-owner')
    const a = await workspace(owner)
    const b = await workspace(owner)
    const writer = await agent(owner)
    const name = `quota${crypto.randomUUID().slice(0, 8)}`
    await pushAt(T, writer, `${a.name}/${name}`, {
      'plan.txt': '1234567890',
    })
    await pushAt(
      T,
      writer,
      `${b.name}/existing${crypto.randomUUID().slice(0, 8)}`,
      { 'plan.txt': '1234567890' },
    )
    await exec(
      `insert into deployment_settings (key, value_json, updated_by, updated_at) values ('limits', ?, ?, ?) on conflict (key) do update set value_json = excluded.value_json`,
      JSON.stringify({ storageBytes: 15 }),
      owner.id,
      Date.now(),
    )
    // A caller the saved limit is new to: settings are read once a caller.
    const mover = await agent(owner)
    try {
      const result: any = await call(mover, 1, (f) =>
        Effect.either(
          f.moveTree({
            tree: ref(`${a.name}/${name}/`),
            to: { workspace: b.name, tree: name },
          }),
        ),
      )
      const used = await rows<{ used: number }>(
        'select sum(coalesce(v.size, 0)) as used from node_versions v join trees t on t.id = v.tree_id where t.workspace_id = ?',
        b.id,
      )
      expect(result._tag).toBe('Left')
      expect(used[0]!.used).toBe(10)
    } finally {
      await exec("delete from deployment_settings where key = 'limits'")
    }
  })
})
