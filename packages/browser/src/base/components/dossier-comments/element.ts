// <dossier-comments>: a page's comment threads, read from the comments
// folder beside the page and written through the page client's public calls
// only, so a replacement component in a kit writes the same files. It
// renders into the page's own DOM, follows the folder with a watch, and
// keeps the focused control across every re-render. With `for`, it shows
// and writes only the threads on that one element of the page.
import {
  COMMENT_MENTIONS_MAX,
  COMMENT_TEXT_MAX,
  DossierError,
  ERRORS,
  isErrorCode,
  type CommentDoc,
  type CommentEntry,
  type Doc,
  type JsonObject,
  type Me,
  type Thread,
} from '@dossier/contracts/bridge'
import type { Dossier } from '../../../page-client/create-page-client.ts'
import { addBaseStyles } from '../../styles.ts'
import { button, Composer, StatusLine, uid } from './composer.ts'
import { PinLayer, type PinMark } from './pins.ts'
import { STYLES } from './styles.ts'
import {
  anchorElement,
  commentsFolder,
  DEFAULT_ANCHORS,
  DEFAULT_PINS,
  elementsFor,
  fullTime,
  isThreadDoc,
  knownEmails,
  labelOf,
  mentionsIn,
  pinText,
  placeThreads,
  shortTime,
  stancesOf,
  TAG,
  type Pin,
  type PlacedThread,
} from './threads.ts'

/** The detail of the bubbling `dossier:state` event. */
export interface CommentsStateDetail {
  readonly state: 'saving' | 'saved' | 'failed'
  readonly error: DossierError | null
  readonly doc: Doc | null
}

/**
 * The detail of the bubbling `dossier:comments` event, fired whenever the
 * threads an element shows change: every thread of the page, or with `for`
 * those on its element, as `dossier.read('<page>.comments/')` gives them.
 */
export interface CommentsDetail {
  readonly threads: readonly Doc<Thread>[]
}

export const TEXT = {
  title: 'Comments',
  empty: 'No comments yet.',
  noneOpen: 'No open comments.',
  showResolved: 'Show resolved',
  earlier: 'On an earlier version',
  wholePage: 'Whole page',
  onWholePage: 'On the whole page',
  on: 'On',
  addComment: 'Add a comment',
  comment: 'Comment',
  reply: 'Reply',
  resolve: 'Resolve',
  reopen: 'Reopen',
  edit: 'Edit',
  editComment: 'Edit comment',
  save: 'Save',
  cancel: 'Cancel',
  delete: 'Delete',
  askDelete: 'Delete?',
  confirmDelete: 'Yes, delete',
  deleted: 'Comment deleted',
  edited: 'edited',
  stance: 'Stance',
  noStance: 'None',
  pinOnImage: 'Pin on image',
  movePin: 'Move pin',
  cancelPin: 'Cancel pin',
  removePin: 'Remove pin',
  visitor:
    'Commenting asks you to sign in first. What you write is kept and sent after.',
  signingIn: 'Taking you to sign in…',
  signInToComment: 'Sign in to comment.',
  saving: 'Saving…',
  saved: 'Saved',
  writeSomething: 'Write something to comment.',
  tooManyMentions: `A comment mentions at most ${COMMENT_MENTIONS_MAX} people.`,
  offline: ERRORS.offline.message,
  rateLimited: 'Too many sends. Try again in a minute.',
  forbidden: ERRORS.forbidden.message,
  unavailable: ERRORS.unavailable.message,
  notInDossier: 'Comments show when this page is open in Dossier.',
} as const

export const tooLong = (length: number): string =>
  `A comment holds at most ${COMMENT_TEXT_MAX.toLocaleString('en-US')} characters; this one has ${length.toLocaleString('en-US')}.`

/** The attribute counting an anchored element's open threads. */
export const MARK = 'data-dossier-comments'

/** Where a visitor's comment waits in sessionStorage while they sign in. */
export const keptKey = (pagePath: string): string => `${TAG}:${pagePath}`

/**
 * Where the new comment's unsent text waits in sessionStorage, so a send
 * that failed, or a reload, never loses what was typed: one per person,
 * and one for visitors, so nobody finds another's text; and one per item
 * for an element with `for`.
 */
export const draftKey = (
  pagePath: string,
  viewer: string | null,
  scope: string | null = null,
): string =>
  `${TAG}-draft:${viewer === null ? 'visitor' : `person:${viewer.toLowerCase()}`}:${pagePath}${scope === null ? '' : `#${scope}`}`

/**
 * How long a comment kept for sign-in goes on its own once its person is
 * back: the round trip its Comment press started, and no later visit.
 */
export const ROUND_TRIP_MS = 15 * 60_000

/** What a person who signs in reads beside a comment kept before it. */
export const claimText = (email: string): string =>
  `Signed in as ${email}. Your comment is back here: send it when it is right.`

type Win = Window & typeof globalThis

type Follower = (value: unknown) => void

interface Feed {
  readonly followers: Set<Follower>
  stop: () => void
  /** The watch's last value, for an element that joins after it came. */
  last: { readonly value: unknown } | null
}

/**
 * One watch per comments folder, however many elements show it: a page with
 * an element under each of its items reads the folder once per change.
 */
const feeds = new WeakMap<Dossier, Map<string, Feed>>()

const follow = (
  dossier: Dossier,
  folder: string,
  follower: Follower,
): (() => void) => {
  let byFolder = feeds.get(dossier)
  if (byFolder === undefined) {
    byFolder = new Map()
    feeds.set(dossier, byFolder)
  }
  const known = byFolder.get(folder)
  const feed: Feed = known ?? {
    followers: new Set(),
    stop: () => {},
    last: null,
  }
  feed.followers.add(follower)
  if (known === undefined) {
    byFolder.set(folder, feed)
    feed.stop = dossier.watch(folder, (value) => {
      feed.last = { value }
      // As they are now: one that leaves or joins meanwhile changes nothing.
      for (const each of Array.from(feed.followers)) {
        try {
          each(value)
        } catch (error) {
          queueMicrotask(() => {
            throw error
          })
        }
      }
    })
  } else if (feed.last !== null) {
    const { value } = feed.last
    queueMicrotask(() => {
      if (feed.followers.has(follower)) follower(value)
    })
  }
  return () => {
    if (!feed.followers.delete(follower) || feed.followers.size > 0) return
    feed.stop()
    if (byFolder.get(folder) === feed) byFolder.delete(folder)
  }
}

interface ThreadUi {
  readonly root: string
  readonly element: HTMLLIElement
  /** Rebuilt when the thread or its state changes. */
  readonly body: HTMLDivElement
  readonly status: StatusLine
  reply: Composer | null
  stance: HTMLSelectElement | null
  signature: string
}

interface Parts {
  readonly pins: PinLayer
  readonly title: HTMLHeadingElement
  /** With `for`: opens and folds the element, and counts its open threads. */
  readonly opener: HTMLButtonElement
  readonly openerCount: HTMLSpanElement
  readonly count: HTMLSpanElement
  readonly toggle: HTMLButtonElement
  readonly empty: HTMLParagraphElement
  readonly list: HTMLUListElement
  readonly earlier: HTMLDetailsElement
  readonly earlierSummary: HTMLElement
  readonly earlierList: HTMLUListElement
  readonly composer: Composer
  readonly onField: HTMLLabelElement
  readonly on: HTMLSelectElement
  readonly pinButton: HTMLButtonElement
  readonly pinNote: HTMLDivElement
  readonly pinNoteText: HTMLSpanElement
  readonly visitorNote: HTMLParagraphElement
  readonly status: StatusLine
}

