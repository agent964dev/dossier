import type { AuthoredSeq, TreeId } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import {
  composedKeyUrl,
  CurrentCaller,
  Pages,
  type Caller,
  type CommitResult,
  type CoreRuntime,
  type Served,
  type StageResult,
} from '../src/core/index.ts'
import { kitRuntime } from './support/base.ts'
import { signedIn } from './support/browser.ts'
import { harness } from './support/harness.ts'
import { callerOf, fresh } from './support/people.ts'
import { agent, nodeAt, pushAll, share, workspace } from './support/trees.ts'

afterEach(() => harness.reset())

const FILES = {
  '_layout.html':
    '<!doctype html><html><head><title>Acme</title></head><body><header>Acme</header><slot></slot></body></html>',
  'guides/_layout.html': '<nav>Guides</nav><slot></slot>',
  'guides/page.html': '<title>Page</title><p>Page</p>',
  'notes.txt': 'notes',
}

const committed = (result: CommitResult | StageResult): CommitResult => {
  if (!('number' in result)) throw new Error('the push did not commit')
  return result
}

/** R2 that counts every read of a blob's bytes. */
const countingBlobs = () => {
  let gets = 0
  const blobs = new Proxy(env.BLOBS, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (...args: Parameters<R2Bucket['get']>) => {
          gets += 1
          return target.get(...args)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { blobs, gets: () => gets, reset: () => (gets = 0) }
}

const frameWith = (
  runtime: CoreRuntime,
  handle: string,
  treeId: TreeId,
  seq: number,
  path: string,
  host = `${treeId}.content.test`,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const pages = yield* Pages
      const caller = yield* pages.handleCaller(handle, treeId)
      if (caller === null) throw new Error('the handle was refused')
      return yield* pages
        .frame({
          treeId,
          seq: seq as AuthoredSeq,
          path,
          folder: false,
          range: null,
          ifNoneMatch: null,
          host,
          wantsAgent: false,
        })
        .pipe(Effect.provideService(CurrentCaller, caller))
    }),
  )

const viewWith = (
  runtime: CoreRuntime,
  caller: Caller,
  treeId: TreeId,
  path: string,
) =>
  runtime.runPromise(
    Effect.flatMap(Pages, (pages) => pages.view({ treeId, path })).pipe(
      Effect.provideService(CurrentCaller, caller),
    ),
  )

const htmlOf = (served: Served): string => {
  if (served.kind !== 'framePage') throw new Error(`not a page: ${served.kind}`)
  return served.html
}

/** An owner, a reader of the whole tree and the tree pushed once. */
const world = async () => {
  const owner = await callerOf(await signedIn(fresh()))
  const ws = await workspace(owner.person!)
  const key = await agent(owner.person!)
  const first = committed(await pushAll(key, `${ws.name}/acme`, FILES))
  const reader = await callerOf(await signedIn(fresh()))
  const root = (await nodeAt(first.treeId, ''))!
  await share(
    first.treeId,
    root.id,
    'email',
    reader.person!.email,
    'read',
    owner.person!,
  )
  return { owner, reader, ws, key, treeId: first.treeId, seq: first.seq }
}

describe('the composed-page cache', () => {
  it('gives two viewers of one page one key and byte-identical HTML', async () => {
    const kit = kitRuntime()
    harness.use(kit.runtime)
    const w = await world()
    const a = await viewWith(kit.runtime, w.owner, w.treeId, 'guides/page')
    const b = await viewWith(kit.runtime, w.reader, w.treeId, 'guides/page')
    expect(a.handle).not.toBe(b.handle)
    const first = await frameWith(
      kit.runtime,
      a.handle,
      w.treeId,
      a.seq,
      'guides/page',
    )
    const second = await frameWith(
      kit.runtime,
      b.handle,
      w.treeId,
      b.seq,
      'guides/page',
    )
    expect(htmlOf(second)).toBe(htmlOf(first))
    expect(first.kind === 'framePage' && first.etag).toBe(
      second.kind === 'framePage' && second.etag,
    )
    const keys = kit.cache.keys()
    expect(keys).toHaveLength(2)
    expect(keys[1]).toEqual(keys[0])
    expect(keys[0]).toEqual({
      host: `${w.treeId}.content.test`,
      treeId: w.treeId,
      seq: w.seq,
      path: 'guides/page.html',
      composer: '6.10',
      base: 'base0000test',
    })
    expect(kit.cache.entries().size).toBe(1)
    expect(htmlOf(first)).toContain('<header>Acme</header>')
    expect(htmlOf(first)).toContain('<nav>Guides</nav>')
  })

  it('takes a new key after a push anywhere in the tree, on another base version and on another host', async () => {
    const kit = kitRuntime()
    harness.use(kit.runtime)
    const w = await world()
    const grant = await viewWith(kit.runtime, w.owner, w.treeId, 'guides/page')
    await frameWith(
      kit.runtime,
      grant.handle,
      w.treeId,
      grant.seq,
      'guides/page',
    )
    // A push that changes only a file elsewhere in the tree.
    const pushed = committed(
      await pushAll(
        w.key,
        `${w.ws.name}/acme`,
        { ...FILES, 'notes.txt': 'notes two' },
        { force: true },
      ),
    )
    const again = await viewWith(kit.runtime, w.owner, w.treeId, 'guides/page')
    expect(again.seq).toBe(pushed.seq)
    await frameWith(
      kit.runtime,
      again.handle,
      w.treeId,
      again.seq,
      'guides/page',
    )
    await frameWith(
      kit.runtime,
      again.handle,
      w.treeId,
      again.seq,
      'guides/page',
      `${w.treeId}.other-content.test`,
    )
    const other = kitRuntime({ version: 'base1111test' })
    const html = htmlOf(
      await frameWith(
        other.runtime,
        again.handle,
        w.treeId,
        again.seq,
        'guides/page',
      ),
    )
    expect(html).toContain('/_/base/base1111test/client.js')
    const keys = [...kit.cache.keys(), ...other.cache.keys()].map(
      composedKeyUrl,
    )
    expect(new Set(keys).size).toBe(4)
    expect(kit.cache.keys().map((k) => k.seq)).toEqual([
      w.seq,
      pushed.seq,
      pushed.seq,
    ])
  })

  it('reads nothing from R2 for a page already composed', async () => {
    const counting = countingBlobs()
    const kit = kitRuntime({ env: { BLOBS: counting.blobs } })
    harness.use(kit.runtime)
    const w = await world()
    const grant = await viewWith(kit.runtime, w.reader, w.treeId, 'guides/page')
    counting.reset()
    const first = await frameWith(
      kit.runtime,
      grant.handle,
      w.treeId,
      grant.seq,
      'guides/page',
    )
    expect(counting.gets()).toBeGreaterThan(0)
    counting.reset()
    const second = await frameWith(
      kit.runtime,
      grant.handle,
      w.treeId,
      grant.seq,
      'guides/page',
    )
    expect(counting.gets()).toBe(0)
    expect(htmlOf(second)).toBe(htmlOf(first))
  })
})
