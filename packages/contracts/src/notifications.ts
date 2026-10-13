// A person's notifications as both sides of the wire and every bell read
// them: their shape, the fragment that opens a comment on its page, and the
// words a notification shows. Plain TypeScript, so the page client's bundle
// carries no Effect.
import type { MentionablePerson } from './comments.ts'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** At most this many notifications come in one page of them. */
export const NOTIFICATIONS_PAGE_MAX = 30
/** How many come when the asker names no limit. */
export const NOTIFICATIONS_PAGE_DEFAULT = 20
/** The unread count stops here: a bell reads it as "9+". */
export const NOTIFICATIONS_UNREAD_MAX = 10

/**
 * One of a person's notifications: someone mentioned them or a team that
 * reached them, or replied in a thread they wrote in.
 */
export interface DossierNotification {
  readonly id: string
  readonly type: 'mention' | 'reply'
  /** A mention that reached them through a team: the team's name. */
  readonly team: string | null
  /** Who wrote the comment; null for a deleted account. */
  readonly actor: MentionablePerson | null
  readonly workspace: string
  readonly tree: string
  /** The page's tree path and its title. */
  readonly page: { readonly path: string; readonly title: string }
  /** The thread's element id and its label; null on the whole page. */
  readonly anchor: string | null
  readonly label: string | null
  /** The comment's start. */
  readonly excerpt: string
  /** The page's link, with the fragment `<dossier-comments>` opens. */
  readonly link: string
  /** ISO 8601. */
  readonly at: string
  readonly read: boolean
  /** An agent wrote the comment, with its person's agent key. */
  readonly agent: boolean
}

/** A page of notifications, newest first. */
export interface NotificationsList {
  readonly notifications: readonly DossierNotification[]
  /** How many are unread, at most NOTIFICATIONS_UNREAD_MAX. */
  readonly unread: number
  /** What `before` takes for older ones; null when there are none. */
  readonly next: string | null
}

const isText = (value: unknown): value is string => typeof value === 'string'
const isTextOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

const isNotification = (value: unknown): value is DossierNotification => {
  if (!isObject(value)) return false
  const { actor, page } = value
  return (
    isText(value.id) &&
    (value.type === 'mention' || value.type === 'reply') &&
    isTextOrNull(value.team) &&
    (actor === null ||
      (isObject(actor) &&
        isText(actor.email) &&
        isTextOrNull(actor.name) &&
        isTextOrNull(actor.image))) &&
    isText(value.workspace) &&
    isText(value.tree) &&
    isObject(page) &&
    isText(page.path) &&
    isText(page.title) &&
    isTextOrNull(value.anchor) &&
    isTextOrNull(value.label) &&
    isText(value.excerpt) &&
    isText(value.link) &&
    isText(value.at) &&
    typeof value.read === 'boolean' &&
    typeof value.agent === 'boolean'
  )
}

/** A page of notifications as Dossier answers it, or null for anything else. */
export const notificationsListOf = (
  value: unknown,
): NotificationsList | null =>
  isObject(value) &&
  Array.isArray(value.notifications) &&
  value.notifications.every(isNotification) &&
  Number.isInteger(value.unread) &&
  isTextOrNull(value.next)
    ? {
        notifications: value.notifications,
        unread: value.unread as number,
        next: value.next,
      }
    : null

/** The name in a link's fragment that opens a comment. */
export const COMMENT_FRAGMENT = 'dossier-comment'

/**
 * The fragment that opens a comment on its page: its path from the page's
 * folder (`plan.comments/sara@acme.com/….json`), and its thread's element.
 */
export const commentFragment = (
  commentPath: string,
  anchor: string | null,
): string => {
  const params = new URLSearchParams({ [COMMENT_FRAGMENT]: commentPath })
  if (anchor !== null) params.set('on', anchor)
  return `#${params}`
}

/** The comment a link's fragment opens, or null when it opens none. */
export const commentOfFragment = (
  hash: string,
): { readonly comment: string; readonly anchor: string | null } | null => {
  const text = hash.startsWith('#') ? hash.slice(1) : hash
  if (!text.startsWith(`${COMMENT_FRAGMENT}=`)) return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(text)
  } catch {
    return null
  }
  const comment = params.get(COMMENT_FRAGMENT) ?? ''
  if (comment === '') return null
  const anchor = params.get('on')
  return { comment, anchor: anchor === null || anchor === '' ? null : anchor }
}

/** What a bell's badge shows: nothing, 1 to 9, or "9+". */
export const unreadBadge = (unread: number): string =>
  unread <= 0 ? '' : unread > 9 ? '9+' : String(unread)

/** What a bell is named by, its count included: "Notifications, 3 unread". */
export const bellName = (unread: number): string =>
  unread <= 0
    ? 'Notifications'
    : `Notifications, ${unread > 9 ? 'more than 9' : unread} unread`

/** Who did it: their name, else their email, else "Someone". */
export const notificationActor = (n: DossierNotification): string => {
  const name = n.actor?.name?.trim() ?? ''
  return name !== '' ? name : (n.actor?.email ?? 'Someone')
}

/** What happened: "mentioned you", "mentioned Design", "replied to your thread". */
export const notificationWhat = (n: DossierNotification): string =>
  n.type === 'reply'
    ? 'replied to your thread'
    : n.team !== null
      ? `mentioned ${n.team}`
      : 'mentioned you'

/** Where: the page's title, and the item's label when it is on one. */
export const notificationWhere = (n: DossierNotification): string =>
  n.anchor === null
    ? n.page.title
    : `${n.page.title} · ${n.label ?? `#${n.anchor}`}`

const SHORT_MONTHS = [
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
] as const

/**
 * How long ago, as a bell shows it: "just now", "5 min ago", "3 h ago",
 * "2 d ago", then the day, "10 Oct", with the year when it is not this one.
 */
export const timeAgo = (iso: string, now: Date = new Date()): string => {
  const at = new Date(iso)
  const ms = now.getTime() - at.getTime()
  if (Number.isNaN(ms)) return iso
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} d ago`
  const year =
    at.getFullYear() === now.getFullYear() ? '' : ` ${at.getFullYear()}`
  return `${at.getDate()} ${SHORT_MONTHS[at.getMonth()]}${year}`
}