interface Send {
  readonly status: StatusLine
  /** Marked busy while it goes, and invalid when the server says so. */
  readonly composer: Composer | null
  readonly run: () => Promise<Doc | void>
  /** What Try again does: the same action, from the controls as they are. */
  readonly again: () => void
  readonly done?: (doc: Doc | null) => void
  readonly failed?: () => void
}

interface Focus {
  readonly element: HTMLElement
  readonly key: string | null
  readonly root: string | null
  readonly selection: readonly [number, number] | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The page client's error as it is: its class comes from another bundle, so
 * it is known by its fields, not by instanceof.
 */
const asError = (error: unknown): DossierError =>
  isRecord(error) &&
  isErrorCode(error.code) &&
  typeof error.message === 'string'
    ? (error as unknown as DossierError)
    : new DossierError({
        code: 'unavailable',
        message: TEXT.unavailable,
        fix: null,
        path: null,
      })

const entryJson = (entry: CommentEntry): JsonObject => ({
  text: entry.text,
  anchor: entry.anchor,
  label: entry.label,
  pin: entry.pin === null ? null : { x: entry.pin.x, y: entry.pin.y },
  replyTo: entry.replyTo,
  stance: entry.stance,
  mentions: [...entry.mentions],
})

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null

/** A kept comment read back, or null when it is not one. */
const keptEntry = (value: unknown): CommentEntry | null => {
  if (!isRecord(value) || typeof value.text !== 'string') return null
  const pin = value.pin
  return {
    text: value.text,
    anchor: textOrNull(value.anchor),
    label: textOrNull(value.label),
    pin:
      isRecord(pin) && typeof pin.x === 'number' && typeof pin.y === 'number'
        ? { x: pin.x, y: pin.y }
        : null,
    replyTo: textOrNull(value.replyTo),
    stance: textOrNull(value.stance),
    mentions: mentionsIn(value.text),
  }
}

const inDocumentOrder = (a: Element, b: Element): number =>
  a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1

/** Puts `wanted` as `parent`'s children in order, moving only what is out of place. */
const arrange = (parent: Element, wanted: readonly Element[]): void => {
  wanted.forEach((child, index) => {
    const at = parent.children[index]
    if (at !== child) parent.insertBefore(child, at ?? null)
  })
  while (parent.children.length > wanted.length) {
    parent.lastElementChild!.remove()
  }
}

/** Focuses any element, giving it a passing tabindex when it takes none. */
const focusElement = (element: HTMLElement): void => {
  if (!element.hasAttribute('tabindex') && element.tabIndex < 0) {
    element.setAttribute('tabindex', '-1')
    element.addEventListener(
      'blur',
      () => element.removeAttribute('tabindex'),
      { once: true },
    )
  }
  element.focus({ preventScroll: true })
}

export class DossierComments extends HTMLElement {
  static readonly observedAttributes = [
    'anchors',
    'pins',
    'stances',
    'for',
  ] as const

  readonly #dossier: Dossier | null
  #parts: Parts | null = null
  #stopWatch: (() => void) | null = null
  /** Bumped on every connect and disconnect, so late answers are dropped. */
  #session = 0
  #ready = false
  #loaded = false
  /** Every thread of the page. */
  #all: readonly Doc<Thread>[] = []
  /** The threads it shows: every one, or with `for` those on its element. */
  #threads: readonly Doc<Thread>[] = []
  /** What the last `dossier:comments` event carried. */
  #announced = ''
  /** With `for`: the element is open rather than folded to its button. */
  #open = false
  /** The new comment's stance choice, when the page offers stances. */
  #mainStance: HTMLSelectElement | null = null
  #showResolved = false
  /** Bumped by every read and applied watch value; older reads are dropped. */
  #generation = 0
  /** Own sends under way: watch values wait for the read after them. */
  #busy = 0
  #missed = false
  /** Reads in flight: a watch value meanwhile may be older than they are. */
  #reloading = 0
  /** A resolve, reopen or delete pressed while its thread was still sending. */
  readonly #queued = new Map<StatusLine, Send>()
  readonly #uis = new Map<string, ThreadUi>()
  readonly #editing = new Map<string, Composer>()
  readonly #confirming = new Set<string>()
  #marked = new Set<Element>()
  #marks: readonly PinMark[] = []
  /** The new comment's pin, placed but not sent. */
  #pin: { readonly anchor: string; readonly pin: Pin } | null = null
  #placing: { readonly target: Element; readonly pin: Pin } | null = null
  #anchors = ''

  constructor(dossier: Dossier | null = null) {
    super()
    this.#dossier = dossier
  }

