import {
  dossierError,
  linkFor,
  parseTarget,
  type LinkRef,
  type LogLine,
  type PushFile,
  type PushNumber,
} from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import {
  Config,
  CurrentCaller,
  Files,
  type ChangeResult,
  type DiffResult,
  type RestorePoint,
} from '../core/index.ts'
import { runScreen, type ScreenFailure } from './run.ts'

/** Where a restore takes a file or folder back to, as the screen sends it. */
export type RestoreChoice =
  | { readonly push: number }
  /** Epoch milliseconds: the versions created at or before it. */
  | { readonly at: number }

export type HistoryLine = LogLine & {
  /** "Push 12 · First questions", "Deleted plan.html". */
  readonly label: string
  /** The author, or the writer of a withdrawal; '' when nobody is named. */
  readonly who: string
  /** "owner · 3 files": what follows the line's day, which screens write. */
  readonly meta: string
  /** The line's path as the history's folder names it: "plan.html". */
  readonly name: string
  /**
   * What Restore (a deletion) or Restore to here (a push) sends; null when
   * the line offers neither.
   */
  readonly restore: {
    /** '<workspace>/<tree>/<path>'. */
    readonly target: string
    readonly to: RestoreChoice
  } | null
}

/** A folder's or a file's history, newest first; write holders only. */
export interface HistoryView {
  readonly deployment: string
  readonly me: { readonly email: string; readonly name: string }
  readonly crumbs: readonly { readonly name: string; readonly href: string }[]
  /** The folder or file whose history this is, and its listing or link. */
  readonly folder: {
    /** "acme/" for a folder, "plan.html" for a file. */
    readonly name: string
    readonly link: string
  }
  /** '<workspace>/<tree>/<path>', with a trailing slash for a folder. */
  readonly target: string
  readonly lines: readonly HistoryLine[]
  /** The cursor of the next, older page; null on the last. */
  readonly next: string | null
  readonly retentionDays: number
}

export type PushFileView = PushFile & {
  /** The file's path as the history's folder names it. */
  readonly name: string
  /** '<workspace>/<tree>/<path>', for its diff. */
  readonly target: string
}

/** One push under the history's folder: what it changed there. */
export interface PushView {
  readonly number: number
  /** The push's message, or null. */
  readonly title: string | null
  /** "Push 12 · First questions". */
  readonly label: string
  /** When it was committed, ISO 8601. */
  readonly at: string
  /** "owner · 3 files": what follows its day, which screens write. */
  readonly meta: string
  readonly files: readonly PushFileView[]
}

export type DiffView = DiffResult

export type RestoreResult = ChangeResult

const notFound = () =>
  dossierError('not_found', 'Nothing is here, or you cannot open it.')

const TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})

const filesText = (count: number) => (count === 1 ? '1 file' : `${count} files`)

const pushLabel = (number: number, message: string | null) =>
  message === null || message.trim() === ''
    ? `Push ${number}`
    : `Push ${number} · ${message.trim()}`

/** A restore's `to`: "push 9" as it comes, a time as a day and hour. */
const pointText = (to: string): string =>
  /^\d{4}-\d{2}-\d{2}T/.test(to) && !Number.isNaN(Date.parse(to))
    ? `${TIME.format(new Date(to))} UTC`
    : to

/** A tree path as the history's folder names it. */
const nameUnder = (folder: string, path: string): string => {
  if (folder === '') return path
  if (path === folder) return path.slice(path.lastIndexOf('/') + 1)
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path
}

const targetOf = (workspace: string, tree: string, path: string) =>
  `${workspace}/${tree}/${path}`

const join = (...parts: readonly string[]) =>
  parts.filter((part) => part !== '').join(' · ')

const lineOf = (
  line: LogLine,
  at: { readonly ref: LinkRef; readonly target: string },
): HistoryLine => {
  const who = line.by ?? ''
  const name = nameUnder(at.ref.path, line.path)
  const base = { ...line, who, name }
  switch (line.kind) {
    case 'push': {
      const push = line.push
      return {
        ...base,
        label: push === null ? 'Push' : pushLabel(push.number, push.message),
        meta: join(who, push === null ? '' : filesText(push.files)),
        restore:
          push === null
            ? null
            : { target: at.target, to: { push: push.number } },
      }
    }
    case 'delete':
      return {
        ...base,
        label: `Deleted ${name}`,
        meta: join(who),
        // A deletion comes back as it stood the moment before it: the
        // versions created up to a millisecond earlier. A push number would
        // miss a restore or a data write made between that push and the
        // deletion.
        restore: line.restorable
          ? {
              target: targetOf(at.ref.workspace, at.ref.tree, line.path),
              to: { at: Date.parse(line.at) - 1 },
            }
          : null,
      }
    case 'restore':
      return {
        ...base,
        label:
          line.to === null
            ? `Restored ${name}`
            : `Restored ${name} to ${pointText(line.to)}`,
        meta: join(who),
        restore: null,
      }
    case 'move':
      return {
        ...base,
        label:
          line.to === null
            ? `Moved ${name}`
            : `Moved ${name} to ${nameUnder(at.ref.path, line.to)}`,
        meta: join(who),
        restore: null,
      }
    case 'withdrawal':
      // A withdrawal shows no content: who withdrew, and when.
      return {
        ...base,
        label: `${who === '' ? 'Someone' : who} withdrew a submission`,
        meta: '',
        restore: null,
      }
  }
}

const refOf = (target: string, origin: URL) =>
  Effect.suspend(() => {
    const ref = parseTarget(target, origin)
    return ref === null ? Effect.fail(notFound()) : Effect.succeed(ref)
  })

