import { Args, Command } from '@effect/cli'
import type { EntryWire, LsResponse } from '@dossier/contracts'
import { Effect } from 'effect'

import { callApi } from '../client.ts'
import { Cli } from '../io.ts'
import { jsonOption } from '../render.ts'
import { targetString } from '../sync.ts'
import { resolveTarget } from '../target.ts'

/** `512 B`, `1.2 KiB`, `3.4 MiB`. */
export const formatSize = (bytes: number | null): string => {
  if (bytes === null) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

const row = (entry: EntryWire): readonly string[] => [
  entry.kind === 'folder' ? `${entry.name}/` : entry.name,
  entry.kind,
  formatSize(entry.size),
  entry.push === null ? '-' : `push ${entry.push.number}`,
]

/** One row per entry in aligned columns: name, kind, size and last push. */
export const describeLs = (ls: LsResponse): string => {
  if (ls.entries.length === 0) return 'Nothing here yet.'
  const rows = ls.entries.map(row)
  const widths = [0, 1, 2].map((column) =>
    Math.max(...rows.map((cells) => cells[column]?.length ?? 0)),
  )
  return rows
    .map((cells) =>
      cells
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

export const ls = Command.make(
  'ls',
  {
    target: Args.text({ name: 'target' }).pipe(
      Args.withDescription(
        'What to list: workspace/tree or workspace/tree/path, or a link.',
      ),
    ),
    json: jsonOption,
  },
  ({ target }) =>
    Effect.gen(function* () {
      const { output } = yield* Cli
      const { remote, ref } = yield* resolveTarget(target)
      const listing = yield* callApi(remote.deployment, remote.key, (client) =>
        client.files.ls({
          urlParams: { path: targetString(ref), depth: 'one' },
        }),
      )
      output.result(describeLs(listing), listing)
    }),
).pipe(
  Command.withDescription(
    'List what a folder of a tree holds: pages, folders, attachments, `_` ' +
      'files as kit, and data.',
  ),
)
