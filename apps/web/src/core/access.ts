import {
  dossierError,
  type DossierError,
  type NodeId,
  type PersonId,
  type ShareId,
  type TreeId,
  type WorkspaceId,
} from '@dossier/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { Context, Effect, Layer } from 'effect'

import { nodes } from '../db/schema.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller, type Caller } from './caller.ts'
import {
  ancestorPaths,
  isMissing,
  type MissingNode,
  type NodeRow,
  type WorkspaceRow,
} from './rows.ts'

export type Role = 'read' | 'respond' | 'write'
export type Action =
  | 'read'
  | 'read-data'
  | 'respond'
  | 'comment'
  | 'write'
  | 'share'
  | 'withdraw-own'
  | 'delete-data'
  /** Write eligibility without changing anything; read-only keys may hold it. */
  | 'read-history'

export type Basis =
  | {
      readonly kind: 'share'
      readonly shareId: ShareId
      readonly role: Role
      readonly targetKind: 'email' | 'team' | 'workspace' | 'anyone'
    }
  | {
      readonly kind: 'admin'
      readonly workspaceId: WorkspaceId
      readonly userId: PersonId
    }
  | {
      readonly kind: 'member'
      readonly workspaceId: WorkspaceId
      readonly userId: PersonId
    }

export type Capability = 'read' | 'read-authored' | 'respond' | 'write'

const CAPABILITIES: Record<Role, readonly Capability[]> = {
  write: ['write', 'respond', 'read'],
  respond: ['respond', 'read-authored'],
  read: ['read'],
}

/** The only place role labels become what they allow. */
export const capabilitiesOf = (
  roles: Iterable<Role>,
): ReadonlySet<Capability> => {
  const caps = new Set<Capability>()
  for (const role of roles) for (const cap of CAPABILITIES[role]) caps.add(cap)
  return caps
}

export interface RoleSet {
  /** The labels the grants give, for display. */
  readonly roles: ReadonlySet<Role>
  /** What every grant together allows; actions are checked against these. */
  readonly caps: ReadonlySet<Capability>
  /** The same from grants that are not public; data rules read these. */
  readonly privateCaps: ReadonlySet<Capability>
  readonly basis: readonly Basis[]
}

declare const granted: unique symbol
/** A node the caller may act on; only Access makes one. */
export type Granted<A extends Action> = NodeRow & {
  readonly [granted]: A
  readonly basis: readonly Basis[]
}

export interface Membership {
  readonly workspace: WorkspaceRow
  readonly role: 'admin' | 'member'
  readonly basis: Basis
}

/** A condition over `nodes`, ANDed into list, event and search queries. */
export interface ReadableNodes {
  readonly where: SQL
}

export interface AccessService {
  readonly require: <A extends Action>(
    action: A,
    node: NodeRow | MissingNode,
  ) => Effect.Effect<
    Granted<A>,
    DossierError<'not_found' | 'sign_in_required' | 'forbidden'>,
    CurrentCaller
  >
  /** The caller's roles on a node, after narrowing by its agent key. */
  readonly roleOn: (
    node: NodeRow,
  ) => Effect.Effect<RoleSet, never, CurrentCaller>
  /** Agrees with require('read') on every node of the tree. */
  readonly readable: (
    treeId: TreeId,
  ) => Effect.Effect<ReadableNodes, never, CurrentCaller>
  readonly member: (
    workspace: WorkspaceRow | null,
  ) => Effect.Effect<
    Membership,
    DossierError<'not_found' | 'sign_in_required' | 'forbidden'>,
    CurrentCaller
  >
}

export class Access extends Context.Tag('Access')<Access, AccessService>() {}

/** Actions that change something: a read-only key never holds them. */
const CHANGING: ReadonlySet<Action> = new Set([
  'write',
  'share',
  'respond',
  'comment',
  'withdraw-own',
  'delete-data',
])

/** Which capability each action needs. */
const allows = (action: Action, roles: RoleSet): boolean => {
  switch (action) {
    case 'read':
      return roles.caps.has('read') || roles.caps.has('read-authored')
    case 'read-data':
      return roles.privateCaps.has('read')
    case 'respond':
    case 'comment':
    case 'withdraw-own':
      return roles.caps.has('respond')
    case 'write':
    case 'share':
    case 'delete-data':
    case 'read-history':
      return roles.caps.has('write')
  }
}

