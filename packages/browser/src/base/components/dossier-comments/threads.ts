// What the comments component works out without changing the page: where
// each thread belongs, how a pin maps to a point on its element, whom a
// comment mentions and whom to suggest, what an anchor is called, and how
// times read.
import {
  COMMENT_LABEL_MAX,
  COMMENT_STANCE_MAX,
  COMMENTS_SUFFIX,
  isTeamNameText,
  MENTIONABLE_MAX,
  TEAM_MENTION_PREFIX,
  teamMentionText,
  teamOfMention,
  type CommentDoc,
  type Doc,
  type Mentionable,
  type MentionablePerson,
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

/** At most this many people and teams are suggested at once while typing @. */
export const SUGGESTIONS_MAX = MENTIONABLE_MAX

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
  // Written before comments carried names: absent.
  (value.name === undefined || isTextOrNull(value.name)) &&
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

/**
 * An @ and what it mentions: a team, quoted (`@team:"Design Ops"`) or bare
 * (`@team:Design`), or an email.
 */
const MENTION =
  /(^|[^\w.+-])@(?:team:(?:"((?:[^"\\\n]|\\.)*)"|([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*))|([\w.+-]+@[\w-]+(?:\.[\w-]+)+))/gu

/**
 * Whom a text mentions with @, each once, in order: emails lower-cased, and
 * teams as `team:<name>`, named as written.
 */
export const mentionsIn = (text: string): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION)) {
    const team =
      match[2] !== undefined
        ? match[2].replace(/\\(.)/g, '$1')
        : (match[3] ?? null)
    if (team !== null && !isTeamNameText(team)) continue
    const mention =
      team !== null ? `${TEAM_MENTION_PREFIX}${team}` : match[4]!.toLowerCase()
    if (seen.has(mention.toLowerCase())) continue
    seen.add(mention.toLowerCase())
    out.push(mention)
  }
  return out
}

/** A run of a comment's text: plain, or one of its mentions as written. */
export type TextPart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'person'
      /** As written, with its @. */
      readonly text: string
      /** Lower-cased. */
      readonly email: string
    }
  | {
      readonly kind: 'team'
      readonly text: string
      readonly name: string
    }

/**
 * A comment's text in runs: each @ that names one of the comment's own
 * `mentions` stands apart, and everything else, an @ it does not name
 * included, is plain text.
 */
export const mentionParts = (
  text: string,
  mentions: readonly unknown[],
): TextPart[] => {
  const named = new Set(
    mentions
      .filter((m): m is string => typeof m === 'string')
      .map((m) => m.toLowerCase()),
  )
  const out: TextPart[] = []
  let plain = ''
  let at = 0
  for (const match of text.matchAll(MENTION)) {
    const lead = match[1] ?? ''
    const start = match.index + lead.length
    const raw = match[0].slice(lead.length)
    const team =
      match[2] !== undefined
        ? match[2].replace(/\\(.)/g, '$1')
        : (match[3] ?? null)
    const key =
      team !== null
        ? `${TEAM_MENTION_PREFIX}${team}`.toLowerCase()
        : match[4]!.toLowerCase()
    if ((team !== null && !isTeamNameText(team)) || !named.has(key)) {
      continue
    }
    plain += text.slice(at, start)
    if (plain !== '') out.push({ kind: 'text', text: plain })
    plain = ''
    out.push(
      team !== null
        ? { kind: 'team', text: raw, name: team }
        : { kind: 'person', text: raw, email: key },
    )
    at = start + raw.length
  }
  plain += text.slice(at)
  if (plain !== '') out.push({ kind: 'text', text: plain })
  return out
}

/** The @ being typed just before the caret, and what follows it so far. */
export const mentionAt = (
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | null => {
  const match =
    /(?:^|[^\w.+-])@(team:"(?:[^"\\\n]|\\.)*|[^\s@]*(?:@[^\s@]*)?)$/.exec(
      text.slice(0, caret),
    )
  if (match === null) return null
  const query = match[1]!
  return { start: caret - query.length - 1, query }
}

