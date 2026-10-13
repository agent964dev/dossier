// MessagePort.postMessage takes no target origin.
// oxlint-disable unicorn/require-post-message-target-origin
import { DossierError, type DocWire } from '@dossier/contracts/bridge'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { shellApi } from '../src/shell/api.ts'
import {
  PING_INTERVAL,
  POLL_INTERVAL,
  pollingChanges,
  webSocketChanges,
  type ChangeSource,
} from '../src/shell/changes.ts'
import { NO_ANSWER_WAITS, RECLAIM_DELAYS } from '../src/shell/create-shell.ts'
import { MOST_PATHS, RECONNECT_DELAY } from '../src/shell/watch.ts'
import { BOOT, openShell, type FakeConnection } from './fake-page.ts'
import { flush, type FakePort } from './ports.ts'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const wire = (path: string, data: unknown): DocWire =>
  ({
    path,
    data,
    by: 'sara@acme.com',
    at: '2026-10-12T10:00:00.000Z',
    push: 2,
  }) as DocWire

const noAnswer = () =>
  new DossierError({
    code: 'offline',
    message: 'Not sent. Your answers are kept on this device. Try again.',
    fix: null,
    path: null,
  })

const refusal = (code: 'blob_reclaiming' | 'forbidden') =>
  new DossierError({ code, message: `The ${code}.`, fix: null, path: 'x' })

/** A shell with its top page and one nested page said hello. */
const started = async () => {
  const it = openShell()
  await it.shell.start()
  const top = it.page()
  const first = it.hello({ source: top })
  const nested = it.hello({
    source: { parent: top },
    nested: true,
    path: '/plan.html',
  })
  await flush()
  let id = 100
  const ask = async (port: FakePort, request: Record<string, unknown>) => {
    const sent = { type: 'request', id: ++id, ...request }
    port.postMessage(sent)
    await flush()
    return sent.id
  }
  const results = (port: FakePort) =>
    port.inbox.filter((m) => (m as { type: string }).type === 'result') as {
      id: number
      ok: boolean
      value?: unknown
      error?: { code: string }
    }[]
  const changes = (port: FakePort) =>
    port.inbox.filter((m) => (m as { type: string }).type === 'changed') as {
      sub: number
      value: unknown
    }[]
  return {
    ...it,
    top: first.page,
    topShell: first.shell,
    nested: nested.page,
    ask,
    results,
    changed: changes,
  }
}

const live = (connections: readonly FakeConnection[]) =>
  connections.filter((c) => !c.closed)

