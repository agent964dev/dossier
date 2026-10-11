import { Window } from 'happy-dom'

/**
 * One end of an in-memory message channel. Like a real port it queues what
 * arrives until `start()`, then delivers asynchronously. `inbox` records every
 * message that reached it, for assertions.
 */
export class FakePort extends EventTarget {
  other: FakePort | null = null
  closed = false
  readonly inbox: unknown[] = []
  #started = false
  #queue: unknown[] = []

  postMessage(data: unknown): void {
    if (this.closed) return
    this.other?.receive(structuredClone(data))
  }

  receive(data: unknown): void {
    if (this.closed) return
    this.inbox.push(data)
    if (this.#started) this.#deliver(data)
    else this.#queue.push(data)
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    for (const data of this.#queue.splice(0)) this.#deliver(data)
  }

  close(): void {
    this.closed = true
  }

  #deliver(data: unknown): void {
    queueMicrotask(() => {
      if (!this.closed)
        this.dispatchEvent(new MessageEvent('message', { data }))
    })
  }
}

export const fakeChannel = (): { port1: FakePort; port2: FakePort } => {
  const port1 = new FakePort()
  const port2 = new FakePort()
  port1.other = port2
  port2.other = port1
  return { port1, port2 }
}

/** Lets pending promise callbacks and port deliveries run. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/**
 * A happy-dom window that loads nothing and never navigates, with its timers
 * on the global ones so `vi.useFakeTimers()` reaches them.
 */
export const domWindow = (url: string): Window => {
  const win = new Window({
    url,
    settings: {
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
        disableFallbackToSetURL: true,
      },
    },
  })
  Object.assign(win, {
    setTimeout: (run: () => void, ms?: number) =>
      globalThis.setTimeout(run, ms),
    clearTimeout: (id?: number) => globalThis.clearTimeout(id),
    setInterval: (run: () => void, ms?: number) =>
      globalThis.setInterval(run, ms),
    clearInterval: (id?: number) => globalThis.clearInterval(id),
  })
  return win
}
