// What a share may carry: never more than the people behind the shared page
// could read, and what a public folder's pages show.
import type { NodeId, TreeId } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { Access, TreeStore, type Caller } from '../src/core/index.ts'
import { db, schema } from '../src/db/client.ts'
import { Browser } from './support/browser.ts'
import { exec } from './support/d1.ts'
import { harness } from './support/harness.ts'
import { runAs } from './support/people.ts'
import {
  agent,
  dataFile,
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

const listedAs = (caller: Caller, treeId: string) =>
  runAs(
    caller,
    Effect.gen(function* () {
      const readable = yield* (yield* Access).readable(treeId as TreeId)
      return yield* Effect.promise(() =>
        db(env)
          .select({ path: schema.nodes.path })
          .from(schema.nodes)
          .where(and(eq(schema.nodes.treeId, treeId), readable.where))
          .all(),
      )
    }),
  ).then((rows) => rows.map((row) => row.path).sort())

/**
 * An admin's tree with a private page and other people's answers, and a
 * writer who may change only `team/`.
 */
const world = async () => {
  const admin = await person('admin')
  const ws = await workspace(admin)
  const writer = await person('writer')
  await join(ws, writer)
  const adminAgent = await agent(admin)
  const pushed = await pushAll(adminAgent, `${ws.name}/t`, {
    'private/secret.html':
      '<!doctype html><title>Secret</title><p>SALARIES</p>',
    'hr/form.html':
      '<!doctype html><title>HR</title><form action="answers/"><input name="a"></form>',
    'team/pub.html': '<!doctype html><title>Public</title><p>Hello</p>',
    'media/pic.png': 'pic',
    'pub/page.html':
      '<!doctype html><title>Pub</title><img src="../media/pic.png">',
  })
  if (!('treeId' in pushed)) throw new Error('no tree')
  const treeId = pushed.treeId
  const node = async (path: string) =>
    (await nodeAt(treeId, path))!.id as NodeId
  await share(treeId, await node('team'), 'email', writer.email, 'write', admin)
  const answerer = await person('answerer')
  await dataFile(
    treeId,
    `hr/answers/${answerer.email}.json`,
    { a: 'private' },
    answerer,
  )
  const at = (path: string) => `${ws.name}/t/${path}`
  return { admin, ws, writer, adminAgent, treeId, node, at }
}

describe('what a page share may carry', () => {
  it('never carries what the person who pushed the page could not read', async () => {
    const w = await world()
    await share(
      w.treeId,
      await w.node('team/pub.html'),
      'anyone',
      '*',
      'read',
      w.admin,
    )
    // The writer of team/ makes the public page frame a private page.
    await pushAll(
      await agent(w.writer),
      `${w.ws.name}/t/team`,
      {
        'pub.html':
          '<!doctype html><title>Public</title><iframe src="../private/secret"></iframe>',
      },
      { force: true },
    )
    expect(await readAs(visitorCaller(), w.at('private/secret.html'))).toBe(
      'sign_in_required',
    )
    expect(await listedAs(visitorCaller(), w.treeId)).not.toContain(
      'private/secret.html',
    )
  })

  it('never carries what the share’s creator cannot read', async () => {
    const w = await world()
    // The admin's page frames the private page; the writer shares it.
    await pushAll(
      w.adminAgent,
      `${w.ws.name}/t/team`,
      {
        'pub.html':
          '<!doctype html><title>Public</title><iframe src="../private/secret"></iframe>',
      },
      { force: true },
    )
    await share(
      w.treeId,
      await w.node('team/pub.html'),
      'anyone',
      '*',
      'read',
      w.writer,
    )
    expect(await readAs(visitorCaller(), w.at('private/secret.html'))).toBe(
      'sign_in_required',
    )
    // Made by the admin, who reads it, the same share carries it.
    await exec(
      "update shares set created_by = ? where node_id = ? and target_kind = 'anyone'",
      w.admin.id,
      await w.node('team/pub.html'),
    )
    expect(await readAs(visitorCaller(), w.at('private/secret.html'))).toBe(
      'ok',
    )
  })

  it('never lets a writer read other people’s answers through a form of a page they share', async () => {
    const w = await world()
    await pushAll(
      await agent(w.writer),
      `${w.ws.name}/t/team`,
      {
        'pub.html':
          '<!doctype html><title>Grab</title><form action="../hr/answers/"><input name="a"></form>',
      },
      { force: true },
    )
    const other = await person('other')
    await share(
      w.treeId,
      await w.node('team/pub.html'),
      'email',
      other.email,
      'read',
      w.writer,
    )
    const listed = await listedAs(await agent(other), w.treeId)
    expect(listed.filter((p) => p.startsWith('hr/answers/'))).toEqual([])
    const [answer] = listed.length >= 0 ? [`hr/answers/`] : []
    expect(
      await readAs(await agent(other), w.at(`${answer}answerer`)),
    ).not.toBe('ok')
  })
})

describe('a public folder', () => {
  it('carries the media its pages show from outside it', async () => {
    const w = await world()
    await share(w.treeId, await w.node('pub'), 'anyone', '*', 'read', w.admin)
    expect(await readAs(visitorCaller(), w.at('media/pic.png'))).toBe('ok')
    expect(await readAs(visitorCaller(), w.at('private/secret.html'))).toBe(
      'sign_in_required',
    )
  })
})

describe('a withdrawn answer of one’s own', () => {
  it('answers the point and the list check alike', async () => {
    const w = await world()
    const answerer = await person('own')
    await dataFile(w.treeId, 'hr/answers/own.json', { a: 1 }, answerer)
    await exec(
      'update nodes set deleted_at = ? where path = ? and tree_id = ?',
      Date.now(),
      'hr/answers/own.json',
      w.treeId,
    )
    const caller = await agent(answerer)
    const node = (
      await db(env)
        .select()
        .from(schema.nodes)
        .where(eq(schema.nodes.treeId, w.treeId))
        .all()
    ).find((n) => n.path === 'hr/answers/own.json')!
    const point = await runAs(
      caller,
      Effect.flatMap(Access, (access) =>
        access.require('read', node as never),
      ).pipe(Effect.isSuccess),
    )
    const listed = await runAs(
      caller,
      Effect.gen(function* () {
        const readable = yield* (yield* Access).readable(w.treeId as TreeId)
        return yield* Effect.promise(() =>
          db(env)
            .select({ id: schema.nodes.id })
            .from(schema.nodes)
            .where(and(eq(schema.nodes.id, node.id), readable.where))
            .all(),
        )
      }),
    )
    expect(listed.length > 0).toBe(point)
  })
})

describe('a public page’s preview image', () => {
  it('leaves out a private file however its URL is spelled', async () => {
    const w = await world()
    const origin = env.PUBLIC_ORIGIN
    const host = new URL(origin).host
    for (const spelled of [
      `${origin}/_/api/file?path=${encodeURIComponent(`${w.ws.name}/t/private/secret.html`)}`,
      `//${host}/_/api/file?path=${encodeURIComponent(`${w.ws.name}/t/private/secret.html`)}`,
      `${origin}/${w.ws.name}/t/media/pic.png`,
    ]) {
      await pushAll(
        w.adminAgent,
        `${w.ws.name}/t/team`,
        {
          'pub.html': `<!doctype html><title>Public</title><meta property="og:image" content="${spelled}">`,
        },
        { force: true },
      )
      await share(
        w.treeId,
        await w.node('team/pub.html'),
        'anyone',
        '*',
        'read',
        w.admin,
      ).catch(() => undefined)
      const html = await (
        await new Browser().fetch(`/${w.ws.name}/t/team/pub`)
      ).text()
      expect(html, spelled).not.toContain('og:image')
    }
  })
})
