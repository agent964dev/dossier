import { PROTOCOL, PROTOCOL_HEADER } from '@dossier/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  errorResponse,
  type Harness,
  harness,
  type SeenRequest,
  stubFetch,
} from '../test-support.ts'
import { PING_MS } from '../watch.ts'

const ENV = { DOSSIER_DEPLOYMENT: 'dossier.acme.com', DOSSIER_KEY: 'dsk_one' }

const SUBMISSION = {
  seq: 8,
  type: 'submission',
  path: 'questions/answers/sara@acme.com.json',
  at: '2026-10-12T14:20:31.000Z',
  by: 'sara@acme.com',
  push: 3,
} as const

const PUSH = {
  seq: 9,
  type: 'push',
  path: 'questions/index.html',
  at: '2026-10-12T14:25:02.000Z',
  by: null,
  push: 4,
} as const

const SUBMISSION_LINE =
  '2026-10-12 14:20  submission  questions/answers/sara@acme.com.json  sara@acme.com'
const PUSH_LINE = '2026-10-12 14:25  push  questions/index.html'

type Event = typeof SUBMISSION | typeof PUSH

/** What happened, in order: event fetches, sockets made and waits. */
let log: string[] = []

/**
 * The events route: without `after` it answers the tree's current sequence;
 * with it, the events after it. `answer` lets a test refuse a call.
 */
const eventsRoute = (feed: {
  readonly events: Event[]
  readonly start: number
  answer?: (call: number) => Response | null
}) => {
  let calls = 0
  return (request: SeenRequest): Response => {
    if (request.url.pathname !== '/_/api/events') {
      return new Response(null, { status: 500 })
    }
    calls += 1
    log.push('events')
    const refused = feed.answer?.(calls) ?? null
    if (refused !== null) return refused
    const after = request.url.searchParams.get('after')
    if (after === null) {
      return Response.json({ events: [], next: feed.start, more: false })
    }
    const events = feed.events.filter((e) => e.seq > Number(after))
    const next = Math.max(Number(after), ...events.map((e) => e.seq))
    return Response.json({ events, next, more: false })
  }
}

/** A WebSocket the test drives: it opens, hints, fails or refuses. */
const fakeSockets = (behaviour: 'wait' | 'refuse') => {
  const made: FakeSocket[] = []
  class FakeSocket extends EventTarget {
    readonly sent: string[] = []
    closed = false
    constructor(
      readonly url: string,
      readonly init: { readonly headers: Record<string, string> },
    ) {
      super()
      made.push(this)
      log.push('socket')
      // A refused upgrade shows only as an error, then a close.
      if (behaviour === 'refuse') setTimeout(() => this.fail(), 0)
    }
    send(data: string) {
      this.sent.push(data)
    }
    close() {
      this.closed = true
    }
    open() {
      this.dispatchEvent(new Event('open'))
    }
    hint(seq: number) {
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'changed', tree: 'tre1', seq, sub: 0 }),
        }),
      )
    }
    fail() {
      this.dispatchEvent(new Event('error'))
      this.dispatchEvent(new Event('close'))
    }
  }
  return {
    WebSocket: FakeSocket as unknown as typeof globalThis.WebSocket,
    made,
  }
}

/**
 * Waits as the harness records them: each settles on the next turn, except
 * the keepalive's, which waits for `ping()` or the end of the watch.
 */
const clock = () => {
  const pending: (() => void)[] = []
  return {
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        log.push(`sleep ${ms}`)
        if (ms !== PING_MS) return void setTimeout(resolve, 0)
        pending.push(resolve)
        signal?.addEventListener('abort', () => resolve(), { once: true })
      }),
    ping: () => pending.shift()?.(),
  }
}

let current: Harness | undefined
let requests: SeenRequest[] = []
let stopWatch: (() => void) | undefined

const setUp = async (options: {
  readonly route: (request: SeenRequest) => Response
  readonly webSocket?: typeof globalThis.WebSocket
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}) => {
  const fetch = stubFetch(options.route)
  requests = fetch.requests
  current = await harness({
    fetch: fetch.fetch,
    env: ENV,
    sleep: options.sleep ?? clock().sleep,
    ...(options.webSocket === undefined
      ? {}
      : { webSocket: options.webSocket }),
    onInterrupt: (stop) => {
      stopWatch = stop
      return () => {
        stopWatch = undefined
      }
    },
  })
  return current
}

afterEach(async () => {
  await current?.cleanup()
  current = undefined
  stopWatch = undefined
  log = []
})

