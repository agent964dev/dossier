// The client.js entry, a classic script that runs before any author script.
import type { Hello, PageBootstrap } from '@dossier/contracts/bridge'
import { createPageClient } from './create-page-client.ts'
import { framePath } from './location.ts'

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