/** The bases that give an action, kept on the Granted for the commit guard. */
const basisFor = (action: Action, roles: RoleSet): readonly Basis[] => {
  const gives = (basis: Basis): Role =>
    basis.kind === 'share'
      ? basis.role
      : basis.kind === 'admin'
        ? 'write'
        : 'read'
  return roles.basis.filter((basis) =>
    allows(action, roleSetOf([{ basis, role: gives(basis) }])),
  )
}

const EMPTY: RoleSet = {
  roles: new Set(),
  caps: new Set(),
  privateCaps: new Set(),
  basis: [],
}

const roleSetOf = (
  grants: readonly { readonly basis: Basis; readonly role: Role }[],
): RoleSet => ({
  roles: new Set(grants.map((g) => g.role)),
  caps: capabilitiesOf(grants.map((g) => g.role)),
  privateCaps: capabilitiesOf(
    grants
      .filter(
        (g) => !(g.basis.kind === 'share' && g.basis.targetKind === 'anyone'),
      )
      .map((g) => g.role),
  ),
  basis: grants.map((g) => g.basis),
})

const signInRequired = (path: string | null) =>
  dossierError(
    'sign_in_required',
    'Sign in to open this.',
    'Sign in with Google, or run dossier login.',
    path,
  )

const notFound = (path: string | null) =>
  dossierError(
    'not_found',
    'Nothing is here, or you cannot open it.',
    'Check the path, or ask someone who can open it to share it with you.',
    path,
  )

/** Missing and unreadable look the same: a visitor is asked to sign in. */
const denied = (caller: Caller, path: string | null) =>
  Effect.fail(caller.person === null ? signInRequired(path) : notFound(path))

interface TreeFacts {
  readonly workspaceId: WorkspaceId
  /** The caller's role in the tree's workspace, if any. */
  readonly memberRole: 'admin' | 'member' | null
}