/** Someone or a team to mention, as the list of suggestions shows them. */
export type Suggestion =
  | ({ readonly kind: 'person' } & MentionablePerson)
  | {
      readonly kind: 'team'
      readonly name: string
      readonly members: number
    }

/** What choosing a suggestion writes: `@sara@acme.com`, `@team:Design`. */
export const suggestionText = (suggestion: Suggestion): string =>
  suggestion.kind === 'person'
    ? `@${suggestion.email}`
    : teamMentionText(suggestion.name)

/**
 * What to look for after an @: its text lower-cased, without `team:` and an
 * opening quote, and whether it asks for teams alone.
 */
export const searchOf = (
  query: string,
): { readonly text: string; readonly teamsOnly: boolean } => {
  const lower = query.toLowerCase()
  if (!lower.startsWith(TEAM_MENTION_PREFIX)) {
    return { text: lower, teamsOnly: false }
  }
  const rest = lower.slice(TEAM_MENTION_PREFIX.length)
  return {
    text: (rest.startsWith('"') ? rest.slice(1) : rest).replace(/\\(.)/g, '$1'),
    teamsOnly: true,
  }
}

/** 0 when a word of a field starts with the text, 1 when one only holds it. */
const rankOf = (text: string, ...fields: (string | null)[]): number | null => {
  let found: number | null = null
  for (const field of fields) {
    if (field === null) continue
    const value = field.toLowerCase()
    if (value.startsWith(text) || value.includes(` ${text}`)) return 0
    if (value.includes(text)) found = 1
  }
  return found
}

/**
 * The people in the threads and those Dossier gave for the query (`found`,
 * null until it answers), each once with the fullest details, and the
 * teams Dossier gave, matching what follows the @: those with a word that
 * starts with it first, at most SUGGESTIONS_MAX.
 */
export const suggestionsFor = (
  known: readonly MentionablePerson[],
  found: Mentionable | null,
  query: string,
): Suggestion[] => {
  const { text, teamsOnly } = searchOf(query)
  const people = new Map<string, MentionablePerson>()
  for (const person of [...(found?.people ?? []), ...known]) {
    const email = person.email.toLowerCase()
    const had = people.get(email)
    people.set(email, {
      email,
      name: had?.name ?? person.name,
      image: had?.image ?? person.image,
    })
  }
  const ranked: { rank: number; order: number; suggestion: Suggestion }[] = []
  if (!teamsOnly) {
    for (const person of people.values()) {
      const rank = rankOf(text, person.email, person.name)
      if (rank === null) continue
      ranked.push({
        rank,
        order: ranked.length,
        suggestion: { kind: 'person', ...person },
      })
    }
  }
  for (const team of found?.teams ?? []) {
    const rank = rankOf(text, team.name)
    if (rank === null) continue
    ranked.push({
      rank,
      order: ranked.length,
      suggestion: { kind: 'team', name: team.name, members: team.members },
    })
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, SUGGESTIONS_MAX)
    .map((r) => r.suggestion)
}

/**
 * Everyone in the threads, by who wrote (with their names) and whom they
 * mentioned, except `me`, by name or email.
 */
export const knownPeople = (
  threads: readonly Doc<Thread>[],
  me: string | null,
): MentionablePerson[] => {
  const out = new Map<string, MentionablePerson>()
  const add = (email: string, name: string | null) => {
    const key = email.toLowerCase()
    const had = out.get(key)
    out.set(key, { email: key, name: had?.name ?? name, image: null })
  }
  for (const { data } of threads) {
    for (const comment of [data.root, ...data.replies]) {
      add(comment.by, typeof comment.name === 'string' ? comment.name : null)
      for (const mention of comment.mentions) {
        if (typeof mention === 'string' && teamOfMention(mention) === null) {
          add(mention, null)
        }
      }
    }
  }
  if (me !== null) out.delete(me.toLowerCase())
  return [...out.values()].sort((a, b) => {
    const x = (a.name ?? a.email).toLowerCase()
    const y = (b.name ?? b.email).toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  })
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
