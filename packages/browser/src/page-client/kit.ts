// The component loader: imports the kit's components before author scripts
// run, and keeps each kit tag hidden until it is defined, for at most three
// seconds. Tags outside the kit are never touched.
import { addedNodes } from './watch.ts'

/** The longest a kit tag stays hidden while its component loads. */
export const HIDE_LIMIT = 3000

export interface KitLoader {
  /** Stops watching for new elements; hidden tags stay until their timers end. */
  readonly stop: () => void
}

export const startKit = (deps: {
  readonly window: Window
  /** Tag → component URL, relative to the page or root-relative. */
  readonly kit: Readonly<Record<string, string>>
  /** The kit tags the composed page uses: imported at once. */
  readonly used: readonly string[]
  /** Loads a module; the browser's own import() unless a test passes one. */
  readonly load?: (url: string) => Promise<unknown>
}): KitLoader => {
  const { kit } = deps
  const win = deps.window as Window & typeof globalThis
  const doc = win.document
  const load = deps.load ?? ((url: string) => import(/* @vite-ignore */ url))
  const tags = new Set(Object.keys(kit))
  const imported = new Set<string>()
  const hidden = new Set<string>()

  const style = doc.createElement('style')
  style.setAttribute('data-dossier-kit', '')
  ;(doc.head ?? doc.documentElement).appendChild(style)
  const render = (): void => {
    style.textContent = [...hidden]
      .map((tag) => `${tag}:not(:defined){visibility:hidden}`)
      .join('\n')
  }
  const show = (tag: string): void => {
    if (hidden.delete(tag)) render()
  }

  let unsubscribe: (() => void) | null = null

  const importTag = (tag: string): void => {
    if (imported.has(tag) || !tags.has(tag)) return
    imported.add(tag)
    // Nothing left to watch for once every kit tag is imported.
    if (imported.size === tags.size) unsubscribe?.()
    hidden.add(tag)
    render()
    const url = new URL(kit[tag] ?? '', win.location.href).href
    win.setTimeout(() => show(tag), HIDE_LIMIT)
    win.customElements.whenDefined(tag).then(
      () => show(tag),
      () => {},
    )
    load(url).catch(() => {
      show(tag)
      win.console.error(`Dossier could not load the component ${url}`)
    })
  }

  for (const tag of deps.used) importTag(tag)

  /** Every kit element in what was added, once per tag. */
  const scan = (node: Node): void => {
    if (node.nodeType !== 1) return
    const element = node as Element
    const name = element.localName
    if (tags.has(name)) importTag(name)
    for (const child of element.querySelectorAll('*')) {
      if (tags.has(child.localName)) importTag(child.localName)
    }
  }
  if (tags.size > imported.size) {
    unsubscribe = addedNodes(win).subscribe(scan)
  }

  return { stop: () => unsubscribe?.() }
}
