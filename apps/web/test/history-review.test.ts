import { type PushNumber } from '@dossier/contracts'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { Files } from '../src/core/index.ts'
import { SELF } from 'cloudflare:test'
import { ORIGIN } from './support/harness.ts'
import { keySecretFor } from './support/keys.ts'
import { at, HOUR, pushAt } from './support/purge.ts'
import {
  agent,
  join,
  nodeAt,
  person,
  ref,
  share,
  workspace,
} from './support/trees.ts'

const T = Date.UTC(2026, 9, 8, 9)
const setup = async () => {
  const owner = await person('review-owner')
  const ws = await workspace(owner)
  const writer = await agent(owner)
  const target = `${ws.name}/review${crypto.randomUUID().slice(0, 8)}`
  const pushed = await pushAt(
    T,
    writer,
    target,
    {
      'shared/keep.txt': 'visible\n',
      'private/acquisition-target.txt': 'secret target\n',
    },
    { message: 'Acquisition target' },
  )
  const guest = await person('review-guest')
  await share(
    pushed.treeId,
    (await nodeAt(pushed.treeId, 'shared'))!.id,
    'email',
    guest.email,
    'write',
    owner,
  )
  return {
    writer,
    guest: await agent(guest),
    target,
    tree: pushed.treeId,
    r: (path: string) => ref(`${target}/${path}`),
  }
}
const call = <A>(
  who: any,
  n: number,
  use: (f: any) => Effect.Effect<A, any, any>,
) => at(T + n * HOUR, who, Effect.flatMap(Files, use) as never) as Promise<A>

