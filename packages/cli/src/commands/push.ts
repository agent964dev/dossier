import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Args, Command, Options } from '@effect/cli'
import type { PushWarning } from '@dossier/html'
import { Effect, Option } from 'effect'

import { Cli } from '../io.ts'
import { jsonOption, usage } from '../render.ts'
import { type PushOutcome, Remote, Sync, SyncLive } from '../sync.ts'
import { resolveTarget } from '../target.ts'

/** The longest message a push may carry. */
const MESSAGE_LIMIT = 500

const warningText = (warning: PushWarning): string =>
  warning.message.startsWith(warning.path)
    ? warning.message
    : `${warning.path}: ${warning.message}`

/** One line per change, ignored data path and warning, then where it landed. */
export const describePush = (outcome: PushOutcome): string => {
  const { plan } = outcome
  const lines = [
    ...plan.added.map((path) => `added    ${path}`),
    ...plan.changed.map((path) => `changed  ${path}`),
    ...plan.deleted.map((path) => `deleted  ${path}`),
    ...plan.ignored.map(
      (ignored) =>
        `ignored  ${ignored.path} (a data file; pushes never change data)`,
    ),
    ...outcome.warnings.map((warning) => `warning  ${warningText(warning)}`),
  ]
  const at =
    outcome.number === null
      ? outcome.link
      : `${outcome.link}  (push ${outcome.number})`
  if (outcome.dryRun) {
    lines.push(`Dry run: nothing was published. ${outcome.link}`)
  } else if (!outcome.committed) {
    lines.push(`No changes. ${at}`)
  } else {
    lines.push(at)
  }
  return lines.join('\n')
}

export const pushJson = (outcome: PushOutcome) => ({
  push: outcome.dryRun ? null : outcome.number,
  link: outcome.link,
  added: outcome.plan.added,
  changed: outcome.plan.changed,
  deleted: outcome.plan.deleted,
  ignored: outcome.plan.ignored,
  warnings: outcome.warnings,
  dryRun: outcome.dryRun,
})

export const push = Command.make(
  'push',
  {
    dir: Args.text({ name: 'dir' }).pipe(
      Args.withDescription('The local folder to push.'),
    ),
    target: Args.text({ name: 'target' }).pipe(
      Args.withDescription(
        'Where it lands: workspace/tree or workspace/tree/path, or a link.',
      ),
    ),
    message: Options.text('message').pipe(
      Options.withAlias('m'),
      Options.withDescription('A short note on what this push changes.'),
      Options.optional,
    ),
    dryRun: Options.boolean('dry-run').pipe(
      Options.withDescription('Show what would change and publish nothing.'),
    ),
    force: Options.boolean('force').pipe(
      Options.withDescription(
        'Push even if someone pushed to the path since this folder last ' +
          'pulled or pushed.',
      ),
    ),
    json: jsonOption,
  },
  ({ dir, target, message, dryRun, force }) =>
    Effect.gen(function* () {
      const { io, output } = yield* Cli
      const text = Option.getOrNull(message)
      if (text !== null && text.length > MESSAGE_LIMIT) {
        return yield* Effect.fail(
          usage(
            `The message is ${text.length} characters; a push message may ` +
              `be at most ${MESSAGE_LIMIT}.`,
            'Shorten the message.',
          ),
        )
      }
      const { remote, ref } = yield* resolveTarget(target)
      const folder = resolve(io.cwd, dir)
      const info = yield* Effect.promise(() => stat(folder).catch(() => null))
      if (info === null || !info.isDirectory()) {
        return yield* Effect.fail(
          usage(
            `${dir} is not a folder.`,
            'Give the folder to push, such as ./site.',
          ),
        )
      }
      const outcome = yield* Effect.flatMap(Sync, (sync) =>
        sync.push({
          dir: folder,
          target: ref,
          message: text,
          dryRun,
          force,
        }),
      ).pipe(Effect.provide(SyncLive), Effect.provideService(Remote, remote))
      output.result(describePush(outcome), pushJson(outcome))
    }),
).pipe(
  Command.withDescription(
    'Publish a local folder to a node of a tree, all at once. Exits 5 if ' +
      'someone pushed there since this folder last pulled or pushed.',
  ),
)
