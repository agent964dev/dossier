import {
  dossierError,
  isShareEmail,
  parseTarget,
  type LinkRef,
  type ShareTarget,
} from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import {
  Config,
  People,
  Shares,
  type NodeShares,
  type Role,
} from '../core/index.ts'
import { runScreen, type ScreenFailure } from './run.ts'

export type { Role } from '../core/index.ts'
export type { ShareTarget } from '@dossier/contracts'

/** One row of who can open the node. */
export interface DialogShare {
  /** Stable per target, for React keys and the row's select. */
  readonly key: string
  readonly target: ShareTarget
  /** "sara@acme.com", "Team Design", "Everyone in agent964", "Anyone with the link". */
  readonly label: string
  readonly role: Role
  /** For an inherited share, the folder it sits on: "acme/" or "acme/plans/". */
  readonly from: string | null
}

/** What the share dialog shows; every action it offers is one the viewer may take. */
export interface ShareDialogView {
  /** "Share questions/". */
  readonly title: string
  readonly kind: 'folder' | 'page' | 'file'
  readonly workspace: string
  /** The workspace's teams, for the add row. */
  readonly teams: readonly { readonly id: string; readonly name: string }[]
  /** People and teams with a share on this node. */
  readonly direct: readonly DialogShare[]
  /** Shares on folders above, which a lower node cannot narrow. */
  readonly inherited: readonly DialogShare[]
  readonly workspaceRole: Role | null
  readonly anyoneRole: Role | null
  /** Tree paths of the `_` files above that become public with the node. */
  readonly publicReach: readonly string[]
}

const keyOf = (target: ShareTarget): string => {
  switch (target.kind) {
    case 'email':
      return `email:${target.email}`
    case 'team':
      return `team:${target.team}`
    case 'workspace':
      return 'workspace'
    case 'anyone':
      return 'anyone'
  }
}

const refOf = (link: string) =>
  Effect.gen(function* () {
    const config = yield* Config
    const ref: LinkRef | null = parseTarget(link, config.origin)
    if (ref === null) {
      return yield* Effect.fail(
        dossierError('not_found', 'Nothing is here, or you cannot open it.'),
      )
    }
    return ref
  })

const viewOf = (shares: NodeShares) =>
  Effect.gen(function* () {
    const { node, tree, workspace } = shares
    const page = node.kind === 'file' && node.path.endsWith('.html')
    const kind = node.kind === 'folder' ? 'folder' : page ? 'page' : 'file'
    const name =
      node.kind === 'folder'
        ? `${node.path === '' ? tree.name : node.name}/`
        : node.name
    const where = (path: string) =>
      path === '' ? `${tree.name}/` : `${tree.name}/${path}/`
    const rows = shares.shares.map(
      (share): DialogShare & { readonly inherited: boolean } => ({
        key: keyOf(share.target),
        target: share.target,
        label: share.label,
        role: share.role,
        from: share.inherited ? where(share.on.path) : null,
        inherited: share.inherited,
      }),
    )
    const plain = (row: (typeof rows)[number]): DialogShare => ({
      key: row.key,
      target: row.target,
      label: row.label,
      role: row.role,
      from: row.from,
    })
    const people = (row: (typeof rows)[number]) =>
      row.target.kind === 'email' || row.target.kind === 'team'
    const teams = yield* (yield* People).teamsForSharing(workspace)
    return {
      title: `Share ${name}`,
      kind,
      workspace: workspace.name,
      teams: teams.map((team) => ({ id: team.id, name: team.name })),
      direct: rows.filter((row) => !row.inherited && people(row)).map(plain),
      inherited: rows.filter((row) => row.inherited).map(plain),
      workspaceRole:
        rows.find((row) => !row.inherited && row.target.kind === 'workspace')
          ?.role ?? null,
      anyoneRole:
        rows.find((row) => !row.inherited && row.target.kind === 'anyone')
          ?.role ?? null,
      publicReach: shares.publicReach,
    } satisfies ShareDialogView
  })

export const shareDialogView = createServerFn({ method: 'GET' })
  .validator((input: { readonly link: string }) => ({
    link: String(input.link),
  }))
  .handler(({ data }): Promise<ShareDialogView | ScreenFailure> =>
    runScreen(
      Effect.gen(function* () {
        const ref = yield* refOf(data.link)
        return yield* viewOf(yield* (yield* Shares).list(ref))
      }),
    ),
  )

const ROLES: ReadonlySet<string> = new Set(['read', 'respond', 'write'])

const targetFrom = (input: unknown): ShareTarget | null => {
  if (typeof input !== 'object' || input === null) return null
  const value = input as Record<string, unknown>
  switch (value.kind) {
    case 'email':
      return typeof value.email === 'string'
        ? { kind: 'email', email: value.email }
        : null
    case 'team':
      return typeof value.team === 'string'
        ? { kind: 'team', team: value.team }
        : null
    case 'workspace':
      return { kind: 'workspace' }
    case 'anyone':
      return { kind: 'anyone' }
    default:
      return null
  }
}

export const setShare = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      readonly link: string
      readonly target: ShareTarget
      readonly role: Role | null
    }) => ({
      link: String(input.link),
      target: targetFrom(input.target),
      role:
        typeof input.role === 'string' && ROLES.has(input.role)
          ? (input.role as Role)
          : null,
    }),
  )
  .handler(({ data }): Promise<ShareDialogView | ScreenFailure> =>
    runScreen(
      Effect.gen(function* () {
        const target = data.target
        if (target === null) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'Give an email address or one of the workspace’s teams.',
            ),
          )
        }
        if (target.kind === 'email' && !isShareEmail(target.email.trim())) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `${target.email.trim()} is not an email address.`,
              'Give an address such as sara@acme.com.',
              'target',
            ),
          )
        }
        const ref = yield* refOf(data.link)
        const shares = yield* (yield* Shares).set({
          ref,
          target,
          role: data.role,
        })
        return yield* viewOf(shares)
      }),
    ),
  )
