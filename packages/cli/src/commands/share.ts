import { Args, Command, Options } from '@effect/cli'
import {
  dossierError,
  type LinkRef,
  parseShareTarget,
  SHARE_ROLES,
  type ShareRoleName,
  type SharesResponse,
  type ShareTarget,
  type ShareWire,
} from '@dossier/contracts'
import { Effect, Option } from 'effect'

import { callApi } from '../client.ts'
import { Cli } from '../io.ts'
import { jsonOption } from '../render.ts'
import { resolveTarget } from '../target.ts'
import { readPath } from './read.ts'

const TARGETS =
  'an email such as sara@acme.com, team:<name>, workspace or anyone'

/** The workspace and tree a share response's link names, with the node. */
interface Place {
  readonly workspace: string
  readonly tree: string
  /** `agent964/acme/questions/`; a page as its link names it. */
  readonly node: string
}

/** Where the response's link points; the asked target when it cannot tell. */
export const placeOf = (response: SharesResponse, ref: LinkRef): Place => {
  try {
    const segments = new URL(response.link).pathname
      .slice(1)
      .split('/')
      .map(decodeURIComponent)
    const [workspace = '', tree = ''] = segments
    if (workspace !== '' && tree !== '') {
      return { workspace, tree, node: segments.join('/') }
    }
  } catch {
    // Name it as it was asked for.
  }
  const node =
    ref.path === ''
      ? `${ref.workspace}/${ref.tree}/`
      : `${ref.workspace}/${ref.tree}/${ref.path}${ref.folder ? '/' : ''}`
  return { workspace: ref.workspace, tree: ref.tree, node }
}

/** Whom a share reaches, as a list line starts. */
const whom = (target: ShareTarget, workspace: string): string => {
  switch (target.kind) {
    case 'email':
      return target.email
    case 'team':
      return `Team ${target.team}`
    case 'workspace':
      return `Everyone in ${workspace}`
    case 'anyone':
      return 'Anyone with the link'
  }
}

/** Whom a share reaches, inside a sentence. */
export const whomInSentence = (
  target: ShareTarget,
  workspace: string,
): string => {
  switch (target.kind) {
    case 'email':
    case 'team':
      return whom(target, workspace)
    case 'workspace':
      return `everyone in ${workspace}`
    case 'anyone':
      return 'anyone with the link'
  }
}

/** `acme/` for the tree's root, `acme/questions/` for a folder in it. */
const folderOf = (tree: string, on: string): string => {
  const path = on.replace(/^\/+|\/+$/g, '')
  return path === '' ? `${tree}/` : `${tree}/${path}/`
}

const shareLine = (share: ShareWire, place: Place): string =>
  [
    `- ${whom(share.target, place.workspace)}`,
    share.role,
    ...(share.inherited ? [`from ${folderOf(place.tree, share.on)}`] : []),
  ].join(' · ')

const notShared = (place: Place) => `${place.node} is not shared with anyone.`

/** `<node> is shared with:` and a line per share, or that it is not. */
export const describeShares = (
  response: SharesResponse,
  ref: LinkRef,
): string => {
  const place = placeOf(response, ref)
  if (response.shares.length === 0) return notShared(place)
  return [
    `${place.node} is shared with:`,
    ...response.shares.map((share) => shareLine(share, place)),
  ].join('\n')
}

/** `Public with it: _layout.html, _theme.css (2 files above).` or nothing. */
const reachLines = (reach: readonly string[]): string[] =>
  reach.length === 0
    ? []
    : [
        `Public with it: ${reach.join(', ')} ` +
          `(${reach.length === 1 ? '1 file' : `${reach.length} files`} above).`,
      ]

/** What setting a share prints: the sentence, the shares, what goes public. */
export const describeSet = (
  response: SharesResponse,
  ref: LinkRef,
  target: ShareTarget,
  role: ShareRoleName,
): string => {
  const place = placeOf(response, ref)
  return [
    `${place.node} is shared with ` +
      `${whomInSentence(target, place.workspace)} (${role}).`,
    ...response.shares.map((share) => shareLine(share, place)),
    ...(target.kind === 'anyone' ? reachLines(response.publicReach) : []),
    ...(target.kind === 'anyone' && role === 'write'
      ? ['Anyone who signs in can now publish pages here.']
      : []),
  ].join('\n')
}

