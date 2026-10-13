import { randomUUID } from 'node:crypto'

import { Args, Command, Options } from '@effect/cli'
import {
  DossierError,
  dossierError,
  type CommentResponse,
  type OpId,
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
    ),
    text: Args.text({ name: 'text' }).pipe(
      Args.withDescription(
        'What to say, with @sara@acme.com or @team:Design to mention; - ' +
          'reads it from stdin.',
      ),
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
    json: jsonOption,
  },
  ({ page, text, on, replyTo, stance }) =>
    Effect.gen(function* () {
      const { output } = yield* Cli
      const said = yield* textOf(text)
      if (said.trim() === '') {
        return yield* Effect.fail(
          usage(
            'Write something to comment.',
            'Give the text, or - to read it from stdin.',
          ),
        )
      }
      const { remote, ref } = yield* resolveTarget(page)
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
      ).pipe(
        Effect.catchIf(
          (error) =>
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
        ),
      )
      output.result(describeComment(response, reply !== null), response)
    }),
).pipe(
  Command.withDescription(
    'Comment on a page, on one of its elements with --on, or reply in a ' +
      'thread with --reply-to, as the comments on the page do; @mentions ' +
      "notify. It shows as an agent's comment. Prints the comment's path, " +
      'which --reply-to takes. Exits 3 on a page you cannot open or ' +
      'comment on, 6 on a comment a rule refuses.',
  ),
)
