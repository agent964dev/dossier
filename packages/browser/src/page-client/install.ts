// The client.js entry, a classic script that runs before any author script.
import type { Hello, PageBootstrap } from '@dossier/contracts/bridge'
import { createPageClient } from './create-page-client.ts'
import {
  libraryUrl,
  startLibraries,
  type LibraryLoader,
  type LibraryModule,
} from './libraries.ts'
import { framePath } from './location.ts'
import { addedNodes } from './watch.ts'

/**
 * Starts the library loader once the document is parsed, so it never renders
 * markup the parser is still adding, then for every node added later.
 */
export const installLibraries = (
  window: Window,
  bootstrap: PageBootstrap,
): LibraryLoader => {
  const doc = window.document
  const base = `/_/base/${encodeURIComponent(bootstrap.base)}`
  const reported = new Set<string>()
  const loader = startLibraries({
    base,
    window,
    reportFailure: (url) => {
      if (reported.has(url)) return
      reported.add(url)
      const { console } = window as Window & typeof globalThis
      console.error(`dossier: could not load ${url}`)
    },
    importLibrary: (name) =>
      import(
        /* @vite-ignore */ libraryUrl(base, name)
      ) as Promise<LibraryModule>,
  })
  const begin = (): void => {
    loader.scan(doc)
    addedNodes(window).subscribe((node) => {
      if (node.nodeType === 1) loader.scan(node as Element)
    })
  }
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', begin, { once: true })
  } else {
    begin()
  }
  return loader
}

/** Installs the page client and `window.dossier` in a composed page. */
export const install = (window: Window): void => {
  const doc = window.document
  const bootstrap = JSON.parse(
    doc.getElementById('dossier-bootstrap')?.textContent ?? 'null',
  ) as PageBootstrap
  const embedded = window.parent !== window.top
  // Before first paint, so page styles can tell a framed page apart.
  if (embedded) doc.documentElement.setAttribute('data-dossier-embedded', '')

  const { MessageChannel } = window as Window & typeof globalThis
  const { port1, port2 } = new MessageChannel()
  const dossier = createPageClient({ bootstrap, port: port1, window })
  installLibraries(window, bootstrap)

  const handle = framePath(window.location.pathname)?.handle
  const top = window.top
  if (top !== null && top !== window && handle !== undefined) {
    const hello: Hello = {
      dossier: 'hello',
      v: 1,
      handle,
      path: bootstrap.path,
      nested: embedded,
    }
    top.postMessage(hello, bootstrap.origin, [port2])
  }

  Object.defineProperty(window, 'dossier', {
    value: dossier,
    writable: false,
    configurable: false,
  })
}

if (
  typeof window !== 'undefined' &&
  window.document.getElementById('dossier-bootstrap') !== null
) {
  install(window)
}
