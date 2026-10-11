import {
  BRIDGE_VERSION,
  DossierError,
  WINDOW_NAME_PREFIX,
  isHello,
  isPageToShell,
  type ErrorCode,
  type Me,
  type RoleName,
  type ShellBoot,
  type ShellToPage,
  type TopBoot,
} from '@dossier/contracts/bridge'
import { within } from './frames.ts'

export interface ViewGrant {
  readonly handle: string
  readonly expiresAt: string
  readonly seq: number
  readonly role: RoleName
}

export interface ShellApi {
  /** Rejects with a DossierError. */
  readonly view: (i: {
    readonly tree: string
    readonly path: string
  }) => Promise<ViewGrant>
}

export interface ShellDeps {
  readonly window: Window
  readonly frame: HTMLIFrameElement
  readonly boot: ShellBoot
  readonly api: ShellApi
}

const HOUR = 60 * 60 * 1000
/** How long the shell waits before reloading after an error that is not a refusal. */
export const RETRY_DELAY = 5000

const FRAME_ATTRIBUTES: Readonly<Record<string, string>> = {
  id: 'dossier-page',
  title: '',
  sandbox: [
    'allow-scripts',
    'allow-same-origin',
    'allow-forms',
    'allow-popups',
    'allow-popups-to-escape-sandbox',
    'allow-modals',
    'allow-downloads',
    'allow-presentation',
    'allow-top-navigation-by-user-activation',
  ].join(' '),
  allow: 'fullscreen; clipboard-write; autoplay; picture-in-picture',
}

/** Answers after which the link route, on reload, shows sign-in or no access. */
const REFUSALS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'not_found',
  'sign_in_required',
])

const hashOf = (hash: string): string =>
  hash === '' || hash.startsWith('#') ? hash : ''

