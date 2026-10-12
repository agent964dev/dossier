// Watch sockets as the shell and the CLI open them, through the real edge.
import { expect } from 'vitest'

import { Browser } from './browser.ts'
import { ORIGIN } from './harness.ts'

export const watchUrl = (tree: string, paths: readonly string[]) => {
  const query = new URLSearchParams({ tree })
  for (const path of paths) query.append('path', path)
  return `/_/api/watch?${query}`
}

/** An upgrade as the shell's socket sends it: the cookie, the main origin. */
export const upgradeAs = (
  browser: Browser,
  tree: string,
  paths: readonly string[],
  headers: Record<string, string> = { origin: ORIGIN },
) =>
  browser.fetch(watchUrl(tree, paths), {
    purpose: 'none',
    headers: { upgrade: 'websocket', ...headers },
  })

export interface Socket {
  readonly ws: WebSocket
  /** Every message so far, in order. */
  readonly seen: unknown[]
  /** The next message, or null after `ms`. */
  readonly next: (ms?: number) => Promise<unknown>
  readonly closed: Promise<{ code: number; reason: string }>
  /** Resolves with the close, or null when it stays open for `ms`. */
  readonly closedWithin: (
    ms: number,
  ) => Promise<{ code: number; reason: string } | null>
}

export const open = (response: Response): Socket => {
  expect(response.status).toBe(101)
  const ws = response.webSocket
  if (ws === null) throw new Error('no socket in the 101')
  ws.accept()
  const seen: unknown[] = []
  const queue: unknown[] = []
  let waiting: ((value: unknown) => void) | null = null
  ws.addEventListener('message', (event) => {
    const text = String(event.data)
    const value: unknown = text.startsWith('{') ? JSON.parse(text) : text
    seen.push(value)
    if (waiting !== null) {
      const resolve = waiting
      waiting = null
      resolve(value)
    } else queue.push(value)
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (event) =>
      resolve({ code: event.code, reason: event.reason }),
    ),
  )
  return {
    ws,
    seen,
    closed,
    closedWithin: (ms) =>
      Promise.race([
        closed,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
      ]),
    next: (ms = 2000) =>
      queue.length > 0
        ? Promise.resolve(queue.shift())
        : new Promise((resolve) => {
            const timer = setTimeout(() => {
              waiting = null
              resolve(null)
            }, ms)
            waiting = (value) => {
              clearTimeout(timer)
              resolve(value)
            }
          }),
  }
}

/** A visitor's browser: no cookie at all. */
export const visitorBrowser = () => new Browser()
