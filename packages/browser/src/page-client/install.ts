// The client.js entry, a classic script that runs before any author script.
import type {
  ExportData,
  Hello,
  PageBootstrap,
} from '@dossier/contracts/bridge'
import { EXPORT_BASE } from '../base/export-url.ts'
import {
  createPageClient,
  type Dossier,
  type HostPort,
  type SubmitSource,
} from './create-page-client.ts'
import { createExportHost, type ExportStorage } from './export-host.ts'
import { formInfoOf, type FormsController } from './forms.ts'
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
 * markup the parser is still adding, then for every node added later. In a
 * page downloaded as one file, libraries are bare names under the export
 * prefix, which the file's import map resolves.
 */
export const installLibraries = (
  window: Window,
  bootstrap: PageBootstrap,
): LibraryLoader => {
  const doc = window.document
  const base =
    bootstrap.export === true
      ? EXPORT_BASE
      : `/_/base/${encodeURIComponent(bootstrap.base)}`
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

type Send = FormsController['submitted']

/**
 * Takes over the sending of managed forms before any author script runs.
 *
 * One capture listener on the window, the first to see a submit event,
 * cancels the browser's own submission at once with the native
 * `preventDefault`, so nothing page code does later can let it through. The
 * event then shows page code only page code's own cancellation: its
 * `preventDefault`, `returnValue` and `defaultPrevented` are shadowed on the
 * instance, and while it dispatches `Event.prototype.preventDefault` called on
 * it counts too. Once dispatch has finished, in a later task so that every
 * listener counts, the form is sent unless page code cancelled.
 * `HTMLFormElement.prototype.submit()` on a managed form sends it the same
 * way; other forms keep the browser's behaviour.
 */
export const interceptSubmits = (
  window: Window,
  managed: (form: HTMLFormElement) => boolean,
): SubmitSource => {
  const win = window as Window & typeof globalThis
  const proto = win.Event.prototype
  const preventDescriptor = Object.getOwnPropertyDescriptor(
    proto,
    'preventDefault',
  )
  // oxlint-disable-next-line typescript/unbound-method
  const nativePrevent = proto.preventDefault
  const formProto = win.HTMLFormElement.prototype
  // oxlint-disable-next-line typescript/unbound-method
  const nativeSubmit = formProto.submit
  // Page code that replaces setTimeout later cannot hold the decision back.
  const later = win.setTimeout.bind(win)

  let handler: Send | null = null
  const waiting: Parameters<Send>[] = []
  const deliver = (...args: Parameters<Send>): void => {
    if (handler === null) waiting.push(args)
    else handler(...args)
  }

  /** Submit events still dispatching, with how each records a cancellation. */
  const dispatching = new Map<Event, () => void>()
  const wrapped = function preventDefault(this: Event): void {
    const cancel = dispatching.get(this)
    if (cancel === undefined) nativePrevent.call(this)
    else cancel()
  }
  const wrap = (): void => {
    Object.defineProperty(proto, 'preventDefault', {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: preventDescriptor?.enumerable ?? true,
    })
  }
  const unwrap = (): void => {
    if (preventDescriptor === undefined) {
      delete (proto as Partial<Event>).preventDefault
    } else {
      Object.defineProperty(proto, 'preventDefault', preventDescriptor)
    }
  }

  const isForm = (target: EventTarget | null): target is HTMLFormElement =>
    target !== null &&
    (target as Partial<Element>).localName === 'form' &&
    typeof (target as Partial<HTMLFormElement>).checkValidity === 'function'

  win.addEventListener(
    'submit',
    (event) => {
      const form = event.target
      if (!isForm(form) || !managed(form)) return
      nativePrevent.call(event)
      let authored = false
      const cancel = (): void => {
        if (event.cancelable) authored = true
      }
      Object.defineProperties(event, {
        preventDefault: {
          value: function preventDefault(): void {
            cancel()
          },
          configurable: true,
          writable: true,
        },
        defaultPrevented: { get: () => authored, configurable: true },
        returnValue: {
          get: () => !authored,
          set: (value: unknown) => {
            if (value === false) cancel()
          },
          configurable: true,
        },
      })
      if (dispatching.size === 0) wrap()
      dispatching.set(event, cancel)
      const submitter = (event as SubmitEvent).submitter ?? null
      later(() => {
        dispatching.delete(event)
        if (dispatching.size === 0) unwrap()
        if (!authored) deliver(form, submitter, 'event')
      }, 0)
    },
    true,
  )

  Object.defineProperty(formProto, 'submit', {
    value: function submit(this: HTMLFormElement): void {
      if (managed(this)) deliver(this, null, 'method')
      else nativeSubmit.call(this)
    },
    writable: true,
    configurable: true,
  })

  return {
    connect: (next) => {
      handler = next
      for (const args of waiting.splice(0)) next(...args)
    },
  }
}

/** What install leaves behind, for tests. */
export interface Installed {
  readonly dossier: Dossier
  /** The forms controller, once it has started. */
  readonly forms: () => FormsController | null
}

/** The browser's storage for this file, or null where it refuses it. */
const localStorageOf = (window: Window): ExportStorage | null => {
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

/** Installs the page client and `window.dossier` in a composed page. */
export const install = (window: Window): Installed => {
  const doc = window.document
  const bootstrap = JSON.parse(
    doc.getElementById('dossier-bootstrap')?.textContent ?? 'null',
  ) as PageBootstrap
  const embedded = window.parent !== window.top
  // Before first paint, so page styles can tell a framed page apart.
  if (embedded) doc.documentElement.setAttribute('data-dossier-embedded', '')

  const submits = interceptSubmits(
    window,
    (form) => formInfoOf(bootstrap, form) !== null,
  )
  // A page downloaded as one file talks to its export host, never Dossier.
  let data: ExportData | null = null
  let port: HostPort
  let shellPort: MessagePort | null = null
  if (bootstrap.export === true) {
    data = JSON.parse(
      doc.getElementById('dossier-export')?.textContent ?? 'null',
    ) as ExportData
    port = createExportHost({
      data,
      bootstrap,
      storage: localStorageOf(window),
      now: () => new Date(),
    })
  } else {
    const { MessageChannel } = window as Window & typeof globalThis
    const channel = new MessageChannel()
    port = channel.port1
    shellPort = channel.port2
  }
  let forms: FormsController | null = null
  const dossier = createPageClient({
    bootstrap,
    port,
    window,
    submits,
    onForms: (controller) => {
      forms = controller
    },
    ...(data === null ? {} : { exported: { me: data.me, at: data.at } }),
  })
  installLibraries(window, bootstrap)

  const handle = framePath(window.location.pathname)?.handle
  const top = window.top
  if (
    shellPort !== null &&
    top !== null &&
    top !== window &&
    handle !== undefined
  ) {
    const hello: Hello = {
      dossier: 'hello',
      v: 1,
      handle,
      path: bootstrap.path,
      nested: embedded,
    }
    top.postMessage(hello, bootstrap.origin, [shellPort])
  }

  Object.defineProperty(window, 'dossier', {
    value: dossier,
    writable: false,
    configurable: false,
  })
  return { dossier, forms: () => forms }
}

if (
  typeof window !== 'undefined' &&
  window.document.getElementById('dossier-bootstrap') !== null
) {
  install(window)
}
