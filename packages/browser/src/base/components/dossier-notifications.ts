// <dossier-notifications>: a bell a page or kit puts in its own header, with
// the viewer's notifications on pages of the page's own tree, as Dossier's
// own screens show them; the shell names the tree. It reads through the page client only (`dossier.notifications`), so
// it acts as the viewer, and shows nothing to a visitor. It renders into the
// page's own DOM with minimal styles in the base layer, which page CSS
// overrides. A notification is a link: the page client opens it, another
// page of the tree in the shell, anything else at the top.
import {
  bellName,
  notificationActor,
  notificationWhat,
  notificationWhere,
  timeAgo,
  unreadBadge,
  type DossierNotification,
} from '@dossier/contracts/bridge'
import type { Dossier } from '../../page-client/create-page-client.ts'
import { addBaseStyles } from '../styles.ts'

export const TAG = 'dossier-notifications'

/** How often the unread count is asked again while the page is open. */
export const REFRESH_MS = 60_000

export const TEXT = {
  title: 'Notifications',
  markAll: 'Mark all as read',
  more: 'Show more',
  empty: "You're all caught up",
  loading: 'Loading…',
  unread: 'Unread',
  agent: 'Agent',
  failed: 'Notifications could not load. Try again in a moment.',
} as const

const STYLES = `
:where(dossier-notifications) { display: inline-block; position: relative; }
:where(dossier-notifications[hidden], dossier-notifications [hidden]) {
  display: none !important;
}
:where(.dossier-notifications-hidden) {
  position: absolute; inline-size: 1px; block-size: 1px; margin: -1px;
  padding: 0; border: 0; overflow: hidden; clip-path: inset(50%);
  white-space: nowrap;
}
:where(.dossier-notifications :focus-visible) {
  outline: 2px solid var(--ring, currentColor); outline-offset: 2px;
}
:where(.dossier-notifications-button) {
  position: relative; display: inline-grid; place-items: center;
  min-inline-size: 2.75rem; min-block-size: 2.75rem; padding: 0;
  font: inherit; color: inherit; background: transparent; cursor: pointer;
  border: 1px solid var(--border, transparent);
  border-radius: var(--radius, 0.375rem);
}
:where(.dossier-notifications-button svg) {
  inline-size: 1.25rem; block-size: 1.25rem;
}
:where(.dossier-notifications-badge) {
  position: absolute; inset-block-start: 0.125rem; inset-inline-end: 0.125rem;
  min-inline-size: 1.125rem; block-size: 1.125rem; padding-inline: 0.25rem;
  box-sizing: border-box; display: grid; place-items: center;
  border-radius: 999px; font-size: 0.6875rem; font-weight: 700; line-height: 1;
  color: var(--primary-foreground, Canvas);
  background: var(--primary, CanvasText);
}
:where(.dossier-notifications-panel) {
  position: absolute; z-index: 20; inset-block-start: calc(100% + 0.375rem);
  inset-inline-end: 0; inline-size: min(24rem, calc(100vw - 1rem));
  max-block-size: min(32rem, 75vh); overflow: auto; box-sizing: border-box;
  color: var(--card-foreground, inherit);
  background: var(--card, var(--background, Canvas));
  border: 1px solid var(--border, color-mix(in srgb, currentColor 22%, transparent));
  border-radius: var(--radius, 0.375rem); padding: 0.375rem;
  box-shadow: 0 1rem 2.5rem color-mix(in srgb, CanvasText 18%, transparent);
  text-align: start;
}
:where(.dossier-notifications-head) {
  display: flex; flex-wrap: wrap; align-items: center;
  justify-content: space-between; gap: 0.5rem; padding-inline: 0.5rem;
}
:where(.dossier-notifications-title) {
  margin: 0; font-size: 1em; font-weight: 600;
}
:where(.dossier-notifications-action) {
  font: inherit; font-size: 0.875em; color: inherit; background: transparent;
  border: 0; border-radius: var(--radius, 0.375rem); cursor: pointer;
  min-block-size: 2.75rem; padding-inline: 0.5rem; text-decoration: underline;
}
:where(.dossier-notifications-list) { list-style: none; margin: 0; padding: 0; }
:where(.dossier-notifications-item) {
  position: relative; display: grid; gap: 0.25rem 0.625rem;
  grid-template-columns: auto minmax(0, 1fr);
  padding-block: 0.625rem; padding-inline: 0.5rem;
  color: inherit; text-decoration: none;
  border-radius: var(--radius, 0.375rem);
}
:where(.dossier-notifications-item:hover) {
  background: color-mix(in srgb, currentColor 8%, transparent);
}
:where(.dossier-notifications-item[data-unread]) {
  background: color-mix(in srgb, var(--primary, currentColor) 10%, transparent);
}
:where(.dossier-notifications-item[data-unread])::after {
  content: ''; position: absolute; inset-block-start: 0.875rem;
  inset-inline-end: 0.5rem; inline-size: 0.5rem; block-size: 0.5rem;
  border-radius: 50%; background: var(--primary, currentColor);
}
:where(.dossier-notifications-avatar) {
  position: relative; display: grid; place-items: center; overflow: hidden;
  inline-size: 2rem; block-size: 2rem; border-radius: 50%;
  font-weight: 600; font-size: 0.875em; text-transform: uppercase;
  background: color-mix(in srgb, currentColor 14%, transparent);
}
:where(.dossier-notifications-avatar > img) {
  position: absolute; inset: 0; inline-size: 100%; block-size: 100%;
  object-fit: cover;
}
:where(.dossier-notifications-text) {
  display: grid; gap: 0.125rem; min-inline-size: 0; padding-inline-end: 1rem;
  font-size: 0.875em; overflow-wrap: anywhere;
}
:where(.dossier-notifications-who) { font-weight: 600; }
:where(.dossier-notifications-agent) {
  font-size: 0.75em; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; border-radius: 0.375em; padding-inline: 0.375em;
  border: 1px solid var(--border, color-mix(in srgb, currentColor 30%, transparent));
}
:where(.dossier-notifications-where, .dossier-notifications-time) {
  color: var(--muted-foreground, inherit);
}
:where(.dossier-notifications-excerpt) {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden;
}
:where(.dossier-notifications-empty, .dossier-notifications-status) {
  margin: 0; padding-block: 0.75rem; padding-inline: 0.5rem;
  font-size: 0.875em; color: var(--muted-foreground, inherit);
}
:where(.dossier-notifications-status:empty) { display: none; }
:where(.dossier-notifications-more) {
  display: block; inline-size: 100%; text-align: center;
}
@media (max-width: 30rem) {
  :where(.dossier-notifications-panel) {
    position: fixed; inset-inline: 0.5rem; inline-size: auto;
    inset-block-start: 3.5rem; max-block-size: calc(100dvh - 4.5rem);
  }
}
`

