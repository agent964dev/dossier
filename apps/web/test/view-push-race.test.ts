import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { expect, it } from 'vitest'

import { CurrentCaller, Pages } from '../src/core/index.ts'
import { signedIn } from './support/browser.ts'
import { rows } from './support/d1.ts'
import { harness, testRuntime } from './support/harness.ts'
import { callerOf, fresh, runAs } from './support/people.ts'
import {
  agent,
  nodeAt,
  person,
  pushAll,
  share,
  workspace,
} from './support/trees.ts'

const plain = '<!doctype html><title>Plan</title><p>Plan one</p>'
const withImage = '<!doctype html><title>Plan</title><img src="asset.svg">'
const svg = (text: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"><text>${text}</text></svg>`

it('issues the files of the page at the sequence a view returns, when a push lands mid-view', async () => {
  const owner = await person('owner')
  const ws = await workspace(owner)
  const key = await agent(owner)
  const first = await pushAll(key, `${ws.name}/acme`, {
    'plan.html': plain,
    'asset.svg': svg('ASSET-ONE'),
  })
  if (!('treeId' in first)) throw new Error('No tree')
  const treeId = first.treeId
  const reader = await callerOf(await signedIn(fresh()))
  const page = (await nodeAt(treeId, 'plan.html'))!
  await share(treeId, page.id, 'email', reader.person!.email, 'read', owner)

  // The view's tree read waits until its page read has answered (or 50 ms),
  // then a push makes the page use asset.svg before the tree read runs.
  let pageRead!: () => void
  const pageWasRead = new Promise<void>((resolve) => {
    pageRead = resolve
  })
  let treePending = true
  let pagePending = true
  let pushed = false
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property !== 'prepare') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (sql: string) => {
        const wrap = (
          statement: D1PreparedStatement,
          values: unknown[] = [],
        ): D1PreparedStatement =>
          new Proxy(statement, {
            get(st, method) {
              if (method === 'bind') {
                return (...args: unknown[]) => wrap(st.bind(...args), args)
              }
              const value = Reflect.get(st, method, st)
              if (
                typeof value !== 'function' ||
                !['raw', 'all', 'first'].includes(String(method))
              ) {
                return typeof value === 'function' ? value.bind(st) : value
              }
              return async (...args: unknown[]) => {
                if (
                  treePending &&
                  /from "trees" inner join "workspaces"/.test(sql)
                ) {
                  treePending = false
                  await Promise.race([
                    pageWasRead,
                    new Promise((resolve) => setTimeout(resolve, 50)),
                  ])
                  harness.reset()
                  await pushAll(
                    key,
                    `${ws.name}/acme`,
                    { 'plan.html': withImage, 'asset.svg': svg('ASSET-ONE') },
                    { force: true },
                  )
                  harness.use(runtime)
                  pushed = true
                }
                if (
                  pagePending &&
                  /from "nodes" left join "node_versions"/.test(sql) &&
                  values.includes('plan.html')
                ) {
                  pagePending = false
                  const result = await value.apply(st, args)
                  pageRead()
                  return result
                }
                return value.apply(st, args)
              }
            },
          })
        return wrap(target.prepare(sql))
      }
    },
  })
  const runtime = testRuntime({ env: { DB: database } })
  harness.use(runtime)
  const grant = await runAs(
    reader,
    Effect.flatMap(Pages, (pages) => pages.view({ treeId, path: 'plan' })),
  )
  harness.reset()
  expect(pushed).toBe(true)

  const asset = (await nodeAt(treeId, 'asset.svg'))!
  const issued = await rows<{ node_id: string }>(
    'select node_id from view_handle_nodes where seq = ?',
    grant.seq,
  )
  expect(issued.map((row) => row.node_id)).toContain(asset.id)

  // A later push changes the image; the open tab still loads the one its
  // view was issued.
  await pushAll(
    key,
    `${ws.name}/acme`,
    { 'plan.html': withImage, 'asset.svg': svg('ASSET-TWO') },
    { force: true },
  )
  const served = await runAs(
    reader,
    Effect.gen(function* () {
      const pages = yield* Pages
      const handle = yield* pages.handleCaller(grant.handle, treeId)
      if (handle === null) return 'no handle'
      return yield* pages
        .frame({
          treeId,
          seq: grant.seq,
          path: 'asset.svg',
          folder: false,
          range: null,
          ifNoneMatch: null,
          host: `${treeId}.content.test`,
          wantsAgent: false,
        })
        .pipe(
          Effect.provideService(CurrentCaller, handle),
          Effect.catchAll((error) => Effect.succeed(error.code)),
        )
    }),
  )
  expect(served).toMatchObject({ kind: 'file' })
}, 120_000)
