// The pins over images, drawn in the component's own layer and placed from
// each pinned element's box, so the page's markup stays as it is. Positions
// are physical pixels from JavaScript: an image does not mirror in a
// right-to-left page, so neither do its pins.
import { button, uid } from './composer.ts'
import {
  labelOf,
  movePin,
  pinFromPoint,
  pinPosition,
  pinText,
  type Pin,
} from './threads.ts'

/** A thread's numbered marker on its element. */
export interface PinMark {
  /** The thread's root path. */
  readonly key: string
  readonly number: number
  readonly target: Element
  readonly pin: Pin
  /** What the marker is called: 'Pin 2: On Mockup, by sara@acme.com'. */
  readonly label: string
}

/** Choosing where a new comment's pin goes. */
export interface Placing {
  /** Every element a pin may sit on. */
  readonly targets: readonly Element[]
  /** Where the keyboard's marker is now. */
  readonly target: Element
  readonly pin: Pin
}

export interface PinLayerEvents {
  /** A marker was pressed: go to its thread. */
  readonly open: (key: string) => void
  readonly move: (target: Element, pin: Pin) => void
  readonly place: (target: Element, pin: Pin) => void
  readonly cancel: () => void
}

/** Small and large steps of the arrow keys, as fractions of the element. */
export const PIN_STEP = 0.02
export const PIN_BIG_STEP = 0.1

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

const nameOf = (element: Element): string =>
  labelOf(element) ?? `#${element.id}`

type Win = Window & typeof globalThis

export class PinLayer {
  /** `.dossier-comments-pins`: no height, in the component's flow. */
  readonly element: HTMLDivElement
  readonly #events: PinLayerEvents
  readonly #markers = new Map<string, HTMLButtonElement>()
  readonly #overlays = new Map<Element, HTMLDivElement>()
  /** The keyboard's marker while placing; kept so it keeps focus. */
  readonly #draft: HTMLButtonElement
  /** A placed pin not sent yet. */
  readonly #dot: HTMLSpanElement
  readonly #announce: HTMLSpanElement
  #marks: readonly PinMark[] = []
  #placed: { readonly target: Element; readonly pin: Pin } | null = null
  #placing: Placing | null = null
  #frame = 0
  #observer: ResizeObserver | null = null
  #connected = false
  /** Following the layout: only while connected with something to place. */
  #listening = false

