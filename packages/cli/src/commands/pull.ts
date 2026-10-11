import { resolve } from 'node:path'

import { Args, Command } from '@effect/cli'
import { Effect } from 'effect'

import { Cli } from '../io.ts'
import { jsonOption } from '../render.ts'
import { type PullOutcome, Remote, Sync, SyncLive } from '../sync.ts'
import { resolveTarget } from '../target.ts'

const files = (n: number): string => (n === 1 ? '1 file' : `${n} files`)

/** One line per written file, then a plain summary. */
export const describePull = (outcome: PullOutcome, dir: string): string => {
  const at = outcome.push === null ? '' : ` at push ${outcome.push}`
  const summary =
    outcome.written.length === 0
      ? `${dir} is up to date${at}.`
      : `Pulled ${files(outcome.written.length)} into ${dir}${at}` +
        (outcome.unchanged === 0
          ? '.'
          : `; ${files(outcome.unchanged)} already up to date.`)
  return [...outcome.written.map((path) => `pulled   ${path}`), summary].join(
    '\n',
  )
}

export const pull = Command.make(
  'pull',
  {
    target: Args.text({ name: 'target' }).pipe(
      Args.withDescription(
        'What to pull: workspace/tree or workspace/tree/path, or a link.',
      ),
    ),
    dir: Args.text({ name: 'dir' }).pipe(
      Args.withDescription('The local folder to write into.'),
    ),
    json: jsonOption,
  },
  ({ target, dir }) =>
    Effect.gen(function* () {
      const { io, output } = yield* Cli
      const { remote, ref } = yield* resolveTarget(target)
      const outcome = yield* Effect.flatMap(Sync, (sync) =>
        sync.pull({ target: ref, dir: resolve(io.cwd, dir) }),
      ).pipe(Effect.provide(SyncLive), Effect.provideService(Remote, remote))
      output.result(describePull(outcome, dir), outcome)
    }),
).pipe(
  Command.withDescription(
    'Copy a node of a tree into a local folder; files people wrote through ' +
      'forms are written read-only.',
  ),
)
