// What the comments component works out without changing the page: where
// each thread belongs, how a pin maps to a point on its element, whom a
// comment mentions, what an anchor is called, and how times read.
import {
  COMMENT_LABEL_MAX,
  COMMENT_STANCE_MAX,
  COMMENTS_SUFFIX,
  type CommentDoc,
  type Doc,
  type Thread,
} from '@dossier/contracts/bridge'

export interface Pin {
  readonly x: number
  readonly y: number
}

export interface PlacedThread {
  readonly doc: Doc<Thread>
  /** The thread is on the whole page, or its anchor is in the page now. */
  readonly anchorFound: boolean
  /** Its place in its list, from 0. */
  readonly order: number
}

export const TAG = 'dossier-comments'

export const DEFAULT_ANCHORS =
  'section[id], article[id], figure[id], h1[id], h2[id], h3[id], h4[id], li[id], tr[id], img[id], svg[id]'
export const DEFAULT_PINS = 'img[id], svg[id], picture[id], [data-pins][id]'

/** At most this many people are suggested at once while typing @. */
export const SUGGESTIONS_MAX = 8

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is string => typeof value === 'string'

const isTextOrNull = (value: unknown): boolean =>
  value === null || typeof value === 'string'

const isPin = (value: unknown): boolean =>
  value === null ||
  (isRecord(value) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number')

export const isCommentDoc = (value: unknown): value is CommentDoc =>
  isRecord(value) &&
  isText(value.path) &&
  isText(value.by) &&
  isText(value.at) &&
  isText(value.text) &&
  isTextOrNull(value.anchor) &&
  isTextOrNull(value.label) &&
  isPin(value.pin) &&
  isTextOrNull(value.replyTo) &&
  isTextOrNull(value.stance) &&
  Array.isArray(value.mentions) &&
  typeof value.edited === 'boolean' &&
  typeof value.deleted === 'boolean'

export const isThread = (value: unknown): value is Thread =>
  isRecord(value) &&
  isCommentDoc(value.root) &&
  Array.isArray(value.replies) &&
  value.replies.every(isCommentDoc) &&
  typeof value.resolved === 'boolean'

/** A Doc of a comments folder that holds a whole thread. */
export const isThreadDoc = (value: unknown): value is Doc<Thread> =>
  isRecord(value) && isText(value.path) && isThread(value.data)

/**
 * The page's comments folder, relative to the page:
 * '/questions/index.html' → 'index.comments/'.
 */
export const commentsFolder = (pagePath: string): string => {
  const file = pagePath.slice(pagePath.lastIndexOf('/') + 1)
  return `${file.replace(/\.html$/i, '')}${COMMENTS_SUFFIX}/`
}

/** Inside a comments component, where ids and anchors never count. */
export const isOwnElement = (element: Element): boolean =>
  element.closest(TAG) !== null

/** The element an anchor names, outside any comments component. */
export const anchorElement = (
  document: Document,
  id: string | null,
): HTMLElement | null => {
  if (id === null || id === '') return null
  const element = document.getElementById(id)
  return element === null || isOwnElement(element) ? null : element
}

/**
 * The elements a selector finds that have an id, in page order, outside any
 * comments component; the fallback's when the selector is not one.
 */
export const elementsFor = (
  document: Document,
  selector: string | null,
  fallback: string,
): HTMLElement[] => {
  const wanted =
    selector === null || selector.trim() === '' ? fallback : selector
  let found: NodeListOf<Element>
  try {
    found = document.querySelectorAll(wanted)
  } catch {
    found = document.querySelectorAll(fallback)
  }
  return ([...found] as HTMLElement[]).filter(
    (element) => element.id !== '' && !isOwnElement(element),
  )
}

/** The page's stances: 'agree, reopen' → ['agree', 'reopen']. */
export const stancesOf = (value: string | null): string[] => {
  const out: string[] = []
  for (const part of (value ?? '').split(',')) {
    const stance = part.trim()
    if (stance === '' || stance.length > COMMENT_STANCE_MAX) continue
    if (!out.includes(stance)) out.push(stance)
  }
  return out
}

const HEADING = /^h[1-6]$/

/** At most `max` characters, never ending inside a surrogate pair. */
const clip = (text: string, max: number): string => {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/**
 * What an anchor is called when a comment is written: its title, its
 * aria-label, or its first heading (itself when it is one), at most 200
 * characters; null when it has none.
 */
export const labelOf = (element: Element): string | null => {
  const heading = HEADING.test(element.localName)
    ? element
    : element.querySelector('h1, h2, h3, h4, h5, h6')
  for (const raw of [
    element.getAttribute('title'),
    element.getAttribute('aria-label'),
    // An image is named by its alt text, as a screen reader names it.
    element.localName === 'img' ? element.getAttribute('alt') : null,
    heading?.textContent,
  ]) {
    const text = (raw ?? '').replace(/\s+/g, ' ').trim()
    if (text !== '') return clip(text, COMMENT_LABEL_MAX)
  }
  return null
}

const byTime = (a: Doc<Thread>, b: Doc<Thread>): number => {
  const x = a.data.root
  const y = b.data.root
  if (x.at !== y.at) return x.at < y.at ? -1 : 1
  return x.path < y.path ? -1 : x.path > y.path ? 1 : 0
}

/** Node.DOCUMENT_POSITION_FOLLOWING, without needing the global. */
const FOLLOWING = 4

/**
 * Splits threads into those on this version of the page, whole-page threads
 * first and then by their anchor's place in the page, and those whose
 * anchor is gone, by time.
 */
export const placeThreads = (
  threads: readonly Doc<Thread>[],
  document: Document,
): {
  readonly current: readonly PlacedThread[]
  readonly earlier: readonly PlacedThread[]
} => {
  const found: { doc: Doc<Thread>; element: Element | null }[] = []
  const gone: Doc<Thread>[] = []
  for (const doc of threads) {
    const { anchor } = doc.data.root
    if (anchor === null) {
      found.push({ doc, element: null })
      continue
    }
    const element = anchorElement(document, anchor)
    if (element === null) gone.push(doc)
    else found.push({ doc, element })
  }
  found.sort((a, b) => {
    if (a.element !== b.element) {
      if (a.element === null) return -1
      if (b.element === null) return 1
      return a.element.compareDocumentPosition(b.element) & FOLLOWING ? -1 : 1
    }
    return byTime(a.doc, b.doc)
  })
  gone.sort(byTime)
  return {
    current: found.map(({ doc }, order) => ({ doc, anchorFound: true, order })),
    earlier: gone.map((doc, order) => ({ doc, anchorFound: false, order })),
  }
}

const within = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5

const round = (n: number): number => Math.round(n * 10_000) / 10_000

/** Where a pin sits in its element's box, in pixels from its left and top. */
export const pinPosition = (
  box: { readonly width: number; readonly height: number },
  pin: Pin,
): { readonly left: number; readonly top: number } => ({
  left: within(pin.x) * box.width,
  top: within(pin.y) * box.height,
})

/**
 * A point on an element as a pin: fractions of its box from the left and
 * top edges, whatever the page's direction, since an image does not mirror.
 */
export const pinFromPoint = (
  box: Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>,
  point: { readonly clientX: number; readonly clientY: number },
): Pin => ({
  x:
    box.width > 0 ? round(within((point.clientX - box.left) / box.width)) : 0.5,
  y:
    box.height > 0
      ? round(within((point.clientY - box.top) / box.height))
      : 0.5,
})

/** A pin moved by a step, kept on its element. */
export const movePin = (pin: Pin, dx: number, dy: number): Pin => ({
  x: round(within(pin.x + dx)),
  y: round(within(pin.y + dy)),
})

/** '40% across, 22% down'. */
export const pinText = (pin: Pin): string =>
  `${Math.round(within(pin.x) * 100)}% across, ${Math.round(within(pin.y) * 100)}% down`

const MENTION = /(^|[^\w.+-])@([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g

/** The emails a text mentions with @, lower-cased, each once, in order. */
export const mentionsIn = (text: string): string[] => {
  const out: string[] = []
  for (const match of text.matchAll(MENTION)) {
    const email = match[2]!.toLowerCase()
    if (!out.includes(email)) out.push(email)
  }
  return out
}

/** The @ being typed just before the caret, and what follows it so far. */
export const mentionAt = (
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | null => {
  const match = /(?:^|[^\w.+-])@([^\s@]*(?:@[^\s@]*)?)$/.exec(
    text.slice(0, caret),
  )
  if (match === null) return null
  const query = match[1]!
  return { start: caret - query.length - 1, query }
}

/** Known emails that match what follows the @, those that start with it first. */
export const suggestEmails = (
  known: readonly string[],
  query: string,
): string[] => {
  const q = query.toLowerCase()
  const starts = known.filter((email) => email.startsWith(q))
  const rest = known.filter(
    (email) => !email.startsWith(q) && email.includes(q),
  )
  return [...starts, ...rest].slice(0, SUGGESTIONS_MAX)
}

/** Everyone in the threads, by who wrote and whom they mentioned, except `me`. */
export const knownEmails = (
  threads: readonly Doc<Thread>[],
  me: string | null,
): string[] => {
  const out = new Set<string>()
  for (const { data } of threads) {
    for (const comment of [data.root, ...data.replies]) {
      out.add(comment.by.toLowerCase())
      for (const email of comment.mentions) {
        if (typeof email === 'string') out.add(email.toLowerCase())
      }
    }
  }
  if (me !== null) out.delete(me.toLowerCase())
  return [...out].sort()
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * '10 Oct, 09:14' in the viewer's local time, with the year when it is not
 * this year's: '10 Oct 2025, 09:14'.
 */
export const shortTime = (iso: string, now: Date = new Date()): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const year =
    date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`
  return `${date.getDate()} ${MONTHS[date.getMonth()]!.slice(0, 3)}${year}, ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** '10 October 2026, 09:14' in the viewer's local time. */
export const fullTime = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
