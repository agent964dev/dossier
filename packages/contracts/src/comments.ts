// How comments are stored and read back. Plain TypeScript with no imports,
// so the base component, a replacement component in a kit, the Worker and
// the CLI read the same shapes.
//
// A page's comments live beside it in a data folder named after it
// (`plan.html` keeps them in `plan.comments/`). Every writer has their own
// folder there, and each comment, resolve or reopen is one entry in it.

/** One comment, as its entry holds it. */
export interface CommentEntry {
  /** '' once deleted. */
  readonly text: string
  /** An element id on the page, or null for the whole page. */
  readonly anchor: string | null
  /** That element's title, aria-label or first heading when written. */
  readonly label: string | null
  /**
   * Fractions of the anchored element's box from its left and top edges,
   * whatever the page's direction: an image does not mirror.
   */
  readonly pin: { readonly x: number; readonly y: number } | null
  /** The thread's root comment, as a path from the page's folder. */
  readonly replyTo: string | null
  /** One of the page's stances, or null. */
  readonly stance: string | null
  /** Lower-cased emails. */
  readonly mentions: readonly string[]
}

/** Resolving or reopening a thread: an entry naming its root comment. */
export type ThreadMark =
  | { readonly resolves: string }
  | { readonly reopens: string }

/** A comment as a read gives it, with who wrote it and when. */
export interface CommentDoc extends CommentEntry {
  /** From the page's folder: 'plan.comments/sara@acme.com/2026-10-10T09-14-03.json'. */
  readonly path: string
  /** The writer's email. */
  readonly by: string
  /** When it was first written, ISO 8601. */
  readonly at: string
  /** The push of the page the writer saw. */
  readonly push: number
  /** Revised after it was first written. */
  readonly edited: boolean
  /** Its text is gone: show "Comment deleted". */
  readonly deleted: boolean
}

/** A root comment with its replies, oldest first, and whether it is resolved. */
export interface Thread {
  readonly root: CommentDoc
  readonly replies: readonly CommentDoc[]
  readonly resolved: boolean
  /** Who resolved it, while it is resolved. */
  readonly resolvedBy: string | null
  /** ISO 8601, while it is resolved. */
  readonly resolvedAt: string | null
}

export const COMMENTS_SUFFIX = '.comments'

/** The most a comment's text holds, after trimming. */
export const COMMENT_TEXT_MAX = 10_000
/** The most an anchor's label holds. */
export const COMMENT_LABEL_MAX = 200
/** The most a stance holds. */
export const COMMENT_STANCE_MAX = 40
/** The most people one comment mentions. */
export const COMMENT_MENTIONS_MAX = 20

/** What a page's comments folder is called inside the tree: 'a/plan.comments'. */
const folderName = (pagePath: string): string =>
  `${pagePath.replace(/^\/+/, '').replace(/\.html$/i, '')}${COMMENTS_SUFFIX}`

/** 'a/plan.html' → 'a/plan.comments/' · 'q/index.html' → 'q/index.comments/'. */
export const commentsFolderOf = (pagePath: string): string =>
  `${folderName(pagePath)}/`

/**
 * The page a comments folder belongs to: 'a/plan.comments/' → 'a/plan.html'.
 * Null when the folder's name does not end in `.comments`.
 */
export const pageOfCommentsFolder = (folderPath: string): string | null => {
  const path = folderPath.replace(/^\/+/, '').replace(/\/+$/, '')
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (!name.endsWith(COMMENTS_SUFFIX) || name === COMMENTS_SUFFIX) return null
  return `${path.slice(0, -COMMENTS_SUFFIX.length)}.html`
}

/**
 * The comments folder a tree path is in or names, as a tree path without its
 * slash: the first folder on the way whose name ends in `.comments`. Null
 * when there is none.
 */
export const commentsFolderIn = (path: string): string | null => {
  const segments = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  for (let n = 0; n < segments.length; n += 1) {
    const name = segments[n]!
    if (name.endsWith(COMMENTS_SUFFIX) && name !== COMMENTS_SUFFIX) {
      return segments.slice(0, n + 1).join('/')
    }
  }
  return null
}

export const isThreadMark = (value: unknown): value is ThreadMark =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  (typeof (value as { resolves?: unknown }).resolves === 'string' ||
    typeof (value as { reopens?: unknown }).reopens === 'string')

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** '10 Oct 2026, 09:14 UTC'. */
const when = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hh}:${mm} UTC`
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`

/** Where a thread sits: 'On Pricing', 'On #mockup, pinned at 40% across, 22% down'. */
const placeOf = (root: CommentDoc): string => {
  if (root.anchor === null) return 'On the whole page'
  const name = root.label ?? `#${root.anchor}`
  return root.pin === null
    ? `On ${name}`
    : `On ${name}, pinned at ${percent(root.pin.x)} across, ${percent(root.pin.y)} down`
}

const commentLines = (comment: CommentDoc, reply: boolean): string[] => {
  const about = [
    `${reply ? 'Reply from ' : ''}${comment.by}`,
    when(comment.at),
    `push ${comment.push}`,
    ...(comment.stance === null ? [] : [comment.stance]),
    ...(comment.edited && !comment.deleted ? ['edited'] : []),
  ]
  const text = comment.deleted
    ? ['Comment deleted.']
    : comment.text.split('\n').map((line) => (line === '' ? '>' : `> ${line}`))
  return ['', about.join(' · '), '', ...text]
}

/**
 * A comments folder's threads as text, the way `dossier read` and a link
 * read by an agent show them: each thread's place and state, then its root
 * comment and replies with who wrote them, when, and the push they saw.
 */
export const threadsText = (i: {
  /** The comments folder inside the tree, without its slash. */
  readonly folder: string
  readonly threads: readonly { readonly data: Thread }[]
}): string => {
  if (i.threads.length === 0) return 'No comments yet.\n'
  const name = i.folder.slice(i.folder.lastIndexOf('/') + 1)
  const count =
    i.threads.length === 1 ? '1 thread' : `${i.threads.length} threads`
  const out = [`# ${name}/ (${count})`]
  for (const { data: thread } of i.threads) {
    const state =
      thread.resolved && thread.resolvedBy !== null
        ? `resolved by ${thread.resolvedBy}${thread.resolvedAt === null ? '' : `, ${when(thread.resolvedAt)}`}`
        : thread.resolved
          ? 'resolved'
          : 'open'
    out.push('', `## ${placeOf(thread.root)} · ${state}`)
    out.push(...commentLines(thread.root, false))
    for (const reply of thread.replies) out.push(...commentLines(reply, true))
  }
  return `${out.join('\n')}\n`
}
