import { Args, Command } from '@effect/cli'
import type { ChangeResponse, LinkRef, LogResponse } from '@dossier/contracts'
import { Effect } from 'effect'

import { callApi } from '../client.ts'
import { Cli } from '../io.ts'
import { jsonOption } from '../render.ts'
import { resolveTarget } from '../target.ts'
import { newestPush, nodeName } from './log.ts'
import { readPath } from './read.ts'

const days = (count: number) => (count === 1 ? '1 day' : `${count} days`)

/**
 * What deleting prints: what went, and how to bring it back. The push to
 * restore to and the retention period come from the node's history, when it
 * could be read.
 */
export const describeRm = (
  response: ChangeResponse,
  ref: LinkRef,
  history: LogResponse | null,
): string => {
  const name = nodeName(ref, response.path)
  const deleted = `Deleted ${name}.`
  if (history === null) {
    return `${deleted} Restore it from history within the retention period.`
  }
  const push = newestPush(history)
  const within = `within ${days(history.retentionDays)}`
  return push === null
    ? `${deleted} Restore it from history ${within}.`
    : `${deleted} Restore it with \`dossier restore ${name} --to ${push}\` ` +
        `${within}.`
}

export const rm = Command.make(
  'rm',
  {
    path: Args.text({ name: 'path' }).pipe(
      Args.withDescription(
        'What to delete: workspace/tree/path, workspace/tree/folder/, the ' +
          "tree's root as workspace/tree/, or a link.",
      ),
    ),
    json: jsonOption,
  },
  ({ path }) =>
    Effect.gen(function* () {
      const { output } = yield* Cli
      const { remote, ref } = yield* resolveTarget(path)
      const response = yield* callApi(remote.deployment, remote.key, (c) =>
        c.files.rm({ payload: { path: readPath(ref) } }),
      )
      if (output.json) return output.result('', response)
      // The hint is a courtesy: a history that cannot be read leaves it out.
      const history = yield* callApi(remote.deployment, remote.key, (c) =>
        c.history.log({
          urlParams: { path: nodeName(ref, response.path) },
        }),
      ).pipe(Effect.orElseSucceed(() => null))
      output.result(describeRm(response, ref, history), response)
    }),
).pipe(
  Command.withDescription(
    'Delete a file, a folder or a whole tree. It stays in history and can ' +
      'be restored with dossier restore within the retention period. Exits ' +
      '3 on a node you cannot delete, 5 when it changed while deleting.',
  ),
)
