// How comments are stored and read back. Plain TypeScript with no run-time
// imports, so the base component, a replacement component in a kit, the
// Worker, an exported page and the CLI read the same shapes and assemble
// threads the same way.
//
// A page's comments live beside it in a data folder named after it
// (`plan.html` keeps them in `plan.comments/`). Every writer has their own
// folder there, and each comment, resolve or reopen is one entry in it.

import type { DocWire } from './api.ts'

/** One comment, as its entry holds it. */
export interface CommentEntry {
  /** '' once deleted. */
  readonly text: string
  /** An element id on the page, or null for the whole page. */
  readonly anchor: string | null
  /**
   * That element's title, aria-label, alt text for an image, or first
   * heading when written.
   */
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
  /**
   * Lower-cased emails, and `team:<name>` for a team of the page's
   * workspace, its name as written.
   */
  readonly mentions: readonly string[]
  /**
   * Written through an agent key, with the CLI. Dossier records it from how
   * the writer came, and never takes it from what is written.
   */
  readonly agent?: boolean
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
  /** The writer's display name, or null when Dossier has none. */
  readonly name: string | null
  /** When it was first written, ISO 8601. */
  readonly at: string
  /** The push of the page the writer saw. */
  readonly push: number
  /** Revised after it was first written. */
  readonly edited: boolean
  /** Its text is gone: show "Comment deleted". */
  readonly deleted: boolean
  /** An agent wrote it, through the CLI with its person's agent key. */
  readonly agent: boolean
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
/** The most people and teams one comment mentions. */
export const COMMENT_MENTIONS_MAX = 20
/** The most people, and the most teams, one suggestion of whom to mention gives. */
export const MENTIONABLE_MAX = 8
/** The longest text after @ that suggestions are asked for. */
export const MENTIONABLE_QUERY_MAX = 100

/** What a comment's mentions hold for a team: `team:Design`. */
export const TEAM_MENTION_PREFIX = 'team:'

/** A team's name as teams keep it: trimmed, 1 to 60 characters. */
export const isTeamNameText = (name: string): boolean =>
  name.length > 0 && name.length <= 60 && name.trim() === name

/** The team a mention names, or null when it names a person. */
export const teamOfMention = (mention: string): string | null => {
  if (!mention.startsWith(TEAM_MENTION_PREFIX)) return null
  const name = mention.slice(TEAM_MENTION_PREFIX.length)
  return isTeamNameText(name) ? name : null
}

/** A team's name that stands bare after `@team:`, ending at anything else. */
export const BARE_TEAM_NAME = /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u

/**
 * How a comment's text mentions a team: `@team:Design`, or with quotes when
 * its name holds anything else, `@team:"Design Ops"`, a quote or backslash
 * in it escaped with a backslash.
 */
export const teamMentionText = (name: string): string =>
  BARE_TEAM_NAME.test(name)
    ? `@${TEAM_MENTION_PREFIX}${name}`
    : `@${TEAM_MENTION_PREFIX}"${name.replace(/[\\"]/g, (c) => `\\${c}`)}"`

/**
 * An @ and what it mentions: a team, quoted (`@team:"Design Ops"`) or bare
 * (`@team:Design`), or an email. Group 1 is what comes before the @, 2 a
 * quoted team's name, 3 a bare one's, 4 an email.
 */
export const MENTION_PATTERN =
  /(^|[^\w.+-])@(?:team:(?:"((?:[^"\\\n]|\\.)*)"|([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*))|([\w.+-]+@[\w-]+(?:\.[\w-]+)+))/gu

/**
 * Whom a text mentions with @, each once, in order: emails lower-cased, and
 * teams as `team:<name>`, named as written. The comment composer and the
 * CLI's `dossier comment` both read mentions this way.
 */
