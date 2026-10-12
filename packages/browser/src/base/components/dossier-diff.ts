// <dossier-diff>: the changes between two files of the tree, or a unified
// diff file, rendered with @pierre/diffs and the shared Shiki into the page's
// own DOM. Its lower-level renderers make the markup without the shadow root
// its own component attaches; the stylesheet the markup needs is nested in a
// :where() scope inside a cascade layer, so any page or kit CSS wins. Code
// colours come from the --dossier-code- variables, like highlighted code.
import {
  DiffHunksRenderer,
  parseDiffFromFile,
  parsePatchFiles,
  registerCustomTheme,
  wrapCoreCSS,
  wrapThemeCSS,
  type FileDiffMetadata,
} from '@pierre/diffs'
import { toHtml } from 'hast-util-to-html'

import { scopeCss } from '../css-scope.ts'
import {
  getHighlighter,
  theme,
  THEME_NAME,
  useGrammarBase,
  variableDefaults,
  VARIABLE_PREFIX,
} from '../lib/highlighter.ts'
import { addBaseStyles } from '../styles.ts'

export interface DossierDiffAttributes {
  /** URLs relative to the page. */
  readonly before?: string
  readonly after?: string
  /** A unified diff file. */
  readonly src?: string
  /** Default: from the file extension. */
  readonly lang?: string
  /** Default 'auto'. */
  readonly layout?: 'auto' | 'split' | 'unified'
}

/** A side larger than this is not shown. */
export const DIFF_MAX_BYTES = 1_048_576
/** In 'auto', unified below this width of the element, split from it. */
export const UNIFIED_BELOW_PX = 640

const OWN_STYLES = `
:where(dossier-diff) { display: block; }
:where(.dossier-diff) { display: block; }
:where(.dossier-diff-toolbar) {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25em 0.75em;
  padding-block: 0.25em; font-size: 0.875em;
}
:where(.dossier-diff-files) { overflow-wrap: anywhere; }
:where(.dossier-diff-counts) { font-variant-numeric: tabular-nums; }
:where(.dossier-diff-toolbar:has(.dossier-diff-files:empty)) { display: none; }
:where(.dossier-diff-status:empty) { display: none; }
:where(.dossier-diff-code) {
  display: block; overflow: auto;
  border: 1px solid var(--border, color-mix(in srgb, currentColor 20%, transparent));
  border-radius: var(--radius, 0.375rem);
  font-family: var(--font-mono, monospace);
}
:where(.dossier-diff-code:focus-visible) {
  outline: 2px solid var(--ring, currentColor); outline-offset: 2px;
}
:where(.dossier-diff-code:empty) { display: none; }
`

/** A --dossier-code- variable with its light-dark() default. */
const codeVariable = (name: string): string =>
  `var(${VARIABLE_PREFIX}${name}, ${variableDefaults[name]})`

/** The library's own stylesheet, scoped to the code region. */
const libraryStyles = (core: string, themeStyles: string): string =>
  scopeCss(
    `${wrapCoreCSS(core)}\n${wrapThemeCSS(themeStyles, 'system')}\n` +
      // The page decides light or dark, not the viewer's system setting.
      '@layer page{:host{color-scheme:inherit;' +
      '--diffs-font-family:var(--font-mono,monospace);' +
      `--diffs-addition-color-override:${codeVariable('token-inserted')};` +
      `--diffs-deletion-color-override:${codeVariable('token-deleted')};` +
      `--diffs-modified-color-override:${codeVariable('token-changed')}}}`,
    '.dossier-diff-code',
    'dossier-diff',
  )

let themed = false
const useTheme = (): void => {
  if (themed) return
  themed = true
  registerCustomTheme(THEME_NAME, () => Promise.resolve(theme))
}

class Failure extends Error {}