const isWebUrl = (href: string): boolean => {
  try {
    const { protocol } = new URL(href)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The shell: frames the page from the tree's content origin, accepts the
 * page client's hello, keeps the address bar in step with the page, and
 * renews the view handle.
 */
export const createShell = (
  deps: ShellDeps,
): { readonly start: () => Promise<void>; readonly dispose: () => void } => {
  const { window: win, boot, api } = deps
  const doc = win.document
  const treePrefix = `/${encodeURIComponent(boot.tree.workspace)}/${encodeURIComponent(boot.tree.name)}/`

  let frame = deps.frame
  /** The newest grant's handle, for the next load and hello checks. */
  let handle: string | null = null
  /** The handle the page in the frame now was loaded with. */
  let framedHandle: string | null = null
  let role: RoleName = 'read'
  /** The link path of the page shown now. */
  let linkPath = boot.linkPath
  let renewedAt = 0
  let loads = 0
  let disposed = false
  let renewTimer: number | undefined
  let retryTimer: number | undefined
  /**
   * Every port of the page in the frame now. The shell follows messages only
   * from the top page's port; nested pages' ports are kept for later calls.
   */
  const ports = new Set<MessagePort>()

  const me = (): Me | null => (boot.me === null ? null : { ...boot.me, role })

  const closePorts = (): void => {
    for (const port of ports) port.close()
    ports.clear()
  }

  const setUrl = (kind: 'push' | 'replace', url: string): void => {
    try {
      if (kind === 'push') win.history.pushState(null, '', url)
      else win.history.replaceState(null, '', url)
    } catch {
      // A URL the history refuses leaves the address bar as it is.
    }
  }

  const failed = (error: unknown): void => {
    if (disposed) return
    if (error instanceof DossierError && REFUSALS.has(error.code)) {
      win.location.reload()
      return
    }
    win.clearTimeout(retryTimer)
    retryTimer = win.setTimeout(() => win.location.reload(), RETRY_DELAY)
  }

  const load = async (path: string, hash: string): Promise<void> => {
    const current = ++loads
    let grant: ViewGrant
    try {
      grant = await api.view({ tree: boot.tree.id, path })
    } catch (error) {
      if (current === loads) failed(error)
      return
    }
    if (current !== loads || disposed) return
    handle = grant.handle
    framedHandle = grant.handle
    role = grant.role
    renewedAt = Date.now()
    linkPath = path

    // The sandbox comes from FRAME_ATTRIBUTES just below.
    // oxlint-disable-next-line react/iframe-missing-sandbox
    const next = doc.createElement('iframe')
    for (const [name, value] of Object.entries(FRAME_ATTRIBUTES)) {
      next.setAttribute(name, value)
    }
    const topBoot: TopBoot = { v: BRIDGE_VERSION, me: me() }
    next.name = WINDOW_NAME_PREFIX + JSON.stringify(topBoot)
    next.src = `${boot.contentOrigin}/_/v/${grant.handle}/${grant.seq}/${path}${hashOf(hash)}`
    closePorts()
    frame.replaceWith(next)
    frame = next
  }

  const renew = async (): Promise<void> => {
    const current = loads
    try {
      const grant = await api.view({ tree: boot.tree.id, path: linkPath })
      // A load since then holds a fresher grant.
      if (disposed || current !== loads) return
      handle = grant.handle
      role = grant.role
      renewedAt = Date.now()
    } catch {
      // The page stays; the next renewal or load asks again.
    }
  }

  const onPageMessage = (data: unknown): void => {
    if (!isPageToShell(data)) return
    switch (data.type) {
      case 'location':
        linkPath = data.path
        setUrl('replace', treePrefix + data.path + hashOf(data.hash))
        doc.title = data.title || boot.deployment.name
        return
      case 'open':
        setUrl('push', treePrefix + data.path + hashOf(data.hash))
        void load(data.path, data.hash)
        return
      case 'navigate':
        if (isWebUrl(data.href)) win.location.assign(data.href)
        return
    }
  }

  const onMessage = (event: MessageEvent): void => {
    const { data, ports: transferred } = event
    const content = frame.contentWindow
    const accepted =
      event.origin === boot.contentOrigin &&
      content !== null &&
      within(content, event.source) &&
      isHello(data) &&
      handle !== null &&
      (data.handle === handle || data.handle === framedHandle) &&
      transferred.length === 1 &&
      // Only the frame's own document is the top page.
      data.nested === (event.source !== content)
    if (!accepted) {
      for (const port of transferred) port.close()
      return
    }
    const port = transferred[0]!
    if (!data.nested) {
      // A new top page: the frame's previous document and its pages are gone.
      closePorts()
      port.addEventListener('message', (message) => onPageMessage(message.data))
      port.start()
    }
    ports.add(port)
    const welcome: ShellToPage = {
      type: 'welcome',
      v: BRIDGE_VERSION,
      me: me(),
    }
    port.postMessage(welcome)
  }

  const onPopState = (): void => {
    const { pathname, hash } = win.location
    if (!pathname.startsWith(treePrefix)) {
      win.location.reload()
      return
    }
    void load(pathname.slice(treePrefix.length), hash)
  }

  const onVisibility = (): void => {
    if (doc.visibilityState === 'visible' && Date.now() - renewedAt >= HOUR) {
      void renew()
    }
  }

  return {
    start: async () => {
      win.addEventListener('message', onMessage)
      win.addEventListener('popstate', onPopState)
      doc.addEventListener('visibilitychange', onVisibility)
      renewTimer = win.setInterval(() => void renew(), HOUR)
      await load(boot.linkPath, win.location.hash)
    },
    dispose: () => {
      disposed = true
      loads++
      win.clearInterval(renewTimer)
      win.clearTimeout(retryTimer)
      win.removeEventListener('message', onMessage)
      win.removeEventListener('popstate', onPopState)
      doc.removeEventListener('visibilitychange', onVisibility)
      closePorts()
    },
  }
}
