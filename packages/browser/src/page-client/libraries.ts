// The library loader: finds each base library's markup in the page and
// imports that library once, only when its markup is there. A page that runs
// its own Mermaid, highlighter or MathJax is left alone: an element that
// already holds child elements, or carries data-processed, is skipped.
import {
  LIBRARY_NAMES,
  LIBRARY_SELECTORS,
  type LibraryName,
} from '@dossier/html/libraries'

export type { LibraryName }

export interface LibraryContext {
  /** '/_/base/<version>' on the page's own host, or the export prefix. */
  readonly base: string
  readonly window: Window
  /** One console line per URL. */
  readonly reportFailure: (url: string) => void
}

export interface LibraryModule {
  readonly render: (
    elements: readonly Element[],
    context: LibraryContext,
  ) => Promise<void>
}

export interface LibraryLoader {
  /** Renders the library markup at or below `root` not yet seen. */
  readonly scan: (root: ParentNode) => void
  /** Stops rendering anything found later; renders already started finish. */
  readonly stop: () => void
}

/** The URL a library's live build is imported from. */
export const libraryUrl = (base: string, name: LibraryName): string =>
  `${base}/lib/${name}.js`

/** Whether the loader should render an element: untouched markup only. */
const isUntouched = (element: Element): boolean =>
  element.childElementCount === 0 && !element.hasAttribute('data-processed')

/** `root` itself when it matches, then every match below it, in order. */
const matches = (root: ParentNode, selector: string): Element[] => {
  const found: Element[] = []
  const self = root as Partial<Element>
  if (typeof self.matches === 'function' && self.matches(selector)) {
    found.push(root as Element)
  }
  found.push(...root.querySelectorAll(selector))
  return found
}

export const startLibraries = (
  context: LibraryContext & {
    /** Live: import(`${base}/lib/${name}.js`). */
    readonly importLibrary: (name: LibraryName) => Promise<LibraryModule>
  },
): LibraryLoader => {
  const { importLibrary, ...shared } = context
  const loading = new Map<LibraryName, Promise<LibraryModule | null>>()
  const seen = new WeakSet<Element>()
  let stopped = false

  const load = (name: LibraryName): Promise<LibraryModule | null> => {
    let module = loading.get(name)
    if (module === undefined) {
      module = importLibrary(name).then(
        (loaded) => loaded,
        () => {
          shared.reportFailure(libraryUrl(shared.base, name))
          return null
        },
      )
      loading.set(name, module)
    }
    return module
  }

  const scan = (root: ParentNode): void => {
    if (stopped) return
    for (const name of LIBRARY_NAMES) {
      const found = matches(root, LIBRARY_SELECTORS[name]).filter(
        (element) => !seen.has(element) && isUntouched(element),
      )
      if (found.length === 0) continue
      for (const element of found) seen.add(element)
      void load(name).then((module) => {
        if (module === null || stopped) return
        const { console } = shared.window as Window & typeof globalThis
        return module.render(found, shared).catch((error: unknown) => {
          console.error(`dossier: could not render ${name} markup`, error)
        })
      })
    }
  }

  return {
    scan,
    stop: () => {
      stopped = true
    },
  }
}
