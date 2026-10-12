// One MutationObserver per document for everything the page client loads by
// markup: the kit's components and the base libraries both learn of added
// nodes from it, and it stops once nobody listens.

export interface AddedNodes {
  /** Calls `listener` with each node added from now on; returns the unsubscribe. */
  readonly subscribe: (listener: (node: Node) => void) => () => void
}

const watches = new WeakMap<Document, AddedNodes>()

/** The document's watch for added nodes, made on first use. */
export const addedNodes = (window: Window): AddedNodes => {
  const doc = window.document
  const known = watches.get(doc)
  if (known !== undefined) return known
  const listeners = new Set<(node: Node) => void>()
  let observer: MutationObserver | null = null
  const watch: AddedNodes = {
    subscribe: (listener) => {
      listeners.add(listener)
      if (observer === null) {
        const { MutationObserver } = window as Window & typeof globalThis
        observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              for (const each of listeners) each(node)
            }
          }
        })
        observer.observe(doc, { childList: true, subtree: true })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          observer?.disconnect()
          observer = null
        }
      }
    },
  }
  watches.set(doc, watch)
  return watch
}
