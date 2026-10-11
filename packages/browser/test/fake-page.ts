// Fake pages around a happy-dom shell document, for the shell's tests.
import type { ShellBoot } from '@dossier/contracts/bridge'
import type { Window as DomWindow } from 'happy-dom'
import { vi } from 'vitest'
import {
  createShell,
  type ShellApi,
  type ViewGrant,
} from '../src/shell/create-shell.ts'
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
}

export const grant = (
  handle: string,
  seq: number,
  role: ViewGrant['role'] = 'write',
): ViewGrant => ({
  handle,
  seq,
  role,
  expiresAt: '2026-10-12T03:00:00.000Z',
})

/** A page window as the shell sees it: only its place among the frames. */
export interface FakeFrameWindow {
  readonly parent: unknown
}

export const openShell = (
  options: {
    readonly boot?: ShellBoot
    readonly url?: string
    readonly grants?: readonly (ViewGrant | Error)[]
  } = {},
) => {
  const boot = options.boot ?? BOOT
  const win: DomWindow = domWindow(
    options.url ?? 'https://main.test/agent964/acme/questions/#intro',
  )
  const doc = win.document
  doc.title = boot.deployment.name
  doc.body.innerHTML = '<iframe id="dossier-page" title=""></iframe>'
  const placeholder = doc.getElementById(
    'dossier-page',
  ) as unknown as HTMLIFrameElement

  const grants = [...(options.grants ?? [grant('h1', 7)])]
  const view = vi.fn<ShellApi['view']>(async () => {
    const next = grants.length > 1 ? grants.shift() : grants[0]
    if (next === undefined) throw new Error('no grant')
    if (next instanceof Error) throw next
    return next
  })
  const reload = vi.spyOn(win.location, 'reload').mockImplementation(() => {})
  const assign = vi.spyOn(win.location, 'assign').mockImplementation(() => {})
  const pushState = vi.spyOn(win.history, 'pushState')
  const replaceState = vi.spyOn(win.history, 'replaceState')

  const shell = createShell({
    window: win as unknown as Window,
    frame: placeholder,
    boot,
    api: { view },
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
  }) => {
    const { port1, port2 } = fakeChannel()
    const ports = input.ports ?? [port2]
    const event = new win.MessageEvent('message', {
      data: {
        dossier: 'hello',
        v: 1,
        handle: input.handle ?? 'h1',
        path: '/questions/index.html',
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
    view,
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
