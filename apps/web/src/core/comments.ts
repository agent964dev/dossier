// The comment rules Data applies in a page's comments folder: what a write
// may hold, which files a read assembles into threads (with assembleThreads
// from @dossier/contracts, which an exported page uses too), and what a
// deleted comment keeps. Internal to Data and the agent reader.
import {
  assembleThreads,
  fromPageFolder,
  COMMENT_LABEL_MAX,
  COMMENT_MENTIONS_MAX,
  COMMENT_STANCE_MAX,
  COMMENT_TEXT_MAX,
  dossierError,
  teamOfMention,
  TEAM_MENTION_PREFIX,
  type CommentEntry,
  type CommentFile,
  type PushNumber,
  type ThreadMark,
  type TreeId,
} from '@dossier/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { Effect } from 'effect'

import { db } from '../db/client.ts'
import type { AccessService } from './access.ts'

export type CommentWrite =
  | { readonly kind: 'comment'; readonly entry: CommentEntry }
  | { readonly kind: 'mark'; readonly mark: ThreadMark }

export interface CommentInvalid {
  readonly invalid: string
  /** The key or path the problem is about. */
  readonly path: string | null
}

const COMMENT_KEYS: ReadonlySet<string> = new Set([
  'text',
  'anchor',
  'label',
  'pin',
  'replyTo',
  'stance',
  'mentions',
])

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const invalid = (message: string, path: string | null): CommentInvalid => ({
  invalid: message,
  path,
})

/** Text of 1 to 10,000 characters once trimmed. */
const textOf = (value: unknown): string | CommentInvalid => {
  if (typeof value !== 'string') {
    return invalid('A comment needs its text.', 'text')
  }
  const text = value.trim()
  if (text === '') return invalid('Write something to comment.', 'text')
  if (text.length > COMMENT_TEXT_MAX) {
    return invalid(
      `A comment holds at most ${COMMENT_TEXT_MAX.toLocaleString('en-US')} characters; this one has ${text.length.toLocaleString('en-US')}.`,
      'text',
    )
  }
  return text
}

/**
 * At most 20 emails, lower-cased, and teams as `team:<name>`, its name as
 * written; each once, a team's name whatever its case.
 */
const mentionsOf = (value: unknown): readonly string[] | CommentInvalid => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    return invalid(
      `Mentions are a list of emails, and ${TEAM_MENTION_PREFIX}<name> for a team.`,
      'mentions',
    )
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      return invalid(`${String(item)} is not an email.`, 'mentions')
    }
    const team = teamOfMention(item)
    if (team === null && !EMAIL.test(item.trim())) {
      return invalid(`${item} is not an email or a team.`, 'mentions')
    }
    const mention =
      team === null
        ? item.trim().toLowerCase()
        : `${TEAM_MENTION_PREFIX}${team}`
    if (seen.has(mention.toLowerCase())) continue
    seen.add(mention.toLowerCase())
    out.push(mention)
  }
  if (out.length > COMMENT_MENTIONS_MAX) {
    return invalid(
      `A comment mentions at most ${COMMENT_MENTIONS_MAX} people and teams.`,
      'mentions',
    )
  }
  return out
}

const isInvalid = (value: unknown): value is CommentInvalid =>
  isObject(value) && typeof value.invalid === 'string'

/** A string up to `max` characters, '' read as nothing. */
const optionalText = (
  value: unknown,
  key: string,
  max: number,
  what: string,
): string | null | CommentInvalid => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return invalid(`${what} is text.`, key)
  const text = value.trim()
  if (text === '') return null
  if (text.length > max) {
    return invalid(`${what} holds at most ${max} characters.`, key)
  }
  return text
}

/**
 * A comment, or a resolve or reopen, as page code wrote it into the comments
 * folder `folder` (its name from the page's folder, `plan.comments`).
 * `existing` maps every comment in the folder, by its path from the page's
 * folder, to the root of its thread; roots map to themselves.
 */