describe('independent Phase 11 history probes', () => {
  it('redacts a tree previous private destination for its new workspace admin', async () => {
    const owner = await person('tree-owner')
    const a = await workspace(owner)
    const b = await workspace(owner)
    const guest = await person('tree-destination-admin')
    const c = await workspace(guest)
    await join(c, owner)
    const writer = await agent(owner)
    const name = `tree${crypto.randomUUID().slice(0, 8)}`
    await pushAt(T, writer, `${a.name}/${name}`, { 'plan.txt': 'plan\n' })
    await call(writer, 1, (f) =>
      f.moveTree({
        tree: ref(`${a.name}/${name}/`),
        to: { workspace: b.name, tree: 'private-acquisition' },
      }),
    )
    await call(writer, 2, (f) =>
      f.moveTree({
        tree: ref(`${b.name}/private-acquisition/`),
        to: { workspace: c.name, tree: 'current' },
      }),
    )
    await pushAt(T + 3 * HOUR, writer, `${b.name}/private-acquisition`, {
      'unreadable.txt': 'private replacement\n',
    })
    const result: any = await call(await agent(guest), 4, (f) =>
      f.log({ ref: ref(`${c.name}/current/`), cursor: null }),
    )
    void JSON.stringify(result)
    expect(JSON.stringify(result)).not.toContain(
      `${b.name}/private-acquisition`,
    )
  })
  it('does not disclose deleted private content through a newly shared replacement folder diff', async () => {
    const owner = await person('folder-owner')
    const ws = await workspace(owner)
    const writer = await agent(owner)
    const target = `${ws.name}/folder${crypto.randomUUID().slice(0, 8)}`
    const r = (path: string) => ref(`${target}/${path}`)
    const pushed = await pushAt(
      T,
      writer,
      target,
      { 'area/secret.txt': 'CONFIDENTIAL acquisition valuation 90000000\n' },
      { message: 'Private acquisition' },
    )
    await call(writer, 1, (f) => f.rm({ ref: r('area/') }))
    await pushAt(
      T + 2 * HOUR,
      writer,
      target,
      { 'area/public.txt': 'Public area\n' },
      { force: true, message: 'Public area' },
    )
    const guest = await person('folder-guest')
    await share(
      pushed.treeId,
      (await nodeAt(pushed.treeId, 'area'))!.id,
      'email',
      guest.email,
      'write',
      owner,
    )
    const secret = await keySecretFor(guest)
    const response = await SELF.fetch(
      `${ORIGIN}/_/api/diff?path=${encodeURIComponent(`${target}/area/`)}&from=1&to=2`,
      { headers: { authorization: `Bearer ${secret}` } },
    )
    const wire = await response.json()
    void (response.status, JSON.stringify(wire))
    expect(JSON.stringify(wire)).not.toContain(
      'CONFIDENTIAL acquisition valuation 90000000',
    )
  })
  it('requires sign-in to read write-only history through an anyone-write share', async () => {
    const t = await setup()
    await share(
      t.tree,
      (await nodeAt(t.tree, ''))!.id,
      'anyone',
      '*',
      'write',
      t.writer.person!,
    )
    await pushAt(
      T + HOUR,
      t.writer,
      t.target,
      {
        'shared/keep.txt': 'public replacement\n',
        'private/acquisition-target.txt': 'secret target\n',
      },
      { force: true, message: 'New plan' },
    )
    const responses: number[] = []
    for (const query of [
      `/log?path=${encodeURIComponent(`${t.target}/`)}`,
      `/push?path=${encodeURIComponent(`${t.target}/`)}&number=1`,
      `/diff?path=${encodeURIComponent(`${t.target}/shared/keep.txt`)}`,
    ]) {
      const response = await SELF.fetch(`${ORIGIN}/_/api${query}`)
      responses.push(response.status)
    }
    expect(responses).toEqual([401, 401, 401])
  })
  it('does not give a newly shared replacement file the deleted private node history at that path', async () => {
    const owner = await person('replacement-owner')
    const ws = await workspace(owner)
    const writer = await agent(owner)
    const target = `${ws.name}/replacement${crypto.randomUUID().slice(0, 8)}`
    const r = (path: string) => ref(`${target}/${path}`)
    const pushed = await pushAt(
      T,
      writer,
      target,
      { 'plan.txt': 'private v1\n' },
      { message: 'Lay off Alice on Friday' },
    )
    await call(writer, 1, (f) => f.rm({ ref: r('plan.txt') }))
    await pushAt(
      T + 2 * HOUR,
      writer,
      target,
      { 'plan.txt': 'public replacement\n' },
      { force: true, message: 'Public plan' },
    )
    const guest = await person('replacement-guest')
    await share(
      pushed.treeId,
      (await nodeAt(pushed.treeId, 'plan.txt'))!.id,
      'email',
      guest.email,
      'write',
      owner,
    )
    const result: any = await call(await agent(guest), 3, (f) =>
      f.log({ ref: r('plan.txt'), cursor: null }),
    )
    void JSON.stringify(result)
    expect(JSON.stringify(result)).not.toContain('Lay off Alice on Friday')
  })
  it('redacts a private intermediate destination after the node returns to shared', async () => {
    const t = await setup()
    await call(t.writer, 1, (f) =>
      f.mv({ from: t.r('shared/keep.txt'), to: t.r('private/layoffs.txt') }),
    )
    await call(t.writer, 2, (f) =>
      f.mv({
        from: t.r('private/layoffs.txt'),
        to: t.r('shared/returned.txt'),
      }),
    )
    await pushAt(
      T + 3 * HOUR,
      t.writer,
      `${t.target}/private`,
      {
        'acquisition-target.txt': 'secret target\n',
        'layoffs.txt': 'new private content\n',
      },
      { force: true, message: 'Private replacement' },
    )
    const result: any = await call(t.guest, 4, (f) =>
      f.log({ ref: t.r('shared/'), cursor: null }),
    )
    void JSON.stringify(result)
    expect(JSON.stringify(result)).not.toContain('private/layoffs.txt')
  })

  it('redacts an inbound file original private path in push detail', async () => {
    const t = await setup()
    await call(t.writer, 1, (f) =>
      f.mv({
        from: t.r('private/acquisition-target.txt'),
        to: t.r('shared/target.txt'),
      }),
    )
    await pushAt(
      T + 2 * HOUR,
      t.writer,
      `${t.target}/private`,
      { 'acquisition-target.txt': 'replacement private content\n' },
      { force: true },
    )
    const result: any = await call(t.guest, 3, (f) =>
      Effect.either(
        f.pushDetail({
          ref: t.r('shared/target.txt'),
          number: 1 as PushNumber,
        }),
      ),
    )
    expect(JSON.stringify(result)).not.toContain(
      'private/acquisition-target.txt',
    )
    const secret = await keySecretFor(t.guest.person!)
    const response = await SELF.fetch(
      `${ORIGIN}/_/api/push?path=${encodeURIComponent(`${t.target}/shared/target.txt`)}&number=1`,
      { headers: { authorization: `Bearer ${secret}` } },
    )
    const wire = await response.json()
    void (response.status, JSON.stringify(wire))
    expect(JSON.stringify(wire)).not.toContain('private/acquisition-target.txt')
  })

  it('does not count a moved-out file in a folder push detail that the caller cannot read now', async () => {
    const t = await setup()
    await call(t.writer, 1, (f) =>
      f.mv({
        from: t.r('shared/keep.txt'),
        to: t.r('private/no-longer-shared.txt'),
      }),
    )
    // The push wrote nothing the caller may see here now: not in this history.
    const result: any = await call(t.guest, 2, (f) =>
      Effect.either(
        f.pushDetail({ ref: t.r('shared/'), number: 1 as PushNumber }),
      ),
    )
    expect(
      result._tag === 'Left' ? result.left.code : result.right.files,
    ).toEqual(result._tag === 'Left' ? 'not_found' : [])
  })
})
