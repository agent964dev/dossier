// A person's notifications: mentions of them or of a team that reached them,
// and replies in threads they wrote in. They are written in the comment's own
// batch (TreeStore.change), so they never drift from it. Reads show only
// what the person can open now: the comment still there with its text, a
// mention still naming them, and the page passing Access.require. Missing
// and unreadable look the same, so a page someone lost leaves no trace.
// Dossier's own screens reach every one; a page, through the shell, reaches
// only its own tree's, which the shell names, never the page.
import {
  commentFragment,
  dossierError,
  linkFor,
  NOTIFICATIONS_PAGE_MAX,
  NOTIFICATIONS_UNREAD_MAX as UNREAD_MAX,
  type DossierError,
  type NodeId,
  type TreeId,
} from '@dossier/contracts'
import { Clock, Context, Effect, Layer } from 'effect'

import { Access } from './access.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller } from './caller.ts'
import { Config } from './config.ts'
import type { NodeRow } from './rows.ts'
import { nodeOfRaw } from './tree-store.ts'

export interface NotificationView {
  readonly id: string
  readonly type: 'mention' | 'reply'
  /** A mention that reached them through a team: the team's name. */
  readonly team: string | null
  /** Who wrote the comment; null for a deleted account. */
  readonly actor: {
    readonly email: string
    readonly name: string | null
    readonly image: string | null
  } | null
  readonly workspace: string
  readonly tree: string
  /** The page's tree path and title. */
  readonly page: { readonly path: string; readonly title: string }
  /** The thread's element and its label; null on the whole page. */
  readonly anchor: string | null
  readonly label: string | null
  /** The comment's start, white space collapsed. */
  readonly excerpt: string
  /** The page's link, with the fragment `<dossier-comments>` opens. */
  readonly link: string
  /** Epoch milliseconds. */
  readonly at: number
  readonly read: boolean
  /** An agent wrote the comment, with its person's agent key. */
  readonly agent: boolean
}

export interface NotificationsPage {
  readonly notifications: readonly NotificationView[]
  /** How many are unread, at most UNREAD_MAX: past it reads "9+". */
  readonly unread: number
  /** What `before` takes for older ones; null when there are none. */
  readonly next: string | null
}

/**
 * Which notifications a call reaches: every one (Dossier's own screens), or
 * one tree's (a page's, through the shell, which names its own tree).
 */
export type NotificationScope = TreeId | null

export interface NotificationsService {
  /** Newest first, `limit` at most, before the cursor `before`. */
  readonly list: (i: {
    readonly before: string | null
    readonly limit: number
    readonly tree: NotificationScope
  }) => Effect.Effect<
    NotificationsPage,
    DossierError<'sign_in_required' | 'invalid'>,
    CurrentCaller
  >
  /** How many are unread, at most UNREAD_MAX. */
  readonly unread: (
    tree: NotificationScope,
  ) => Effect.Effect<number, DossierError<'sign_in_required'>, CurrentCaller>
  /** Marks these, or all, read; answers how many stay unread. */
  readonly markRead: (
    i: ({ readonly ids: readonly string[] } | { readonly all: true }) & {
      readonly tree: NotificationScope
    },
  ) => Effect.Effect<number, DossierError<'sign_in_required'>, CurrentCaller>
}

export class Notifications extends Context.Tag('Notifications')<
  Notifications,
  NotificationsService
>() {}

/** How long an excerpt is, in characters. */
export const EXCERPT_MAX = 140

/** Rows read per pass while unreadable ones are left out. */
const SCAN = 50
const SCANS_MAX = 4
/** The most unread rows a count reads looking for readable ones. */
const UNREAD_SCAN = 300

/**
 * What every read joins: the comment live with its text, a mention still
 * naming whom it reached, the page, its tree and its workspace live.
 */
const LIVE = `
  join nodes c on c.id = n.comment_node_id and c.deleted_at is null
  join node_versions v on v.id = c.current_version_id
  join nodes p on p.id = n.page_node_id and p.deleted_at is null
  join trees t on t.id = p.tree_id and t.deleted_at is null
  join workspaces w on w.id = t.workspace_id and w.deleted_at is null`
const STANDS = `
  json_type(v.json_value, '$.text') = 'text'
  and json_extract(v.json_value, '$.text') <> ''
  and (n.type <> 'mention' or exists (
    select 1 from json_each(v.json_value, '$.mentions') j
    where j.value = coalesce(n.via, n.email)))`

interface Row {
  readonly id: string
  readonly type: 'mention' | 'reply'
  readonly via: string | null
  readonly anchor: string | null
  readonly label: string | null
  readonly createdAt: number
  readonly readAt: number | null
  readonly pageId: NodeId
  readonly pagePath: string
  readonly commentPath: string
  readonly text: string
  readonly agent: number
  readonly actorEmail: string | null
  readonly actorName: string | null
  readonly actorImage: string | null
  readonly tree: string
  readonly workspace: string
  readonly title: string | null
}

