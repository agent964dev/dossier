import {
  DossierError,
  PAGE_ERROR_CODES,
  type Doc,
  type DocWire,
  type ErrorCode,
  type Json,
  type JsonObject,
  type Me,
} from '@dossier/contracts/bridge'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Dossier } from '../src/page-client/create-page-client.ts'
import { FIXES } from '../src/page-client/data.ts'
import { install } from '../src/page-client/install.ts'
import { applyMergePatch } from '../src/page-client/merge-patch.ts'
import { BOOTSTRAP, SARA, openPage, type Page } from './fake-shell.ts'
import { flush, type FakePort } from './ports.ts'

afterEach(() => {
  vi.useRealTimers()
})

const bootName = (me: Me | null) =>
  `dossier-boot:${JSON.stringify({ v: 1, me, drafts: {}, resume: [] })}`

interface Request {
  readonly type: 'request'
  readonly id: number
  readonly op: string
  readonly path?: string
  readonly patch?: JsonObject
  readonly replace?: boolean
  readonly opId?: string
  readonly seq?: number
  readonly sub?: number
  readonly name?: string
  readonly contentType?: string
  readonly file?: Blob
}

const wire = (path: string, data: unknown, push = 2): DocWire =>
  ({
    path,
    data,
    by: 'sara@acme.com',
    at: '2026-10-12T10:00:00.000Z',
    push,
  }) as DocWire

/** The page questions/results.html of the path table, in the shell's frame. */
const open = (me: Me | null = SARA, placement: 'top' | 'nested' = 'top') => {
  const page: Page = openPage({
    placement,
    name: placement === 'top' ? bootName(me) : undefined,
    bootstrap: { ...BOOTSTRAP, path: '/questions/results.html', seq: 9 },
  })
  install(page.window)
  const dossier = (page.win as unknown as { dossier: Dossier }).dossier
  const shellEnd = page.shell.hellos[0]!.ports[0]!
  const pageEnd = shellEnd.other as FakePort
  const raw: unknown[] = []
  const post = pageEnd.postMessage.bind(pageEnd)
  pageEnd.postMessage = (data: unknown) => {
    raw.push(data)
    post(data)
  }
  const requests = (op?: string) =>
    (page.shell.received() as Request[]).filter(
      (m) => m.type === 'request' && (op === undefined || m.op === op),
    )
  const answer = async (id: number, value: unknown) => {
    page.shell.tell({ type: 'result', id, ok: true, value })
    await flush()
  }
  const fail = async (
    id: number,
    code: ErrorCode,
    message = `The ${code} answer.`,
    fix: string | null = null,
    path: string | null = null,
  ) => {
    page.shell.tell({
      type: 'result',
      id,
      ok: false,
      error: { code, message, fix, path },
    })
    await flush()
  }
  const changed = async (sub: number, value: unknown) => {
    page.shell.tell({ type: 'changed', sub, value })
    await flush()
  }
  return { page, dossier, requests, answer, fail, changed, raw }
}

type Opened = ReturnType<typeof open>

/**
 * A stand-in for the server's store: answers every write request not yet
 * answered by merging its patch, in the order the requests arrive.
 */
const server = (it: Opened, stored = new Map<string, Json>()) => {
  const answered = new Set<number>()
  const step = async (): Promise<number> => {
    let count = 0
    for (const request of it.requests('write')) {
      if (answered.has(request.id)) continue
      answered.add(request.id)
      const path = request.path!.slice(1)
      const value = request.replace
        ? request.patch!
        : applyMergePatch(stored.get(path) ?? {}, request.patch!)
      stored.set(path, value)
      await it.answer(request.id, wire(path, value))
      count += 1
    }
    return count
  }
  return {
    stored,
    /** Answers the requests now, then any they lead to, until none is left. */
    settle: async () => {
      while ((await step()) > 0) {
        // Each answer may send the next request.
      }
    },
    step,
  }
}

