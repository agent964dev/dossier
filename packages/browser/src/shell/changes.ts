// Where the shell learns that a tree changed: the tree's socket, which sends
// bare hints, or polling when the socket cannot be reached.

export interface ChangeSource {
  readonly connect: (i: {
    readonly tree: string
    readonly paths: readonly string[]
    /** 0 asks for a fetch after (re)connecting, and on each poll. */
    readonly onHint: (seq: number) => void
    readonly onState: (state: 'live' | 'polling') => void
  }) => { readonly close: () => void }
}

/** How often the polling source asks for a fetch. */
export const POLL_INTERVAL = 10_000
/** How often an open socket says it is still there. */
export const PING_INTERVAL = 30_000
/** The first wait before the socket is tried again, doubled up to the most. */
export const RECONNECT_FIRST = 1000
export const RECONNECT_MOST = 60_000

// The watch upgrade's path. Written out here because the contracts root, where
// the shared constant lives, carries Effect, which the browser bundles leave
// out.
const WATCH_PATH = '/_/api/watch'

type Timers = Pick<
  Window,
  'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'
>

/** A hint at once, then one every interval. */
export const pollingChanges = (
  window: Timers,
  intervalMs = POLL_INTERVAL,
): ChangeSource => ({
  connect: ({ onHint, onState }) => {
    onState('polling')
    onHint(0)
    const timer = window.setInterval(() => onHint(0), intervalMs)
    return { close: () => window.clearInterval(timer) }
  },
})

/** The socket's URL on the main host, from the deployment's origin. */
export const watchUrl = (
  origin: string,
  tree: string,
  paths: readonly string[],
): string => {
  const url = new URL(WATCH_PATH, origin)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  const query = new URLSearchParams({ tree })
  for (const path of paths) query.append('path', path)
  url.search = query.toString()
  return url.href
}

const hintOf = (data: unknown): number | null => {
  if (typeof data !== 'string' || data === 'pong') return null
  try {
    const message: unknown = JSON.parse(data)
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'changed' &&
      Number.isInteger((message as { seq?: unknown }).seq)
    ) {
      return (message as { seq: number }).seq
    }
  } catch {
    // Not a hint.
  }
  return null
}

/**
 * The tree's socket on the main host, so the session cookie goes with it.
 * While it is closed, `fallback` runs and the socket is tried again after
 * 1 s, 2 s, 4 s and so on, up to a minute.
 */
export const webSocketChanges = (
  window: Window,
  origin: string,
  fallback: ChangeSource,
): ChangeSource => ({
  connect: (input) => {
    const { WebSocket } = window as Window & typeof globalThis
    const url = watchUrl(origin, input.tree, input.paths)
    let socket: WebSocket | null = null
    let polling: { readonly close: () => void } | null = null
    let closed = false
    let wait = RECONNECT_FIRST
    let retry: number | undefined
    let ping: number | undefined

    const lost = (from: WebSocket | null): void => {
      if (closed || from !== socket) return
      socket = null
      window.clearInterval(ping)
      try {
        from?.close()
      } catch {
        // Already closed.
      }
      polling ??= fallback.connect(input)
      retry = window.setTimeout(open, wait)
      wait = Math.min(wait * 2, RECONNECT_MOST)
    }

    const open = (): void => {
      if (closed) return
      let next: WebSocket
      try {
        next = new WebSocket(url)
      } catch {
        socket = null
        lost(null)
        return
      }
      socket = next
      next.addEventListener('open', () => {
        if (closed || socket !== next) return
        wait = RECONNECT_FIRST
        polling?.close()
        polling = null
        input.onState('live')
        input.onHint(0)
        ping = window.setInterval(() => {
          try {
            next.send('ping')
          } catch {
            lost(next)
          }
        }, PING_INTERVAL)
      })
      next.addEventListener('message', (event: MessageEvent) => {
        if (closed || socket !== next) return
        const seq = hintOf(event.data)
        if (seq !== null) input.onHint(seq)
      })
      next.addEventListener('error', () => lost(next))
      next.addEventListener('close', () => lost(next))
    }

    open()
    return {
      close: () => {
        closed = true
        window.clearTimeout(retry)
        window.clearInterval(ping)
        polling?.close()
        polling = null
        const last = socket
        socket = null
        try {
          last?.close()
        } catch {
          // Already closed.
        }
      },
    }
  },
})