const SVG = 'http://www.w3.org/2000/svg'

/** A bell, drawn in the text's colour. */
const bellIcon = (doc: Document): SVGSVGElement => {
  const svg = doc.createElementNS(SVG, 'svg')
  for (const [name, value] of [
    ['viewBox', '0 0 24 24'],
    ['fill', 'none'],
    ['stroke', 'currentColor'],
    ['stroke-width', '2'],
    ['stroke-linecap', 'round'],
    ['stroke-linejoin', 'round'],
    ['aria-hidden', 'true'],
    ['focusable', 'false'],
  ] as const) {
    svg.setAttribute(name, value)
  }
  for (const d of [
    'M10.27 21a2 2 0 0 0 3.46 0',
    'M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33',
  ]) {
    const path = doc.createElementNS(SVG, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

let ids = 0
const uid = (part: string): string => `${TAG}-${part}-${++ids}`

interface Parts {
  readonly button: HTMLButtonElement
  readonly name: HTMLSpanElement
  readonly badge: HTMLSpanElement
  readonly panel: HTMLDivElement
  readonly title: HTMLHeadingElement
  readonly list: HTMLUListElement
  readonly empty: HTMLParagraphElement
  readonly status: HTMLParagraphElement
  readonly markAll: HTMLButtonElement
  readonly more: HTMLButtonElement
}

export class DossierNotifications extends HTMLElement {
  readonly #dossier: Dossier | null
  #parts: Parts | null = null
  #items: DossierNotification[] = []
  #next: string | null = null
  #unread = 0
  #loaded = false
  #signedIn = false
  /** Bumped on every connect and disconnect, so late answers are dropped. */
  #session = 0
  #timer: ReturnType<typeof setInterval> | undefined

  readonly #onOutside = (event: Event): void => {
    if (this.#isOpen() && !event.composedPath().includes(this)) {
      this.#close(false)
    }
  }
  readonly #onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.#isOpen()) {
      event.preventDefault()
      this.#close(true)
    }
  }
  readonly #onFocus = (): void => {
    if (this.ownerDocument.visibilityState !== 'hidden') this.#refresh()
  }

  constructor(dossier: Dossier | null = null) {
    super()
    this.#dossier = dossier
  }

  connectedCallback(): void {
    if (this.#parts === null) this.#build()
    const session = ++this.#session
    const dossier = this.#dossier
    const doc = this.ownerDocument
    // Away from Dossier, and for a visitor, there is no bell.
    this.hidden = true
    if (dossier === null || typeof dossier.notifications !== 'object') return
    doc.addEventListener('pointerdown', this.#onOutside)
    doc.addEventListener('keydown', this.#onKey)
    dossier.ready.then(
      () => {
        if (session !== this.#session || dossier.me === null) return
        this.#signedIn = true
        this.hidden = false
        this.#refresh()
        doc.defaultView?.addEventListener('focus', this.#onFocus)
        doc.addEventListener('visibilitychange', this.#onFocus)
        this.#timer = setInterval(this.#onFocus, REFRESH_MS)
      },
      () => {},
    )
  }

  disconnectedCallback(): void {
    this.#session += 1
    clearInterval(this.#timer)
    const doc = this.ownerDocument
    doc.defaultView?.removeEventListener('focus', this.#onFocus)
    doc.removeEventListener('visibilitychange', this.#onFocus)
    doc.removeEventListener('pointerdown', this.#onOutside)
    doc.removeEventListener('keydown', this.#onKey)
  }

  #build(): void {
    const doc = this.ownerDocument
    addBaseStyles(doc, TAG, STYLES)
    this.classList.add(TAG)
    const panelId = uid('panel')
    const titleId = uid('title')
    const element = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      className: string,
      text = '',
    ): HTMLElementTagNameMap[K] => {
      const made = doc.createElement(tag)
      made.className = className
      if (text !== '') made.textContent = text
      return made
    }

    const button = element('button', 'dossier-notifications-button')
    button.type = 'button'
    button.setAttribute('aria-expanded', 'false')
    button.setAttribute('aria-controls', panelId)
    button.setAttribute('aria-haspopup', 'dialog')
    const name = element('span', 'dossier-notifications-hidden')
    const badge = element('span', 'dossier-notifications-badge')
    badge.setAttribute('aria-hidden', 'true')
    badge.hidden = true
    button.append(bellIcon(doc), name, badge)
    button.addEventListener('click', () =>
      this.#isOpen() ? this.#close(true) : this.#openPanel(),
    )

    const panel = element('div', 'dossier-notifications-panel')
    panel.id = panelId
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-labelledby', titleId)
    panel.hidden = true
    const head = element('div', 'dossier-notifications-head')
    const title = element('h2', 'dossier-notifications-title', TEXT.title)
    title.id = titleId
    title.tabIndex = -1
    const markAll = element(
      'button',
      'dossier-notifications-action dossier-notifications-mark-all',
      TEXT.markAll,
    )
    markAll.type = 'button'
    markAll.hidden = true
    markAll.addEventListener('click', () => this.#readAll())
    head.append(title, markAll)
    const status = element('p', 'dossier-notifications-status')
    status.setAttribute('role', 'status')
    const list = element('ul', 'dossier-notifications-list')
    const empty = element('p', 'dossier-notifications-empty', TEXT.empty)
    empty.hidden = true
    const more = element(
      'button',
      'dossier-notifications-action dossier-notifications-more',
      TEXT.more,
    )
    more.type = 'button'
    more.hidden = true
    more.addEventListener('click', () => void this.#load(true))
    panel.append(head, status, list, empty, more)

    this.replaceChildren(button, panel)
    this.#parts = {
      button,
      name,
      badge,
      panel,
      title,
      list,
      empty,
      status,
      markAll,
      more,
    }
    this.#renderCount()
  }

  #isOpen(): boolean {
    return this.#parts !== null && !this.#parts.panel.hidden
  }

  /** The unread count again, and the list when it is open. */
  #refresh(): void {
    const dossier = this.#dossier
    if (dossier === null || !this.#signedIn) return
    if (this.#isOpen()) {
      void this.#load(false)
      return
    }
    const session = this.#session
    dossier.notifications.unread().then(
      (unread) => {
        if (session !== this.#session) return
        this.#unread = unread
        this.#renderCount()
      },
      () => {},
    )
  }

  #openPanel(): void {
    const parts = this.#parts!
    parts.panel.hidden = false
    parts.button.setAttribute('aria-expanded', 'true')
    parts.title.focus({ preventScroll: true })
    void this.#load(false)
  }

  #close(focus: boolean): void {
    const parts = this.#parts!
    parts.panel.hidden = true
    parts.button.setAttribute('aria-expanded', 'false')
    if (focus) parts.button.focus()
  }

  /** The newest page, or with `more` the next older one after it. */
  async #load(more: boolean): Promise<void> {
    const dossier = this.#dossier
    const parts = this.#parts!
    if (dossier === null) return
    const session = this.#session
    if (!this.#loaded) parts.status.textContent = TEXT.loading
    try {
      const page = await dossier.notifications.list({
        before: more ? this.#next : null,
      })
      if (session !== this.#session) return
      const had = new Set(this.#items.map((n) => n.id))
      this.#items = more
        ? [...this.#items, ...page.notifications.filter((n) => !had.has(n.id))]
        : [...page.notifications]
      this.#next = page.next
      this.#unread = page.unread
      this.#loaded = true
      parts.status.textContent = ''
    } catch {
      if (session !== this.#session) return
      parts.status.textContent = TEXT.failed
    }
    this.#renderCount()
    this.#renderList()
  }

  #readAll(): void {
    const dossier = this.#dossier
    if (dossier === null) return
    this.#items = this.#items.map((n) => ({ ...n, read: true }))
    this.#unread = 0
    this.#renderCount()
    this.#renderList()
    // The button pressed goes away: focus stays in the panel.
    this.#parts!.title.focus({ preventScroll: true })
    const session = this.#session
    dossier.notifications.read('all').then(
      (unread) => {
        if (session !== this.#session) return
        this.#unread = unread
        this.#renderCount()
      },
      () => {
        if (session === this.#session) {
          this.#parts!.status.textContent = TEXT.failed
        }
      },
    )
  }

  /** A notification chosen: read now, while its link goes on as any link. */
  #choose(n: DossierNotification): void {
    if (!n.read) {
      this.#items = this.#items.map((had) =>
        had.id === n.id ? { ...had, read: true } : had,
      )
      this.#unread = Math.max(0, this.#unread - 1)
      this.#renderCount()
    }
    this.#dossier?.notifications.read([n.id]).catch(() => {})
  }

  #renderCount(): void {
    const parts = this.#parts!
    const badge = unreadBadge(this.#unread)
    parts.badge.textContent = badge
    parts.badge.hidden = badge === ''
    parts.name.textContent = bellName(this.#unread)
    this.toggleAttribute('data-unread', this.#unread > 0)
  }

  #renderList(): void {
    const parts = this.#parts!
    const doc = this.ownerDocument
    const now = new Date()
    const span = (className: string, text: string): HTMLSpanElement => {
      const made = doc.createElement('span')
      made.className = className
      made.dir = 'auto'
      made.textContent = text
      return made
    }
    // A refresh keeps focus on the notification it was on.
    const active = doc.activeElement
    const focused =
      active !== null && parts.list.contains(active)
        ? (active.closest('[data-id]')?.getAttribute('data-id') ?? null)
        : null
    parts.list.replaceChildren(
      ...this.#items.map((n) => {
        const item = doc.createElement('li')
        const link = doc.createElement('a')
        link.className = 'dossier-notifications-item'
        link.href = n.link
        link.setAttribute('data-id', n.id)
        if (!n.read) link.setAttribute('data-unread', '')
        link.addEventListener('click', () => this.#choose(n))
        const who = notificationActor(n)
        const avatar = span('dossier-notifications-avatar', '')
        avatar.setAttribute('aria-hidden', 'true')
        avatar.textContent = Array.from(who)[0] ?? '?'
        const image = n.actor?.image ?? null
        if (image !== null) {
          const img = doc.createElement('img')
          img.alt = ''
          img.src = image
          img.referrerPolicy = 'no-referrer'
          img.addEventListener('error', () => img.remove())
          avatar.append(img)
        }
        const text = doc.createElement('span')
        text.className = 'dossier-notifications-text'
        const line = span('dossier-notifications-line', '')
        if (!n.read) {
          line.append(span('dossier-notifications-hidden', `${TEXT.unread}: `))
        }
        line.append(span('dossier-notifications-who', who))
        // Written with the CLI, through the person's agent key.
        if (n.agent) {
          line.append(' ', span('dossier-notifications-agent', TEXT.agent))
        }
        line.append(` ${notificationWhat(n)}`)
        const time = doc.createElement('time')
        time.className = 'dossier-notifications-time'
        time.dateTime = n.at
        time.title = new Date(n.at).toLocaleString()
        time.textContent = timeAgo(n.at, now)
        text.append(
          line,
          span('dossier-notifications-where', notificationWhere(n)),
          span('dossier-notifications-excerpt', n.excerpt),
          time,
        )
        link.append(avatar, text)
        item.append(link)
        return item
      }),
    )
    if (focused !== null) {
      const again = [
        ...parts.list.querySelectorAll<HTMLElement>('[data-id]'),
      ].find((link) => link.getAttribute('data-id') === focused)
      // Gone from the list: the list's title holds focus instead.
      ;(again ?? parts.title).focus({ preventScroll: true })
    }
    parts.empty.hidden = !this.#loaded || this.#items.length > 0
    parts.markAll.hidden =
      this.#unread === 0 && this.#items.every((n) => n.read)
    parts.more.hidden = this.#next === null
  }
}

/** Defines `<dossier-notifications>` for `dossier`, once per registry. */
export const define = (
  registry: CustomElementRegistry,
  dossier: Dossier,
): void => {
  if (registry.get(TAG) !== undefined) return
  registry.define(
    TAG,
    class extends DossierNotifications {
      constructor() {
        super(dossier)
      }
    },
  )
}

const page =
  typeof window === 'undefined'
    ? undefined
    : (window as Window & { readonly dossier?: Dossier })

if (page?.dossier !== undefined && typeof customElements !== 'undefined') {
  define(customElements, page.dossier)
}