describe('paths', () => {
  test('resolve like URLs from the page, / from the root, ~ for the viewer', async () => {
    const it = open()
    void it.dossier.read('answers/')
    void it.dossier.read('../plan.json')
    void it.dossier.read('/team/roster.json')
    void it.dossier.read('answers/~.json')
    void it.dossier.write('ideas/~/', { idea: 'x' })
    void it.dossier.write('../plan.comments/', { text: 'Hi' })
    await flush()
    expect(it.requests().map((r) => [r.op, r.path])).toEqual([
      ['read', '/questions/answers/'],
      ['read', '/plan.json'],
      ['read', '/team/roster.json'],
      ['read', '/questions/answers/sara@acme.com.json'],
      ['write', '/questions/ideas/sara@acme.com/'],
      ['write', '/plan.comments/'],
    ])
  })

  test('a path that leaves the tree is refused here with forbidden', async () => {
    const it = open()
    for (const call of [
      () => it.dossier.read('../../../x.json'),
      () => it.dossier.write('../../../x.json', { a: 1 }),
      () => it.dossier.withdraw('../../x.json'),
    ]) {
      const error = await call().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DossierError)
      expect(error).toMatchObject({
        code: 'forbidden',
        fix: FIXES.forbidden,
        path: expect.stringContaining('x.json'),
      })
    }
    await flush()
    expect(it.requests()).toEqual([])
  })

  test('~ for a visitor, and any write by one, is refused with sign_in_required', async () => {
    const it = open(null)
    const read = await it.dossier.read('answers/~.json').catch((e) => e)
    const write = await it.dossier.write('board.json', { a: 1 }).catch((e) => e)
    const upload = await it.dossier
      .upload(new File(['x'], 'a.txt'))
      .catch((e) => e)
    for (const error of [read, write, upload]) {
      expect(error).toBeInstanceOf(DossierError)
      expect(error).toMatchObject({
        code: 'sign_in_required',
        fix: FIXES.sign_in_required,
      })
    }
    expect(read.path).toBe('answers/~.json')
    // A visitor reads paths without ~.
    void it.dossier.read('../plan.json')
    await flush()
    expect(it.requests().map((r) => r.path)).toEqual(['/plan.json'])
  })

  test('a nested page waits for its welcome before resolving ~', async () => {
    const it = open(null, 'nested')
    const reading = it.dossier.read('answers/~.json')
    await flush()
    expect(it.requests()).toEqual([])
    it.page.shell.welcome(SARA)
    await flush()
    const [request] = it.requests('read')
    expect(request!.path).toBe('/questions/answers/sara@acme.com.json')
    await it.answer(request!.id, null)
    await expect(reading).resolves.toBeNull()
  })
})

describe('read', () => {
  test('a missing file is null and a folder is Doc[], paths relative to the page', async () => {
    const it = open()
    const missing = it.dossier.read('nope.json')
    const gone = it.dossier.read('gone.json')
    const folder = it.dossier.read('answers/')
    const empty = it.dossier.read('none/')
    await flush()
    const [a, b, c, d] = it.requests('read')
    await it.answer(a!.id, null)
    await it.fail(b!.id, 'not_found')
    await it.answer(c!.id, [
      wire('questions/answers/omar@acme.com.json', { choice: 'b' }),
      wire('questions/answers/sara@acme.com.json', { choice: 'a' }),
    ])
    await it.fail(d!.id, 'not_found')
    await expect(missing).resolves.toBeNull()
    await expect(gone).resolves.toBeNull()
    await expect(empty).resolves.toEqual([])
    const docs = (await folder) as Doc[]
    expect(docs.map((doc) => [doc.path, doc.data])).toEqual([
      ['answers/omar@acme.com.json', { choice: 'b' }],
      ['answers/sara@acme.com.json', { choice: 'a' }],
    ])
    expect(docs[0]).toMatchObject({
      by: 'sara@acme.com',
      at: '2026-10-12T10:00:00.000Z',
      push: 2,
    })
  })

  test('a file comes back as a Doc', async () => {
    const it = open()
    const reading = it.dossier.read('../plan.json')
    await flush()
    await it.answer(it.requests('read')[0]!.id, wire('plan.json', { v: 1 }))
    await expect(reading).resolves.toEqual({
      path: '../plan.json',
      data: { v: 1 },
      by: 'sara@acme.com',
      at: '2026-10-12T10:00:00.000Z',
      push: 2,
    })
  })
})

