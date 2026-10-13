import { Args, Command } from '@effect/cli'
import { dossierError, type DiffResponse } from '@dossier/contracts'
import { Effect, Option } from 'effect'

import { callApi } from '../client.ts'
import { Cli } from '../io.ts'
import { jsonOption } from '../render.ts'
import { resolveTarget } from '../target.ts'
import { readPath } from './read.ts'

/** A push number from the command line: a positive integer, or a refusal. */
export const pushNumberOf = (given: string, example: string) => {
  const value = given.trim()
  const number = /^\d+$/.test(value) ? Number(value) : Number.NaN
  return Number.isSafeInteger(number) && number > 0
    ? Effect.succeed(number)
    : Effect.fail(
        dossierError(
          'invalid',
          `"${given}" is not a push number.`,
          `Give a push number from dossier log, such as ${example}.`,
        ),
      )
}

const nameOf = (path: string) => {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** What `dossier diff` prints when there is no patch to print. */
export const describeNoPatch = (response: DiffResponse): string => {
  const name = nameOf(response.path)
  if (response.binary) {
    const absent = (side: string | null) => side === null || side === 'deleted'
    const what = absent(response.from)
      ? 'was added'
      : absent(response.to)
        ? 'was deleted'
        : 'changed'
    return `${name} ${what}; it is binary or too large to show, so no diff is shown.`
  }
  const between =
    response.from === null || response.to === null
      ? ''
      : ` between ${response.from} and ${response.to}`
  return `No differences in ${name}${between}.`
}

export const diff = Command.make(
  'diff',
  {
    path: Args.text({ name: 'path' }).pipe(
      Args.withDescription(
        'A file or a folder: workspace/tree/path, workspace/tree/folder/, or ' +
          'a link.',
      ),
    ),
    from: Args.text({ name: 'from' }).pipe(
      Args.withDescription(
        'The push to compare from. Alone, it compares that push with now.',
      ),
      Args.optional,
    ),
    to: Args.text({ name: 'to' }).pipe(
      Args.withDescription('The push to compare to.'),
      Args.optional,
    ),
    json: jsonOption,
  },
  ({ path, from, to }) =>
    Effect.gen(function* () {
      const { output } = yield* Cli
      const fromPush = yield* Option.match(from, {
        onNone: () => Effect.succeed(undefined),
        onSome: (given) => pushNumberOf(given, 'dossier diff <path> 11 12'),
      })
      const toPush = yield* Option.match(to, {
        onNone: () => Effect.succeed(undefined),
        onSome: (given) => pushNumberOf(given, 'dossier diff <path> 11 12'),
      })
      const { remote, ref } = yield* resolveTarget(path)
      const response = yield* callApi(remote.deployment, remote.key, (c) =>
        c.history.diff({
          urlParams: {
            path: readPath(ref),
            ...(fromPush === undefined ? {} : { from: fromPush }),
            ...(toPush === undefined ? {} : { to: toPush }),
          },
        }),
      )
      // The patch goes out byte for byte, as the deployment made it.
      if (response.patch !== null && response.patch !== '') {
        output.exact(response.patch, response)
      } else {
        output.result(describeNoPatch(response), response)
      }
    }),
).pipe(
  Command.withDescription(
    'Print a unified diff. With no push, a file shows its last change and a ' +
      'folder its latest push; with one, that push against now; with two, ' +
      'the first against the second. Exits 3 on a node whose history you ' +
      'cannot read, 6 on a push number that is not one.',
  ),
)