export const parseCommentWrite = (
  patch: unknown,
  folder: string,
  existing: ReadonlyMap<string, string>,
): CommentWrite | CommentInvalid => {
  if (!isObject(patch)) {
    return invalid('A comment is a JSON object.', null)
  }
  const keys = Object.keys(patch)
  const isRoot = (path: string) => existing.get(path) === path
  for (const mark of ['resolves', 'reopens'] as const) {
    if (!(mark in patch)) continue
    const other = keys.find((key) => key !== mark)
    if (other !== undefined) {
      return invalid(
        `${other} has no place beside ${mark}: a resolve or reopen names only its thread.`,
        other,
      )
    }
    const root = patch[mark]
    if (typeof root !== 'string' || !isRoot(root)) {
      return invalid(`${String(root)} is not a thread in ${folder}/.`, mark)
    }
    return {
      kind: 'mark',
      mark: mark === 'resolves' ? { resolves: root } : { reopens: root },
    }
  }
  const unknown = keys.find((key) => !COMMENT_KEYS.has(key))
  if (unknown !== undefined) {
    return invalid(`${unknown} is not part of a comment.`, unknown)
  }
  const text = textOf(patch.text)
  if (isInvalid(text)) return text
  let anchor: string | null = null
  if (patch.anchor !== undefined && patch.anchor !== null) {
    if (
      typeof patch.anchor !== 'string' ||
      patch.anchor === '' ||
      /\s/.test(patch.anchor) ||
      patch.anchor.length > COMMENT_LABEL_MAX
    ) {
      return invalid('An anchor is the id of an element on the page.', 'anchor')
    }
    anchor = patch.anchor
  }
  const label = optionalText(patch.label, 'label', COMMENT_LABEL_MAX, 'A label')
  if (isInvalid(label)) return label
  let pin: CommentEntry['pin'] = null
  if (patch.pin !== undefined && patch.pin !== null) {
    const p = patch.pin
    const within = (n: unknown) =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
    if (
      !isObject(p) ||
      Object.keys(p).some((key) => key !== 'x' && key !== 'y') ||
      !within(p.x) ||
      !within(p.y)
    ) {
      return invalid(
        'A pin is { x, y }, each a fraction between 0 and 1.',
        'pin',
      )
    }
    if (anchor === null) {
      return invalid('A pin sits on an element: give its anchor.', 'pin')
    }
    pin = { x: p.x as number, y: p.y as number }
  }
  let replyTo: string | null = null
  if (patch.replyTo !== undefined && patch.replyTo !== null) {
    const root =
      typeof patch.replyTo === 'string' ? existing.get(patch.replyTo) : null
    if (root === undefined || root === null) {
      return invalid(
        `${String(patch.replyTo)} is not a comment in ${folder}/.`,
        'replyTo',
      )
    }
    // A reply to a reply joins the thread's root.
    replyTo = root
  }
  const stance = optionalText(
    patch.stance,
    'stance',
    COMMENT_STANCE_MAX,
    'A stance',
  )
  if (isInvalid(stance)) return stance
  const mentions = mentionsOf(patch.mentions)
  if (isInvalid(mentions)) return mentions
  return {
    kind: 'comment',
    entry: { text, anchor, label, pin, replyTo, stance, mentions },
  }
}

/** What a writer may change of their comment: its text and its mentions. */
export const parseCommentRevision = (
  patch: unknown,
):
  | { readonly text?: string; readonly mentions?: readonly string[] }
  | CommentInvalid => {
  if (!isObject(patch)) return invalid('A comment is a JSON object.', null)
  const other = Object.keys(patch).find(
    (key) => key !== 'text' && key !== 'mentions',
  )
  if (other !== undefined) {
    return invalid(
      `Only a comment's text and mentions change once it is written; ${other} stays.`,
      other,
    )
  }
  if (!('text' in patch) && !('mentions' in patch)) {
    return invalid('Give the comment its new text or mentions.', null)
  }
  const out: { text?: string; mentions?: readonly string[] } = {}
  if ('text' in patch) {
    const text = textOf(patch.text)
    if (isInvalid(text)) return text
    out.text = text
  }
  if ('mentions' in patch) {
    const mentions = mentionsOf(patch.mentions)
    if (isInvalid(mentions)) return mentions
    out.mentions = mentions
  }
  return out
}

/** A deleted comment: the entry with its text and mentions gone. */
export const blankOf = (entry: CommentEntry): CommentEntry => ({
  ...entry,
  text: '',
  mentions: [],
})

/**
 * The live files of a comments folder, with their writers, read by
 * `readable` (SQL over the unaliased `nodes` table), or every one when it
 * is null.
 */
export const commentFiles = (
  bindings: Pick<Env, 'DB'>,
  treeId: TreeId,
  folder: string,
  readable: SQL | null,
) =>
  Effect.tryPromise({
    try: () =>
      db(bindings).all<{
        path: string
        createdAt: number
        email: string | null
        name: string | null
        json: string | null
        revision: number
        push: number | null
      }>(
        // A deleted account's comments keep their email and lose the name.
        sql`select nodes.path, nodes.created_at as createdAt, u.email,
              case when pp.deleted_at is null then nullif(u.name, '') end as name,
              v.json_value as json, v.revision, v.seen_push_number as push
            from nodes join node_versions v on v.id = nodes.current_version_id
              left join "user" u on u.id = nodes.owner_id
              left join people pp on pp.user_id = u.id
            where nodes.tree_id = ${treeId} and nodes.deleted_at is null
              and nodes.kind = 'file' and nodes.origin = 'data'
              and substr(nodes.path, 1, length(${folder}) + 1) = ${`${folder}/`}
              and ${readable ?? sql`1`}`,
      ),
    catch: (error) => {
      console.error('A comments read failed', error)
      return dossierError('unavailable')
    },
  }).pipe(
    Effect.map((rows) => {
      const name = fromPageFolder(folder)
      return rows.flatMap((row): CommentFile[] => {
        if (row.email === null) return []
        let value: unknown = null
        try {
          value = row.json === null ? null : JSON.parse(row.json)
        } catch {
          value = null
        }
        return [
          {
            path: `${name}${row.path.slice(folder.length)}`,
            treePath: row.path,
            by: row.email,
            name: row.name,
            at: row.createdAt,
            push: (row.push ?? 0) as PushNumber,
            revision: row.revision,
            value,
          },
        ]
      })
    }),
  )

/** The threads of a comments folder the caller reads. */
export const readThreads = (
  bindings: Pick<Env, 'DB'>,
  access: AccessService,
  treeId: TreeId,
  folder: string,
) =>
  Effect.gen(function* () {
    const readable = yield* access.readable(treeId)
    const files = yield* commentFiles(bindings, treeId, folder, readable.where)
    return assembleThreads(files)
  })