export const AccessLive: Layer.Layer<Access, never, Bindings> = Layer.effect(
  Access,
  Effect.gen(function* () {
    const { DB } = yield* Bindings

    const query = <A>(run: () => Promise<A>) =>
      Effect.tryPromise(run).pipe(
        Effect.tapError((error) =>
          Effect.logError('An access read failed', error),
        ),
        Effect.orDie,
      )

    /** The tree's live workspace and the caller's place in it, or null. */
    const treeFacts = (caller: Caller, treeId: TreeId) =>
      query(() =>
        DB.prepare(
          `select t.workspace_id as workspaceId,
             (select role from workspace_members m
               where m.workspace_id = t.workspace_id and m.user_id = ?2) as memberRole
           from trees t join workspaces w on w.id = t.workspace_id
           where t.id = ?1 and t.deleted_at is null and w.deleted_at is null`,
        )
          .bind(treeId, caller.person?.id ?? '')
          .first<TreeFacts>(),
      )

    const roleOn = (node: NodeRow) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        if (caller.via.kind === 'system') return EMPTY
        // A view handle reaches only the tree whose content host it serves.
        if (caller.via.kind === 'handle' && caller.via.treeId !== node.treeId) {
          return EMPTY
        }
        const facts = yield* treeFacts(caller, node.treeId)
        if (facts === null) return EMPTY
        const paths = ancestorPaths(node.path)
        const ancestors = yield* query(() =>
          DB.prepare(
            `select id from nodes where tree_id = ? and deleted_at is null
               and path in (${paths.map(() => '?').join(', ')})`,
          )
            .bind(node.treeId, ...paths)
            .all<{ id: NodeId }>(),
        )
        const ids = ancestors.results.map((row) => row.id)
        if (
          caller.via.kind === 'agent' &&
          caller.via.scope !== null &&
          !ids.includes(caller.via.scope)
        ) {
          return EMPTY
        }
        const email = caller.person?.email.toLowerCase() ?? null
        const shares =
          ids.length === 0
            ? []
            : (yield* query(() =>
                DB.prepare(
                  `select id, target_kind as targetKind, target, role from shares
                   where node_id in (${ids.map(() => '?').join(', ')})`,
                )
                  .bind(...ids)
                  .all<{
                    id: ShareId
                    targetKind: 'email' | 'team' | 'workspace' | 'anyone'
                    target: string
                    role: Role
                  }>(),
              )).results
        const grants: { basis: Basis; role: Role }[] = []
        for (const share of shares) {
          const matches =
            share.targetKind === 'anyone' ||
            (share.targetKind === 'email' && share.target === email) ||
            (share.targetKind === 'workspace' &&
              share.target === facts.workspaceId &&
              facts.memberRole !== null)
          if (!matches) continue
          grants.push({
            role: share.role,
            basis: {
              kind: 'share',
              shareId: share.id,
              role: share.role,
              targetKind: share.targetKind,
            },
          })
        }
        if (facts.memberRole === 'admin' && caller.person !== null) {
          grants.push({
            role: 'write',
            basis: {
              kind: 'admin',
              workspaceId: facts.workspaceId,
              userId: caller.person.id,
            },
          })
        }
        return roleSetOf(grants)
      })

    const require = <A extends Action>(
      action: A,
      node: NodeRow | MissingNode,
    ) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        if (isMissing(node)) return yield* denied(caller, node.path)
        const roles = yield* roleOn(node)
        const reads =
          roles.caps.has('read') ||
          (roles.caps.has('read-authored') && node.origin === 'authored')
        if (!reads) return yield* denied(caller, node.path)
        if (
          caller.via.kind === 'agent' &&
          caller.via.readOnly &&
          CHANGING.has(action)
        ) {
          return yield* Effect.fail(
            dossierError(
              'forbidden',
              undefined,
              'This agent key is read only. Use a key that can write.',
              node.path,
            ),
          )
        }
        if (!allows(action, roles)) {
          return yield* Effect.fail(
            dossierError('forbidden', undefined, null, node.path),
          )
        }
        return {
          ...node,
          basis: basisFor(action, roles),
        } as unknown as Granted<A>
      })

    const readable = (treeId: TreeId) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const nothing: ReadableNodes = { where: sql`0` }
        if (
          caller.via.kind === 'system' ||
          (caller.via.kind === 'handle' && caller.via.treeId !== treeId)
        ) {
          return nothing
        }
        const facts = yield* treeFacts(caller, treeId)
        if (facts === null) return nothing
        let scope: SQL = sql`1`
        if (caller.via.kind === 'agent' && caller.via.scope !== null) {
          const scopeNode = yield* query(() =>
            DB.prepare(
              'select path from nodes where id = ? and tree_id = ? and deleted_at is null',
            )
              .bind(caller.via.kind === 'agent' ? caller.via.scope : '', treeId)
              .first<{ path: string }>(),
          )
          if (scopeNode === null) return nothing
          scope = under(sql`${scopeNode.path}`)
        }
        const inTree = sql`${nodes.treeId} = ${treeId} and ${scope}`
        if (facts.memberRole === 'admin') return { where: inTree }
        const email = caller.person?.email.toLowerCase() ?? null
        const member = facts.memberRole === null ? 0 : 1
        return {
          where: sql`${inTree} and exists (
            select 1 from shares s join nodes a on a.id = s.node_id and a.deleted_at is null
            where s.tree_id = ${treeId}
              and (s.target_kind = 'anyone'
                or (s.target_kind = 'email' and s.target = ${email})
                or (s.target_kind = 'workspace' and s.target = ${facts.workspaceId} and ${member} = 1))
              and ${under(sql`a.path`)}
              and (s.role <> 'respond' or ${nodes.origin} = 'authored'))`,
        }
      })

    const member = (workspace: WorkspaceRow | null) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        if (caller.person === null) return yield* denied(caller, null)
        if (
          workspace === null ||
          workspace.deletedAt !== null ||
          caller.via.kind === 'system' ||
          caller.via.kind === 'handle'
        ) {
          return yield* denied(caller, workspace?.name ?? null)
        }
        const person = caller.person
        const row = yield* query(() =>
          DB.prepare(
            'select role from workspace_members where workspace_id = ? and user_id = ?',
          )
            .bind(workspace.id, person.id)
            .first<{ role: 'admin' | 'member' }>(),
        )
        if (row === null) return yield* denied(caller, workspace.name)
        if (
          caller.via.kind === 'agent' &&
          (caller.via.scope !== null || caller.via.readOnly)
        ) {
          return yield* Effect.fail(
            dossierError(
              'forbidden',
              undefined,
              'Only an agent key that reaches everything and can write creates trees.',
              workspace.name,
            ),
          )
        }
        return {
          workspace,
          role: row.role,
          basis: {
            kind: 'member',
            workspaceId: workspace.id,
            userId: person.id,
          },
        } satisfies Membership
      })

    return { require, roleOn, readable, member }
  }),
)

/** `nodes.path` is `prefix` or lies below it. */
const under = (prefix: SQL): SQL =>
  sql`(${prefix} = '' or ${nodes.path} = ${prefix} or substr(${nodes.path}, 1, length(${prefix}) + 1) = ${prefix} || '/')`