const cursorOf = (at: { readonly at: number; readonly id: string }): string =>
  `${at.at}.${at.id}`

const parseCursor = (
  cursor: string,
): { readonly at: number; readonly id: string } | null => {
  const dot = cursor.indexOf('.')
  const at = Number(cursor.slice(0, dot))
  const id = cursor.slice(dot + 1)
  return dot > 0 && Number.isSafeInteger(at) && /^[\w-]{1,64}$/.test(id)
    ? { at, id }
    : null
}

/** 'docs/plan.html' → 'plan'; 'docs/index.html' → 'docs'. */
const fallbackTitle = (path: string): string => {
  const parts = path.split('/')
  const file = parts[parts.length - 1] ?? path
  if (file === 'index.html' && parts.length > 1) return parts[parts.length - 2]!
  return file.replace(/\.html$/i, '')
}

/** At most EXCERPT_MAX characters, white space collapsed, with an ellipsis. */
export const excerptOf = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= EXCERPT_MAX) return flat
  const cut = flat.slice(0, EXCERPT_MAX - 1)
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`
}

/** A photo only by an https address. */
const imageOf = (image: string | null): string | null =>
  image !== null && /^https:\/\/[^\s"'<>]+$/i.test(image) ? image : null

/** A comment's tree path from its page's folder: 'plan.comments/…'. */
const fromPageFolderOf = (pagePath: string, commentPath: string): string =>
  commentPath.slice(pagePath.lastIndexOf('/') + 1)

export const NotificationsLive: Layer.Layer<
  Notifications,
  never,
  Bindings | Config | Access
> = Layer.effect(
  Notifications,
  Effect.gen(function* () {
    const { DB } = yield* Bindings
    const config = yield* Config
    const access = yield* Access

    const read = <A>(what: string, run: () => Promise<A>) =>
      Effect.tryPromise(run).pipe(
        Effect.tapError((error) => Effect.logError(`${what} failed`, error)),
        Effect.orDie,
      )

    const signedIn = Effect.gen(function* () {
      const { person } = yield* CurrentCaller
      if (person === null) {
        return yield* Effect.fail(
          dossierError(
            'sign_in_required',
            'Sign in to see your notifications.',
            'Sign in with Google, or run dossier login.',
            null,
          ),
        )
      }
      return { id: person.id, email: person.email.toLowerCase() }
    })

    /** Which of these pages the caller opens now, each asked once. */
    const readablePages = (ids: readonly NodeId[]) =>
      Effect.gen(function* () {
        const wanted = [...new Set(ids)]
        if (wanted.length === 0) return new Set<string>()
        const raw = yield* read('A notification pages read', () =>
          DB.prepare(
            'select * from nodes where id in (select value from json_each(?))',
          )
            .bind(JSON.stringify(wanted))
            .all<Record<string, unknown>>(),
        )
        const nodes = raw.results.map(nodeOfRaw)
        const opens = yield* Effect.forEach(
          nodes,
          (node: NodeRow) =>
            access.require('read', node).pipe(
              Effect.isSuccess,
              Effect.map((ok) => (ok ? node.id : null)),
            ),
          { concurrency: 4 },
        )
        return new Set(opens.filter((id): id is NodeId => id !== null))
      })

    const unreadOf = (email: string, tree: NotificationScope) =>
      Effect.gen(function* () {
        // Indexed reads of the unread, newest first, with the access of
        // their pages, until UNREAD_MAX readable ones or UNREAD_SCAN rows:
        // ones on pages the person lost never hide older ones they can open.
        let readable = 0
        let from: { readonly at: number; readonly id: string } | null = null
        const opens = new Map<string, boolean>()
        for (let scanned = 0; scanned < UNREAD_SCAN; scanned += SCAN) {
          const rows = yield* read('A notifications count', () =>
            DB.prepare(
              `select n.id, n.created_at as createdAt, n.page_node_id as pageId
               from notifications n ${LIVE}
               where n.email = ?1 and n.read_at is null and ${STANDS}
                 and (?2 is null or p.tree_id = ?2)
                 and (?3 is null or n.created_at < ?3
                   or (n.created_at = ?3 and n.id < ?4))
               order by n.created_at desc, n.id desc limit ${SCAN}`,
            )
              .bind(email, tree, from?.at ?? null, from?.id ?? '')
              .all<{ id: string; createdAt: number; pageId: NodeId }>(),
          )
          const found = rows.results
          const asked = found
            .map((r) => r.pageId)
            .filter((id) => !opens.has(id))
          const open = yield* readablePages(asked)
          for (const id of asked) opens.set(id, open.has(id))
          for (const row of found) {
            if (opens.get(row.pageId) === true) readable += 1
            if (readable === UNREAD_MAX) return readable
            from = { at: row.createdAt, id: row.id }
          }
          if (found.length < SCAN) break
        }
        return readable
      })

    const list: NotificationsService['list'] = (i) =>
      Effect.gen(function* () {
        const me = yield* signedIn
        const limit = Math.max(0, Math.min(NOTIFICATIONS_PAGE_MAX, i.limit))
        let from = i.before === null ? null : parseCursor(i.before)
        if (i.before !== null && from === null) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'This cursor is not one Dossier gave.',
              'Ask again without before.',
              'before',
            ),
          )
        }
        const unread = yield* unreadOf(me.email, i.tree)
        if (limit === 0) return { notifications: [], unread, next: null }
        const shown: NotificationView[] = []
        let more = false
        for (let scan = 0; scan < SCANS_MAX; scan++) {
          const rows = yield* read('A notifications read', () =>
            DB.prepare(
              `select n.id, n.type, n.via, n.anchor, n.label,
                 n.created_at as createdAt, n.read_at as readAt,
                 p.id as pageId, p.path as pagePath, c.path as commentPath,
                 json_extract(v.json_value, '$.text') as text,
                 coalesce(json_extract(v.json_value, '$.agent'), 0) as agent,
                 u.email as actorEmail,
                 case when pp.deleted_at is null then nullif(u.name, '') end as actorName,
                 case when pp.deleted_at is null then u.image end as actorImage,
                 t.name as tree, w.name as workspace, d.title
               from notifications n ${LIVE}
                 left join "user" u on u.id = n.actor_id
                 left join people pp on pp.user_id = u.id
                 left join search_docs d on d.node_id = p.id
               where n.email = ?1 and ${STANDS}
                 and (?5 is null or p.tree_id = ?5)
                 and (?2 is null or n.created_at < ?2
                   or (n.created_at = ?2 and n.id < ?3))
               order by n.created_at desc, n.id desc
               limit ?4`,
            )
              .bind(me.email, from?.at ?? null, from?.id ?? '', SCAN, i.tree)
              .all<Row>(),
          )
          const found = rows.results
          const opens = yield* readablePages(found.map((r) => r.pageId))
          for (const row of found) {
            if (opens.has(row.pageId)) {
              if (shown.length === limit) {
                more = true
                break
              }
              shown.push(viewOf(row))
            }
            from = { at: row.createdAt, id: row.id }
          }
          if (more || found.length < SCAN) break
          // Passes end here; older ones may still follow this cursor.
          if (scan === SCANS_MAX - 1) more = true
        }
        return {
          notifications: shown,
          unread,
          next: more && from !== null ? cursorOf(from) : null,
        }
      })

    const viewOf = (row: Row): NotificationView => ({
      id: row.id,
      type: row.type,
      team:
        row.type === 'mention' &&
        row.via !== null &&
        row.via.startsWith('team:')
          ? row.via.slice('team:'.length)
          : null,
      actor:
        row.actorEmail === null
          ? null
          : {
              email: row.actorEmail,
              name: row.actorName,
              image: imageOf(row.actorImage),
            },
      workspace: row.workspace,
      tree: row.tree,
      page: {
        path: row.pagePath,
        title:
          row.title !== null && row.title.trim() !== ''
            ? row.title
            : fallbackTitle(row.pagePath),
      },
      anchor: row.anchor,
      label: row.label,
      excerpt: excerptOf(row.text),
      link: `${linkFor(config.origin, {
        workspace: row.workspace,
        tree: row.tree,
        path: row.pagePath,
        kind: 'page',
      })}${commentFragment(fromPageFolderOf(row.pagePath, row.commentPath), row.anchor)}`,
      at: row.createdAt,
      read: row.readAt !== null,
      agent: row.agent === 1,
    })

    const unread: NotificationsService['unread'] = (tree) =>
      Effect.flatMap(signedIn, (me) => unreadOf(me.email, tree))

    const markRead: NotificationsService['markRead'] = (i) =>
      Effect.gen(function* () {
        const me = yield* signedIn
        const now = yield* Clock.currentTimeMillis
        // A page's call reaches only its own tree's.
        if ('all' in i) {
          yield* read('Marking notifications read', () =>
            DB.prepare(
              `update notifications set read_at = ?2
               where email = ?1 and read_at is null
                 and (?3 is null or tree_id = ?3)`,
            )
              .bind(me.email, now, i.tree)
              .run(),
          )
        } else if (i.ids.length > 0) {
          yield* read('Marking notifications read', () =>
            DB.prepare(
              `update notifications set read_at = ?2
               where email = ?1 and read_at is null
                 and (?3 is null or tree_id = ?3)
                 and id in (select value from json_each(?4))`,
            )
              .bind(me.email, now, i.tree, JSON.stringify(i.ids.slice(0, 100)))
              .run(),
          )
        }
        return yield* unreadOf(me.email, i.tree)
      })

    return { list, unread, markRead }
  }),
)