describe('the watch manager', () => {
  test('one connection per tree for every sub of every page', async () => {
    const it = await started()
    it.read.mockImplementation(async ({ path }) =>
      path.endsWith('/') ? [] : wire(path, { v: 1 }),
    )
    await it.ask(it.top, { op: 'watch', sub: 1, path: 'answers/' })
    await it.ask(it.top, { op: 'watch', sub: 2, path: '/plan.json' })
    await it.ask(it.nested, { op: 'watch', sub: 1, path: 'plan.json' })
    // Each sub gets its value at once, resolved against its own page.
    expect(it.changed(it.top)).toEqual([
      { type: 'changed', sub: 1, value: [] },
      { type: 'changed', sub: 2, value: wire('plan.json', { v: 1 }) },
    ])
    expect(it.changed(it.nested)).toEqual([
      { type: 'changed', sub: 1, value: wire('plan.json', { v: 1 }) },
    ])
    expect(it.results(it.top).map((r) => r.ok)).toEqual([true, true])
    expect(it.changes.connections).toEqual([])
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(it.changes.connections).toHaveLength(1)
    expect(it.changes.connections[0]).toMatchObject({
      tree: 't1',
      paths: ['plan.json', 'questions/answers/'],
    })
    it.shell.dispose()
    expect(it.changes.connections[0]!.closed).toBe(true)
  })

  test('connects again with the new path set 200 ms after it changes', async () => {
    const it = await started()
    await it.ask(it.top, { op: 'watch', sub: 1, path: 'answers/' })
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(live(it.changes.connections)).toHaveLength(1)

    await it.ask(it.nested, { op: 'watch', sub: 7, path: 'notes.json' })
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY - 1)
    expect(it.changes.connections).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(it.changes.connections).toHaveLength(2)
    expect(it.changes.connections[0]!.closed).toBe(true)
    expect(it.changes.connections[1]!.paths).toEqual([
      'notes.json',
      'questions/answers/',
    ])

    // A path already watched changes nothing.
    await it.ask(it.top, { op: 'watch', sub: 2, path: '/notes.json' })
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(it.changes.connections).toHaveLength(2)

    await it.ask(it.top, { op: 'unwatch', sub: 1 })
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(live(it.changes.connections).map((c) => c.paths)).toEqual([
      ['notes.json'],
    ])

    // A new top page closes every port, and their subs go with them.
    it.hello({ source: it.page() })
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(live(it.changes.connections)).toEqual([])
    it.shell.dispose()
  })

  test('more than 50 paths watch the whole tree', async () => {
    const it = await started()
    for (let sub = 1; sub <= MOST_PATHS + 1; sub++) {
      await it.ask(it.top, { op: 'watch', sub, path: `f${sub}.json` })
    }
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(live(it.changes.connections).map((c) => c.paths)).toEqual([['']])
    it.shell.dispose()
  })

  test('fetches events from the opaque cursor after a hint and reads each affected sub once', async () => {
    const it = await started()
    await it.ask(it.top, { op: 'watch', sub: 1, path: 'answers/' })
    await it.ask(it.top, { op: 'watch', sub: 2, path: 'answers/' })
    await it.ask(it.nested, { op: 'watch', sub: 1, path: 'plan.json' })
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    const [connection] = it.changes.connections
    it.read.mockClear()
    const event = (cursor: string, path: string) => ({
      cursor,
      type: 'submission',
      path,
      at: '2026-10-12T10:00:00.000Z',
      by: 'omar@acme.com',
      push: 2,
    })
    it.events.mockResolvedValueOnce({
      events: [
        event('k9', 'questions/answers/omar@acme.com.json'),
        event('b2', 'questions/answers/lena@acme.com.json'),
      ],
      next: 'b2',
      more: true,
    })
    it.events.mockResolvedValueOnce({
      events: [event('a7', 'questions/answers/omar@acme.com.json')],
      next: 'a7',
      more: false,
    })
    const docs = [wire('questions/answers/omar@acme.com.json', 1)]
    it.read.mockResolvedValue(docs)
    connection!.onHint()
    await flush()
    // The grant's cursor first, then each page's next, compared with nothing.
    expect(it.events.mock.calls.map(([i]) => i)).toEqual([
      { tree: 't1', after: 'c40' },
      { tree: 't1', after: 'b2' },
    ])
    // One read for the folder both subs watch; plan.json is not touched.
    expect(it.read.mock.calls).toEqual([
      [{ tree: 't1', path: 'questions/answers/' }],
    ])
    expect(it.changed(it.top).slice(-2)).toEqual([
      { type: 'changed', sub: 1, value: docs },
      { type: 'changed', sub: 2, value: docs },
    ])
    expect(it.changed(it.nested)).toHaveLength(1)

    // A hint with nothing new reads nothing and keeps the cursor.
    connection!.onHint()
    await flush()
    expect(it.events.mock.calls.at(-1)![0]).toEqual({ tree: 't1', after: 'a7' })
    expect(it.read).toHaveBeenCalledTimes(1)
    // A push of a folder above the file reaches it.
    it.events.mockResolvedValueOnce({
      events: [event('z1', '')],
      next: 'z1',
      more: false,
    })
    connection!.onHint()
    await flush()
    expect(it.events.mock.calls.at(-1)![0]).toEqual({ tree: 't1', after: 'a7' })
    expect(it.read).toHaveBeenCalledTimes(3)
    connection!.onHint()
    await flush()
    expect(it.events.mock.calls.at(-1)![0]).toEqual({ tree: 't1', after: 'z1' })
    it.shell.dispose()
  })

  test('after a reconnect, one fetch from the cursor, then every sub reads once', async () => {
    const it = await started()
    await it.ask(it.top, { op: 'watch', sub: 1, path: 'answers/' })
    await it.ask(it.nested, { op: 'watch', sub: 1, path: 'plan.json' })
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    const [connection] = it.changes.connections
    it.read.mockClear()
    connection!.onState('live')
    connection!.onHint()
    await flush()
    expect(it.events.mock.calls.map(([i]) => i)).toEqual([
      { tree: 't1', after: 'c40' },
    ])
    expect(it.read.mock.calls.map(([i]) => i.path).sort()).toEqual([
      'plan.json',
      'questions/answers/',
    ])
    expect(it.changed(it.top)).toHaveLength(2)
    expect(it.changed(it.nested)).toHaveLength(2)

    // A poll after that reads only what changed: nothing here.
    it.read.mockClear()
    connection!.onHint()
    await flush()
    expect(it.events).toHaveBeenCalledTimes(2)
    expect(it.read).not.toHaveBeenCalled()
    it.shell.dispose()
  })
})

