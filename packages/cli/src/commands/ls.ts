import { Args, Command } from '@effect/cli'
import {
  DossierError,
  dossierError,
  isWorkspaceName,
  type EntryWire,
  type LsResponse,
  type ScopePlace,
  type SharedPlace,
  type WorkspaceResponse,
  type WorkspacesResponse,
} from '@dossier/contracts'
import { Effect, Option } from 'effect'

import { callApi } from '../client.ts'
import { currentDeployment } from '../deployment.ts'
import { Cli } from '../io.ts'
import { jsonOption, usage } from '../render.ts'
import { targetString } from '../sync.ts'
import { resolveTarget } from '../target.ts'
import { notSignedIn } from './whoami.ts'

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

/** Rows in columns as wide as their widest cell, two spaces apart. */
const aligned = (rows: readonly (readonly string[])[]): string[] => {
  const columns = Math.max(0, ...rows.map((cells) => cells.length))
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(...rows.map((cells) => cells[column]?.length ?? 0)),
  )
  return rows.map((cells) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd(),
  )
}

const row = (entry: EntryWire): readonly string[] => [
  entry.folder ? `${entry.name}/` : entry.name,
  entry.kind,
  formatSize(entry.size),
  entry.push === null ? '-' : `push ${entry.push.number}`,
]

/** One row per entry in aligned columns: name, kind, size and last push. */
export const describeLs = (ls: LsResponse): string => {
  if (ls.entries.length === 0) return 'Nothing here yet.'
  return aligned(ls.entries.map(row)).join('\n')
}

const sharedRow = (place: SharedPlace): readonly string[] => [
  place.target,
  place.kind,
  place.can,
  [
    place.title,
    ...(place.waiting ? ['waiting for your answer'] : []),
    ...(place.mentioned ? ['mentioned you'] : []),
  ].join(' · '),
]

const scopeLines = (scope: ScopePlace): string[] =>
  scope.can === null
    ? [
        `This key is limited to ${scope.target}, which is gone or no longer opens for you.`,
      ]
    : [
        ...aligned([[scope.target, scope.can]]),
        `This key is limited to ${scope.target}; it sees nothing else.`,
      ]

const workspaceRow = (
  name: string,
  role: string,
  suspended: boolean,
): readonly string[] => [
  `${name}/`,
  'workspace',
  suspended ? `${role}, suspended` : role,
]

/**
 * Where the caller can work: each workspace with its role, then its trees
 * with what the caller may do at each root, then what others shared.
 */