  connectedCallback(): void {
    if (this.#parts === null) this.#build()
    const parts = this.#parts!
    const session = ++this.#session
    parts.pins.connect()
    this.#render()
    const dossier = this.#dossier
    if (dossier === null) {
      parts.status.say(TEXT.notInDossier)
      return
    }
    this.#stopWatch?.()
    this.#stopWatch = follow(dossier, this.#folder(), (value) => {
      if (session === this.#session) this.#fromWatch(value)
    })
    dossier.ready.then(
      () => {
        if (session !== this.#session) return
        this.#ready = true
        // Who is viewing is known now: their own unsent text comes back.
        if (parts.composer.text === '') parts.composer.text = this.#draft()
        // An item's element opens on the text someone left unsent in it.
        if (parts.composer.text !== '') this.#open = true
        this.#render()
        this.#claimKept()
      },
      () => {
        if (session === this.#session) parts.status.say(TEXT.unavailable)
      },
    )
  }

  disconnectedCallback(): void {
    this.#session += 1
    this.#stopWatch?.()
    this.#stopWatch = null
    this.#parts?.pins.disconnect()
    this.#placing = null
    for (const element of this.#marked) element.removeAttribute(MARK)
    this.#marked = new Set()
  }

  attributeChangedCallback(
    name: string,
    before: string | null,
    after: string | null,
  ): void {
    if (before === after || this.#parts === null || !this.isConnected) return
    // Another element, or none: the threads it shows are chosen again.
    if (name === 'for' && this.#loaded) this.#take(this.#all)
    else this.#render()
  }

  // Building ---------------------------------------------------------------

  #build(): void {
    const doc = this.ownerDocument
    addBaseStyles(doc, TAG, STYLES)
    this.classList.add(TAG)
    const pins = new PinLayer(doc, {
      open: (key) => this.#openThread(key),
      move: (target, pin) => {
        if (this.#placing === null) return
        this.#placing = { target, pin }
        this.#drawPins()
      },
      place: (target, pin) => this.#placePin(target, pin),
      cancel: () => this.#cancelPlacing(),
    })

    const header = doc.createElement('div')
    header.className = 'dossier-comments-header'
    const title = doc.createElement('h2')
    title.className = 'dossier-comments-title'
    title.id = uid('title')
    title.tabIndex = -1
    title.textContent = TEXT.title
    title.setAttribute('data-key', 'title')
    const count = doc.createElement('span')
    count.className = 'dossier-comments-count'
    count.dir = 'auto'
    const toggle = button(
      doc,
      TEXT.showResolved,
      'show-resolved',
      'dossier-comments-toggle',
    )
    toggle.setAttribute('aria-pressed', 'false')
    toggle.hidden = true
    toggle.addEventListener('click', () => {
      this.#showResolved = !this.#showResolved
      this.#render()
    })
    const opener = button(doc, '', 'open', 'dossier-comments-open')
    opener.setAttribute('aria-expanded', 'false')
    opener.hidden = true
    const openerText = doc.createElement('span')
    openerText.textContent = TEXT.comment
    const openerCount = doc.createElement('span')
    openerCount.className = 'dossier-comments-count'
    openerCount.dir = 'auto'
    openerCount.hidden = true
    opener.replaceChildren(openerText, openerCount)
    opener.addEventListener('click', () => {
      this.#open = !this.#open
      this.#render()
    })
    header.append(title, opener, count, toggle)

    const empty = doc.createElement('p')
    empty.className = 'dossier-comments-empty'
    empty.dir = 'auto'
    empty.hidden = true
    const list = doc.createElement('ul')
    list.className = 'dossier-comments-threads'
    list.setAttribute('aria-labelledby', title.id)
    const earlier = doc.createElement('details')
    earlier.className = 'dossier-comments-earlier'
    earlier.hidden = true
    const earlierSummary = doc.createElement('summary')
    earlierSummary.setAttribute('data-key', 'earlier')
    const earlierList = doc.createElement('ul')
    earlierList.className = 'dossier-comments-threads'
    earlier.append(earlierSummary, earlierList)

    const composer = new Composer({
      document: doc,
      key: 'main',
      label: TEXT.addComment,
      submitLabel: TEXT.comment,
      known: () => this.#known(),
      onSubmit: () => this.#submitMain(),
    })
    const status = new StatusLine(doc, 'main', () => composer.textarea)
    composer.describedBy(status.line.id)
    composer.textarea.addEventListener('input', () => this.#keepDraft())

    const onField = doc.createElement('label')
    onField.className = 'dossier-comments-field'
    const onText = doc.createElement('span')
    onText.textContent = TEXT.on
    const on = doc.createElement('select')
    on.className = 'dossier-comments-select'
    on.setAttribute('data-key', 'on:main')
    on.append(this.#option('', TEXT.wholePage))
    on.addEventListener('change', () => {
      if (this.#pin !== null && this.#pin.anchor !== on.value) this.#pin = null
      this.#render()
    })
    onField.append(onText, on)
    const pinButton = button(doc, TEXT.pinOnImage, 'pin-button:main')
    pinButton.hidden = true
    pinButton.addEventListener('click', () => {
      if (this.#placing !== null) this.#cancelPlacing()
      else this.#startPlacing()
    })
    const pinNote = doc.createElement('div')
    pinNote.className = 'dossier-comments-field'
    pinNote.hidden = true
    const pinNoteText = doc.createElement('span')
    pinNoteText.dir = 'auto'
    const removePin = button(doc, TEXT.removePin, 'remove-pin:main')
    removePin.addEventListener('click', () => {
      this.#pin = null
      this.#render()
      composer.textarea.focus()
    })
    pinNote.append(pinNoteText, removePin)
    composer.extras.append(onField, pinButton, pinNote)
    const visitorNote = doc.createElement('p')
    visitorNote.className = 'dossier-comments-note'
    visitorNote.dir = 'auto'
    visitorNote.textContent = TEXT.visitor
    visitorNote.hidden = true
    composer.extras.after(visitorNote)
    composer.form.hidden = true

    this.replaceChildren(
      pins.element,
      header,
      empty,
      list,
      earlier,
      composer.form,
      status.element,
    )
    this.#parts = {
      pins,
      title,
      opener,
      openerCount,
      count,
      toggle,
      empty,
      list,
      earlier,
      earlierSummary,
      earlierList,
      composer,
      onField,
      on,
      pinButton,
      pinNote,
      pinNoteText,
      visitorNote,
      status,
    }
  }

  #option(value: string, text: string): HTMLOptionElement {
    const option = this.ownerDocument.createElement('option')
    option.value = value
    option.textContent = text
    return option
  }

  // What the component knows ----------------------------------------------

  #me(): Me | null {
    return this.#dossier?.me ?? null
  }

  #folder(): string {
    return commentsFolder(this.#dossier!.page.path)
  }

  /** The id of the one element it comments on (`for`), or null for the page. */
  #scope(): string | null {
    const id = this.getAttribute('for')?.trim() ?? ''
    return id === '' ? null : id
  }

  /** May write: a person who may respond, or a visitor who will sign in. */
  #canWrite(): boolean {
    const me = this.#me()
    return (
      this.#dossier !== null &&
      this.#ready &&
      (me === null || me.role !== 'read')
    )
  }

  #isOwn(comment: CommentDoc): boolean {
    const me = this.#me()
    return (
      me !== null &&
      !comment.deleted &&
      comment.by.toLowerCase() === me.email.toLowerCase()
    )
  }

  #known(): readonly string[] {
    return knownEmails(this.#all, this.#me()?.email ?? null)
  }

  #stances(): string[] {
    return stancesOf(this.getAttribute('stances'))
  }

  #pinTargets(): HTMLElement[] {
    return elementsFor(
      this.ownerDocument,
      this.getAttribute('pins'),
      DEFAULT_PINS,
    )
  }

  /** Every element a comment may be on, in page order, each id once. */
  #anchorElements(): HTMLElement[] {
    const doc = this.ownerDocument
    const all = [
      ...elementsFor(doc, this.getAttribute('anchors'), DEFAULT_ANCHORS),
      ...this.#pinTargets(),
    ].sort(inDocumentOrder)
    const seen = new Set<string>()
    return all.filter((element) => {
      if (seen.has(element.id)) return false
      seen.add(element.id)
      return true
    })
  }

  #thread(root: string): Thread | null {
    return (
      this.#threads.find((doc) => doc.data.root.path === root)?.data ?? null
    )
  }

  // Reading ----------------------------------------------------------------

