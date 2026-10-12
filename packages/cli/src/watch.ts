import {
  DossierError,
  dossierError,
  type EventsResponse,
  type EventWire,
  type LinkRef,
  PROTOCOL,
  PROTOCOL_HEADER,
  WATCH_PATH,
} from '@dossier/contracts'
import { Chunk, Effect, Queue } from 'effect'

import { callApi } from './client.ts'
import { Cli, type CliIo, sleep, VERSION } from './io.ts'
import type { CliProblem } from './render.ts'
import type { RemoteService } from './sync.ts'

/** How often the events route is asked when no live connection is open. */
export const POLL_MS = 10_000
/** How often an open connection sends `ping`, so nothing between drops it. */
export const PING_MS = 30_000
/** The first wait before opening a dropped connection again; it doubles. */
export const RETRY_FIRST_MS = 1_000
/** The longest wait between tries to open the connection again. */
export const RETRY_MAX_MS = 60_000

/** What watching needs from the outside world. */
export interface WatchIo {
  /** Null where this Node has no WebSocket: then only polling. */
  readonly WebSocket: typeof globalThis.WebSocket | null
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

export const watchIoOf = (io: CliIo): WatchIo => ({
  WebSocket: io.webSocket ?? null,
  sleep: io.sleep ?? sleep,
})

/** `agent964/acme`, the tree as the events route and the socket name it. */
const treeOf = (ref: LinkRef): string => `${ref.workspace}/${ref.tree}`

/** The tree path watched: a folder ends in `/`; the root is the whole tree. */
export const watchedPath = (ref: LinkRef): string | null =>
  ref.path === '' ? null : ref.folder ? `${ref.path}/` : ref.path

/** The live connection's address; it never carries the key. */
export const watchUrl = (origin: URL, ref: LinkRef): string => {
  const url = new URL(WATCH_PATH, origin)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.searchParams.set('tree', treeOf(ref))
  const path = watchedPath(ref)
  if (path !== null) url.searchParams.set('path', path)
  return url.href
}

type Signal =
  | { readonly kind: 'open' }
  | { readonly kind: 'hint' }
  | { readonly kind: 'closed' }

/** A hint from the deployment: `{ type: 'changed', tree, sub }`. */
const isHint = (data: unknown): boolean => {
  if (typeof data !== 'string' || data === 'pong') return false
  try {
    const value: unknown = JSON.parse(data)
    return (
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      value.type === 'changed'
    )
  } catch {
    return false
  }
}

/** How a live connection ended. */
type Ended = 'done' | 'opened' | 'failed'

/**
 * Watches a tree, a folder or a file and calls `onEvent` for each event the
 * caller may read, oldest first. The first call to the events route sets the
 * cursor and learns a refusal (not found or key refused) before anything
 * else. A live connection, with the key in its `Authorization` header only,
 * brings hints; each hint fetches the events after the cursor. When the
 * connection fails or this Node has none, the events route is polled every 10
 * seconds, and the connection is tried again after 1, 2, 4 … up to 60
 * seconds. With `next`, it ends after the first event.
 */
export const watchEvents = (i: {
  readonly remote: RemoteService
  readonly ref: LinkRef
  readonly next: boolean
  readonly onEvent: (event: EventWire) => void
}): Effect.Effect<void, DossierError | CliProblem, Cli> =>
  Effect.gen(function* () {
    const { io } = yield* Cli
    const watchIo = watchIoOf(io)
    const { deployment, key } = i.remote
    const tree = treeOf(i.ref)
    const path = watchedPath(i.ref)
    const asked = path === null ? i.ref.tree : `${i.ref.tree}/${path}`

    const fetchEvents = (after: string | undefined) =>
      callApi(deployment, key, (client) =>
        client.events.events({
          urlParams: {
            tree,
            ...(after === undefined ? {} : { after }),
            ...(path === null ? {} : { path }),
          },
        }),
      ).pipe(
        Effect.catchIf(
          (error) =>
            error instanceof DossierError && error.code === 'not_found',
          (error) =>
            Effect.fail(
              dossierError(
                'not_found',
                `Stopped. ${asked} was not found, or you cannot open it.`,
                (error as DossierError).fix,
                (error as DossierError).path,
              ),
            ),
        ),
      )

    // Cursors are opaque: each request resumes from the latest `next`.
    const first: EventsResponse = yield* fetchEvents(undefined)
    let cursor = first.next

    /** Every event after the cursor; true once `next` has its event. */
    const drain = Effect.gen(function* () {
      for (;;) {
        const page = yield* fetchEvents(cursor)
        for (const event of page.events) {
          i.onEvent(event)
          if (i.next) return true
        }
        cursor = page.next
        if (!page.more) return false
      }
    })

    const wait = (ms: number) =>
      Effect.promise((signal) => watchIo.sleep(ms, signal))

    /** Polls every 10 seconds for `ms`; true once `next` has its event. */
    const pollFor = (ms: number) =>
      Effect.gen(function* () {
        for (let left = ms; left > 0; left -= POLL_MS) {
          yield* wait(Math.min(POLL_MS, left))
          if (left >= POLL_MS && (yield* drain)) return true
        }
        return false
      })

    const WebSocket = watchIo.WebSocket
    if (WebSocket === null) {
      for (;;) if (yield* pollFor(POLL_MS)) return
    }

    const url = watchUrl(deployment.origin, i.ref)
    const headers: Record<string, string> = {
      [PROTOCOL_HEADER]: String(PROTOCOL),
      'user-agent': `dossier/${VERSION}`,
    }
    if (key !== null) headers.Authorization = `Bearer ${key}`

    /** One live connection, from opening to its end. */
    const live: Effect.Effect<Ended, DossierError | CliProblem, Cli> =
      Effect.scoped(
        Effect.gen(function* () {
          const signals = yield* Queue.unbounded<Signal>()
          const socket = yield* Effect.acquireRelease(
            Effect.try(() => {
              // Node's WebSocket (undici) takes headers as its second
              // argument, so the key never goes into the address.
              const opened = new WebSocket(url, { headers } as never)
              opened.addEventListener('open', () => {
                signals.unsafeOffer({ kind: 'open' })
              })
              opened.addEventListener('message', (event) => {
                if (isHint(event.data)) signals.unsafeOffer({ kind: 'hint' })
              })
              opened.addEventListener('error', () => {
                signals.unsafeOffer({ kind: 'closed' })
              })
              opened.addEventListener('close', () => {
                signals.unsafeOffer({ kind: 'closed' })
              })
              return opened
            }).pipe(Effect.orElseSucceed(() => null)),
            (opened) =>
              Effect.sync(() => {
                try {
                  opened?.close()
                } catch {
                  // Already closed.
                }
              }),
          )
          if (socket === null) return 'failed'
          let opened = false
          for (;;) {
            const signal = yield* Queue.take(signals)
            if (signal.kind === 'closed') return opened ? 'opened' : 'failed'
            if (signal.kind === 'open') {
              if (opened) continue
              opened = true
              yield* Effect.forkScoped(
                Effect.forever(
                  Effect.zipRight(
                    wait(PING_MS),
                    Effect.sync(() => {
                      try {
                        socket.send('ping')
                      } catch {
                        // Closing; the close signal follows.
                      }
                    }),
                  ),
                ),
              )
              // Events between the first call and the connection opening.
              if (yield* drain) return 'done'
            } else {
              // One fetch covers every hint already waiting.
              const waiting = yield* Queue.takeAll(signals)
              if (yield* drain) return 'done'
              if (Chunk.some(waiting, (s) => s.kind === 'closed')) {
                return opened ? 'opened' : 'failed'
              }
            }
          }
        }),
      )

    let tries = 0
    for (;;) {
      const ended = yield* live
      if (ended === 'done') return
      if (ended === 'opened') tries = 0
      // A refused upgrade does not say why; the events route does, and it
      // also brings what happened while the connection was down.
      if (yield* drain) return
      const delay = Math.min(RETRY_FIRST_MS * 2 ** tries, RETRY_MAX_MS)
      tries += 1
      if (yield* pollFor(delay)) return
    }
  })