/** What removing a share prints: the sentence, then what is left. */
export const describeRemove = (
  response: SharesResponse,
  ref: LinkRef,
  target: ShareTarget,
): string => {
  const place = placeOf(response, ref)
  const removed =
    `${place.node} is no longer shared with ` +
    `${whomInSentence(target, place.workspace)}.`
  if (response.shares.length === 0) {
    return `${removed}\nIt is not shared with anyone now.`
  }
  return [
    removed,
    'It is still shared with:',
    ...response.shares.map((share) => shareLine(share, place)),
  ].join('\n')
}

const invalid = (message: string, fix: string) =>
  Effect.fail(dossierError('invalid', message, fix))

const isRole = (value: string): value is ShareRoleName =>
  (SHARE_ROLES as readonly string[]).includes(value)

/** The share the command line asks for, checked before any request. */
const askedFor = (
  given: { target: string | null; role: string | null; remove: boolean },
  path: string,
) =>
  Effect.gen(function* () {
    if (given.target === null) {
      if (given.remove) {
        return yield* invalid(
          '--remove needs the target whose share to take away.',
          `Give it as dossier share ${path} <target> --remove, with ` +
            `${TARGETS}.`,
        )
      }
      return null
    }
    const target = parseShareTarget(given.target)
    if (target === null) {
      return yield* invalid(
        `"${given.target}" is not a share target.`,
        `Give ${TARGETS}: dossier share <path> <target> <role>.`,
      )
    }
    if (given.remove) {
      if (given.role !== null) {
        return yield* invalid(
          '--remove takes a target and no role.',
          `Run dossier share ${path} ${given.target} --remove.`,
        )
      }
      return { target, role: null }
    }
    if (given.role === null) {
      return yield* invalid(
        `Say which role ${given.target} gets on ${path}.`,
        `Add read, respond or write, such as dossier share ${path} ` +
          `${given.target} respond, or --remove to take the share away.`,
      )
    }
    if (!isRole(given.role)) {
      return yield* invalid(
        `"${given.role}" is not a role.`,
        'Give read, respond or write: dossier share <path> <target> <role>.',
      )
    }
    return { target, role: given.role }
  })

export const share = Command.make(
  'share',
  {
    path: Args.text({ name: 'path' }).pipe(
      Args.withDescription(
        'What to share: workspace/tree, workspace/tree/path, ' +
          'workspace/tree/folder/, or a link.',
      ),
    ),
    target: Args.text({ name: 'target' }).pipe(
      Args.withDescription(
        'Whom: sara@acme.com, team:Design, workspace or anyone. Leave it ' +
          'out to list the shares.',
      ),
      Args.optional,
    ),
    role: Args.text({ name: 'role' }).pipe(
      Args.withDescription('read, respond or write.'),
      Args.optional,
    ),
    remove: Options.boolean('remove').pipe(
      Options.withDescription("Take the target's share away."),
    ),
    json: jsonOption,
  },
  ({ path, target, role, remove }) =>
    Effect.gen(function* () {
      const { output } = yield* Cli
      const asked = yield* askedFor(
        {
          target: Option.getOrNull(target),
          role: Option.getOrNull(role),
          remove,
        },
        path,
      )
      const { remote, ref } = yield* resolveTarget(path)
      const at = readPath(ref)
      if (asked === null) {
        const listing = yield* callApi(remote.deployment, remote.key, (c) =>
          c.shares.list({ urlParams: { path: at } }),
        )
        return output.result(describeShares(listing, ref), listing)
      }
      const response = yield* callApi(remote.deployment, remote.key, (c) =>
        c.shares.set({
          payload: { path: at, target: asked.target, role: asked.role },
        }),
      )
      output.result(
        asked.role === null
          ? describeRemove(response, ref, asked.target)
          : describeSet(response, ref, asked.target, asked.role),
        response,
      )
    }),
).pipe(
  Command.withDescription(
    "List a node's shares, give a person, a team, the workspace or anyone " +
      'a role on it, or take a share away with --remove. Exits 3 on a node ' +
      'you cannot share, 6 on a target or role that is not one.',
  ),
)