describe('write', () => {
  test('50 writes during one request go as two, merged', async () => {
    const it = open()
    const store = server(it)
    const first = it.dossier.write('board.json', { k0: 0 })
    await flush()
    const rest = Array.from({ length: 49 }, (_, i) =>
      it.dossier.write('board.json', { [`k${i + 1}`]: i + 1, k0: null }),
    )
    await flush()
    expect(it.requests('write')).toHaveLength(1)
    await store.settle()
    const writes = it.requests('write')
    expect(writes).toHaveLength(2)
    expect(writes[0]!.patch).toEqual({ k0: 0 })
    const expected: Record<string, number | null> = { k0: null }
    for (let i = 1; i < 50; i++) expected[`k${i}`] = i
    expect(writes[1]!.patch).toEqual(expected)
    const all: Record<string, number> = {}
    for (let i = 1; i < 50; i++) all[`k${i}`] = i
    expect(store.stored.get('questions/board.json')).toEqual(all)
    await expect(first).resolves.toMatchObject({ data: { k0: 0 } })
    for (const each of rest) {
      await expect(each).resolves.toMatchObject({
        path: 'board.json',
        data: all,
      })
    }
  })

  test('null, then an object under the same key, go as two more requests in order', async () => {
    const it = open()
    const store = server(it)
    const patches: JsonObject[] = [
      { a: { x: 1, y: 2 } },
      { a: null },
      { a: { z: 3 } },
    ]
    const calls = patches.map((patch) => it.dossier.write('board.json', patch))
    await flush()
    expect(it.requests('write')).toHaveLength(1)
    await store.settle()
    expect(it.requests('write').map((r) => r.patch)).toEqual(patches)
    const inOrder = patches.reduce<Json>(applyMergePatch, {})
    expect(inOrder).toEqual({ a: { z: 3 } })
    expect(store.stored.get('questions/board.json')).toEqual(inOrder)
    await Promise.all(calls)
  })

  test('every write request carries the bootstrap seq and a fresh op ID', async () => {
    const it = open()
    const store = server(it)
    void it.dossier.write('board.json', { a: 1 })
    void it.dossier.write('board.json', { b: 1 })
    void it.dossier.write('other.json', { c: 1 })
    void it.dossier.write('ideas/~/', { d: 1 })
    void it.dossier.write('board.json', { e: 1 }, { replace: true })
    await store.settle()
    const writes = it.requests('write')
    expect(writes.length).toBeGreaterThanOrEqual(4)
    expect(new Set(writes.map((r) => r.seq))).toEqual(new Set([9]))
    expect(new Set(writes.map((r) => r.opId)).size).toBe(writes.length)
  })

  test('a replace starts the queue again from its value', async () => {
    const it = open()
    const store = server(it)
    void it.dossier.write('board.json', { a: 1 })
    void it.dossier.write('board.json', { b: 1 })
    void it.dossier.write('board.json', { c: 1 }, { replace: true })
    void it.dossier.write('board.json', { d: 1 })
    await store.settle()
    expect(it.requests('write').map((r) => [r.patch, r.replace])).toEqual([
      [{ a: 1 }, false],
      [{ c: 1, d: 1 }, true],
    ])
    expect(store.stored.get('questions/board.json')).toEqual({ c: 1, d: 1 })
  })

  test('a folder write sends one request per call', async () => {
    const it = open()
    const one = it.dossier.write('ideas/~/', { idea: 'a' })
    const two = it.dossier.write('ideas/~/', { idea: 'b' })
    await flush()
    const writes = it.requests('write')
    expect(writes.map((r) => [r.path, r.patch])).toEqual([
      ['/questions/ideas/sara@acme.com/', { idea: 'a' }],
      ['/questions/ideas/sara@acme.com/', { idea: 'b' }],
    ])
    await it.answer(
      writes[0]!.id,
      wire('questions/ideas/sara@acme.com/20261012T100000Z.json', {
        idea: 'a',
      }),
    )
    await it.answer(
      writes[1]!.id,
      wire('questions/ideas/sara@acme.com/20261012T100000Z-2.json', {
        idea: 'b',
      }),
    )
    await expect(one).resolves.toMatchObject({
      path: 'ideas/sara@acme.com/20261012T100000Z.json',
    })
    await expect(two).resolves.toMatchObject({ data: { idea: 'b' } })
  })

  test('a patch that is not an object is refused with not_mergeable', async () => {
    const it = open()
    const error = await it.dossier
      .write('board.json', [1] as unknown as JsonObject)
      .catch((e) => e)
    expect(error).toMatchObject({ code: 'not_mergeable', path: 'board.json' })
  })
})