describe('a nested page that goes away', () => {
  test('a new hello from the same frame drops the old page’s watches', async () => {
    const it = openShell()
    await it.shell.start()
    const top = it.page()
    it.hello({ source: top })
    const frame = { parent: top }
    const first = it.hello({ source: frame, nested: true, path: '/plan.html' })
    await flush()
    first.page.postMessage({
      type: 'request',
      id: 1,
      op: 'watch',
      sub: 1,
      path: 'plan.json',
    })
    await flush()
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(live(it.changes.connections).map((c) => c.paths)).toEqual([
      ['plan.json'],
    ])
    // The frame navigated: its next page says hello from the same window.
    const second = it.hello({
      source: frame,
      nested: true,
      path: '/notes.html',
    })
    await flush()
    expect(first.shell.closed).toBe(true)
    expect(second.shell.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(live(it.changes.connections)).toEqual([])
    it.shell.dispose()
  })

  test('a port that reports it closed drops its watches', async () => {
    const it = openShell()
    await it.shell.start()
    const top = it.page()
    it.hello({ source: top })
    const nested = it.hello({
      source: { parent: top },
      nested: true,
      path: '/plan.html',
    })
    await flush()
    nested.page.postMessage({
      type: 'request',
      id: 1,
      op: 'watch',
      sub: 1,
      path: 'plan.json',
    })
    await flush()
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(live(it.changes.connections)).toHaveLength(1)
    nested.shell.dispatchEvent(new Event('close'))
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(live(it.changes.connections)).toEqual([])
    it.shell.dispose()
  })
})

describe('reads that cross a write', () => {
  /** A read the test answers when it chooses. */
  const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  test('a watch read sent before a write’s ack is read again, never sent stale', async () => {
    const it = await started()
    it.read.mockResolvedValueOnce(wire('questions/board.json', { a: 1 }))
    await it.ask(it.top, { op: 'watch', sub: 1, path: 'board.json' })
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    const [connection] = it.changes.connections
    const late = deferred<DocWire>()
    it.read.mockReturnValueOnce(late.promise)
    it.read.mockResolvedValueOnce(wire('questions/board.json', { a: 1, b: 2 }))
    it.events.mockResolvedValueOnce({
      events: [
        {
          cursor: 'e1',
          type: 'data_write',
          path: 'questions/board.json',
          at: '2026-10-12T10:00:00.000Z',
          by: 'omar@acme.com',
          push: null,
        },
      ],
      next: 'e1',
      more: false,
    })
    connection!.onHint()
    await flush()
    expect(it.read).toHaveBeenCalledTimes(2)
    // The page's write is answered while that read is out.
    it.write.mockResolvedValueOnce(wire('questions/board.json', { a: 1, b: 2 }))
    const id = await it.ask(it.top, {
      op: 'write',
      path: 'board.json',
      patch: { b: 2 },
      replace: false,
      opId: 'w',
      seq: 7,
    })
    await flush()
    expect(it.results(it.top).at(-1)).toMatchObject({ id, ok: true })
    late.resolve(wire('questions/board.json', { a: 1 }))
    await flush()
    // The stale value never reaches the page; a fresh read does.
    expect(it.read).toHaveBeenCalledTimes(3)
    const after = it.top.inbox.slice(
      it.top.inbox.findIndex(
        (m) => (m as { type: string; id?: number }).id === id,
      ),
    )
    expect(
      after.filter((m) => (m as { type: string }).type === 'changed'),
    ).toEqual([
      {
        type: 'changed',
        sub: 1,
        value: wire('questions/board.json', { a: 1, b: 2 }),
      },
    ])
    it.shell.dispose()
  })

  test('a folder watch read is fenced by a write below it', async () => {
    const it = await started()
    it.read.mockResolvedValueOnce([])
    await it.ask(it.top, { op: 'watch', sub: 1, path: 'ideas/' })
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    const [connection] = it.changes.connections
    const late = deferred<DocWire[]>()
    it.read.mockReturnValueOnce(late.promise)
    const entry = wire('questions/ideas/sara@acme.com/1.json', { idea: 'x' })
    it.read.mockResolvedValueOnce([entry])
    connection!.onState('live')
    connection!.onHint()
    await flush()
    it.write.mockResolvedValueOnce(entry)
    await it.ask(it.top, {
      op: 'write',
      path: 'ideas/~/',
      patch: { idea: 'x' },
      replace: false,
      opId: 'w',
      seq: 7,
    })
    await flush()
    late.resolve([])
    await flush()
    expect(it.changed(it.top).map((m) => m.value)).toEqual([[], [entry]])
    it.shell.dispose()
  })
})

describe('page code’s requests', () => {
  test('a write goes to the API resolved against its page, with its op ID and seq', async () => {
    const it = await started()
    const id = await it.ask(it.nested, {
      op: 'write',
      path: 'ideas/~/',
      patch: { idea: 'x' },
      replace: false,
      opId: 'op-w',
      seq: 9,
    })
    await flush()
    expect(it.write).toHaveBeenCalledWith({
      tree: 't1',
      page: 'plan.html',
      path: 'ideas/sara@acme.com/',
      patch: { idea: 'x' },
      replace: false,
      opId: 'op-w',
      seq: 9,
      as: 'sara@acme.com',
    })
    expect(it.results(it.nested).at(-1)).toMatchObject({ id, ok: true })
    const refused = await it.ask(it.nested, {
      op: 'write',
      path: '../x.json',
      patch: {},
      replace: false,
      opId: 'op-x',
      seq: 9,
    })
    expect(it.results(it.nested).at(-1)).toMatchObject({
      id: refused,
      ok: false,
      error: { code: 'forbidden', path: '../x.json' },
    })
    expect(it.write).toHaveBeenCalledTimes(1)
    it.shell.dispose()
  })

  test('a visitor’s write and withdrawal say so with as null', async () => {
    const it = openShell({ boot: { ...BOOT, me: null } })
    await it.shell.start()
    const { page } = it.hello({ source: it.page() })
    await flush()
    page.postMessage({
      type: 'request',
      id: 1,
      op: 'write',
      path: 'board.json',
      patch: { a: 1 },
      replace: false,
      opId: 'w',
      seq: 7,
    })
    page.postMessage({
      type: 'request',
      id: 2,
      op: 'withdraw',
      path: 'board.json',
      opId: 'd',
    })
    await flush()
    expect(it.write.mock.calls[0]![0].as).toBeNull()
    expect(it.withdraw.mock.calls[0]![0].as).toBeNull()
    it.shell.dispose()
  })

  test('a nested page the deployment does not confirm is never answered', async () => {
    const it = openShell()
    await it.shell.start()
    const top = it.page()
    it.hello({ source: top })
    it.confirm.mockResolvedValueOnce({
      path: 'other.html',
      email: 'sara@acme.com',
    })
    const nested = it.hello({
      source: { parent: top },
      nested: true,
      path: '/plan.html',
    })
    await flush()
    expect(it.confirm).toHaveBeenCalledWith({ tree: 't1', page: 'plan.html' })
    expect(nested.shell.closed).toBe(true)
    for (const [id, request] of [
      { op: 'read', path: 'x.json' },
      { op: 'watch', sub: 1, path: 'x.json' },
      {
        op: 'write',
        path: 'x.json',
        patch: {},
        replace: false,
        opId: 'w',
        seq: 7,
      },
    ].entries()) {
      nested.page.postMessage({ type: 'request', id, ...request })
    }
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(it.read).not.toHaveBeenCalled()
    expect(it.write).not.toHaveBeenCalled()
    expect(it.changes.connections).toEqual([])
    expect(nested.page.inbox).toEqual([])
    it.shell.dispose()
  })

  test('retries a request without an answer with the same op ID, then answers unavailable', async () => {
    const it = await started()
    it.write.mockRejectedValueOnce(noAnswer())
    it.write.mockRejectedValueOnce(noAnswer())
    const id = await it.ask(it.top, {
      op: 'write',
      path: 'board.json',
      patch: { a: 1 },
      replace: false,
      opId: 'op-1',
      seq: 7,
    })
    expect(it.write).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(NO_ANSWER_WAITS[0]!)
    expect(it.write).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(NO_ANSWER_WAITS[1]!)
    expect(it.write).toHaveBeenCalledTimes(3)
    await flush()
    expect(it.write.mock.calls.map(([i]) => i.opId)).toEqual([
      'op-1',
      'op-1',
      'op-1',
    ])
    expect(it.results(it.top).at(-1)).toMatchObject({ id, ok: true })

    it.write.mockClear()
    it.write.mockRejectedValue(noAnswer())
    const lost = await it.ask(it.top, {
      op: 'write',
      path: 'board.json',
      patch: { a: 2 },
      replace: false,
      opId: 'op-2',
      seq: 7,
    })
    await vi.advanceTimersByTimeAsync(1000 + 3000 + 9000)
    await flush()
    expect(it.write).toHaveBeenCalledTimes(4)
    expect(it.results(it.top).at(-1)).toMatchObject({
      id: lost,
      ok: false,
      error: { code: 'unavailable' },
    })
    it.shell.dispose()
  })

  test('rejects with offline only when the browser is offline', async () => {
    const it = await started()
    const online = vi.spyOn(it.win.navigator, 'onLine', 'get')
    online.mockReturnValue(false)
    for (const request of [
      { op: 'read', path: 'plan.json' },
      {
        op: 'write',
        path: 'board.json',
        patch: {},
        replace: false,
        opId: 'w',
        seq: 7,
      },
      { op: 'withdraw', path: 'answers/~.json', opId: 'd' },
      {
        op: 'upload',
        file: new File(['x'], 'a.txt'),
        name: 'a.txt',
        contentType: 'text/plain',
        opId: 'u',
        seq: 7,
      },
    ]) {
      const id = await it.ask(it.top, request)
      expect(it.results(it.top).at(-1)).toMatchObject({
        id,
        ok: false,
        error: { code: 'offline' },
      })
    }
    expect(it.read).not.toHaveBeenCalled()
    expect(it.write).not.toHaveBeenCalled()
    expect(it.withdraw).not.toHaveBeenCalled()
    expect(it.upload).not.toHaveBeenCalled()

    // Online, a request that never gets an answer is unavailable, not offline.
    online.mockReturnValue(true)
    it.read.mockRejectedValue(noAnswer())
    const id = await it.ask(it.top, { op: 'read', path: 'plan.json' })
    await vi.advanceTimersByTimeAsync(13_000)
    await flush()
    expect(it.results(it.top).at(-1)).toMatchObject({
      id,
      error: { code: 'unavailable' },
    })
    it.shell.dispose()
  })

  test('tries again after 0.5, 2 and 5 s while a purge holds the blob, as sends do', async () => {
    const it = await started()
    it.upload.mockRejectedValue(refusal('blob_reclaiming'))
    const timers = vi.spyOn(it.win, 'setTimeout')
    const id = await it.ask(it.top, {
      op: 'upload',
      file: new File(['x'], 'a.txt'),
      name: 'a.txt',
      contentType: 'text/plain',
      opId: 'u',
      seq: 7,
    })
    // The hash takes real time before the first try.
    await vi.waitFor(() => expect(it.upload).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(500 + 2000 + 5000)
    await flush()
    expect(it.upload).toHaveBeenCalledTimes(4)
    // The waits between tries are the sends' own.
    const waits = timers.mock.calls.map(([, ms]) => ms)
    expect(waits.filter((ms) => RECLAIM_DELAYS.includes(ms ?? -1))).toEqual([
      ...RECLAIM_DELAYS,
    ])
    expect(it.results(it.top).at(-1)).toMatchObject({
      id,
      error: { code: 'unavailable' },
    })
    // Other answers pass as they are.
    it.write.mockRejectedValueOnce(refusal('forbidden'))
    await it.ask(it.top, {
      op: 'write',
      path: 'board.json',
      patch: {},
      replace: false,
      opId: 'w',
      seq: 7,
    })
    await flush()
    expect(it.results(it.top).at(-1)).toMatchObject({
      error: { code: 'forbidden', path: 'x' },
    })
    expect(it.write).toHaveBeenCalledTimes(1)
    it.shell.dispose()
  })

  test('an upload goes without form params, with its hash, and answers the stored place', async () => {
    const it = await started()
    it.upload.mockResolvedValueOnce({
      path: 'questions/index.uploads/sara@acme.com/cv.pdf',
      file: 'cv.pdf',
      name: 'cv.pdf',
      size: 6,
      type: 'application/pdf',
    })
    const file = new File(['%PDF-1'], 'cv.pdf', { type: 'application/pdf' })
    const id = await it.ask(it.top, {
      op: 'upload',
      file,
      name: 'cv.pdf',
      contentType: 'application/pdf',
      opId: 'op-u',
      seq: 7,
    })
    await vi.waitFor(() => expect(it.upload).toHaveBeenCalled())
    const [params] = it.upload.mock.calls[0]!
    expect({ ...params, body: undefined }).toEqual({
      tree: 't1',
      page: 'questions/index.html',
      seq: 7,
      name: 'cv.pdf',
      type: 'application/pdf',
      size: 6,
      sha256: createHash('sha256').update('%PDF-1').digest('hex'),
      opId: 'op-u',
      as: 'sara@acme.com',
      body: undefined,
    })
    await vi.waitFor(() =>
      expect(it.results(it.top).at(-1)).toMatchObject({
        id,
        ok: true,
        value: { path: 'questions/index.uploads/sara@acme.com/cv.pdf' },
      }),
    )
    it.shell.dispose()
  })
})

/** A WebSocket stand-in the tests open, message and close. */
class FakeSocket extends EventTarget {
  static made: FakeSocket[] = []
  readonly sent: string[] = []
  closed = false
  constructor(readonly url: string) {
    super()
    FakeSocket.made.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.dispatchEvent(new Event('open'))
  }
  message(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
  drop(): void {
    this.dispatchEvent(new Event('error'))
    this.dispatchEvent(new Event('close'))
  }
}

const socketWindow = () =>
  ({
    WebSocket: FakeSocket,
    setTimeout: (run: () => void, ms?: number) =>
      globalThis.setTimeout(run, ms),
    clearTimeout: (id?: number) => globalThis.clearTimeout(id),
    setInterval: (run: () => void, ms?: number) =>
      globalThis.setInterval(run, ms),
    clearInterval: (id?: number) => globalThis.clearInterval(id),
  }) as unknown as Window

const recorder = () => {
  const log: string[] = []
  return {
    log,
    input: {
      tree: 't1',
      paths: ['questions/answers/', 'plan.json'],
      onHint: () => log.push('hint'),
      onState: (state: 'live' | 'polling') => log.push(state),
    },
  }
}

describe('change sources', () => {
  beforeEach(() => {
    FakeSocket.made = []
  })

  test('polling hints at once and every 10 seconds until closed', async () => {
    const { log, input } = recorder()
    const connection = pollingChanges(socketWindow()).connect(input)
    expect(log).toEqual(['polling', 'hint'])
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 2)
    expect(log).toEqual(['polling', 'hint', 'hint', 'hint'])
    connection.close()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 2)
    expect(log).toHaveLength(4)
  })

  test('the socket hints, pings, falls back to polling on close and returns when it opens', async () => {
    const { log, input } = recorder()
    const fallback: { closed: number; made: number } = { closed: 0, made: 0 }
    const polling: ChangeSource = {
      connect: (i) => {
        fallback.made += 1
        i.onState('polling')
        return { close: () => void (fallback.closed += 1) }
      },
    }
    const connection = webSocketChanges(
      socketWindow(),
      'https://main.test',
      polling,
    ).connect(input)
    expect(FakeSocket.made.map((s) => s.url)).toEqual([
      'wss://main.test/_/api/watch?tree=t1&path=questions%2Fanswers%2F&path=plan.json',
    ])
    const [first] = FakeSocket.made
    first!.open()
    expect(log).toEqual(['live', 'hint'])
    // A hint names the tree and the sub, and no sequence.
    first!.message(JSON.stringify({ type: 'changed', tree: 't1', sub: 1 }))
    first!.message('pong')
    first!.message('nonsense')
    first!.message(JSON.stringify({ type: 'other', tree: 't1' }))
    expect(log).toEqual(['live', 'hint', 'hint'])
    await vi.advanceTimersByTimeAsync(PING_INTERVAL)
    expect(first!.sent).toEqual(['ping'])

    first!.drop()
    expect(fallback.made).toBe(1)
    expect(log.at(-1)).toBe('polling')
    // Tried again after 1 s, then 2 s, then 4 s.
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeSocket.made).toHaveLength(2)
    FakeSocket.made[1]!.drop()
    await vi.advanceTimersByTimeAsync(1999)
    expect(FakeSocket.made).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeSocket.made).toHaveLength(3)
    FakeSocket.made[2]!.drop()
    await vi.advanceTimersByTimeAsync(4000)
    expect(FakeSocket.made).toHaveLength(4)
    // Polling ran the whole time, made once.
    expect(fallback.made).toBe(1)
    expect(fallback.closed).toBe(0)

    FakeSocket.made[3]!.open()
    expect(fallback.closed).toBe(1)
    expect(log.slice(-2)).toEqual(['live', 'hint'])

    connection.close()
    expect(FakeSocket.made[3]!.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(FakeSocket.made).toHaveLength(4)
    expect(FakeSocket.made[3]!.sent).toEqual([])
  })

  test('the wait between tries stops growing at a minute', async () => {
    const { input } = recorder()
    webSocketChanges(
      socketWindow(),
      'http://localhost:8787',
      pollingChanges(socketWindow()),
    ).connect(input)
    expect(FakeSocket.made[0]!.url.startsWith('ws://localhost:8787/')).toBe(
      true,
    )
    for (const wait of [1, 2, 4, 8, 16, 32, 60, 60]) {
      FakeSocket.made.at(-1)!.drop()
      const before = FakeSocket.made.length
      await vi.advanceTimersByTimeAsync(wait * 1000 - 1)
      expect(FakeSocket.made).toHaveLength(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeSocket.made).toHaveLength(before + 1)
    }
  })
})

