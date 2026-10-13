import { Args, Command, Options } from '@effect/cli'
import {
  type ChangeResponse,
  dossierError,
  type LinkRef,
  PushNumber,
  type RestoreTo,
} from '@dossier/contracts'
import { Effect } from 'effect'

import { callApi } from '../client.ts'
import { Cli } from '../io.ts'
import { jsonOption } from '../render.ts'
import { resolveTarget } from '../target.ts'
import { nodeName } from './log.ts'
import { readPath } from './read.ts'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:$|T)/

/** `--to 9` is push 9; `--to 2026-10-11T09:30:00Z` is that time. */
export const restorePointOf = (given: string) => {
  const value = given.trim()
  if (/^\d+$/.test(value)) {
    const push = Number(value)
    if (Number.isSafeInteger(push) && push > 0) {
      return Effect.succeed<RestoreTo>({ push: PushNumber.make(push) })
    }
  } else if (ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))) {
    return Effect.succeed<RestoreTo>({ at: value })
  }
  return Effect.fail(
    dossierError(
      'invalid',
      `"${given}" is not a push number or a time.`,
      'Give a push number from dossier log, such as --to 9, or an ISO 8601 ' +
        'time, such as --to 2026-10-11T09:30:00Z.',
    ),
  )
}

/** `push 9`, or the time as it was given. */
const pointText = (to: RestoreTo) => ('push' in to ? `push ${to.push}` : to.at)

/** What restoring prints: the sentence, then each file it changed. */
export const describeRestore = (
  response: ChangeResponse,
  ref: LinkRef,
  to: RestoreTo,
): string => {
  const name = nodeName(ref, response.path)
  if (response.changed.length === 0) {
    return `Nothing to restore: ${name} already matches ${pointText(to)}.`
  }
  return [
    `Restored ${name} to ${pointText(to)}.`,
    ...response.changed.map((path) => `- ${path}`),
  ].join('\n')
}

export const restore = Command.make(
  'restore',
  {
    path: Args.text({ name: 'path' }).pipe(
      Args.withDescription(
        'A file or a folder, deleted or not: workspace/tree/path, ' +
          'workspace/tree/folder/, or a link.',
      ),
    ),
    to: Options.text('to').pipe(
      Options.withDescription(
        'A push number from dossier log, or an ISO 8601 time such as ' +
          '2026-10-11T09:30:00Z.',
      ),
    ),
    json: jsonOption,
  },
  ({ path, to }) =>
    Effect.gen(function* () {
      const { output } = yield* Cli
      const point = yield* restorePointOf(to)
      const { remote, ref } = yield* resolveTarget(path)
      const response = yield* callApi(remote.deployment, remote.key, (c) =>
        c.history.restore({ payload: { path: readPath(ref), to: point } }),
      )
      output.result(describeRestore(response, ref, point), response)
    }),
).pipe(
  Command.withDescription(
    'Bring a file or a folder back to how it was just after a push, or at ' +
      'a time, and print the files that changed. A folder matches that ' +
      'point: files made since are deleted, data written since stays. ' +
      'Exits 3 on a node you cannot restore or past the retention period, ' +
      '5 when a newer node holds its path, 6 on a point it did not exist at.',
  ),
)
