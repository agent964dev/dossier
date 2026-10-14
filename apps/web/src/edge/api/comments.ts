import {
  commentFragment,
  commentsFolderIn,
  dossierError,
  DossierApi,
  linkFor,
  pageOfCommentsFolder,
  parseTarget,
  type LinkRef,
} from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { Config, Data } from '../../core/index.ts'
import { targetOf } from './target.ts'

const notAThread = (thread: string) =>
  dossierError(
    'invalid',
    `${thread} is not a thread.`,
    "Give a thread's path as dossier comment prints it, or with the page " +
      "its path from the page's folder.",
    'thread',
  )

/**
 * The page and its thread: the page as given, or the page whose comments
 * folder the thread's own target lies in.
 */
const threadOf = (payload: {
  readonly thread: string
  readonly page?: string
}) =>
  Effect.gen(function* () {
    if (payload.page !== undefined) {
      return { ref: yield* targetOf(payload.page), thread: payload.thread }
    }
    const at = yield* targetOf(payload.thread).pipe(
      Effect.mapError(() => notAThread(payload.thread)),
    )
    const folder = commentsFolderIn(at.path)
    const page = folder === null ? null : pageOfCommentsFolder(folder)
    if (folder === null || page === null || at.path === folder) {
      return yield* Effect.fail(notAThread(payload.thread))
    }
    // The page as its link names it: `plan`, or `questions/` for an index.
    const config = yield* Config
    const ref: LinkRef | null = parseTarget(
      linkFor(config.origin, {
        workspace: at.workspace,
        tree: at.tree,
        path: page,
        kind: 'page',
      }),
      config.origin,
    )
    if (ref === null) return yield* Effect.fail(notAThread(payload.thread))
    return { ref, thread: at.path }
  })

/**
 * `dossier comment`: the comment component's write, from the command line.
 * Written with an agent key, the comment is an agent's.
 */
export const CommentsApiLive = HttpApiBuilder.group(
  DossierApi,
  'comments',
  (handlers) =>
    handlers
      .handle('comment', ({ payload }) =>
        Effect.gen(function* () {
          const ref = yield* targetOf(payload.path)
          const written = yield* (yield* Data).comment({
            ref,
            text: payload.text,
            anchor: payload.on ?? null,
            replyTo: payload.replyTo ?? null,
            stance: payload.stance ?? null,
            opId: payload.opId,
          })
          const config = yield* Config
          const data = written.doc.data as { anchor?: unknown } | null
          const anchor = typeof data?.anchor === 'string' ? data.anchor : null
          return {
            comment: written.comment,
            page: written.page,
            link: `${linkFor(config.origin, {
              workspace: ref.workspace,
              tree: ref.tree,
              path: written.page,
              kind: 'page',
            })}${commentFragment(written.comment, anchor)}`,
            doc: written.doc,
          }
        }),
      )
      .handle('thread', ({ payload }) =>
        Effect.gen(function* () {
          const { ref, thread } = yield* threadOf(payload)
          const marked = yield* (yield* Data).markThread({
            ref,
            thread,
            resolved: payload.resolved,
            opId: payload.opId,
          })
          const config = yield* Config
          return {
            thread: marked.thread,
            page: marked.page,
            resolved: payload.resolved,
            changed: marked.changed,
            link: `${linkFor(config.origin, {
              workspace: ref.workspace,
              tree: ref.tree,
              path: marked.page,
              kind: 'page',
            })}${commentFragment(marked.thread, marked.anchor)}`,
          }
        }),
      ),
)
