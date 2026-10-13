// Fake pages around a happy-dom shell document, for the shell's tests.
import type { DocWire, ShellBoot } from '@dossier/contracts/bridge'
import type { Window as DomWindow } from 'happy-dom'
import { vi } from 'vitest'
import type { ChangeSource } from '../src/shell/changes.ts'
import {
  createShell,
  type ShellApi,
  type ViewGrant,
} from '../src/shell/create-shell.ts'
import { memoryStore, type MemoryStore } from './memory-store.ts'
import { domWindow, fakeChannel, type FakePort } from './ports.ts'

export const BOOT: ShellBoot = {
  v: 1,
  deployment: { origin: 'https://main.test', name: 'Acme Dossier' },
  tree: { id: 't1', workspace: 'agent964', name: 'acme' },
  contentOrigin: 'https://t1-dev.content.test',
  path: 'questions/index.html',
  link: 'https://main.test/agent964/acme/questions/',
  linkPath: 'questions/',
  seq: 7,
  base: 'b1',
  me: { email: 'sara@acme.com', name: 'Sara' },
  preview: null,
}

export const grant = (
  handle: string,
  seq: number,
  role: ViewGrant['role'] = 'write',
  path = 'questions/index.html',
  email?: string | null,
  events = 'c40',
): ViewGrant =>
  ({
    handle,
    seq,
    role,
    expiresAt: '2026-10-12T03:00:00.000Z',
    path,
    events,
    ...(email === undefined ? {} : { email }),
  }) as ViewGrant

/** One connection a fake change source was asked for. */
export interface FakeConnection {
  readonly tree: string
  readonly paths: readonly string[]
  readonly onHint: () => void
  readonly onState: (state: 'live' | 'polling') => void
  closed: boolean
}

/** A change source that records its connections; tests send the hints. */
export const fakeChanges = () => {
  const connections: FakeConnection[] = []
  const source: ChangeSource = {
    connect: (input) => {
      const connection: FakeConnection = { ...input, closed: false }
      connections.push(connection)
      return {
        close: () => {
          connection.closed = true
        },
      }
    },
  }
  return {
    source,
    connections,
    /** The connections not closed. */
    open: () => connections.filter((connection) => !connection.closed),
  }
}

/** A page window as the shell sees it: only its place among the frames. */
export interface FakeFrameWindow {
  readonly parent: unknown
}

export const openShell = (
  options: {
    readonly boot?: ShellBoot
    readonly url?: string
    readonly grants?: readonly (ViewGrant | Error)[]
    readonly store?: MemoryStore
    readonly changes?: ReturnType<typeof fakeChanges>
  } = {},
) => {
  const boot = options.boot ?? BOOT
  const store = options.store ?? memoryStore()
  const win: DomWindow = domWindow(
    options.url ?? 'https://main.test/agent964/acme/questions/#intro',
  )
  const doc = win.document
  doc.title = boot.deployment.name
  doc.body.innerHTML =
    '<iframe id="dossier-page" title="agent964/acme/questions/"></iframe>'
  const placeholder = doc.getElementById(
    'dossier-page',
  ) as unknown as HTMLIFrameElement

  const grants = [...(options.grants ?? [grant('h1', 7)])]
  const view = vi.fn<ShellApi['view']>(async () => {
    const next = grants.length > 1 ? grants.shift() : grants[0]
    if (next === undefined) throw new Error('no grant')
    if (next instanceof Error) throw next
    // A grant is for the person the shell booted for, unless a test says.
    const given: ViewGrant = next
    return 'email' in given
      ? given
      : ({
          ...(given as object),
          email: boot.me?.email ?? null,
        } as ViewGrant)
  })
  /** The deployment confirms a nested page's path for the same person. */
  const confirm = vi.fn<ShellApi['confirm']>(async ({ page }) => ({
    path: page,
    email: boot.me?.email ?? null,
  }))
  const read = vi.fn<ShellApi['read']>(async () => null)
  const send = vi.fn<ShellApi['send']>(async () => ({
    doc: null,
    replayed: false,
  }))
  const upload = vi.fn<ShellApi['upload']>(async (i) => ({
    path: `${i.target}${boot.me?.email ?? 'visitor'}/files/${i.name}`,
    file: `files/${i.name}`,
    name: i.name,
    size: i.size,
    type: i.type,
  }))
  const withdraw = vi.fn<ShellApi['withdraw']>(async () => {})
  const write = vi.fn<ShellApi['write']>(
    async (i) =>
      ({
        path: i.path,
        data: i.patch,
        by: boot.me?.email ?? '',
        at: '2026-10-12T10:00:00.000Z',
        push: 2,
      }) as DocWire,
  )
  const mentionable = vi.fn<ShellApi['mentionable']>(async () => ({
    people: [],
    teams: [],
  }))
  const events = vi.fn<ShellApi['events']>(async ({ after }) => ({
    events: [],
    next: after,
    more: false,
  }))
  const notifications = vi.fn<ShellApi['notifications']>(async () => ({
    notifications: [],
    unread: 0,
    next: null,
  }))
  const readNotifications = vi.fn<ShellApi['readNotifications']>(async () => 0)
  const changes = options.changes ?? fakeChanges()
  const reload = vi.spyOn(win.location, 'reload').mockImplementation(() => {})
  const assign = vi.spyOn(win.location, 'assign').mockImplementation(() => {})
  const pushState = vi.spyOn(win.history, 'pushState')
  const replaceState = vi.spyOn(win.history, 'replaceState')

  const shell = createShell({
    window: win as unknown as Window,
    frame: placeholder,
    boot,
    api: {
      view,
      confirm,
      read,
      send,
      upload,
      withdraw,
      write,
      mentionable,
      events,
      notifications,
      readNotifications,
    },
    store,
    changes: changes.source,
  })

  /** The iframe element in the shell now. */
  const frame = (): HTMLIFrameElement =>
    doc.getElementById('dossier-page') as unknown as HTMLIFrameElement

  /** Gives the iframe now a fake page window and returns it. */
  const page = (): FakeFrameWindow => {
    const content: FakeFrameWindow = { parent: win }
    Object.defineProperty(frame(), 'contentWindow', {
      value: content,
      configurable: true,
    })
    return content
  }

  /**
   * Posts a hello to the shell as a page would, with one port unless `ports`
   * says otherwise. Returns the page's end of the channel.
   */
  const hello = (input: {
    readonly source: unknown
    readonly handle?: string
    readonly nested?: boolean
    readonly origin?: string
    readonly ports?: FakePort[]
    readonly path?: string
  }) => {
    const { port1, port2 } = fakeChannel()
    const ports = input.ports ?? [port2]
    const event = new win.MessageEvent('message', {
      data: {
        dossier: 'hello',
        v: 1,
        handle: input.handle ?? 'h1',
        path: input.path ?? '/questions/index.html',
        nested: input.nested ?? false,
      },
      origin: input.origin ?? boot.contentOrigin,
      source: input.source as never,
      ports: ports as never,
    })
    win.dispatchEvent(event)
    return { page: port1, shell: port2, ports }
  }

  return {
    win,
    shell,
    store,
    view,
    confirm,
    read,
    send,
    upload,
    withdraw,
    write,
    mentionable,
    events,
    notifications,
    readNotifications,
    changes,
    reload,
    assign,
    pushState,
    replaceState,
    placeholder,
    frame,
    page,
    hello,
  }
}