export const describeWorkspaces = (places: WorkspacesResponse): string => {
  if (places.scope !== null) return scopeLines(places.scope).join('\n')
  const lines: string[] = []
  if (places.workspaces.length > 0) {
    lines.push(
      ...aligned(
        places.workspaces.flatMap((w) => [
          workspaceRow(w.name, w.role, w.suspended),
          ...w.trees.map((t) => [t.target, 'tree', t.can]),
        ]),
      ),
    )
  }
  if (places.shared.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('Shared with you:', ...aligned(places.shared.map(sharedRow)))
  }
  if (lines.length === 0) {
    return 'You are in no workspace, and nothing is shared with you yet.'
  }
  return lines.join('\n')
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/**
 * One workspace: a member's trees, what others shared with the caller in
 * it, its teams for members, and how a member makes a tree.
 */
export const describeWorkspace = (place: WorkspaceResponse): string => {
  if (place.scope !== null) return scopeLines(place.scope).join('\n')
  const lines: string[] = []
  if (place.role !== null) {
    lines.push(
      ...aligned([
        workspaceRow(place.name, place.role, place.suspended),
        ...place.trees.map((t) => [t.target, 'tree', t.can]),
      ]),
    )
    if (place.trees.length === 0) lines.push('No trees you can open yet.')
  }
  if (place.shared.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(
      place.role === null
        ? `Shared with you in ${place.name}:`
        : 'Shared with you here:',
      ...aligned(place.shared.map(sharedRow)),
    )
  }
  if (place.teams !== null && place.teams.length > 0) {
    lines.push(
      '',
      'Teams: share with team:<name>, mention with @team:<name> ' +
        '(@team:"<name>" when it has a space):',
      ...aligned(
        place.teams.map((t) => [
          t.name,
          plural(t.members, 'member', 'members'),
        ]),
      ),
    )
  }
  if (place.createsTrees) {
    lines.push(
      '',
      `Make a tree by pushing to a new tree name: dossier push <folder> ${place.name}/<tree>/`,
    )
  }
  return lines.join('\n')
}

const isLink = (input: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim())

/**
 * What a target names before any tree: the deployment itself (nothing, or
 * a link to its root) or one workspace (`agent964`, `agent964/`, or a link
 * to it). Null for anything deeper, which `resolveTarget` reads.
 */
const aboveTrees = (
  input: string | null,
): {
  readonly link: string | undefined
  readonly workspace: string | null
} | null => {
  if (input === null) return { link: undefined, workspace: null }
  const trimmed = input.trim()
  let path: string
  if (isLink(trimmed)) {
    if (!URL.canParse(trimmed)) return null
    path = new URL(trimmed).pathname
  } else {
    path = trimmed
  }
  const segments = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((s) => s !== '')
  if (segments.length > 1) return null
  const link = isLink(trimmed) ? trimmed : undefined
  if (segments.length === 0) return { link, workspace: null }
  let name = segments[0]!
  try {
    name = decodeURIComponent(name)
  } catch {
    return null
  }
  return { link, workspace: name }
}

/** A workspace that is not there, or not for this caller, in the CLI's words. */
const workspaceNotFound = (name: string, error: DossierError) =>
  dossierError(
    'not_found',
    `Nothing at ${name}, or you cannot open it.`,
    'Run dossier ls to see your workspaces and what is shared with you.',
    error.path,
  )

export const ls = Command.make(
  'ls',
  {
    target: Args.text({ name: 'target' }).pipe(
      Args.withDescription(
        'What to list: nothing for every workspace you are in and what is ' +
          'shared with you; a workspace for its trees and teams; ' +
          'workspace/tree or workspace/tree/path, or a link, for a folder.',
      ),
      Args.optional,
    ),
    json: jsonOption,
  },
  ({ target }) =>
    Effect.gen(function* () {
      const { output } = yield* Cli
      const given = Option.getOrNull(target)
      const above = aboveTrees(given)
      if (above !== null) {
        const { deployment, key } = yield* currentDeployment(above.link)
        if (key === null) return yield* Effect.fail(notSignedIn(deployment))
        if (above.workspace === null) {
          const places = yield* callApi(deployment, key, (client) =>
            client.workspaces.list(),
          )
          output.result(describeWorkspaces(places), places)
          return
        }
        const name = above.workspace
        if (!isWorkspaceName(name)) {
          return yield* Effect.fail(
            usage(
              `"${given}" is not a workspace, a tree or a link on ${deployment.id}.`,
              'Give a workspace such as agent964, workspace/tree, or ' +
                'workspace/tree/path; or nothing, to see where you can work.',
            ),
          )
        }
        const place = yield* callApi(deployment, key, (client) =>
          client.workspaces.get({ path: { name } }),
        ).pipe(
          Effect.catchIf(
            (error) =>
              error instanceof DossierError && error.code === 'not_found',
            (error) =>
              Effect.fail(workspaceNotFound(name, error as DossierError)),
          ),
        )
        output.result(describeWorkspace(place), place)
        return
      }
      const { remote, ref } = yield* resolveTarget(given!)
      const listing = yield* callApi(remote.deployment, remote.key, (client) =>
        client.files.ls({
          urlParams: { path: targetString(ref), depth: 'one' },
        }),
      )
      output.result(describeLs(listing), listing)
    }),
).pipe(
  Command.withDescription(
    'List where you can work, or what a workspace or a folder holds. ' +
      'With nothing: your workspaces with your role, their trees with ' +
      'what you may do at each (read, respond or write), and what others ' +
      'shared with you. With a workspace: its trees, what is shared with ' +
      'you there, and, for members, its teams (team:<name>). With a tree or ' +
      'folder: its pages, folders, attachments, `_` files as kit, and data.',
  ),
)