describe('dossier watch', () => {
  it('sends the key only in the Authorization header, and exits 0 after the first event with --next', async () => {
    const feed = { events: [] as Event[], start: 7 }
    const sockets = fakeSockets('wait')
    const cli = await setUp({
      route: eventsRoute(feed),
      webSocket: sockets.WebSocket,
    })

    const exit = cli.run([
      'watch',
      'agent964/live/questions/answers/',
      '--next',
    ])
    await vi.waitFor(() => expect(sockets.made).toHaveLength(1))
    const socket = sockets.made[0]!
    expect(socket.url).toBe(
      'wss://dossier.acme.com/_/api/watch?tree=agent964%2Flive&path=questions%2Fanswers%2F',
    )
    expect(socket.url).not.toContain('dsk_one')
    expect(socket.init.headers).toEqual({
      Authorization: 'Bearer dsk_one',
      [PROTOCOL_HEADER]: String(PROTOCOL),
      'user-agent': expect.stringMatching(/^dossier\//),
    })

    socket.open()
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    feed.events.push(SUBMISSION, PUSH)
    socket.hint(9)

    expect(await exit).toBe(0)
    expect(cli.stdout()).toBe(`${SUBMISSION_LINE}\n`)
    expect(socket.closed).toBe(true)
    expect(requests.map((r) => r.url.search)).toEqual([
      '?tree=agent964%2Flive&path=questions%2Fanswers%2F',
      '?tree=agent964%2Flive&after=7&path=questions%2Fanswers%2F',
      '?tree=agent964%2Flive&after=7&path=questions%2Fanswers%2F',
    ])
    for (const request of requests) {
      expect(request.url.href).not.toContain('dsk_one')
      expect(request.headers.get('authorization')).toBe('Bearer dsk_one')
    }
  })

  it('prints one line per event until Ctrl-C, then exits 0', async () => {
    const feed = { events: [] as Event[], start: 7 }
    const sockets = fakeSockets('wait')
    const cli = await setUp({
      route: eventsRoute(feed),
      webSocket: sockets.WebSocket,
    })

    const exit = cli.run(['watch', 'agent964/live'])
    await vi.waitFor(() => expect(sockets.made).toHaveLength(1))
    const socket = sockets.made[0]!
    expect(socket.url).toBe(
      'wss://dossier.acme.com/_/api/watch?tree=agent964%2Flive',
    )
    socket.open()
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    feed.events.push(SUBMISSION)
    socket.hint(8)
    await vi.waitFor(() => expect(cli.stdout()).toBe(`${SUBMISSION_LINE}\n`))
    feed.events.push(PUSH)
    socket.hint(9)
    // A hint at or before the cursor fetches nothing.
    socket.hint(9)
    await vi.waitFor(() =>
      expect(cli.stdout()).toBe(`${SUBMISSION_LINE}\n${PUSH_LINE}\n`),
    )

    stopWatch?.()
    expect(await exit).toBe(0)
    expect(socket.closed).toBe(true)
    expect(log.filter((entry) => entry === 'events')).toHaveLength(4)
    expect(cli.stderr()).toContain('Ctrl-C stops')
  })

  it('prints one JSON object per line with its link with --json', async () => {
    const feed = { events: [] as Event[], start: 7 }
    const sockets = fakeSockets('wait')
    const cli = await setUp({
      route: eventsRoute(feed),
      webSocket: sockets.WebSocket,
    })

    const exit = cli.run(['watch', 'agent964/live/questions/', '--json'])
    await vi.waitFor(() => expect(sockets.made).toHaveLength(1))
    sockets.made[0]!.open()
    feed.events.push(SUBMISSION, PUSH)
    sockets.made[0]!.hint(9)
    await vi.waitFor(() =>
      expect(cli.stdout().split('\n').filter(Boolean)).toHaveLength(2),
    )
    stopWatch?.()
    expect(await exit).toBe(0)

    const lines = cli.stdout().split('\n')
    expect(lines.pop()).toBe('')
    expect(lines.map((text) => JSON.parse(text))).toEqual([
      {
        ...SUBMISSION,
        link: 'https://dossier.acme.com/agent964/live/questions/answers/sara%40acme.com.json',
      },
      { ...PUSH, link: 'https://dossier.acme.com/agent964/live/questions/' },
    ])
    expect(cli.stderr()).toBe('')
  })

  it('pings an open connection every 30 seconds', async () => {
    const feed = { events: [] as Event[], start: 7 }
    const sockets = fakeSockets('wait')
    const time = clock()
    const cli = await setUp({
      route: eventsRoute(feed),
      webSocket: sockets.WebSocket,
      sleep: time.sleep,
    })

    const exit = cli.run(['watch', 'agent964/live'])
    await vi.waitFor(() => expect(sockets.made).toHaveLength(1))
    const socket = sockets.made[0]!
    socket.open()
    await vi.waitFor(() => expect(log).toContain(`sleep ${PING_MS}`))
    expect(socket.sent).toEqual([])
    time.ping()
    await vi.waitFor(() => expect(socket.sent).toEqual(['ping']))
    time.ping()
    await vi.waitFor(() => expect(socket.sent).toEqual(['ping', 'ping']))
    stopWatch?.()
    expect(await exit).toBe(0)
  })

  it('fetches what it missed when an open connection drops, then opens another', async () => {
    const feed = { events: [] as Event[], start: 7 }
    const sockets = fakeSockets('wait')
    const cli = await setUp({
      route: eventsRoute(feed),
      webSocket: sockets.WebSocket,
    })

    const exit = cli.run(['watch', 'agent964/live'])
    await vi.waitFor(() => expect(sockets.made).toHaveLength(1))
    sockets.made[0]!.open()
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    feed.events.push(SUBMISSION)
    sockets.made[0]!.fail()
    await vi.waitFor(() => expect(sockets.made).toHaveLength(2))
    expect(cli.stdout()).toBe(`${SUBMISSION_LINE}\n`)
    expect(log.filter((entry) => entry !== `sleep ${PING_MS}`)).toEqual([
      'events',
      'socket',
      'events',
      'events',
      'sleep 1000',
      'socket',
    ])
    stopWatch?.()
    expect(await exit).toBe(0)
  })

  it('falls back to polling every 10 seconds when the socket fails, trying it again with backoff', async () => {
    const feed = {
      events: [] as Event[],
      start: 7,
      answer: (call: number) => {
        if (call === 9) feed.events.push(SUBMISSION)
        return null
      },
    }
    const sockets = fakeSockets('refuse')
    const cli = await setUp({
      route: eventsRoute(feed),
      webSocket: sockets.WebSocket,
    })

    expect(await cli.run(['watch', 'agent964/live', '--next'])).toBe(0)
    expect(cli.stdout()).toBe(`${SUBMISSION_LINE}\n`)
    expect(log).toEqual([
      'events',
      'socket',
      'events',
      'sleep 1000',
      'socket',
      'events',
      'sleep 2000',
      'socket',
      'events',
      'sleep 4000',
      'socket',
      'events',
      'sleep 8000',
      'socket',
      'events',
      'sleep 10000',
      'events',
      'sleep 6000',
      'socket',
      'events',
      'sleep 10000',
      'events',
    ])
  })

  it('polls every 10 seconds where this Node has no WebSocket', async () => {
    const feed = {
      events: [] as Event[],
      start: 7,
      answer: (call: number) => {
        if (call === 3) feed.events.push(SUBMISSION)
        return null
      },
    }
    const cli = await setUp({ route: eventsRoute(feed) })

    expect(await cli.run(['watch', 'agent964/live', '--next'])).toBe(0)
    expect(cli.stdout()).toBe(`${SUBMISSION_LINE}\n`)
    expect(log).toEqual([
      'events',
      'sleep 10000',
      'events',
      'sleep 10000',
      'events',
    ])
  })

  it('exits 3 when the upgrade answers 404, learning it from the events route', async () => {
    const feed = {
      events: [] as Event[],
      start: 7,
      answer: (call: number) =>
        call === 1
          ? null
          : errorResponse(
              'not_found',
              'Nothing is here, or you cannot open it.',
              'Check the path, or ask someone who can open it to share it with you.',
            ),
    }
    const sockets = fakeSockets('refuse')
    const cli = await setUp({
      route: eventsRoute(feed),
      webSocket: sockets.WebSocket,
    })

    expect(await cli.run(['watch', 'agent964/live/nope/'])).toBe(3)
    expect(log).toEqual(['events', 'socket', 'events'])
    expect(cli.stderr()).toContain(
      'dossier: Stopped. live/nope/ was not found, or you cannot open it.\n' +
        'Check the path, or ask someone who can open it to share it with you.\n',
    )
    expect(cli.stdout()).toBe('')
  })

  it('exits 3 before connecting when the path is not found or cannot be read', async () => {
    const sockets = fakeSockets('wait')
    const cli = await setUp({
      route: () => errorResponse('not_found'),
      webSocket: sockets.WebSocket,
    })

    expect(await cli.run(['watch', 'agent964/live/nope/', '--json'])).toBe(3)
    expect(sockets.made).toHaveLength(0)
    expect(JSON.parse(cli.stdout()).error).toMatchObject({
      code: 3,
      message: 'Stopped. live/nope/ was not found, or you cannot open it.',
    })
  })

  it('exits 4 when the key is refused', async () => {
    const sockets = fakeSockets('wait')
    const cli = await setUp({
      route: () => errorResponse('sign_in_required'),
      webSocket: sockets.WebSocket,
    })

    expect(await cli.run(['watch', 'agent964/live'])).toBe(4)
    expect(sockets.made).toHaveLength(0)
  })
})