describe('watch', () => {
  test('calls back at once and on each changed', async () => {
    const it = open()
    const seen: unknown[] = []
    const stop = it.dossier.watch('answers/', (value) => seen.push(value))
    await flush()
    const [request] = it.requests('watch')
    expect(request).toMatchObject({ path: '/questions/answers/', sub: 1 })
    await it.answer(request!.id, null)
    await it.changed(1, [])
    expect(seen).toEqual([[]])
    await it.changed(1, [wire('questions/answers/omar@acme.com.json', 1)])
    expect(seen.at(-1)).toEqual([
      expect.objectContaining({ path: 'answers/omar@acme.com.json', data: 1 }),
    ])
    stop()
    await flush()
    expect(it.requests('unwatch')).toEqual([
      expect.objectContaining({ sub: 1 }),
    ])
    await it.changed(1, [])
    expect(seen).toHaveLength(2)
  })

  test('sees the viewer’s own write at once, and its rollback after a refusal', async () => {
    const it = open()
    const file: (Doc | null)[] = []
    const folder: Doc[][] = []
    it.dossier.watch('board.json', (value) => file.push(value as Doc | null))
    it.dossier.watch('/', (value) => folder.push(value as Doc[]))
    await flush()
    await it.changed(1, wire('questions/board.json', { a: 1 }))
    await it.changed(2, [
      wire('plan.json', { p: 1 }),
      wire('questions/board.json', { a: 1 }),
    ])
    expect(file.map((doc) => doc?.data)).toEqual([{ a: 1 }])

    const writing = it.dossier.write('board.json', { b: 2 })
    // At once, before any answer.
    expect(file.map((doc) => doc?.data)).toEqual([{ a: 1 }, { a: 1, b: 2 }])
    expect(folder.at(-1)!.map((doc) => [doc.path, doc.data])).toEqual([
      ['../plan.json', { p: 1 }],
      ['board.json', { a: 1, b: 2 }],
    ])
    await flush()
    const [write] = it.requests('write')
    await it.fail(
      write!.id,
      'forbidden',
      'You can open this but not change it.',
    )
    await expect(writing).rejects.toMatchObject({ code: 'forbidden' })
    expect(file.at(-1)!.data).toEqual({ a: 1 })
    expect(folder.at(-1)!.map((doc) => doc.data)).toEqual([{ p: 1 }, { a: 1 }])
  })

  test('takes a comments folder’s threads as they come, never merging an entry written into it', async () => {
    const it = open()
    const seen: Doc[][] = []
    it.dossier.watch('results.comments/', (value) => seen.push(value as Doc[]))
    await flush()
    const root =
      'questions/results.comments/sara@acme.com/2026-10-12T10-00-00.json'
    const thread = (replies: number) => ({ root: { path: root }, replies })
    await it.changed(1, [wire(root, thread(0))])
    expect(seen.at(-1)!.map((doc) => doc.data)).toEqual([thread(0)])

    const writing = it.dossier.write('results.comments/', { text: 'A reply' })
    await flush()
    const [write] = it.requests('write')
    const reply =
      'questions/results.comments/sara@acme.com/2026-10-12T10-01-00.json'
    await it.answer(write!.id, wire(reply, { text: 'A reply' }))
    await writing
    // The watch still holds one Doc per thread, not the new entry.
    expect(seen.at(-1)!.map((doc) => doc.data)).toEqual([thread(0)])
    await it.changed(1, [wire(root, thread(1))])
    expect(seen.at(-1)!.map((doc) => [doc.path, doc.data])).toEqual([
      ['results.comments/sara@acme.com/2026-10-12T10-00-00.json', thread(1)],
    ])

    const withdrawing = it.dossier.withdraw(
      'results.comments/sara@acme.com/2026-10-12T10-00-00.json',
    )
    await flush()
    const [withdrawal] = it.requests('withdraw')
    await it.answer(withdrawal!.id, null)
    await withdrawing
    // A deleted comment stays in its thread: the next value says so.
    expect(seen.at(-1)).toHaveLength(1)
  })

  test('a rollback keeps the patches still queued', async () => {
    const it = open()
    const file: unknown[] = []
    it.dossier.watch('board.json', (value) => file.push((value as Doc)?.data))
    await flush()
    await it.changed(1, wire('questions/board.json', { a: 1 }))
    const first = it.dossier.write('board.json', { b: 2 })
    const second = it.dossier.write('board.json', { c: 3 })
    await flush()
    const [write] = it.requests('write')
    await it.fail(write!.id, 'rate_limited', 'Too many writes.')
    await expect(first).rejects.toMatchObject({ code: 'rate_limited' })
    expect(file.at(-1)).toEqual({ a: 1, c: 3 })
    const [, next] = it.requests('write')
    expect(next!.patch).toEqual({ c: 3 })
    await it.answer(next!.id, wire('questions/board.json', { a: 1, c: 3 }))
    await expect(second).resolves.toMatchObject({ data: { a: 1, c: 3 } })
  })

  test('the stored value replaces the optimistic one when it arrives', async () => {
    const it = open()
    const file: unknown[] = []
    it.dossier.watch('board.json', (value) => file.push((value as Doc)?.data))
    await flush()
    await it.changed(1, wire('questions/board.json', { a: 1 }))
    void it.dossier.write('board.json', { b: 2 })
    // Someone else's write landed first; the pending patch shows on top.
    await it.changed(1, wire('questions/board.json', { a: 1, x: 9 }))
    expect(file.at(-1)).toEqual({ a: 1, x: 9, b: 2 })
    const [write] = it.requests('write')
    await it.answer(
      write!.id,
      wire('questions/board.json', { a: 1, x: 9, b: 2 }),
    )
    await it.changed(1, wire('questions/board.json', { a: 1, x: 9, b: 2 }))
    expect(file.at(-1)).toEqual({ a: 1, x: 9, b: 2 })
  })
})

