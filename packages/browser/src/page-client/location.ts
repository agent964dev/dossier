import type { PageBootstrap, PageToShell } from '@dossier/contracts/bridge'
import type { HostPort } from './create-page-client.ts'

const FRAME_PATH = /^\/_\/v\/([^/]+)\/(\d+)(?:\/(.*))?$/

/**
 * Splits a frame URL's path, `/_/v/<handle>/<seq>/<link path>`, or null for
 * any other path. The link path stays URL-encoded, as in the link.
 */
export const framePath = (
  pathname: string,
): {
  readonly handle: string
  readonly seq: number
  readonly path: string
} | null => {
  const match = FRAME_PATH.exec(pathname)
  if (match === null) return null
  return { handle: match[1]!, seq: Number(match[2]), path: match[3] ?? '' }
}

const treePrefix = (bootstrap: PageBootstrap): string =>
  `/${encodeURIComponent(bootstrap.tree.workspace)}/${encodeURIComponent(bootstrap.tree.name)}/`

/**
 * What the shell does with a link the top page follows: open another page of
 * the tree, navigate the top to anything else, or null to leave it to the
 * frame (a hash on the same document, or a URL that is not http or https).
 */
export const linkAction = (
  href: string,
  page: { readonly location: string; readonly bootstrap: PageBootstrap },
): Extract<PageToShell, { type: 'open' | 'navigate' }> | null => {
  let url: URL
  let here: URL
  try {
    url = new URL(href)
    here = new URL(page.location)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (
    url.origin === here.origin &&
    url.pathname === here.pathname &&
    url.search === here.search &&
    url.hash !== ''
  ) {
    return null
  }
  if (url.origin === here.origin) {
    const target = framePath(url.pathname)
    const own = framePath(here.pathname)
    if (target !== null && own !== null && target.handle === own.handle) {
      return { type: 'open', path: target.path, hash: url.hash }
    }
  }
  if (url.origin === new URL(page.bootstrap.origin).origin) {
    const prefix = treePrefix(page.bootstrap)
    if (url.pathname.startsWith(prefix)) {
      return {
        type: 'open',
        path: url.pathname.slice(prefix.length),
        hash: url.hash,
      }
    }
    if (url.pathname === prefix.slice(0, -1)) {
      return { type: 'open', path: '', hash: url.hash }
    }
  }
  return { type: 'navigate', href: url.href }
}

const XLINK = 'http://www.w3.org/1999/xlink'

const isElement = (node: unknown): node is Element =>
  typeof node === 'object' &&
  node !== null &&
  typeof (node as Partial<Element>).getAttribute === 'function'

/** The link the click is on: `<a>` or `<area>`, SVG's `<a>` included. */
const linkOf = (event: Event): Element | null => {
  for (const node of event.composedPath()) {
    if (!isElement(node)) continue
    const name = node.localName
    if (name !== 'a' && name !== 'area') continue
    if (node.hasAttribute('href') || node.hasAttributeNS(XLINK, 'href')) {
      return node
    }
  }
  return null
}

const targetOf = (link: Element, doc: Document): string =>
  link.getAttribute('target') ??
  doc.querySelector('base[target]')?.getAttribute('target') ??
  ''

/**
 * Keeps the shell's address bar in step with the top page and hands it the
 * links that leave the page. Only the top page in the shell calls this.
 */
export const trackLocation = (deps: {
  readonly window: Window
  readonly bootstrap: PageBootstrap
  readonly port: HostPort
}): void => {
  const { window: win, bootstrap, port } = deps
  const doc = win.document

  const report = (): void => {
    const frame = framePath(win.location.pathname)
    if (frame === null) return
    const message: PageToShell = {
      type: 'location',
      path: frame.path,
      hash: win.location.hash,
      title: doc.title,
    }
    port.postMessage(message)
  }

  // On the window in the bubble phase, so the page's own handlers on the link
  // and the document run first and can cancel the click.
  win.addEventListener('click', (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }
    const link = linkOf(event)
    if (link === null || link.hasAttribute('download')) return
    const target = targetOf(link, doc).trim().toLowerCase()
    if (target !== '' && target !== '_self') return
    const raw = link.getAttribute('href') ?? link.getAttributeNS(XLINK, 'href')
    if (raw === null) return
    let href: string
    try {
      href = new URL(raw, doc.baseURI).href
    } catch {
      return
    }
    const action = linkAction(href, { location: win.location.href, bootstrap })
    if (action === null) return
    event.preventDefault()
    port.postMessage(action)
  })

  win.addEventListener('hashchange', report)
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', report, { once: true })
  } else {
    report()
  }
}
