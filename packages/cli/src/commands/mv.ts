import { Args, Command } from '@effect/cli'
import { type MoveResponse, parseTarget } from '@dossier/contracts'
import { Effect } from 'effect'

import { callApi } from '../client.ts'
import { Cli } from '../io.ts'
import { jsonOption, usage } from '../render.ts'
import { resolveTarget } from '../target.ts'
import { readPath } from './read.ts'

/** `Design`, from a team as the deployment names it. */
const teamName = (share: string) => share.replace(/^team:/i, '').trim()

/** What a move prints: where it went, the links it updated, and its link. */
export const describeMv = (response: MoveResponse): string => {
  const count = response.rewritten.length
  const moved = `Moved ${response.from} to ${response.to}.`
  return [
    count === 0
      ? moved
      : `${moved} Updated links in ${count === 1 ? '1 file' : `${count} files`}.`,
    response.link,
    ...response.revokedTeamShares.map(
      (share) =>
        `Team ${teamName(share)} no longer reaches it: teams belong to the ` +
        'workspace it left.',
    ),
  ].join('\n')
}

export const mv = Command.make(
  'mv',
  {
    from: Args.text({ name: 'from' }).pipe(
      Args.withDescription(
        'What to move: workspace/tree/path, workspace/tree/folder/, a ' +
          "tree's root as workspace/tree, or a link.",
      ),
    ),
    to: Args.text({ name: 'to' }).pipe(
      Args.withDescription(
        'Its new path in the same tree, or for a tree, workspace/name in ' +
          'another workspace or under another name.',
      ),
    ),
    json: jsonOption,
  },
  ({ from, to }) =>
    Effect.gen(function* () {
      const { output } = yield* Cli
      const { remote, ref } = yield* resolveTarget(from)
      const destination = parseTarget(to, remote.deployment.origin)
      if (destination === null) {
        return yield* Effect.fail(
          usage(
            `"${to}" is not a path on ${remote.deployment.id}.`,
            'Give workspace/tree/path, such as agent964/acme/plans/plan.html, ' +
              'or a link on the same deployment.',
          ),
        )
      }
      const response = yield* callApi(remote.deployment, remote.key, (c) =>
        c.files.mv({
          payload: { from: readPath(ref), to: readPath(destination) },
        }),
      )
      output.result(describeMv(response), response)
    }),
).pipe(
  Command.withDescription(
    'Move or rename a file or a folder within its tree, or move a tree to ' +
      'another workspace. Its old link keeps working, and relative links in ' +
      'pages that point into or out of it are updated. Exits 3 on a node ' +
      'you cannot move, 5 when its new path is taken, 6 on a move a rule ' +
      'refuses.',
  ),
)