describe('a page that goes away', () => {
  test('unwatches everything on pagehide, and watches again when shown from the cache', async () => {
    const it = open()
    it.dossier.watch('board.json', () => {})
    it.dossier.watch('answers/', () => {})
    const stopped = it.dossier.watch('../plan.json', () => {})
    stopped()
    await flush()
    it.page.win.dispatchEvent(new it.page.win.Event('pagehide'))
    await flush()
    expect(it.requests('unwatch').map((r) => r.sub)).toEqual([3, 1, 2])
    // A plain show changes nothing; one from the back-forward cache watches again.
    it.page.win.dispatchEvent(new it.page.win.Event('pageshow'))
    await flush()
    expect(it.requests('watch')).toHaveLength(3)
    const shown = Object.assign(new it.page.win.Event('pageshow'), {
      persisted: true,
    })
    it.page.win.dispatchEvent(shown)
    await flush()
    expect(
      it
        .requests('watch')
        .slice(3)
        .map((r) => [r.sub, r.path]),
    ).toEqual([
      [1, '/questions/board.json'],
      [2, '/questions/answers/'],
    ])
  })
})

describe('reads that cross a write', () => {
  test('a read sent before a write’s ack never rolls the write back', async () => {
    const it = open()
    const file: unknown[] = []
    it.dossier.watch('board.json', (value) => file.push((value as Doc)?.data))
    await flush()
    await it.changed(1, wire('questions/board.json', { a: 1 }))
    // The read leaves first; the peer answers it only after the write's ack.
    const reading = it.dossier.read('board.json')
    await flush()
    const writing = it.dossier.write('board.json', { b: 2 })
    await flush()
    const [read] = it.requests('read')
    const [write] = it.requests('write')
    await it.answer(write!.id, wire('questions/board.json', { a: 1, b: 2 }))
    await expect(writing).resolves.toMatchObject({ data: { a: 1, b: 2 } })
    await it.answer(read!.id, wire('questions/board.json', { a: 1 }))
    await expect(reading).resolves.toMatchObject({ data: { a: 1, b: 2 } })
    expect(file).toEqual([{ a: 1 }, { a: 1, b: 2 }])
    // A later write builds on the acknowledged value, not the late read.
    void it.dossier.write('board.json', { c: 3 })
    expect(file.at(-1)).toEqual({ a: 1, b: 2, c: 3 })
  })

  test('a folder read sent before a write’s ack keeps the written file', async () => {
    const it = open()
    const reading = it.dossier.read('/')
    await flush()
    const writing = it.dossier.write('board.json', { b: 2 })
    await flush()
    const [read] = it.requests('read')
    const [write] = it.requests('write')
    await it.answer(write!.id, wire('questions/board.json', { b: 2 }))
    await writing
    // The late list predates the write: the file is missing from it.
    await it.answer(read!.id, [wire('plan.json', { p: 1 })])
    const docs = (await reading) as Doc[]
    expect(docs.map((doc) => [doc.path, doc.data])).toEqual([
      ['../plan.json', { p: 1 }],
      ['board.json', { b: 2 }],
    ])
    // And a read of the file now answered by the peer is taken as it is.
    const again = it.dossier.read('board.json')
    await flush()
    await it.answer(
      it.requests('read').at(-1)!.id,
      wire('questions/board.json', { b: 2, x: 1 }),
    )
    await expect(again).resolves.toMatchObject({ data: { b: 2, x: 1 } })
  })

  test('a read sent after the ack is taken as it is', async () => {
    const it = open()
    const writing = it.dossier.write('board.json', { b: 2 })
    await flush()
    await it.answer(
      it.requests('write')[0]!.id,
      wire('questions/board.json', { b: 2 }),
    )
    await writing
    const reading = it.dossier.read('board.json')
    await flush()
    // Someone withdrew it since.
    await it.answer(it.requests('read')[0]!.id, null)
    await expect(reading).resolves.toBeNull()
  })
})

