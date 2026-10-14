import { resolve } from 'node:path'

import { Args, Command, Options } from '@effect/cli'
import { Effect } from 'effect'

import { Cli } from '../io.ts'
import { jsonOption } from '../render.ts'
import {
  type MergeFile,
  type MergeOutcome,
  type PullOutcome,
  Remote,
  Sync,
  SyncLive,
} from '../sync.ts'
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

/** What to do with a file the merge left in conflict. */
export const conflictFix = (file: MergeFile): string | null => {
  switch (file.conflict) {
    case null:
      return null
    case 'text':
      return 'Keep the right lines and remove the marker lines.'
    case 'binary':
      return `Keep one version and delete ${file.theirs}.`
    case 'deleted-here':
      return 'It was deleted here and changed in the tree. Keep it, or delete it again.'
    case 'deleted-there':
      return 'It was changed here and deleted in the tree. Keep it, or delete it.'
  }
}

const mergeNote = (file: MergeFile): string => {
  switch (file.conflict) {
    case 'text':
      return 'both sides changed the same lines'
    case 'binary':
      return `both sides changed it; the tree's version is in ${file.theirs}`
    case 'deleted-here':
      return 'deleted here, changed in the tree; the tree’s version is back'
    case 'deleted-there':
      return 'changed here, deleted in the tree'
    case null:
      return file.deletedHere ? 'deleted here' : ''
  }
}

/** One line per file the merge took, kept, merged or left, then a summary. */
export const describeMerge = (outcome: MergeOutcome, dir: string): string => {
  const lines = outcome.files.map((file) => {
    const note = mergeNote(file)
    const line = `${file.result.padEnd(9)}${file.path}`
    return note === '' ? line : `${line}  (${note})`
  })
  const at = outcome.push === null ? '' : ` at push ${outcome.push}`
  const changed = outcome.files.length === 0
  const summary = changed
    ? `${dir} is up to date${at}.`
    : outcome.conflicts === 0
      ? `Merged the tree${at} into ${dir}. Push to publish the result.`
      : `Merged the tree${at} into ${dir}; ` +
        `${outcome.conflicts === 1 ? '1 conflict' : `${outcome.conflicts} conflicts`} ` +
        'to resolve, then push.'
  return [
    ...lines,
    // Into an empty folder every file is simply taken; the note matters
    // only where the folder held files of its own.
    ...(outcome.base || outcome.files.every((file) => file.result === 'taken')
      ? []
      : [
          'This folder had no copy of its last sync, so every file that ' +
            'differs counts as changed on both sides.',
        ]),
    summary,
  ].join('\n')
}

export const mergeJson = (outcome: MergeOutcome) => ({
  files: outcome.files.map((file) => ({
    path: file.path,
    result: file.result,
    ...(file.conflict === null
      ? {}
      : { conflict: file.conflict, fix: conflictFix(file) }),
    ...(file.theirs === null ? {} : { theirs: file.theirs }),
    ...(file.deletedHere ? { deletedHere: true } : {}),
  })),
  unchanged: outcome.unchanged,
  conflicts: outcome.conflicts,
  base: outcome.base,
  seq: outcome.seq,
  push: outcome.push,
  dir: outcome.dir,
})

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
    merge: Options.boolean('merge').pipe(
      Options.withDescription(
        "Keep this folder's changes: merge the tree's changes since this " +
          "folder's last pull or push into it, file by file.",
      ),
    ),
    json: jsonOption,
  },
  ({ target, dir, merge }) =>
    Effect.gen(function* () {
      const { io, output } = yield* Cli
      const { remote, ref } = yield* resolveTarget(target)
      const folder = resolve(io.cwd, dir)
      if (merge) {
        const outcome = yield* Effect.flatMap(Sync, (sync) =>
          sync.merge({ target: ref, dir: folder }),
        ).pipe(Effect.provide(SyncLive), Effect.provideService(Remote, remote))
        output.result(describeMerge(outcome, dir), mergeJson(outcome))
        if (outcome.conflicts > 0) output.exitWith(7)
        return
      }
      const outcome = yield* Effect.flatMap(Sync, (sync) =>
        sync.pull({ target: ref, dir: folder }),
      ).pipe(Effect.provide(SyncLive), Effect.provideService(Remote, remote))
      output.result(describePull(outcome, dir), outcome)
    }),
).pipe(
  Command.withDescription(
    'Copy a node of a tree into a local folder; files people wrote through ' +
      'forms are written read-only. A plain pull overwrites local changes. ' +
      'With --merge, it keeps them: a file only the tree changed is taken, ' +
      'one only the folder changed is kept, text both changed is merged line ' +
      'by line, and what cannot be merged is left with git-style conflict ' +
      'markers, or beside it as <name>.theirs.<ext>. --merge never writes ' +
      "people's data. Exits 7 when conflicts remain: resolve them, then push.",
  ),
)
