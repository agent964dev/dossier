// A fake shell around a happy-dom page, for the page client's tests.
import type { DraftValues, Me, PageBootstrap } from '@dossier/contracts/bridge'
import type { Window as DomWindow } from 'happy-dom'
import { domWindow, fakeChannel, type FakePort } from './ports.ts'

export const MAIN = 'https://main.test'
export const CONTENT = 'https://t1-dev.content.test'
export const HANDLE = 'h1'
export const PAGE_URL = `${CONTENT}/_/v/${HANDLE}/3/questions/plan`

export const BOOTSTRAP: PageBootstrap = {
  v: 1,
  origin: MAIN,
  tree: { id: 't1', workspace: 'agent964', name: 'acme' },
  path: '/questions/plan.html',
  link: `${MAIN}/agent964/acme/questions/plan`,
  push: 2,
  seq: 3,
  base: 'b1',
  kit: {},
  used: [],
  forms: [],
}

export const SARA: Me = { email: 'sara@acme.com', name: 'Sara', role: 'write' }

export interface Hello {
  readonly data: unknown
  readonly targetOrigin: string
  readonly ports: readonly FakePort[]
}

/** The shell's window as a page sees it: only `postMessage` and its place. */
export interface FakeShell {
  readonly window: {
    readonly parent: unknown
    readonly top: unknown
    postMessage(data: unknown, targetOrigin: string, ports: FakePort[]): void
  }
  readonly hellos: Hello[]
  /** Answers the last hello with a welcome. */
  readonly welcome: (
    me: Me | null,
    extra?: {
      readonly drafts?: Readonly<Record<string, DraftValues>>
      readonly resume?: readonly string[]
    },
  ) => void
  /** Sends the page anything over the last hello's port. */
  readonly tell: (message: unknown) => void
  /** What the page sent to the shell over the last hello's port. */
  readonly received: () => unknown[]
}

export const fakeShell = (): FakeShell => {
  const hellos: Hello[] = []
  const window = {
    parent: undefined as unknown,
    top: undefined as unknown,
    postMessage(data: unknown, targetOrigin: string, ports: FakePort[]) {
      hellos.push({ data, targetOrigin, ports })
    },
  }
  window.parent = window
  window.top = window
  const lastPort = (): FakePort => {
    const port = hellos.at(-1)?.ports[0]
    if (port === undefined) throw new Error('no hello yet')
    return port
  }
  const post = (message: unknown): void => {
    // A MessagePort's postMessage takes no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    lastPort().postMessage(message)
  }
  return {
    window,
    hellos,
    welcome: (me, extra = {}) =>
      post({
        type: 'welcome',
        v: 1,
        me,
        drafts: extra.drafts ?? {},
        resume: extra.resume ?? [],
      }),
    tell: post,
    received: () => lastPort().inbox,
  }
}

/** Where the page sits: in the shell's frame, inside another page, or alone. */
export type Placement = 'top' | 'nested' | 'alone'

export interface Page {
  readonly win: DomWindow
  /** The same window, typed as the page client's dependency. */
  readonly window: Window
  readonly shell: FakeShell
}

export const openPage = (options: {
  readonly placement: Placement
  readonly name?: string
  readonly url?: string
  readonly body?: string
  readonly title?: string
  readonly bootstrap?: PageBootstrap
}): Page => {
  const shell = fakeShell()
  const win = domWindow(options.url ?? PAGE_URL)
  const doc = win.document
  doc.title = options.title ?? 'Plan'
  const bootstrap = doc.createElement('script')
  bootstrap.setAttribute('type', 'application/json')
  bootstrap.id = 'dossier-bootstrap'
  bootstrap.textContent = JSON.stringify(options.bootstrap ?? BOOTSTRAP)
  doc.head.prepend(bootstrap)
  doc.body.innerHTML = options.body ?? ''

  const place = (parent: unknown, top: unknown): void => {
    Object.defineProperty(win, 'parent', { value: parent, configurable: true })
    Object.defineProperty(win, 'top', { value: top, configurable: true })
  }
  if (options.placement === 'top') place(shell.window, shell.window)
  if (options.placement === 'nested') {
    place({ parent: shell.window }, shell.window)
  }
  win.name = options.name ?? ''
  Object.assign(win, {
    MessageChannel: class {
      readonly port1: FakePort
      readonly port2: FakePort
      constructor() {
        const channel = fakeChannel()
        this.port1 = channel.port1
        this.port2 = channel.port2
      }
    },
  })
  return { win, window: win as unknown as Window, shell }
}
