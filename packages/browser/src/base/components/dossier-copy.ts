// <dossier-copy>: a button that copies a page's agent version, the text an
// agent gets from the page's link, or another page's or folder's with `src`.
// It asks the page's own host for the Markdown, so the request is
// same-origin, and writes the clipboard inside the click, because Safari only
// allows clipboard writes that start in the person's gesture.
import { addBaseStyles } from '../styles.ts'

export interface DossierCopyAttributes {
  /** A page or folder relative to the page; default the page itself. */
  readonly src?: string
  /** Default 'Copy for agent'. */
  readonly label?: string
}

export const COPY_LABEL = 'Copy for agent'
/** How long "Copied" stays. */
export const COPIED_FOR = 3000

const STYLES = `
:where(.dossier-copy) {
  display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.5em;
}
:where(.dossier-copy-button) {
  font: inherit; color: var(--primary-foreground, inherit);
  background: var(--primary, transparent);
  border: 1px solid var(--border, currentColor);
  border-radius: var(--radius, 0.375rem);
  padding-block: 0.375em; padding-inline: 0.75em; cursor: pointer;
}
:where(.dossier-copy-button:focus-visible) {
  outline: 2px solid var(--ring, currentColor); outline-offset: 2px;
}
:where(.dossier-copy-button[aria-busy="true"]) { cursor: progress; }
:where(.dossier-copy-text) {
  display: block; inline-size: 100%; min-block-size: 8em; font: inherit;
  font-family: var(--font-mono, monospace); color: inherit;
  background: var(--background, transparent);
  border: 1px solid var(--border, currentColor);
  border-radius: var(--radius, 0.375rem);
  padding-block: 0.5em; padding-inline: 0.75em; box-sizing: border-box;
}
`

type Clipboardish = {
  readonly write?: (items: ClipboardItem[]) => Promise<void>
  readonly writeText?: (text: string) => Promise<void>
}

export class DossierCopy extends HTMLElement {
  static readonly observedAttributes: readonly string[] = ['label']

  #button: HTMLButtonElement | null = null
  #status: HTMLSpanElement | null = null
  #text: HTMLTextAreaElement | null = null
  #clear: number | undefined

  connectedCallback(): void {
    if (this.#button !== null) return
    const doc = this.ownerDocument
    addBaseStyles(doc, 'dossier-copy', STYLES)
    this.classList.add('dossier-copy')
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'dossier-copy-button'
    button.textContent = this.#label()
    button.addEventListener('click', () => this.#copy())
    const status = doc.createElement('span')
    status.className = 'dossier-copy-status'
    status.setAttribute('role', 'status')
    this.replaceChildren(button, status)
    this.#button = button
    this.#status = status
  }

  attributeChangedCallback(): void {
    if (this.#button !== null) this.#button.textContent = this.#label()
  }

  #label(): string {
    const label = this.getAttribute('label')?.trim() ?? ''
    return label === '' ? COPY_LABEL : label
  }

  /** The URL of the text: `src` against the page, or the page itself. */
  #url(): string {
    const win = this.ownerDocument.defaultView!
    const src = this.getAttribute('src')
    const url = new URL(
      src === null || src.trim() === '' ? win.location.href : src,
      this.ownerDocument.baseURI,
    )
    url.hash = ''
    return url.href
  }

  #say(text: string): void {
    const win = this.ownerDocument.defaultView!
    win.clearTimeout(this.#clear)
    if (this.#status !== null) this.#status.textContent = text
  }

  #copy(): void {
    const win = this.ownerDocument.defaultView! as Window & typeof globalThis
    const button = this.#button!
    this.#text?.remove()
    this.#text = null
    this.#say('')
    button.setAttribute('aria-busy', 'true')
    let failedToLoad = false
    const text = win
      .fetch(this.#url(), { headers: { Accept: 'text/markdown' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status}`)
        return response.text()
      })
      .catch((error: unknown) => {
        failedToLoad = true
        throw error
      })
    const clipboard = win.navigator.clipboard as Clipboardish | undefined
    const { ClipboardItem } = win
    let written: Promise<void>
    if (typeof ClipboardItem === 'function' && clipboard?.write) {
      // The item's data is a promise, so the write starts inside the click.
      const item = new ClipboardItem({
        'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })),
      })
      written = clipboard.write([item])
    } else if (clipboard?.writeText) {
      const writeText = clipboard.writeText.bind(clipboard)
      written = text.then((t) => writeText(t))
    } else {
      written = text.then(() => Promise.reject(new Error('no clipboard')))
    }
    written.then(
      () => {
        button.removeAttribute('aria-busy')
        this.#say('Copied')
        this.#clear = win.setTimeout(() => this.#say(''), COPIED_FOR)
      },
      async () => {
        let copy: string
        try {
          copy = await text
        } catch {
          failedToLoad = true
        }
        button.removeAttribute('aria-busy')
        if (failedToLoad) {
          this.#say('Could not load the text to copy.')
          return
        }
        this.#offer(copy!)
      },
    )
  }

  /** The clipboard refused: the text, selected, for the person to copy. */
  #offer(copy: string): void {
    const doc = this.ownerDocument
    const area = doc.createElement('textarea')
    area.className = 'dossier-copy-text'
    area.readOnly = true
    area.value = copy
    area.setAttribute('aria-label', this.#label())
    this.append(area)
    this.#text = area
    area.focus()
    area.select()
    this.#say('Copy the selected text.')
  }
}

if (
  typeof customElements !== 'undefined' &&
  customElements.get('dossier-copy') === undefined
) {
  customElements.define('dossier-copy', DossierCopy)
}