describe('shellApi write and events', () => {
  const answer = (status: number, body: unknown) => {
    const spy = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify(body), { status }),
    )
    return Object.assign(spy as unknown as typeof fetch, { spy })
  }

  test('write posts JSON with the CSRF header and answers the Doc', async () => {
    const doc = wire('board.json', { a: 1 })
    const fetch = answer(200, doc)
    const payload = {
      tree: 't1',
      page: 'board.html',
      path: 'board.json',
      patch: { a: 1 },
      replace: false,
      opId: 'op-1',
      seq: 7,
      as: 'sara@acme.com',
    }
    await expect(
      shellApi(fetch, 'https://main.test').write(payload),
    ).resolves.toEqual(doc)
    const [url, init] = fetch.spy.mock.calls[0]!
    expect(url).toBe('https://main.test/_/api/data/write')
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'Dossier-CSRF': '1' },
    })
    expect(JSON.parse(String(init?.body))).toEqual(payload)
    const refused = await shellApi(
      answer(422, {
        error: {
          code: 'not_mergeable',
          message: 'Not an object.',
          fix: null,
          path: 'board.json',
        },
      }),
      'https://main.test',
    )
      .write(payload)
      .catch((e: unknown) => e)
    expect(refused).toMatchObject({ code: 'not_mergeable', path: 'board.json' })
  })

  test('events asks after the cursor and reads the page of events', async () => {
    const body = {
      events: [
        {
          cursor: 'q1',
          type: 'submission',
          path: 'answers/sara@acme.com.json',
          at: '2026-10-12T10:00:00.000Z',
          by: 'sara@acme.com',
          push: null,
        },
      ],
      next: 'q1',
      more: false,
    }
    const fetch = answer(200, body)
    await expect(
      shellApi(fetch, 'https://main.test').events({
        tree: 't1',
        after: 'p+0/9=',
      }),
    ).resolves.toEqual(body)
    expect(fetch.spy.mock.calls[0]![0]).toBe(
      'https://main.test/_/api/events?tree=t1&after=p%2B0%2F9%3D',
    )
    const odd = await shellApi(
      answer(200, { events: 'x' }),
      'https://main.test',
    )
      .events({ tree: 't1', after: 'q1' })
      .catch((e: unknown) => e)
    expect(odd).toMatchObject({ code: 'unavailable' })
  })

  test('a view grant carries the event cursor', async () => {
    const grant = {
      handle: 'h1',
      expiresAt: '2026-10-12T03:00:00.000Z',
      seq: 7,
      role: 'read',
      path: 'questions/index.html',
      email: 'sara@acme.com',
      events: 'v1.opaque',
    }
    await expect(
      shellApi(answer(200, grant), 'https://main.test').view({
        tree: 't1',
        path: 'questions/',
      }),
    ).resolves.toEqual(grant)
  })
})
