// The shell's watch manager: every page's subscriptions on one connection
// per tree, the event cursor, and the reads that follow each change.
import {
  pathsMeet,
  type DocWire,
  type ShellToPage,
} from '@dossier/contracts/bridge'
import type { ChangeSource } from './changes.ts'
import type { ShellApi } from './create-shell.ts'

/** Past this many distinct paths, the connection watches the whole tree. */
export const MOST_PATHS = 50
/** How long the path set settles before the connection is made again. */
export const RECONNECT_DELAY = 200

export interface Watches {
  /** Adds a page's subscription and sends it the path's value now. */
  readonly add: (i: {
    readonly port: MessagePort
    readonly sub: number
    /** A tree path, already resolved; a folder ends in '/'. */
    readonly path: string
  }) => void
  readonly remove: (port: MessagePort, sub: number) => void
  /** A page left: its subscriptions go. */
  readonly drop: (port: MessagePort) => void
  /**
   * The cursor a view grant gives. Cursors are opaque, so only the first is
   * taken; after that the cursor is the latest `next` the events route gave.
   */
  readonly seen: (cursor: string) => void
  /**
   * A page's write, withdrawal, upload or send to this tree path was
   * answered: a read sent before now may hold what it replaced.
   */
  readonly acknowledged: (path: string) => void
  readonly dispose: () => void
}

interface Sub {
  readonly port: MessagePort
  readonly sub: number
  readonly path: string
  /** The newest read started for it; older answers are dropped. */
  reads: number
  /** Its last read failed: the next batch reads it again. */
  stale: boolean
}

type Value = DocWire | DocWire[] | null

export const createWatches = (deps: {
  readonly window: Pick<Window, 'setTimeout' | 'clearTimeout'>
  readonly tree: string
  readonly api: Pick<ShellApi, 'read' | 'events'>
  readonly changes: ChangeSource
  readonly post: (port: MessagePort, message: ShellToPage) => void
}): Watches => {
  const { window: win, tree, api } = deps
  const subs = new Map<MessagePort, Map<number, Sub>>()
  let cursor: string | null = null
  /** Counts acknowledgements, so a read knows which came after it left. */
  let clock = 0
  /** Each acknowledged tree path, with the clock when it was answered. */
  const acked = new Map<string, number>()
  /** Reads out now; with none, no read can be crossed and acked empties. */
  let reading = 0
  let connection: { readonly close: () => void } | null = null
  /** The path set the connection was made with, joined. */
  let connected = ''
  let timer: number | undefined
  let disposed = false
  /** The next fetch reads every subscription: a (re)connect or a new source. */
  let fresh = false
  let running = false
  let again = false

  const all = (): Sub[] =>
    [...subs.values()].flatMap((map) => [...map.values()])

  const pathSet = (): string[] => {
    const paths = [...new Set(all().map((sub) => sub.path))].sort()
    return paths.length > MOST_PATHS ? [''] : paths
  }

  const tell = (sub: Sub, value: Value): void => {
    if (subs.get(sub.port)?.get(sub.sub) !== sub) return
    deps.post(sub.port, { type: 'changed', sub: sub.sub, value })
  }

  /** A write under, at or above the path was answered after `sentAt`. */
  const crossed = (path: string, sentAt: number): boolean => {
    for (const [written, at] of acked) {
      if (at > sentAt && pathsMeet(written, path)) return true
    }
    return false
  }

  /**
   * Reads each path once and tells every subscription on it. An answer to a
   * read that left before a write there was answered may predate that write,
   * so the path is read again rather than sent back over a newer value.
   */
  const readAll = async (targets: readonly Sub[]): Promise<void> => {
    const byPath = new Map<string, Sub[]>()
    for (const sub of targets) {
      sub.reads += 1
      byPath.set(sub.path, [...(byPath.get(sub.path) ?? []), sub])
    }
    await Promise.all(
      [...byPath].map(async ([path, list]) => {
        const started = list.map((sub) => sub.reads)
        let value: Value
        for (;;) {
          const sentAt = clock
          reading += 1
          let fenced: boolean
          try {
            value = await api.read({ tree, path })
            fenced = crossed(path, sentAt)
          } catch {
            for (const sub of list) sub.stale = true
            return
          } finally {
            reading -= 1
            if (reading === 0) acked.clear()
          }
          if (disposed || !fenced) break
        }
        list.forEach((sub, i) => {
          if (sub.reads !== started[i]) return
          sub.stale = false
          tell(sub, value)
        })
      }),
    )
  }

  /** Events after the cursor, then the reads they call for. */
  const batch = async (): Promise<void> => {
    const everyone = fresh
    fresh = false
    const paths: string[] = []
    if (cursor !== null) {
      try {
        for (;;) {
          const page = await api.events({ tree, after: cursor })
          for (const event of page.events) paths.push(event.path)
          cursor = page.next
          if (!page.more) break
        }
      } catch {
        // The next hint, poll or reconnect asks again from the cursor; the
        // events already fetched still call for their reads.
        if (!everyone && paths.length === 0) return
      }
    }
    if (disposed) return
    const targets = all().filter(
      (sub) =>
        everyone ||
        sub.stale ||
        paths.some((path) => pathsMeet(path, sub.path)),
    )
    if (targets.length > 0) await readAll(targets)
  }

  const run = async (): Promise<void> => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      // A hint during a batch runs one more after it.
      for (;;) {
        again = false
        await batch()
        if (!again || disposed) break
      }
    } finally {
      running = false
    }
  }

  const onHint = (): void => {
    if (!disposed) void run()
  }

  const connect = (): void => {
    timer = undefined
    const paths = pathSet()
    const key = paths.join('\n')
    if (paths.length === 0) {
      connection?.close()
      connection = null
      connected = ''
      return
    }
    if (connection !== null && key === connected) return
    connection?.close()
    connected = key
    connection = deps.changes.connect({
      tree,
      paths,
      onHint,
      onState: () => {
        fresh = true
      },
    })
  }

  /** The path set may have changed: connect again once it settles. */
  const changed = (): void => {
    if (disposed) return
    const paths = pathSet()
    const key = paths.join('\n')
    const same =
      paths.length === 0
        ? connection === null
        : connection !== null && key === connected
    if (same) {
      win.clearTimeout(timer)
      timer = undefined
      return
    }
    win.clearTimeout(timer)
    timer = win.setTimeout(connect, RECONNECT_DELAY)
  }

  return {
    add: ({ port, sub, path }) => {
      if (disposed) return
      const map = subs.get(port) ?? new Map<number, Sub>()
      subs.set(port, map)
      const entry: Sub = { port, sub, path, reads: 0, stale: false }
      map.set(sub, entry)
      void readAll([entry])
      changed()
    },
    remove: (port, sub) => {
      const map = subs.get(port)
      if (map?.delete(sub) !== true) return
      if (map.size === 0) subs.delete(port)
      changed()
    },
    drop: (port) => {
      if (!subs.delete(port)) return
      changed()
    },
    seen: (first) => {
      cursor ??= first
    },
    acknowledged: (path) => {
      clock += 1
      acked.delete(path)
      acked.set(path, clock)
    },
    dispose: () => {
      disposed = true
      win.clearTimeout(timer)
      connection?.close()
      connection = null
      subs.clear()
    },
  }
}