  constructor(document: Document, events: PinLayerEvents) {
    this.#events = events
    const layer = document.createElement('div')
    layer.className = 'dossier-comments-pins'
    const help = document.createElement('span')
    help.className = 'dossier-comments-hidden'
    help.id = uid('pin-help')
    help.textContent =
      'Arrow keys move the pin, with Shift in larger steps. Enter places it. Escape cancels.'
    const announce = document.createElement('span')
    announce.className = 'dossier-comments-hidden'
    announce.setAttribute('aria-live', 'polite')
    const draft = button(document, '+', 'pin-draft')
    // A marker, not one of the component's plain buttons.
    draft.className = 'dossier-comments-pin dossier-comments-pin-draft'
    draft.setAttribute('aria-describedby', help.id)
    draft.hidden = true
    draft.addEventListener('keydown', (event) => this.#key(event))
    draft.addEventListener('click', () => {
      const placing = this.#placing
      if (placing !== null) events.place(placing.target, placing.pin)
    })
    const dot = document.createElement('span')
    dot.className = 'dossier-comments-pin dossier-comments-pin-draft'
    dot.setAttribute('aria-hidden', 'true')
    dot.textContent = '+'
    dot.hidden = true
    layer.append(help, announce, dot, draft)
    this.element = layer
    this.#draft = draft
    this.#dot = dot
    this.#announce = announce
  }

  /**
   * Starts following the page's layout, once it has something to place: a
   * page with many elements and no pins follows nothing.
   */
  connect(): void {
    if (this.#connected) return
    this.#connected = true
    this.#follow()
  }

  disconnect(): void {
    if (!this.#connected) return
    this.#connected = false
    this.#follow()
  }

  /** Whether there is anything to place over the page. */
  #drawing(): boolean {
    return (
      this.#marks.length > 0 ||
      this.#overlays.size > 0 ||
      this.#placed !== null ||
      this.#placing !== null
    )
  }

  /** Listens to the layout while connected and drawing, and only then. */
  #follow(): void {
    const wanted = this.#connected && this.#drawing()
    if (wanted === this.#listening) return
    this.#listening = wanted
    if (wanted) this.#listen()
    else this.#unlisten()
  }

  #listen(): void {
    const doc = this.element.ownerDocument
    const win = doc.defaultView as Win | null
    win?.addEventListener('resize', this.#schedule)
    doc.addEventListener('scroll', this.#schedule, {
      capture: true,
      passive: true,
    })
    // Images and folded sections change the layout as they load and open.
    doc.addEventListener('load', this.#schedule, true)
    doc.addEventListener('toggle', this.#schedule, true)
    doc.addEventListener('keydown', this.#escape, true)
    if (win !== null && typeof win.ResizeObserver === 'function') {
      this.#observer = new win.ResizeObserver(this.#schedule)
      this.#observer.observe(doc.documentElement)
      this.#observeTargets()
    }
    this.#schedule()
  }

  #unlisten(): void {
    const doc = this.element.ownerDocument
    const win = doc.defaultView as Win | null
    win?.removeEventListener('resize', this.#schedule)
    doc.removeEventListener('scroll', this.#schedule, { capture: true })
    doc.removeEventListener('load', this.#schedule, true)
    doc.removeEventListener('toggle', this.#schedule, true)
    doc.removeEventListener('keydown', this.#escape, true)
    this.#observer?.disconnect()
    this.#observer = null
    if (this.#frame !== 0) win?.cancelAnimationFrame?.(this.#frame)
    this.#frame = 0
  }

  /** Draws the threads' markers, a placed pin, and the placing controls. */
  render(state: {
    readonly marks: readonly PinMark[]
    readonly placed: { readonly target: Element; readonly pin: Pin } | null
    readonly placing: Placing | null
  }): void {
    const doc = this.element.ownerDocument
    this.#marks = state.marks
    this.#placed = state.placed
    this.#placing = state.placing
    const keep = new Set(state.marks.map((mark) => mark.key))
    for (const [key, marker] of this.#markers) {
      if (keep.has(key)) continue
      marker.remove()
      this.#markers.delete(key)
    }
    for (const mark of state.marks) {
      let marker = this.#markers.get(mark.key)
      if (marker === undefined) {
        marker = button(doc, '', `pin:${mark.key}`)
        marker.className = 'dossier-comments-pin'
        marker.addEventListener('click', () => this.#events.open(mark.key))
        this.#markers.set(mark.key, marker)
      }
      marker.textContent = String(mark.number)
      marker.setAttribute('aria-label', mark.label)
      if (marker.parentNode !== this.element) this.element.append(marker)
    }
    const targets = new Set(state.placing?.targets ?? [])
    for (const [target, overlay] of this.#overlays) {
      if (targets.has(target)) continue
      overlay.remove()
      this.#overlays.delete(target)
    }
    for (const target of targets) {
      if (this.#overlays.has(target)) continue
      const overlay = doc.createElement('div')
      overlay.className = 'dossier-comments-pin-target'
      overlay.setAttribute('aria-hidden', 'true')
      overlay.addEventListener('click', (event) => {
        event.preventDefault()
        this.#events.place(
          target,
          pinFromPoint(target.getBoundingClientRect(), event),
        )
      })
      this.#overlays.set(target, overlay)
      // Under the keyboard's marker, so a tap on the marker stays its own.
      this.element.insertBefore(overlay, this.#dot)
    }
    const placing = state.placing
    this.#draft.hidden = placing === null
    if (placing !== null) {
      const where = `${pinText(placing.pin)} on ${nameOf(placing.target)}`
      this.#draft.setAttribute('aria-label', `New pin, ${where}`)
    }
    this.#dot.hidden = state.placed === null || placing !== null
    this.#follow()
    this.#observeTargets()
    this.layout()
  }

  focusDraft(): void {
    if (!this.#draft.hidden) this.#draft.focus({ preventScroll: true })
  }

  /** Places every marker from the boxes of the elements now. */
  layout(): void {
    // Nothing to place: no reading of boxes, which would lay the page out.
    if (!this.#drawing()) return
    const origin = this.element.getBoundingClientRect()
    for (const mark of this.#marks) {
      const marker = this.#markers.get(mark.key)
      if (marker !== undefined) this.#put(marker, mark.target, mark.pin, origin)
    }
    for (const [target, overlay] of this.#overlays) {
      const box = target.getBoundingClientRect()
      overlay.hidden = box.width === 0 && box.height === 0
      overlay.style.left = `${box.left - origin.left}px`
      overlay.style.top = `${box.top - origin.top}px`
      overlay.style.width = `${box.width}px`
      overlay.style.height = `${box.height}px`
    }
    if (this.#placing !== null) {
      this.#put(this.#draft, this.#placing.target, this.#placing.pin, origin)
    } else if (this.#placed !== null) {
      this.#put(this.#dot, this.#placed.target, this.#placed.pin, origin)
    }
  }

  #put(node: HTMLElement, target: Element, pin: Pin, origin: DOMRect): void {
    const box = target.getBoundingClientRect()
    // An element that is not shown has no point to mark; the keyboard's
    // marker stays so it keeps focus.
    if (node !== this.#draft) node.hidden = box.width === 0 && box.height === 0
    const at = pinPosition(box, pin)
    node.style.left = `${box.left - origin.left + at.left}px`
    node.style.top = `${box.top - origin.top + at.top}px`
  }

  #observeTargets(): void {
    const observer = this.#observer
    if (observer === null) return
    for (const mark of this.#marks) observer.observe(mark.target)
    for (const target of this.#overlays.keys()) observer.observe(target)
  }

  readonly #schedule = (): void => {
    if (this.#frame !== 0 || !this.#listening) return
    const win = this.element.ownerDocument.defaultView as Win | null
    if (win === null) return
    const run = (): void => {
      this.#frame = 0
      this.layout()
    }
    this.#frame =
      typeof win.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame(run)
        : win.setTimeout(run, 16)
  }

  #key(event: KeyboardEvent): void {
    const placing = this.#placing
    if (placing === null) return
    const arrow = ARROWS[event.key]
    if (arrow !== undefined) {
      event.preventDefault()
      const step = event.shiftKey ? PIN_BIG_STEP : PIN_STEP
      const pin = movePin(placing.pin, arrow[0] * step, arrow[1] * step)
      this.#announce.textContent = pinText(pin)
      this.#events.move(placing.target, pin)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      this.#events.place(placing.target, placing.pin)
    }
  }

  readonly #escape = (event: KeyboardEvent): void => {
    if (this.#placing === null || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    this.#events.cancel()
  }
}