  #fromWatch(value: unknown): void {
    const docs = Array.isArray(value) ? (value as unknown[]) : []
    // Our own send is under way: the read after it brings this and more.
    if (this.#busy > 0 || this.#reloading > 0) {
      this.#missed = true
      return
    }
    // A single entry the page client just wrote is not a thread: read again.
    if (!docs.every(isThreadDoc)) {
      void this.#reload()
      return
    }
    this.#generation += 1
    this.#take(docs)
  }

  async #reload(): Promise<void> {
    const dossier = this.#dossier
    if (dossier === null) return
    this.#missed = false
    const generation = ++this.#generation
    const session = this.#session
    let docs: unknown
    this.#reloading += 1
    try {
      docs = await dossier.read(this.#folder() as `${string}/`)
    } catch {
      // The watch brings the next change; nothing was lost.
      return
    } finally {
      this.#reloading -= 1
    }
    if (generation !== this.#generation || session !== this.#session) return
    this.#take(Array.isArray(docs) ? (docs as unknown[]) : [])
    // A change came while this read was out: read once more for it.
    if (this.#missed && this.#busy === 0) void this.#reload()
  }

  #take(docs: readonly unknown[]): void {
    this.#all = docs.filter(isThreadDoc)
    const scope = this.#scope()
    this.#threads =
      scope === null
        ? this.#all
        : this.#all.filter((doc) => doc.data.root.anchor === scope)
    this.#loaded = true
    this.#render()
    this.#announce()
  }

  /** Tells the page its threads changed, so it can build on them live. */
  #announce(): void {
    const signature = JSON.stringify(this.#threads)
    if (signature === this.#announced) return
    this.#announced = signature
    const win = this.ownerDocument.defaultView as Win
    const detail: CommentsDetail = { threads: this.#threads }
    this.dispatchEvent(
      new win.CustomEvent('dossier:comments', { bubbles: true, detail }),
    )
  }

  // Rendering --------------------------------------------------------------

  #render(): void {
    const parts = this.#parts
    if (parts === null) return
    const focus = this.#rememberFocus()
    const doc = this.ownerDocument
    const placed = placeThreads(this.#threads, doc)
    const shown = (thread: PlacedThread) =>
      this.#showResolved || !thread.doc.data.resolved
    const all = [...placed.current, ...placed.earlier]
    const open = all.filter((thread) => !thread.doc.data.resolved).length
    const resolved = all.length - open
    // With `for`: a compact element, folded to its button until opened.
    const scoped = this.#scope() !== null
    const unfolded = !scoped || this.#open
    this.classList.toggle('dossier-comments-item', scoped)

    parts.title.hidden = scoped
    parts.opener.hidden = !scoped
    parts.opener.setAttribute('aria-expanded', String(this.#open))
    parts.openerCount.hidden = !this.#loaded || open === 0
    parts.openerCount.textContent = `${open} open`
    parts.count.hidden = scoped || !this.#loaded || all.length === 0
    parts.count.textContent = `${open} open`
    parts.toggle.hidden = resolved === 0 || !unfolded
    parts.toggle.textContent = `${TEXT.showResolved} (${resolved})`
    parts.toggle.setAttribute('aria-pressed', String(this.#showResolved))

    const current = placed.current.filter(shown)
    const earlier = placed.earlier.filter(shown)
    // Pins are drawn and numbered by the whole page's element only.
    const numbers = new Map<string, number>()
    for (const thread of scoped ? [] : current) {
      const { root } = thread.doc.data
      if (root.pin !== null && root.anchor !== null) {
        numbers.set(root.path, numbers.size + 1)
      }
    }
    this.#fill(parts.list, current, numbers)
    this.#fill(parts.earlierList, earlier, numbers)
    parts.list.hidden = !unfolded
    parts.earlier.hidden = earlier.length === 0 || !unfolded
    parts.earlierSummary.textContent = `${TEXT.earlier} (${earlier.length})`
    parts.empty.hidden =
      !unfolded || !this.#loaded || current.length + earlier.length > 0
    parts.empty.textContent = all.length === 0 ? TEXT.empty : TEXT.noneOpen
    this.#forget()

    this.#renderComposer()
    this.#markAnchors(placed.current)
    this.#marks = scoped ? [] : this.#pinMarks(current, numbers)
    this.#drawPins()
    this.#restoreFocus(focus)
  }

  #renderComposer(): void {
    const parts = this.#parts!
    const doc = this.ownerDocument
    const scoped = this.#scope() !== null
    const writable = this.#canWrite() && (!scoped || this.#open)
    parts.composer.form.hidden = !writable
    parts.visitorNote.hidden = !(writable && this.#me() === null)
    // An item's element comments on its item: no choice of place, no pins.
    parts.onField.hidden = scoped
    this.#mainStance = this.#stanceField(
      parts.composer,
      this.#mainStance,
      'main',
    )
    this.#refreshAnchors()
    if (
      this.#pin !== null &&
      (scoped || anchorElement(doc, this.#pin.anchor) === null)
    ) {
      this.#pin = null
    }
    const targets = scoped ? [] : this.#pinTargets()
    if (!writable || targets.length === 0) this.#placing = null
    parts.pinButton.hidden = targets.length === 0
    parts.pinButton.textContent =
      this.#placing !== null
        ? TEXT.cancelPin
        : this.#pin !== null
          ? TEXT.movePin
          : TEXT.pinOnImage
    const pin = this.#pin
    parts.pinNote.hidden = pin === null
    if (pin !== null) {
      const element = anchorElement(doc, pin.anchor)!
      const name = labelOf(element) ?? `#${pin.anchor}`
      parts.pinNoteText.textContent = `Pinned at ${pinText(pin.pin)} on ${name}`
    }
  }

  /** The anchors the composer offers, rebuilt only when they change. */
  #refreshAnchors(): void {
    const select = this.#parts!.on
    const entries = this.#anchorElements().map(
      (element) => [element.id, labelOf(element) ?? `#${element.id}`] as const,
    )
    const signature = JSON.stringify(entries)
    if (signature === this.#anchors) return
    this.#anchors = signature
    const value = select.value
    select.replaceChildren(
      this.#option('', TEXT.wholePage),
      ...entries.map(([id, name]) => this.#option(id, name)),
    )
    select.value = entries.some(([id]) => id === value) ? value : ''
  }

  /** The threads of one list, each rebuilt only when it changed. */
  #fill(
    list: HTMLUListElement,
    threads: readonly PlacedThread[],
    numbers: ReadonlyMap<string, number>,
  ): void {
    const me = this.#me()
    const wanted = threads.map((placed) => {
      const thread = placed.doc.data
      const ui = this.#ui(thread.root.path)
      this.#syncStances(ui)
      const comments = [thread.root, ...thread.replies]
      const signature = JSON.stringify([
        thread,
        placed.anchorFound,
        numbers.get(thread.root.path) ?? null,
        me,
        this.#ready,
        ui.reply !== null,
        comments.map((c) => [
          this.#editing.has(c.path),
          this.#confirming.has(c.path),
        ]),
      ])
      if (signature !== ui.signature) {
        ui.signature = signature
        this.#buildThread(ui, placed, numbers.get(thread.root.path))
      }
      if (thread.resolved) ui.element.setAttribute('data-resolved', '')
      else ui.element.removeAttribute('data-resolved')
      arrange(ui.element, [
        ui.body,
        ...(ui.reply === null ? [] : [ui.reply.form]),
        ui.status.element,
      ])
      return ui.element
    })
    arrange(list, wanted)
  }

  /** Drops the state of threads that are gone, unless something waits there. */
  #forget(): void {
    if (!this.#loaded) return
    const roots = new Set(this.#threads.map((doc) => doc.data.root.path))
    for (const [root, ui] of this.#uis) {
      if (roots.has(root) || ui.reply !== null || ui.status.busy) continue
      ui.element.remove()
      this.#uis.delete(root)
    }
    for (const path of this.#editing.keys()) {
      const live = this.#threads.some(({ data }) =>
        [data.root, ...data.replies].some((c) => c.path === path && !c.deleted),
      )
      if (!live) this.#editing.delete(path)
    }
  }

  #ui(root: string): ThreadUi {
    const known = this.#uis.get(root)
    if (known !== undefined) return known
    const doc = this.ownerDocument
    const element = doc.createElement('li')
    element.className = 'dossier-comments-thread'
    element.tabIndex = -1
    element.setAttribute('data-key', `thread:${root}`)
    element.setAttribute('data-root', root)
    const body = doc.createElement('div')
    body.className = 'dossier-comments-thread-body'
    const status = new StatusLine(
      doc,
      `thread:${root}`,
      () => this.#uis.get(root)?.reply?.textarea ?? element,
    )
    const ui: ThreadUi = {
      root,
      element,
      body,
      status,
      reply: null,
      stance: null,
      signature: '',
    }
    element.append(body, status.element)
    this.#uis.set(root, ui)
    return ui
  }

  #buildThread(
    ui: ThreadUi,
    placed: PlacedThread,
    number: number | undefined,
  ): void {
    const doc = this.ownerDocument
    const thread = placed.doc.data
    const { root } = thread
    const me = this.#me()
    const nodes: Node[] = []

    const place = doc.createElement('p')
    place.className = 'dossier-comments-place'
    if (root.anchor === null) {
      place.append(this.#span(TEXT.onWholePage))
    } else if (this.#scope() !== null && placed.anchorFound) {
      // An item's element sits with its item: the place goes without saying.
    } else {
      const name = root.label ?? `#${root.anchor}`
      if (placed.anchorFound) {
        const anchor = root.anchor
        const link = doc.createElement('a')
        link.className = 'dossier-comments-link'
        link.dir = 'auto'
        link.href = `#${encodeURIComponent(anchor)}`
        link.textContent = `On ${name}`
        link.setAttribute('data-key', `anchor:${root.path}`)
        link.addEventListener('click', (event) => {
          event.preventDefault()
          this.#goToAnchor(anchor)
        })
        place.append(link)
      } else {
        place.append(this.#span(`On ${name}`))
      }
    }
    if (number !== undefined) place.append(this.#span(`Pin ${number}`))
    if (thread.resolved) {
      const by =
        typeof thread.resolvedBy === 'string' ? ` by ${thread.resolvedBy}` : ''
      place.append(this.#span(`Resolved${by}`))
      if (typeof thread.resolvedAt === 'string') {
        place.append(this.#time(thread.resolvedAt))
      }
    }
    if (place.childElementCount > 0) nodes.push(place)
    nodes.push(this.#comment(root, ui.root))

    if (thread.replies.length > 0) {
      const replies = doc.createElement('ul')
      replies.className = 'dossier-comments-replies'
      replies.setAttribute('aria-label', 'Replies')
      for (const reply of thread.replies) {
        const item = doc.createElement('li')
        item.append(this.#comment(reply, ui.root))
        replies.append(item)
      }
      nodes.push(replies)
    }

    const actions = doc.createElement('div')
    actions.className = 'dossier-comments-actions'
    if (this.#canWrite() && ui.reply === null) {
      const reply = button(doc, TEXT.reply, `reply:${root.path}`)
      reply.addEventListener('click', () => this.#startReply(root.path))
      actions.append(reply)
    }
    if (this.#ready && me !== null && me.role !== 'read') {
      const mark = thread.resolved
        ? button(doc, TEXT.reopen, `reopen:${root.path}`)
        : button(doc, TEXT.resolve, `resolve:${root.path}`)
      mark.addEventListener('click', () =>
        this.#mark(root.path, !thread.resolved),
      )
      actions.append(mark)
    }
    if (actions.childElementCount > 0) nodes.push(actions)
    ui.body.replaceChildren(...nodes)
  }

  #span(text: string): HTMLSpanElement {
    const span = this.ownerDocument.createElement('span')
    // Each piece of text takes its own direction; the layout keeps the page's.
    span.dir = 'auto'
    span.textContent = text
    return span
  }

  #time(iso: string): HTMLTimeElement {
    const time = this.ownerDocument.createElement('time')
    time.dir = 'auto'
    time.dateTime = iso
    time.title = fullTime(iso)
    time.textContent = shortTime(iso)
    return time
  }

  #comment(comment: CommentDoc, root: string): HTMLElement {
    const doc = this.ownerDocument
    const own = this.#isOwn(comment)
    const article = doc.createElement('article')
    article.className = 'dossier-comments-comment'
    if (own) article.setAttribute('data-own', '')
    const avatar = doc.createElement('span')
    avatar.className = 'dossier-comments-avatar'
    avatar.setAttribute('aria-hidden', 'true')
    avatar.textContent = Array.from(comment.by)[0] ?? '?'
    const main = doc.createElement('div')
    main.className = 'dossier-comments-main'
    const meta = doc.createElement('p')
    meta.className = 'dossier-comments-meta'
    const author = this.#span(comment.by)
    author.className = 'dossier-comments-author'
    author.id = uid('by')
    article.setAttribute('aria-labelledby', author.id)
    meta.append(author, this.#time(comment.at))
    if (comment.edited && !comment.deleted) {
      const edited = this.#span(TEXT.edited)
      edited.className = 'dossier-comments-edited'
      meta.append(edited)
    }
    if (comment.stance !== null && comment.stance !== '') {
      const stance = this.#span(comment.stance)
      stance.className = 'dossier-comments-stance'
      meta.append(stance)
    }
    main.append(meta)

    const editor = this.#editing.get(comment.path)
    if (editor !== undefined) {
      main.append(editor.form)
    } else if (comment.deleted) {
      const gone = doc.createElement('p')
      gone.className = 'dossier-comments-deleted'
      gone.dir = 'auto'
      gone.textContent = TEXT.deleted
      main.append(gone)
    } else {
      const text = doc.createElement('p')
      text.className = 'dossier-comments-text'
      text.dir = 'auto'
      // Comment text is only ever text: mentions and markup stay as written.
      text.textContent = comment.text
      main.append(text)
    }

    if (own && editor === undefined) {
      const actions = doc.createElement('div')
      actions.className = 'dossier-comments-actions'
      if (this.#confirming.has(comment.path)) {
        const ask = doc.createElement('p')
        ask.className = 'dossier-comments-confirm'
        ask.dir = 'auto'
        ask.textContent = TEXT.askDelete
        const yes = button(
          doc,
          TEXT.confirmDelete,
          `confirm-delete:${comment.path}`,
        )
        yes.addEventListener('click', () => this.#delete(comment.path, root))
        const no = button(doc, TEXT.cancel, `cancel-delete:${comment.path}`)
        no.addEventListener('click', () => this.#keepComment(comment.path))
        actions.append(ask, yes, no)
      } else {
        // Someone who may only read now still deletes what they wrote.
        if (this.#canWrite()) {
          const edit = button(doc, TEXT.edit, `edit:${comment.path}`)
          edit.addEventListener('click', () => this.#startEdit(comment, root))
          actions.append(edit)
        }
        const remove = button(doc, TEXT.delete, `delete:${comment.path}`)
        remove.addEventListener('click', () => this.#askDelete(comment.path))
        actions.append(remove)
      }
      main.append(actions)
    }
    article.append(avatar, main)
    return article
  }

  /** The reply composer's stance choice follows the page's stances. */
  #syncStances(ui: ThreadUi): void {
    if (ui.reply === null) return
    ui.stance = this.#stanceField(ui.reply, ui.stance, ui.root)
  }

  /**
   * A composer's stance choice, rebuilt only when the page's stances change;
   * none when the page offers none.
   */
  #stanceField(
    composer: Composer,
    have: HTMLSelectElement | null,
    key: string,
  ): HTMLSelectElement | null {
    const stances = this.#stances()
    const options = have === null ? [] : [...have.options].slice(1)
    if (
      options.length === stances.length &&
      options.every((option, index) => option.value === stances[index])
    ) {
      return have
    }
    const value = have?.value ?? ''
    have?.closest('label')?.remove()
    if (stances.length === 0) return null
    const doc = this.ownerDocument
    const field = doc.createElement('label')
    field.className = 'dossier-comments-field'
    const select = doc.createElement('select')
    select.className = 'dossier-comments-select'
    select.setAttribute('data-key', `stance:${key}`)
    select.append(
      this.#option('', TEXT.noStance),
      ...stances.map((stance) => this.#option(stance, stance)),
    )
    select.value = stances.includes(value) ? value : ''
    field.append(this.#span(TEXT.stance), select)
    composer.extras.append(field)
    return select
  }

  /** The stance chosen in a select, if the page still offers it. */
  #chosen(select: HTMLSelectElement | null): string | null {
    const value = select?.value ?? ''
    return this.#stances().includes(value) ? value : null
  }

  /** Each anchored element carries how many open threads it has. */
  #markAnchors(current: readonly PlacedThread[]): void {
    const doc = this.ownerDocument
    const counts = new Map<Element, number>()
    for (const { doc: thread } of current) {
      if (thread.data.resolved) continue
      const element = anchorElement(doc, thread.data.root.anchor)
      if (element !== null) counts.set(element, (counts.get(element) ?? 0) + 1)
    }
    for (const element of this.#marked) {
      if (!counts.has(element)) element.removeAttribute(MARK)
    }
    for (const [element, count] of counts) {
      if (element.getAttribute(MARK) !== String(count)) {
        element.setAttribute(MARK, String(count))
      }
    }
    this.#marked = new Set(counts.keys())
  }

  #pinMarks(
    current: readonly PlacedThread[],
    numbers: ReadonlyMap<string, number>,
  ): PinMark[] {
    const doc = this.ownerDocument
    const marks: PinMark[] = []
    for (const { doc: thread } of current) {
      const { root } = thread.data
      const number = numbers.get(root.path)
      const target = anchorElement(doc, root.anchor)
      if (number === undefined || root.pin === null || target === null) continue
      const name = root.label ?? `#${root.anchor}`
      marks.push({
        key: root.path,
        number,
        target,
        pin: root.pin,
        label: `Pin ${number}: on ${name}, by ${root.by}`,
      })
    }
    return marks
  }

  #drawPins(): void {
    const parts = this.#parts!
    const doc = this.ownerDocument
    const pin = this.#pin
    const placedOn = pin === null ? null : anchorElement(doc, pin.anchor)
    const placing = this.#placing
    parts.pins.render({
      marks: this.#marks,
      placed:
        pin !== null && placedOn !== null
          ? { target: placedOn, pin: pin.pin }
          : null,
      placing:
        placing === null
          ? null
          : {
              targets: this.#pinTargets(),
              target: placing.target,
              pin: placing.pin,
            },
    })
  }

  // Focus ------------------------------------------------------------------

  #rememberFocus(): Focus | null {
    const active = this.ownerDocument.activeElement as HTMLElement | null
    if (active === null || !this.contains(active)) return null
    const area =
      active.localName === 'textarea' ? (active as HTMLTextAreaElement) : null
    return {
      element: active,
      key: active.closest('[data-key]')?.getAttribute('data-key') ?? null,
      root: active.closest('[data-root]')?.getAttribute('data-root') ?? null,
      selection:
        area === null ? null : [area.selectionStart, area.selectionEnd],
    }
  }

  #visible(element: Element): boolean {
    if (!element.isConnected || !this.contains(element)) return false
    if (element.closest('[hidden]') !== null) return false
    const closed = element.closest('details:not([open])')
    return closed === null || element.localName === 'summary'
  }

  #byKey(key: string): HTMLElement | null {
    for (const element of this.querySelectorAll('[data-key]')) {
      if (element.getAttribute('data-key') === key && this.#visible(element)) {
        return element as HTMLElement
      }
    }
    return null
  }

  /** After a re-render, focus goes back where it was, or as near as it can. */
  #restoreFocus(saved: Focus | null): void {
    if (saved === null) return
    const doc = this.ownerDocument
    const active = doc.activeElement
    if (active === saved.element) return
    // Focus moved elsewhere on purpose: leave it there.
    if (
      active !== null &&
      active !== doc.body &&
      active !== doc.documentElement
    ) {
      return
    }
    if (this.#visible(saved.element)) {
      saved.element.focus({ preventScroll: true })
      if (saved.selection !== null) {
        ;(saved.element as HTMLTextAreaElement).setSelectionRange(
          saved.selection[0],
          saved.selection[1],
        )
      }
      return
    }
    const key = saved.key ?? ''
    const [kind = '', ...rest] = key.split(':')
    const tail = rest.join(':')
    const near: string[] = [key]
    if (kind === 'resolve') near.push(`reopen:${tail}`)
    if (kind === 'reopen') near.push(`resolve:${tail}`)
    if (kind === 'confirm-delete' || kind === 'cancel-delete') {
      near.push(`delete:${tail}`)
    }
    if (saved.root !== null) {
      near.push(`reply:${saved.root}`, `thread:${saved.root}`)
    }
    near.push('show-resolved', 'open', 'title')
    for (const each of near) {
      const element = this.#byKey(each)
      if (element !== null) {
        element.focus({ preventScroll: true })
        return
      }
    }
  }

  #focusKey(key: string): void {
    this.#byKey(key)?.focus()
  }

  #smooth(): ScrollBehavior {
    const win = this.ownerDocument.defaultView
    return win?.matchMedia?.('(prefers-reduced-motion: no-preference)').matches
      ? 'smooth'
      : 'auto'
  }

  #goToAnchor(id: string): void {
    const element = anchorElement(this.ownerDocument, id)
    if (element === null) return
    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: this.#smooth(), block: 'start' })
    }
    focusElement(element)
  }

  #openThread(root: string): void {
    const element = this.#uis.get(root)?.element
    if (element === undefined || !this.#visible(element)) return
    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: this.#smooth(), block: 'nearest' })
    }
    element.focus({ preventScroll: true })
  }

  // Pins -------------------------------------------------------------------

  #startPlacing(): void {
    const targets = this.#pinTargets()
    const parts = this.#parts!
    const chosen =
      targets.find((target) => target.id === parts.on.value) ??
      targets.find((target) => target.id === this.#pin?.anchor) ??
      targets[0]
    if (chosen === undefined) return
    const pin =
      this.#pin?.anchor === chosen.id ? this.#pin.pin : { x: 0.5, y: 0.5 }
    this.#placing = { target: chosen, pin }
    this.#render()
    if (typeof chosen.scrollIntoView === 'function') {
      chosen.scrollIntoView({ behavior: this.#smooth(), block: 'nearest' })
    }
    parts.pins.focusDraft()
  }

  #placePin(target: Element, pin: Pin): void {
    const parts = this.#parts!
    this.#placing = null
    this.#pin = { anchor: target.id, pin }
    this.#refreshAnchors()
    parts.on.value = target.id
    this.#render()
    parts.composer.textarea.focus({ preventScroll: true })
  }

  #cancelPlacing(): void {
    this.#placing = null
    this.#render()
    this.#parts!.pinButton.focus({ preventScroll: true })
  }

  // Writing ----------------------------------------------------------------

  #emit(
    state: CommentsStateDetail['state'],
    error: DossierError | null,
    doc: Doc | null,
  ): void {
    const win = this.ownerDocument.defaultView as Win
    const detail: CommentsStateDetail = { state, error, doc }
    this.dispatchEvent(
      new win.CustomEvent('dossier:state', { bubbles: true, detail }),
    )
  }

  /** Mirrors the server's rules, so a send it would refuse never leaves. */
  #check(
    text: string,
    mentions: readonly string[],
    composer: Composer,
    status: StatusLine,
  ): boolean {
    const problem =
      text === ''
        ? TEXT.writeSomething
        : text.length > COMMENT_TEXT_MAX
          ? tooLong(text.length)
          : mentions.length > COMMENT_MENTIONS_MAX
            ? TEXT.tooManyMentions
            : null
    if (problem === null) return true
    composer.setInvalid(true)
    status.say(problem)
    composer.textarea.focus()
    return false
  }

  /** One send from one place, never two at once and never again by itself. */
  #send(send: Send): void {
    const { status, composer } = send
    if (status.busy) {
      // It goes once the send before it is answered, never twice.
      this.#queued.set(status, send)
      return
    }
    status.busy = true
    composer?.setBusy(true)
    composer?.setInvalid(false)
    status.say(TEXT.saving)
    this.#emit('saving', null, null)
    this.#busy += 1
    let run: Promise<Doc | void>
    try {
      run = send.run()
    } catch (error) {
      run = Promise.reject(error)
    }
    run.then(
      (doc) => {
        status.busy = false
        composer?.setBusy(false)
        status.say(TEXT.saved)
        const stored = doc ?? null
        this.#emit('saved', null, stored)
        send.done?.(stored)
        this.#settle(true, status)
      },
      (error: unknown) => {
        status.busy = false
        composer?.setBusy(false)
        const failure = asError(error)
        this.#fail(failure, status, composer, send.again)
        this.#emit('failed', failure, null)
        send.failed?.()
        this.#settle(false, status)
      },
    )
  }

  #settle(wrote: boolean, status: StatusLine): void {
    this.#busy -= 1
    const next = this.#queued.get(status)
    if (next !== undefined) {
      this.#queued.delete(status)
      this.#send(next)
    }
    // After a write, read at once rather than wait for the watch.
    if (wrote || this.#missed) void this.#reload()
  }

  #fail(
    error: DossierError,
    status: StatusLine,
    composer: Composer | null,
    again: () => void,
  ): void {
    switch (error.code) {
      case 'offline':
        status.say(TEXT.offline, again)
        return
      case 'unavailable':
        status.say(TEXT.unavailable, again)
        return
      case 'rate_limited':
        status.say(TEXT.rateLimited)
        return
      case 'forbidden':
        status.say(TEXT.forbidden)
        return
      case 'invalid':
        composer?.setInvalid(true)
        status.say(error.message === '' ? TEXT.unavailable : error.message)
        return
      default:
        status.say(error.message === '' ? TEXT.unavailable : error.message)
    }
  }

  #submitMain(): void {
    const parts = this.#parts!
    const { composer, status } = parts
    if (status.busy) return
    const text = composer.text.trim()
    const mentions = mentionsIn(text)
    if (!this.#check(text, mentions, composer, status)) return
    const scope = this.#scope()
    const element = anchorElement(
      this.ownerDocument,
      scope ?? (parts.on.value || null),
    )
    // An item's element comments on its item, even before it is drawn.
    const anchor = scope ?? (element === null ? null : element.id)
    const placed =
      scope === null && anchor !== null && this.#pin?.anchor === anchor
        ? this.#pin
        : null
    const pin = placed?.pin ?? null
    const stance = this.#chosen(this.#mainStance)
    const entry: CommentEntry = {
      text,
      anchor,
      label: element === null ? null : labelOf(element),
      pin,
      replyTo: null,
      stance,
      mentions,
    }
    if (this.#me() === null) {
      this.#keepAndSignIn(entry, status)
      return
    }
    this.#send({
      status,
      composer,
      again: () => this.#submitMain(),
      run: () => this.#dossier!.write(this.#folder(), entryJson(entry)),
      done: () => {
        // What was typed since the send stays.
        if (composer.text.trim() === text) {
          composer.text = ''
          const select = this.#mainStance
          if (select !== null && select.value === (stance ?? '')) {
            select.value = ''
          }
        }
        this.#keepDraft()
        // Only the pin this comment took: one placed since stays.
        if (placed !== null && this.#pin === placed) this.#pin = null
        this.#render()
      },
    })
  }

  #startReply(root: string): void {
    const composer = this.#openReply(root)
    this.#render()
    composer.focus()
  }

  #openReply(root: string): Composer {
    const ui = this.#ui(root)
    if (ui.reply !== null) return ui.reply
    const thread = this.#thread(root)
    const composer = new Composer({
      document: this.ownerDocument,
      key: `reply:${root}`,
      label: thread === null ? TEXT.reply : `Reply to ${thread.root.by}`,
      submitLabel: TEXT.reply,
      cancelLabel: TEXT.cancel,
      known: () => this.#known(),
      onSubmit: () => this.#submitReply(root),
      onCancel: () => this.#closeReply(root),
    })
    composer.describedBy(ui.status.line.id)
    ui.reply = composer
    this.#syncStances(ui)
    return composer
  }

  #closeReply(root: string): void {
    const ui = this.#ui(root)
    ui.reply = null
    ui.stance = null
    this.#render()
    this.#focusKey(`reply:${root}`)
  }

  #submitReply(root: string): void {
    const ui = this.#uis.get(root)
    const composer = ui?.reply
    if (ui === undefined || composer === undefined || composer === null) return
    if (ui.status.busy) return
    const text = composer.text.trim()
    const mentions = mentionsIn(text)
    if (!this.#check(text, mentions, composer, ui.status)) return
    const thread = this.#thread(root)
    const entry: CommentEntry = {
      text,
      anchor: thread?.root.anchor ?? null,
      label: thread?.root.label ?? null,
      pin: null,
      replyTo: root,
      stance: this.#chosen(ui.stance),
      mentions,
    }
    if (this.#me() === null) {
      this.#keepAndSignIn(entry, ui.status)
      return
    }
    this.#send({
      status: ui.status,
      composer,
      again: () => this.#submitReply(root),
      run: () => this.#dossier!.write(this.#folder(), entryJson(entry)),
      done: () => {
        if (composer.text.trim() !== text || ui.reply !== composer) return
        this.#closeReply(root)
      },
    })
  }

  #mark(root: string, resolves: boolean): void {
    const ui = this.#ui(root)
    this.#send({
      status: ui.status,
      composer: null,
      again: () => this.#mark(root, resolves),
      run: () =>
        this.#dossier!.write(
          this.#folder(),
          resolves ? { resolves: root } : { reopens: root },
        ),
    })
  }

  #startEdit(comment: CommentDoc, root: string): void {
    const ui = this.#ui(root)
    const path = comment.path
    const composer = new Composer({
      document: this.ownerDocument,
      key: `edit:${path}`,
      label: TEXT.editComment,
      hideLabel: true,
      submitLabel: TEXT.save,
      cancelLabel: TEXT.cancel,
      known: () => this.#known(),
      onSubmit: () => this.#submitEdit(path, root),
      onCancel: () => this.#endEdit(path),
    })
    composer.text = comment.text
    composer.describedBy(ui.status.line.id)
    this.#editing.set(path, composer)
    this.#render()
    composer.textarea.focus()
    const end = composer.text.length
    composer.textarea.setSelectionRange(end, end)
  }

  #endEdit(path: string): void {
    this.#editing.delete(path)
    this.#render()
    this.#focusKey(`edit:${path}`)
  }

  #submitEdit(path: string, root: string): void {
    const composer = this.#editing.get(path)
    const ui = this.#ui(root)
    if (composer === undefined || ui.status.busy) return
    const text = composer.text.trim()
    const mentions = mentionsIn(text)
    if (!this.#check(text, mentions, composer, ui.status)) return
    this.#send({
      status: ui.status,
      composer,
      again: () => this.#submitEdit(path, root),
      run: () => this.#dossier!.write(path, { text, mentions }),
      done: () => {
        if (this.#editing.get(path) !== composer) return
        if (composer.text.trim() === text) this.#endEdit(path)
      },
    })
  }

  #askDelete(path: string): void {
    this.#confirming.add(path)
    this.#render()
    this.#focusKey(`confirm-delete:${path}`)
  }

  #keepComment(path: string): void {
    this.#confirming.delete(path)
    this.#render()
    this.#focusKey(`delete:${path}`)
  }

  #delete(path: string, root: string): void {
    const ui = this.#ui(root)
    this.#send({
      status: ui.status,
      composer: null,
      again: () => this.#delete(path, root),
      run: () => this.#dossier!.withdraw(path),
      done: () => {
        this.#confirming.delete(path)
        this.#render()
        this.#focusKey(`thread:${root}`)
      },
      failed: () => {
        if (!this.#confirming.delete(path)) return
        this.#render()
        this.#focusKey(`delete:${path}`)
      },
    })
  }

  // Visitors ---------------------------------------------------------------

  /** The deployment's origin and the page's link, from the page's bootstrap. */
  #bootstrap(): { readonly origin: string; readonly link: string } | null {
    const text =
      this.ownerDocument.getElementById('dossier-bootstrap')?.textContent
    try {
      const value: unknown = JSON.parse(text ?? 'null')
      if (
        isRecord(value) &&
        typeof value.origin === 'string' &&
        typeof value.link === 'string'
      ) {
        return { origin: value.origin, link: value.link }
      }
    } catch {
      // No bootstrap: not a page Dossier serves.
    }
    return null
  }

  #storage(): Storage | null {
    try {
      return this.ownerDocument.defaultView?.sessionStorage ?? null
    } catch {
      return null
    }
  }

  /**
   * Keeps a visitor's comment for this page, then opens sign-in at the top.
   * The frame may navigate the top only in the person's own gesture, so a
   * link is clicked inside it.
   */
  #keepAndSignIn(entry: CommentEntry, status: StatusLine): void {
    const dossier = this.#dossier!
    try {
      this.#storage()?.setItem(
        keptKey(dossier.page.path),
        // When the press started the round trip to sign-in, spent once,
        // and the element it was written in: the page's, or an item's.
        JSON.stringify({
          ...entryJson(entry),
          keptAt: Date.now(),
          ...(this.#scope() === null ? {} : { for: this.#scope() }),
        }),
      )
      // The text now waits as the kept comment, never also as a draft.
      if (entry.replyTo === null) {
        this.#storage()?.removeItem(
          draftKey(dossier.page.path, null, this.#scope()),
        )
      }
    } catch {
      // Storage is full or refused: sign-in still goes on.
    }
    const boot = this.#bootstrap()
    if (boot === null) {
      status.say(TEXT.signInToComment)
      return
    }
    status.say(TEXT.signingIn)
    const link = this.ownerDocument.createElement('a')
    link.className = 'dossier-comments-sign-in'
    link.href = `${boot.origin}/_/sign-in?next=${encodeURIComponent(boot.link)}`
    link.target = '_top'
    link.hidden = true
    this.append(link)
    link.click()
    link.remove()
  }

  /** The new comment's unsent text, kept as it is typed, for this viewer. */
  #keepDraft(): void {
    const text = this.#parts?.composer.text ?? ''
    const dossier = this.#dossier
    // Before the viewer is known, text could land under someone else.
    if (dossier === null || !this.#ready) return
    const key = draftKey(
      dossier.page.path,
      this.#me()?.email ?? null,
      this.#scope(),
    )
    try {
      if (text.trim() === '') this.#storage()?.removeItem(key)
      else this.#storage()?.setItem(key, text)
    } catch {
      // Storage is full or refused: the text stays in the composer.
    }
  }

  #draft(): string {
    const dossier = this.#dossier
    if (dossier === null) return ''
    try {
      return (
        this.#storage()?.getItem(
          draftKey(dossier.page.path, this.#me()?.email ?? null, this.#scope()),
        ) ?? ''
      )
    } catch {
      return ''
    }
  }

  /**
   * The comment a visitor kept before signing in, taken out once, by the
   * element it was written in: the page's, or the one for its item.
   */
  #takeKept(): {
    readonly entry: CommentEntry
    readonly keptAt: number | null
  } | null {
    const storage = this.#storage()
    const key = keptKey(this.#dossier!.page.path)
    let raw: string | null = null
    try {
      raw = storage?.getItem(key) ?? null
    } catch {
      return null
    }
    if (raw === null) return null
    let value: unknown = null
    try {
      value = JSON.parse(raw)
    } catch {
      value = null
    }
    const kept =
      isRecord(value) && typeof value.for === 'string' ? value.for : null
    if (value !== null && kept !== this.#scope()) return null
    try {
      storage?.removeItem(key)
    } catch {
      return null
    }
    const entry = keptEntry(value)
    if (entry === null) return null
    const at = isRecord(value) ? value.keptAt : null
    return { entry, keptAt: typeof at === 'number' ? at : null }
  }

  /**
   * Back from sign-in: the comment kept before it. Straight back from the
   * round trip its own press started, it goes once, as the person signed
   * in now; any other time it returns to its composer for whoever signed
   * in to send themselves, since they may not be the one who wrote it.
   */
  #claimKept(): void {
    const me = this.#me()
    if (me === null || this.#dossier === null) return
    const kept = this.#takeKept()
    if (kept === null) return
    const { entry, keptAt } = kept
    const since = keptAt === null ? null : Date.now() - keptAt
    if (since !== null && since >= 0 && since <= ROUND_TRIP_MS) {
      this.#sendKept(entry)
      return
    }
    this.#restoreKept(entry, claimText(me.email))
  }

  /** The kept comment in its composer, with `note` in its status line. */
  #restoreKept(entry: CommentEntry, note: string | null): void {
    const parts = this.#parts!
    const root = entry.replyTo
    this.#open = true
    if (root === null || this.#thread(root) === null) {
      parts.composer.text = entry.text
      const element = anchorElement(this.ownerDocument, entry.anchor)
      this.#render()
      parts.on.value = element === null ? '' : element.id
      this.#pin =
        this.#scope() === null && element !== null && entry.pin !== null
          ? { anchor: element.id, pin: entry.pin }
          : null
      if (this.#mainStance !== null && entry.stance !== null) {
        this.#mainStance.value = entry.stance
      }
      this.#keepDraft()
      this.#render()
      if (note !== null) parts.status.say(note)
      parts.composer.textarea.focus({ preventScroll: true })
      return
    }
    const composer = this.#openReply(root)
    composer.text = entry.text
    const ui = this.#ui(root)
    this.#render()
    if (ui.stance !== null && entry.stance !== null) {
      ui.stance.value = entry.stance
    }
    if (note !== null) ui.status.say(note)
    composer.focus()
  }

  /** The round trip's comment, sent once; on failure back in its composer. */
  #sendKept(entry: CommentEntry): void {
    const parts = this.#parts!
    const root =
      entry.replyTo !== null && this.#thread(entry.replyTo) !== null
        ? entry.replyTo
        : null
    const status = root === null ? parts.status : this.#ui(root).status
    this.#send({
      status,
      composer: root === null ? parts.composer : null,
      again: () =>
        root === null ? this.#submitMain() : this.#submitReply(root),
      run: () => this.#dossier!.write(this.#folder(), entryJson(entry)),
      failed: () => this.#restoreKept(entry, null),
    })
  }
}

/** Defines `<dossier-comments>` for `dossier`, once per registry. */
export const define = (
  registry: CustomElementRegistry,
  dossier: Dossier,
): void => {
  if (registry.get(TAG) !== undefined) return
  registry.define(
    TAG,
    class extends DossierComments {
      constructor() {
        super(dossier)
      }
    },
  )
}