/** A side's text, or a Failure whose message the status shows. */
const load = async (win: Window, href: string, url: string) => {
  let response: Response
  try {
    response = await win.fetch(url)
  } catch {
    throw new Failure(`Could not load ${href}.`)
  }
  if (!response.ok) throw new Failure(`Could not load ${href}.`)
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > DIFF_MAX_BYTES) {
    throw new Failure('This diff is too large to show here.')
  }
  const bytes = await response.arrayBuffer().catch(() => {
    throw new Failure(`Could not load ${href}.`)
  })
  if (bytes.byteLength > DIFF_MAX_BYTES) {
    throw new Failure('This diff is too large to show here.')
  }
  return new TextDecoder().decode(bytes)
}

const countsOf = (diffs: readonly FileDiffMetadata[]) => {
  let added = 0
  let removed = 0
  for (const diff of diffs) {
    for (const hunk of diff.hunks) {
      added += hunk.additionLines
      removed += hunk.deletionLines
    }
  }
  return { added, removed }
}

export class DossierDiff extends HTMLElement {
  static readonly observedAttributes: readonly string[] = [
    'before',
    'after',
    'src',
    'lang',
    'layout',
  ]

  #parts: {
    readonly root: HTMLDivElement
    readonly files: HTMLSpanElement
    readonly counts: HTMLSpanElement
    readonly status: HTMLParagraphElement
    readonly code: HTMLDivElement
  } | null = null
  /** Bumped by every load, so an older one never writes over a newer. */
  #generation = 0
  #diffs: readonly FileDiffMetadata[] | null = null
  #split: boolean | null = null
  #observer: ResizeObserver | null = null

  connectedCallback(): void {
    if (this.#parts === null) this.#build()
    this.#observe()
    void this.#load()
  }

  disconnectedCallback(): void {
    this.#observer?.disconnect()
    this.#observer = null
  }

  attributeChangedCallback(name: string): void {
    if (this.#parts === null || !this.isConnected) return
    if (name === 'layout') {
      this.#observe()
      void this.#show()
    } else {
      void this.#load()
    }
  }

  #build(): void {
    const doc = this.ownerDocument
    addBaseStyles(doc, 'dossier-diff', OWN_STYLES)
    const root = doc.createElement('div')
    root.className = 'dossier-diff'
    const toolbar = doc.createElement('div')
    toolbar.className = 'dossier-diff-toolbar'
    const files = doc.createElement('span')
    files.className = 'dossier-diff-files'
    const counts = doc.createElement('span')
    counts.className = 'dossier-diff-counts'
    // "−2 +3" keeps its signs before its numbers in a right-to-left page.
    counts.dir = 'ltr'
    files.dir = 'auto'
    toolbar.append(files, counts)
    const status = doc.createElement('p')
    status.className = 'dossier-diff-status'
    status.setAttribute('role', 'status')
    const code = doc.createElement('div')
    code.className = 'dossier-diff-code'
    code.tabIndex = 0
    code.setAttribute('role', 'region')
    // The grid of code reads left to right, whatever the page's direction.
    code.dir = 'ltr'
    root.append(toolbar, status, code)
    this.replaceChildren(root)
    this.#parts = { root, files, counts, status, code }
  }

  #layout(): 'auto' | 'split' | 'unified' {
    const value = this.getAttribute('layout')?.trim().toLowerCase()
    return value === 'split' || value === 'unified' ? value : 'auto'
  }

  /** In 'auto', the layout follows the element's own width. */
  #observe(): void {
    const win = this.ownerDocument.defaultView as Window & typeof globalThis
    if (this.#layout() !== 'auto') {
      this.#observer?.disconnect()
      this.#observer = null
      return
    }
    if (this.#observer !== null || typeof win.ResizeObserver !== 'function') {
      return
    }
    this.#observer = new win.ResizeObserver(() => void this.#show())
    this.#observer.observe(this)
  }

  /** Whether the diff shows side by side now. */
  #wantsSplit(): boolean {
    const layout = this.#layout()
    if (layout !== 'auto') return layout === 'split'
    return this.getBoundingClientRect().width >= UNIFIED_BELOW_PX
  }

  #say(text: string): void {
    const parts = this.#parts!
    parts.status.textContent = text
    if (text === 'Loading diff…') parts.root.setAttribute('aria-busy', 'true')
    else parts.root.removeAttribute('aria-busy')
  }

  async #load(): Promise<void> {
    const parts = this.#parts!
    const generation = ++this.#generation
    const win = this.ownerDocument.defaultView!
    const base = this.ownerDocument.baseURI
    const attr = (name: string) => {
      const value = this.getAttribute(name)?.trim() ?? ''
      return value === '' ? null : value
    }
    const src = attr('src')
    const before = attr('before')
    const after = attr('after')
    const lang = attr('lang') ?? undefined
    this.#diffs = null
    this.#split = null
    parts.code.replaceChildren()
    parts.files.textContent = ''
    parts.counts.textContent = ''
    if (src === null && before === null && after === null) {
      this.#say('')
      return
    }
    this.#say('Loading diff…')
    const url = (href: string) => new URL(href, base).href
    let diffs: FileDiffMetadata[]
    let label: string
    try {
      if (src !== null) {
        const text = await load(win, src, url(src))
        diffs = parsePatchFiles(text).flatMap((patch) => patch.files)
        if (lang !== undefined) {
          diffs = diffs.map((diff) => ({ ...diff, lang }) as FileDiffMetadata)
        }
        label = src
      } else {
        const [old, now] = await Promise.all([
          before === null ? null : load(win, before, url(before)),
          after === null ? null : load(win, after, url(after)),
        ])
        const file = (name: string | null, contents: string | null) =>
          name === null || contents === null
            ? null
            : ({ name, contents, ...(lang ? { lang } : {}) } as never)
        diffs = [parseDiffFromFile(file(before, old), file(after, now))]
        label = [before, after].filter((n) => n !== null).join(' → ')
      }
    } catch (error) {
      if (generation !== this.#generation) return
      this.#say(
        error instanceof Failure ? error.message : 'Could not show this diff.',
      )
      return
    }
    if (generation !== this.#generation) return
    this.#diffs = diffs
    const { added, removed } = countsOf(diffs)
    parts.files.textContent = label
    parts.counts.textContent = `−${removed} +${added}`
    parts.code.setAttribute('aria-label', `Changes in ${label}`)
    await this.#show()
  }

  /** Renders the loaded diff in the layout the element wants now. */
  async #show(): Promise<void> {
    const diffs = this.#diffs
    const parts = this.#parts
    if (diffs === null || parts === null) return
    const split = this.#wantsSplit()
    if (split === this.#split) return
    this.#split = split
    const generation = this.#generation
    const doc = this.ownerDocument
    const base = new URL('..', import.meta.url).href.replace(/\/$/, '')
    useGrammarBase(base)
    useTheme()
    await getHighlighter()
    let html = ''
    let styles: string | null = null
    try {
      for (const diff of diffs) {
        const renderer = new DiffHunksRenderer({
          theme: THEME_NAME,
          diffStyle: split ? 'split' : 'unified',
          disableFileHeader: true,
          hunkSeparators: 'line-info-basic',
          overflow: 'scroll',
          lineDiffType: 'word-alt',
        })
        const result = await renderer.asyncRender(diff)
        styles ??= libraryStyles(result.css, result.themeStyles)
        html += toHtml(renderer.renderFullAST(result))
        renderer.cleanUp()
      }
    } catch {
      if (generation === this.#generation) {
        this.#say('Could not show this diff.')
      }
      return
    }
    if (generation !== this.#generation || split !== this.#split) return
    if (styles !== null) addBaseStyles(doc, 'dossier-diff-code', styles)
    const template = doc.createElement('template')
    template.innerHTML = html
    parts.code.replaceChildren(template.content)
    this.#say('')
  }
}

if (
  typeof customElements !== 'undefined' &&
  customElements.get('dossier-diff') === undefined
) {
  customElements.define('dossier-diff', DossierDiff)
}
