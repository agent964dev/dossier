import { Args, Command, Options } from '@effect/cli'
import type { LinkRef, LogLine, LogResponse } from '@dossier/contracts'
import { Clock, Effect, Option } from 'effect'

import { callApi } from '../client.ts'
import { Cli } from '../io.ts'
import { jsonOption } from '../render.ts'
import { resolveTarget } from '../target.ts'
import { readPath } from './read.ts'

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

const two = (value: number) => String(value).padStart(2, '0')

/**
 * `10 Oct 14:02` in UTC, with the year when it is not `thisYear`. A time
 * that does not parse is printed as it came.
 */
export const timeText = (iso: string, thisYear: number): string => {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const year = at.getUTCFullYear()
  return [
    String(at.getUTCDate()),
    MONTHS[at.getUTCMonth()],
    ...(year === thisYear ? [] : [String(year)]),
    `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`,
  ].join(' ')
}

/** This year in UTC, by the effect's clock. */
export const currentYear = Effect.map(Clock.currentTimeMillis, (now) =>
  new Date(now).getUTCFullYear(),
)

/**
 * `agent964/acme/plan.html`: a tree path the deployment answered with, under
 * the workspace and tree asked about. A folder asked for with its slash keeps
 * it, and the tree's root is `agent964/acme/`.
 */
export const nodeName = (ref: LinkRef, treePath: string): string => {
  const path = treePath.replace(/^\/+|\/+$/g, '')
  if (path === '') return `${ref.workspace}/${ref.tree}/`
  return `${ref.workspace}/${ref.tree}/${path}${ref.folder ? '/' : ''}`
}

const files = (count: number) => (count === 1 ? '1 file' : `${count} files`)

/** Who made a change, as the deployment names them. */
const who = (line: LogLine) => line.by ?? 'someone'

/** One history line: what happened, when, who, and the rest. */
export const logLine = (line: LogLine, thisYear: number): string => {
  const when = timeText(line.at, thisYear)
  switch (line.kind) {
    case 'push': {
      const push = line.push
      return [
        push === null ? 'push' : `push ${push.number}`,
        when,
        who(line),
        ...(push?.message ? [push.message] : []),
        ...(push === null ? [] : [`(${files(push.files)})`]),
      ].join('  ')
    }
    case 'delete':
      return [
        'deleted',
        when,
        who(line),
        line.restorable ? line.path : `${line.path}  (not restorable now)`,
      ].join('  ')
    case 'restore':
      return [
        `restored ${line.path}${line.to === null ? '' : ` to ${line.to}`}`,
        when,
        who(line),
      ].join('  ')
    case 'move':
      return [
        `moved ${line.path}${line.to === null ? '' : ` to ${line.to}`}`,
        when,
        who(line),
      ].join('  ')
    case 'withdrawal':
      return ['withdrawal', when, `${who(line)} withdrew a submission`].join(
        '  ',
      )
  }
}

/** What `dossier log` prints: a line per change, then how to go further back. */
export const describeLog = (
  response: LogResponse,
  ref: LinkRef,
  asked: string,
  thisYear: number,
): string => {
  const lines =
    response.lines.length === 0
      ? [`${nodeName(ref, response.path)} has no history yet.`]
      : response.lines.map((line) => logLine(line, thisYear))
  return [
    ...lines,
    ...(response.next === null
      ? []
      : [`Older lines: dossier log ${asked} --cursor ${response.next}`]),
  ].join('\n')
}

export const log = Command.make(
  'log',
  {
    path: Args.text({ name: 'path' }).pipe(
      Args.withDescription(
        'Whose history: workspace/tree, workspace/tree/path, ' +
          'workspace/tree/folder/, or a link.',
      ),
    ),
    cursor: Options.text('cursor').pipe(
      Options.withDescription(
        'Show the older lines a previous page ended on, as its last line ' +
          'gives it.',
      ),
      Options.optional,
    ),
    json: jsonOption,
  },
  ({ path, cursor }) =>
    Effect.gen(function* () {
      const { output } = yield* Cli
      const { remote, ref } = yield* resolveTarget(path)
      const at = readPath(ref)
      const page = yield* callApi(remote.deployment, remote.key, (c) =>
        c.history.log({
          urlParams: Option.match(cursor, {
            onNone: () => ({ path: at }),
            onSome: (value) => ({ path: at, cursor: value }),
          }),
        }),
      )
      const thisYear = yield* currentYear
      output.result(describeLog(page, ref, at, thisYear), page)
    }),
).pipe(
  Command.withDescription(
    "List a folder's or a file's history, newest first: pushes, deletions, " +
      'restores, moves and withdrawals, 50 lines a page, times in UTC. ' +
      'Shown to write holders; exits 3 for anyone else.',
  ),
)
