import { Args, Command, Options } from '@effect/cli'
import { type EventWire, type LinkRef, linkFor } from '@dossier/contracts'
import { Effect } from 'effect'

import type { Deployment } from '../deployment.ts'
import { Cli, type CliIo } from '../io.ts'
import { jsonOption } from '../render.ts'
import { resolveTarget } from '../target.ts'
import { watchedPath, watchEvents } from '../watch.ts'

/** '2026-10-12 14:20', in UTC. */
const timeOf = (at: string): string => {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  const iso = date.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

/**
 * One event as a line: when, what, where and who, two spaces apart; an
 * event that hides who did it leaves the last column out.
 */
export const eventLine = (event: EventWire): string =>
  [
    timeOf(event.at),
    event.type,
    event.path,
    ...(event.by ? [event.by] : []),
  ].join('  ')

/** The link of an event's path on the deployment. */
export const eventLink = (
  deployment: Deployment,
  ref: LinkRef,
  event: EventWire,
): string => {
  const folder = event.path.endsWith('/')
  const path = folder ? event.path.slice(0, -1) : event.path
  return linkFor(deployment.origin, {
    workspace: ref.workspace,
    tree: ref.tree,
    path,
    kind:
      folder || path === ''
        ? 'folder'
        : path.endsWith('.html')
          ? 'page'
          : 'file',
  })
}

/** Ends when the person presses Ctrl-C; never where the io cannot tell. */
const interrupted = (io: CliIo) =>
  Effect.async<void>((resume) => {
    const giveBack = io.onInterrupt?.(() => resume(Effect.void))
    return Effect.sync(() => giveBack?.())
  })

export const watch = Command.make(
  'watch',
  {
    target: Args.text({ name: 'target' }).pipe(
      Args.withDescription(
        'What to watch: workspace/tree, workspace/tree/folder/, ' +
          'workspace/tree/file, or a link.',
      ),
    ),
    next: Options.boolean('next').pipe(
      Options.withDescription('Print the first event, then exit 0.'),
    ),
    json: jsonOption,
  },
  ({ target, next }) =>
    Effect.gen(function* () {
      const { io, output } = yield* Cli
      const { remote, ref } = yield* resolveTarget(target)
      const path = watchedPath(ref)
      if (!output.json) {
        io.stderr(
          `Watching ${ref.workspace}/${ref.tree}/${path ?? ''} for changes. ` +
            `${next ? 'Stops after the first event' : 'Ctrl-C stops'}.\n`,
        )
      }
      const onEvent = (event: EventWire) =>
        io.stdout(
          output.json
            ? `${JSON.stringify({
                ...event,
                link: eventLink(remote.deployment, ref, event),
              })}\n`
            : `${eventLine(event)}\n`,
        )
      yield* Effect.raceFirst(
        watchEvents({ remote, ref, next, onEvent }),
        interrupted(io),
      )
    }),
).pipe(
  Command.withDescription(
    'Print each change to a tree, folder or file as it happens: when, the ' +
      'event (push, submission, entry, data_write, withdrawal, …), its path ' +
      'and who, one line each, or one JSON object per line with its link ' +
      'with --json. A folder ends in /. Runs until Ctrl-C, or the first ' +
      'event with --next.',
  ),
)