/** The splat as the route gives it, made a target. */
const historyTarget = (input: {
  readonly workspace: string
  readonly tree: string
  readonly path: string
  readonly folder: boolean
}) => {
  const path = input.path.replace(/^\/+|\/+$/g, '')
  const slash = input.folder && path !== '' ? '/' : ''
  return `${input.workspace}/${input.tree}/${path}${slash}`
}

export const historyView = createServerFn({ method: 'GET' })
  .validator(
    (input: {
      readonly workspace: string
      readonly tree: string
      readonly path: string
      /** The URL ends in a slash, or names the tree's root. */
      readonly folder: boolean
      readonly cursor: string | null
    }) => ({
      workspace: String(input.workspace),
      tree: String(input.tree),
      path: String(input.path ?? ''),
      folder: input.folder !== false,
      cursor:
        typeof input.cursor === 'string' && input.cursor !== ''
          ? input.cursor
          : null,
    }),
  )
  .handler(({ data }): Promise<HistoryView | ScreenFailure> =>
    runScreen(
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const me = caller.person
        if (me === null) {
          return yield* Effect.fail(
            dossierError('sign_in_required', 'Sign in to see history.'),
          )
        }
        const config = yield* Config
        const target = historyTarget(data)
        const ref = yield* refOf(target, config.origin)
        const page = yield* (yield* Files).log({ ref, cursor: data.cursor })
        const segments = ref.path === '' ? [] : ref.path.split('/')
        const folderAt = (path: string) =>
          linkFor(config.origin, {
            workspace: ref.workspace,
            tree: ref.tree,
            path,
            kind: 'folder',
          })
        const own = `/_/history/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.tree)}/${segments.map(encodeURIComponent).join('/')}${ref.folder && segments.length > 0 ? '/' : ''}`
        const crumbs = [
          {
            name: ref.workspace,
            href: `/?w=${encodeURIComponent(ref.workspace)}`,
          },
          { name: ref.tree, href: folderAt('') },
          ...segments.map((name, index) => ({
            name,
            href: folderAt(segments.slice(0, index + 1).join('/')),
          })),
          { name: 'history', href: own },
        ]
        const last = segments[segments.length - 1] ?? ref.tree
        return {
          deployment: config.deploymentName,
          me: { email: me.email, name: me.name },
          crumbs,
          folder: {
            name: ref.folder ? `${last}/` : last,
            link: ref.folder
              ? folderAt(ref.path)
              : linkFor(config.origin, {
                  workspace: ref.workspace,
                  tree: ref.tree,
                  path: ref.path,
                  kind: ref.path.endsWith('.html') ? 'page' : 'file',
                }),
          },
          target,
          lines: page.lines.map((line) => lineOf(line, { ref, target })),
          next: page.next,
          retentionDays: page.retentionDays,
        } satisfies HistoryView
      }),
    ),
  )

const pushNumber = (value: unknown): PushNumber | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? (value as PushNumber)
    : null

export const pushView = createServerFn({ method: 'GET' })
  .validator((input: { readonly target: string; readonly number: number }) => ({
    target: String(input.target),
    number: Number(input.number),
  }))
  .handler(({ data }): Promise<PushView | ScreenFailure> =>
    runScreen(
      Effect.gen(function* () {
        const config = yield* Config
        const ref = yield* refOf(data.target, config.origin)
        const number = pushNumber(data.number)
        if (number === null) return yield* Effect.fail(notFound())
        const detail = yield* (yield* Files).pushDetail({ ref, number })
        const at = new Date(
          detail.push.committedAt ?? detail.push.createdAt,
        ).toISOString()
        return {
          number,
          title: detail.push.message,
          label: pushLabel(number, detail.push.message),
          at,
          meta: join(detail.by, filesText(detail.files.length)),
          files: detail.files.map((file) => ({
            ...file,
            name: nameUnder(ref.path, file.path),
            target: targetOf(ref.workspace, ref.tree, file.path),
          })),
        } satisfies PushView
      }),
    ),
  )

export const diffView = createServerFn({ method: 'GET' })
  .validator(
    (input: {
      readonly target: string
      readonly from: number | null
      readonly to: number | null
    }) => ({
      target: String(input.target),
      from: input.from === null ? null : Number(input.from),
      to: input.to === null ? null : Number(input.to),
    }),
  )
  .handler(({ data }): Promise<DiffView | ScreenFailure> =>
    runScreen(
      Effect.gen(function* () {
        const config = yield* Config
        const ref = yield* refOf(data.target, config.origin)
        return yield* (yield* Files).diff({
          ref,
          from: pushNumber(data.from),
          to: pushNumber(data.to),
        })
      }),
    ),
  )

const restorePoint = (to: unknown): RestorePoint | null => {
  if (typeof to !== 'object' || to === null) return null
  if ('push' in to) {
    const push = pushNumber((to as { push: unknown }).push)
    return push === null ? null : { push }
  }
  if ('at' in to) {
    const at = (to as { at: unknown }).at
    return typeof at === 'number' && Number.isSafeInteger(at) && at >= 0
      ? { at }
      : null
  }
  return null
}

/** Restore and Restore to here: a file or folder made to match a point. */
export const restore = createServerFn({ method: 'POST' })
  .validator(
    (input: { readonly target: string; readonly to: RestoreChoice }) => ({
      target: String(input.target),
      to: restorePoint(input.to),
    }),
  )
  .handler(({ data }): Promise<RestoreResult | ScreenFailure> =>
    runScreen(
      Effect.gen(function* () {
        const config = yield* Config
        const ref = yield* refOf(data.target, config.origin)
        if (data.to === null) {
          return yield* Effect.fail(
            dossierError('invalid', 'Choose a push or a time to restore to.'),
          )
        }
        return yield* (yield* Files).restore({ ref, to: data.to })
      }),
    ),
  )