describe('errors', () => {
  test('each of the ten codes reaches page code as a DossierError with fix and path', async () => {
    const it = open()
    for (const code of PAGE_ERROR_CODES) {
      const writing = it.dossier.write('board.json', { a: 1 })
      await flush()
      const request = it.requests('write').at(-1)!
      await it.fail(
        request.id,
        code,
        `The ${code} answer.`,
        `Fix ${code}.`,
        'a',
      )
      const error = await writing.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DossierError)
      expect(error).toMatchObject({
        code,
        message: `The ${code} answer.`,
        fix: `Fix ${code}.`,
        path: 'a',
      })
    }
  })

  test('an answer that names no fix or path gets the code’s fix and the call’s path', async () => {
    const it = open()
    for (const code of PAGE_ERROR_CODES) {
      const writing = it.dossier.write('../plan.json', { a: 1 })
      await flush()
      await it.fail(it.requests('write').at(-1)!.id, code)
      await expect(writing).rejects.toMatchObject({
        code,
        fix: FIXES[code],
        path: '../plan.json',
      })
    }
  })

  test('any other server code arrives as unavailable with its message', async () => {
    const it = open()
    for (const code of ['conflict', 'stale_head', 'form_changed'] as const) {
      const writing = it.dossier.write('board.json', { a: 1 })
      await flush()
      await it.fail(it.requests('write').at(-1)!.id, code, `Odd ${code}.`)
      await expect(writing).rejects.toMatchObject({
        code: 'unavailable',
        message: `Odd ${code}.`,
        fix: FIXES.unavailable,
      })
    }
  })

  test('not_found: a write is forbidden and a withdrawal is done', async () => {
    const it = open()
    const writing = it.dossier.write('board.json', { a: 1 })
    const withdrawing = it.dossier.withdraw('answers/~.json')
    await flush()
    await it.fail(it.requests('write')[0]!.id, 'not_found')
    const [withdraw] = it.requests('withdraw')
    expect(withdraw).toMatchObject({
      path: '/questions/answers/sara@acme.com.json',
      opId: expect.any(String),
    })
    await it.fail(withdraw!.id, 'not_found')
    await expect(writing).rejects.toMatchObject({ code: 'forbidden' })
    await expect(withdrawing).resolves.toBeUndefined()
  })
})

describe('upload', () => {
  test('sends the file with its name, type, an op ID and the seq, and answers its place', async () => {
    const it = open()
    const file = new File(['%PDF-1'], 'cv.pdf', { type: 'application/pdf' })
    const uploading = it.dossier.upload(file)
    await flush()
    const [request] = it.requests('upload')
    expect(request).toMatchObject({
      name: 'cv.pdf',
      contentType: 'application/pdf',
      seq: 9,
      opId: expect.any(String),
    })
    const sent = it.raw.find((m) => (m as Request).op === 'upload') as Request
    expect(sent.file).toBe(file)
    await it.answer(request!.id, {
      path: 'questions/results.uploads/sara@acme.com/cv.pdf',
      file: 'cv.pdf',
      name: 'cv.pdf',
      size: 6,
      type: 'application/pdf',
    })
    await expect(uploading).resolves.toEqual({
      file: 'results.uploads/sara@acme.com/cv.pdf',
      name: 'cv.pdf',
      size: 6,
      type: 'application/pdf',
    })
  })
})

test('a page opened on its own has no shell to ask', async () => {
  const page = openPage({ placement: 'alone' })
  install(page.window)
  const dossier = (page.win as unknown as { dossier: Dossier }).dossier
  await expect(dossier.read('x.json')).rejects.toMatchObject({
    code: 'unavailable',
  })
})
