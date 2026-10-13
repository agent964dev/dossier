import { randomUUID } from 'node:crypto'

import { Args, Command, Options } from '@effect/cli'
import {
  commentOfFragment,
  DossierError,
  dossierError,
  type CommentResponse,
  type LinkRef,
  type OpId,
  type ThreadMarkResponse,
} from '@dossier/contracts'
import { Effect, Option } from 'effect'

import { callApi } from '../client.ts'
import { Cli } from '../io.ts'
import { jsonOption, usage } from '../render.ts'
import { resolveTarget } from '../target.ts'
import { notFoundMessage, readPath } from './read.ts'

/** What a comment prints: where it went, its path for --reply-to, its link. */
export const describeComment = (
  response: CommentResponse,
  reply: boolean,
): string =>
  [
    `${reply ? 'Replied' : 'Commented'} on ${response.page}: ${response.comment}`,
    response.link,
  ].join('\n')

/** What a resolve or a reopen did, and the link that opens the thread. */
export const describeMark = (response: ThreadMarkResponse): string =>
  [
    response.changed
      ? `${response.resolved ? 'Resolved' : 'Reopened'} ${response.thread} on ${response.page}.`
      : `${response.thread} on ${response.page} was already ${response.resolved ? 'resolved' : 'open'}.`,
    response.link,
  ].join('\n')

/** A not_found worded for what the command line named. */
const notFoundAt = (ref: LinkRef) =>
  Effect.catchIf(
    (error: unknown) =>
      error instanceof DossierError && error.code === 'not_found',
    (error) =>
      Effect.fail(
        dossierError(
          'not_found',
          notFoundMessage(ref),
          (error as DossierError).fix,
          (error as DossierError).path,
        ),
      ),
  )

/**
 * `--resolve` or `--reopen`: the thread, with the page when given. A link
 * that opens a comment (`…/plan#dossier-comment=…`) names both.
 */
const markThread = (i: {
  readonly thread: string
  readonly page: string | null
  readonly resolved: boolean
}) =>
  Effect.gen(function* () {
    const { output } = yield* Cli
    let page = i.page
    let thread = i.thread.trim()
    const hash = thread.indexOf('#')
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(thread) && hash >= 0) {
      const opened = commentOfFragment(thread.slice(hash))
      if (opened !== null) {
        page ??= thread.slice(0, hash)
        thread = opened.comment
      }
    }
    const { remote, ref } = yield* resolveTarget(page ?? thread)
    const response = yield* callApi(remote.deployment, remote.key, (c) =>
      c.comments.thread({
        payload: {
          thread: page === null ? readPath(ref) : thread,
          page: page === null ? undefined : readPath(ref),
          resolved: i.resolved,
          opId: randomUUID() as OpId,
        },
      }),
    ).pipe(notFoundAt(ref))
    output.result(describeMark(response), response)
  })

/** The text: as given, or all of stdin for `-`. */
const textOf = (given: string) =>
  Effect.gen(function* () {
    if (given !== '-') return given
    const { io } = yield* Cli
    if (io.stdin === undefined) {
      return yield* Effect.fail(
        usage('Nothing to read the comment from.', 'Give its text instead.'),
      )
    }
    return yield* Effect.promise(() => io.stdin!())
  })

export const comment = Command.make(
  'comment',
  {
    page: Args.text({ name: 'page' }).pipe(
      Args.withDescription(
        'The page to comment on: workspace/tree/path, or a link.',
      ),
      Args.optional,
    ),
    text: Args.text({ name: 'text' }).pipe(
      Args.withDescription(
        'What to say, with @sara@acme.com or @team:Design to mention; - ' +
          'reads it from stdin.',
      ),
      Args.optional,
    ),
    on: Options.text('on').pipe(
      Options.withDescription(
        'The id of the element on the page the comment is about.',
      ),
      Options.optional,
    ),
    replyTo: Options.text('reply-to').pipe(
      Options.withDescription(
        "A thread's path, as dossier comment prints it or --json reads " +
          "it from the page's comments, to reply in it.",
      ),
      Options.optional,
    ),
    stance: Options.text('stance').pipe(
      Options.withDescription('A stance the page offers, such as reopen.'),
      Options.optional,
    ),
    resolve: Options.text('resolve').pipe(
      Options.withDescription(
        'Resolve a thread instead of commenting, named by its root ' +
          'comment: a link that opens it, workspace/tree/<its path in the ' +
          'tree>, or, after the page, its path as dossier comment prints it.',
      ),
      Options.optional,
    ),
    reopen: Options.text('reopen').pipe(
      Options.withDescription(
        'Reopen a resolved thread, named as for --resolve.',
      ),
      Options.optional,
    ),
    json: jsonOption,
  },
  ({ page, text, on, replyTo, stance, resolve, reopen }) =>
    Effect.gen(function* () {
      const { output } = yield* Cli
      const mark = Option.orElse(resolve, () => reopen)
      if (Option.isSome(mark)) {
        if (Option.isSome(resolve) && Option.isSome(reopen)) {
          return yield* Effect.fail(
            usage('Give --resolve or --reopen, not both.'),
          )
        }
        if (
          Option.isSome(text) ||
          Option.isSome(on) ||
          Option.isSome(replyTo) ||
          Option.isSome(stance)
        ) {
          return yield* Effect.fail(
            usage(
              'A resolve or reopen takes only its thread, and the page if ' +
                'you like.',
              'Leave out the text, --on, --reply-to and --stance, or ' +
                'comment separately.',
            ),
          )
        }
        return yield* markThread({
          thread: mark.value,
          page: Option.getOrNull(page),
          resolved: Option.isSome(resolve),
        })
      }
      if (Option.isNone(page) || Option.isNone(text)) {
        return yield* Effect.fail(
          usage(
            'Give the page and what to say.',
            'dossier comment <page> <text>, or --resolve or --reopen with ' +
              'a thread.',
          ),
        )
      }
      const said = yield* textOf(text.value)
      if (said.trim() === '') {
        return yield* Effect.fail(
          usage(
            'Write something to comment.',
            'Give the text, or - to read it from stdin.',
          ),
        )
      }
      const { remote, ref } = yield* resolveTarget(page.value)
      const reply = Option.getOrNull(replyTo)
      const response = yield* callApi(remote.deployment, remote.key, (c) =>
        c.comments.comment({
          payload: {
            path: readPath(ref),
            text: said,
            on: Option.getOrUndefined(on),
            replyTo: reply ?? undefined,
            stance: Option.getOrUndefined(stance),
            opId: randomUUID() as OpId,
          },
        }),
      ).pipe(notFoundAt(ref))
      output.result(describeComment(response, reply !== null), response)
    }),
).pipe(
  Command.withDescription(
    'Comment on a page, on one of its elements with --on, or reply in a ' +
      'thread with --reply-to, as the comments on the page do; @mentions ' +
      "notify. It shows as an agent's comment. Prints the comment's path, " +
      'which --reply-to, --resolve and --reopen take. --resolve and ' +
      '--reopen resolve or reopen a thread, for anyone who may comment ' +
      'there. Exits 3 on a page you cannot open or comment on, 6 on a ' +
      'comment a rule refuses or a thread that is not one.',
  ),
)