export const mentionsIn = (text: string): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_PATTERN)) {
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

/** A person to mention: their email, display name and photo. */
export interface MentionablePerson {
  readonly email: string
  readonly name: string | null
  /** The address of their photo, or null. */
  readonly image: string | null
}

/** A team to mention, with how many people it has. */
export interface MentionableTeam {
  readonly name: string
  readonly members: number
}

/**
 * Whom the viewer may mention on a page, for what follows their @. A member
 * of the page's workspace gets the people and teams who can open the page;
 * anyone else gets nobody.
 */
export interface Mentionable {
  readonly people: readonly MentionablePerson[]
  readonly teams: readonly MentionableTeam[]
}

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One file of a comments folder, as assembling reads it. */
export interface CommentFile {
  /** From the page's folder: 'plan.comments/sara@acme.com/….json'. */
  readonly path: string
  /** Inside the tree. */
  readonly treePath: string
  /** The writer's email. */
  readonly by: string
  /** The writer's display name; null or absent when there is none. */
  readonly name?: string | null
  /** When the entry was first written, ms. */
  readonly at: number
  readonly push: DocWire['push']
  /** Its versions: more than one once revised. */
  readonly revision: number
  readonly value: unknown
}

export const isCommentValue = (value: unknown): value is CommentEntry =>
  isObject(value) && typeof value.text === 'string'

const docOf = (file: CommentFile, entry: CommentEntry): CommentDoc => ({
  text: entry.text,
  anchor: typeof entry.anchor === 'string' ? entry.anchor : null,
  label: typeof entry.label === 'string' ? entry.label : null,
  pin:
    isObject(entry.pin) &&
    typeof entry.pin.x === 'number' &&
    typeof entry.pin.y === 'number'
      ? { x: entry.pin.x, y: entry.pin.y }
      : null,
  replyTo: typeof entry.replyTo === 'string' ? entry.replyTo : null,
  stance: typeof entry.stance === 'string' ? entry.stance : null,
  mentions: Array.isArray(entry.mentions)
    ? entry.mentions.filter((m): m is string => typeof m === 'string')
    : [],
  path: file.path,
  by: file.by,
  name: typeof file.name === 'string' && file.name !== '' ? file.name : null,
  at: new Date(file.at).toISOString(),
  push: file.push,
  edited: file.revision > 1 && entry.text !== '',
  deleted: entry.text === '',
  agent: entry.agent === true,
})

const byTime = (a: CommentFile, b: CommentFile) =>
  a.at - b.at || a.path.localeCompare(b.path)

/** A thread as a read gives it: the root's tree path, the Thread as data. */
export type ThreadWire = DocWire & { readonly data: Thread }

/**
 * The threads of a comments folder: one Doc per root comment, by its time,
 * with its replies oldest first and the newest resolve or reopen deciding
 * whether it is resolved. The Doc's path is the root's tree path.
 */
export const assembleThreads = (
  files: readonly CommentFile[],
): readonly ThreadWire[] => {
  const sorted = [...files].sort(byTime)
  const roots = sorted.filter(
    (f) => isCommentValue(f.value) && f.value.replyTo === null,
  )
  const replies = new Map<string, CommentDoc[]>()
  const marks = new Map<string, { file: CommentFile; resolves: boolean }>()
  for (const file of sorted) {
    const value = file.value
    if (isCommentValue(value)) {
      if (typeof value.replyTo !== 'string') continue
      const list = replies.get(value.replyTo) ?? []
      list.push(docOf(file, value))
      replies.set(value.replyTo, list)
    } else if (isObject(value)) {
      const root =
        typeof value.resolves === 'string'
          ? value.resolves
          : typeof value.reopens === 'string'
            ? value.reopens
            : null
      // Sorted oldest first, so the last one seen is the newest.
      if (root !== null) {
        marks.set(root, { file, resolves: typeof value.resolves === 'string' })
      }
    }
  }
  return roots.map((file) => {
    const mark = marks.get(file.path)
    const resolved = mark?.resolves === true
    const thread: Thread = {
      root: docOf(file, file.value as CommentEntry),
      replies: replies.get(file.path) ?? [],
      resolved,
      resolvedBy: resolved ? mark!.file.by : null,
      resolvedAt: resolved ? new Date(mark!.file.at).toISOString() : null,
    }
    return {
      path: file.treePath,
      data: thread,
      by: file.by,
      at: new Date(file.at).toISOString(),
      push: file.push,
    } satisfies ThreadWire
  })
}

/** 'a/plan.comments' → 'plan.comments': the folder from its page's folder. */
export const fromPageFolder = (folder: string): string =>
  folder.slice(folder.lastIndexOf('/') + 1)

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
    `${reply ? 'Reply from ' : ''}${comment.by}${comment.agent ? ' (agent)' : ''}`,
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
