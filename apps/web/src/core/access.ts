import {
  dossierError,
  type DossierError,
  type NodeId,
  type PersonId,
  type ShareId,
  type TeamId,
  type TreeId,
  type WorkspaceId,
} from '@dossier/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { Context, Effect, Layer } from 'effect'

import { db } from '../db/client.ts'
import { nodes } from '../db/schema.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller, type Caller } from './caller.ts'
import { underscoreSplit } from './lookup.ts'
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
  /**
   * Read on a `_` node through a readable node at or below `from`, where the
   * node's `_` part starts. Never a basis for a change.
   */
  | { readonly kind: 'reach'; readonly from: string }
  /** The writer of a data node, who may always read and withdraw it. */
  | {
      readonly kind: 'owner'
      readonly nodeId: NodeId
      readonly userId: PersonId
    }
  /** The place in a team that a team share reaches, beside the share's own. */
  | {
      readonly kind: 'team-member'
      readonly teamId: TeamId
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
  /**
   * What reaches people's data: grants that are not public, and public ones
   * that sit on a data node (a data folder made public itself).
   */
  readonly privateCaps: ReadonlySet<Capability>
  readonly basis: readonly Basis[]
  /** The caller wrote this data node: it is theirs to read and withdraw. */
  readonly owns: boolean
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
  /**
   * Whether the caller reads the node now through grants that already
   * existed at grant order `order`: shares, and the workspace standing
   * behind a workspace share or an admin's write, written (or last given a
   * new role) at or before it. Orders follow commits (`grant_clock`), so a
   * grant committed later never counts, whatever its request's clock said;
   * one removed and made again, or changed in role, counts as new.
   */
  readonly readsAsOf: (
    node: NodeRow,
    order: number,
  ) => Effect.Effect<boolean, never, CurrentCaller>
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
      return roles.privateCaps.has('read') || roles.owns
    case 'withdraw-own':
      return roles.owns
    case 'respond':
    case 'comment':
      return roles.caps.has('respond')
    case 'write':
    case 'share':
    case 'delete-data':
    case 'read-history':
      return roles.caps.has('write')
  }
}

interface Grant {
  readonly basis: Basis
  /** What else the grant rests on: a team share's place in the team. */
  readonly also: Basis | null
  readonly role: Role
  /** The share sits on a data node. */
  readonly onData: boolean
}

const basesOf = (g: Grant): readonly Basis[] =>
  g.also === null ? [g.basis] : [g.basis, g.also]

/**
 * The bases that give an action, kept on the Granted for the commit guard.
 * The owner's own basis stands for what only ownership gives.
 */
const basisFor = (
  action: Action,
  roles: RoleSet,
  grants: readonly Grant[],
  owner: Basis | null,
): readonly Basis[] => {
  if (action === 'withdraw-own') return owner === null ? [] : [owner]
  // Reach is never part of a role set; it is granted beside one.
  const shared = grants
    .filter((g) => allows(action, roleSetOf([g], false)))
    .flatMap(basesOf)
  return owner !== null &&
    (action === 'read' || action === 'read-data') &&
    roles.owns
    ? [...shared, owner]
    : shared
}

const roleSetOf = (grants: readonly Grant[], owns: boolean): RoleSet => ({
  roles: new Set(grants.map((g) => g.role)),
  caps: capabilitiesOf(grants.map((g) => g.role)),
  privateCaps: capabilitiesOf(
    grants
      .filter(
        (g) =>
          g.onData ||
          !(g.basis.kind === 'share' && g.basis.targetKind === 'anyone'),
      )
      .map((g) => g.role),
  ),
  basis: grants.flatMap(basesOf),
  owns,
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
  readonly workspaceName: string
  /** A suspended or deleted workspace reads as missing. */
  readonly state: 'live' | 'suspended' | 'deleted'
  /** The caller's role in the tree's workspace, if any. */
  readonly memberRole: 'admin' | 'member' | null
  /** The caller's teams in the tree's workspace. */
  readonly teams: readonly TeamId[]
}

/** What a member hears when a suspended workspace refuses a change. */
export const suspendedError = (
  workspace: string,
  deployment: string,
  path: string | null,
) =>
  dossierError(
    'forbidden',
    `${workspace} is suspended. A super admin of ${deployment} can lift the suspension.`,
    null,
    path,
  )

export const AccessLive: Layer.Layer<Access, never, Bindings> = Layer.effect(
  Access,
  Effect.gen(function* () {
    const { DB, DEPLOYMENT_NAME } = yield* Bindings
    const deployment = DEPLOYMENT_NAME ?? 'this deployment'

    const query = <A>(run: () => Promise<A>) =>
      Effect.tryPromise(run).pipe(
        Effect.tapError((error) =>
          Effect.logError('An access read failed', error),
        ),
        Effect.orDie,
      )

    /**
     * The live tree's workspace, its state, and the caller's role and teams
     * in it, counting only grants at or below order `asOf`; null when the
     * tree is gone.
     */
    const treeFacts = (
      caller: Caller,
      treeId: TreeId,
      asOf: number | null = null,
    ) =>
      query(() =>
        DB.prepare(
          `select t.workspace_id as workspaceId, w.name as workspaceName,
             case when w.deleted_at is not null then 'deleted'
               when w.suspended_at is not null then 'suspended'
               else 'live' end as state,
             (select role from workspace_members m
               where m.workspace_id = t.workspace_id and m.user_id = ?2
                 and (?3 is null or m.grant_order <= ?3)) as memberRole,
             (select json_group_array(tm.team_id) from team_members tm
               join teams tt on tt.id = tm.team_id
               where tt.workspace_id = t.workspace_id and tm.user_id = ?2
                 and (?3 is null or tm.grant_order <= ?3)) as teamsJson
           from trees t join workspaces w on w.id = t.workspace_id
           where t.id = ?1 and t.deleted_at is null`,
        )
          .bind(treeId, caller.person?.id ?? '', asOf)
          .first<Omit<TreeFacts, 'teams'> & { teamsJson: string | null }>(),
      ).pipe(
        Effect.map((row): TreeFacts | null =>
          row === null
            ? null
            : {
                workspaceId: row.workspaceId,
                workspaceName: row.workspaceName,
                state: row.state,
                memberRole: row.memberRole,
                teams: JSON.parse(row.teamsJson ?? '[]') as TeamId[],
              },
        ),
      )

    /**
     * The caller's grants on a node, counting only grants at or below order
     * `asOf`, and whether they own it.
     */
    const grantsOn = (node: NodeRow, asOf: number | null = null) =>
      Effect.gen(function* () {
        const none = {
          grants: [] as Grant[],
          owns: false,
          facts: null as TreeFacts | null,
        }
        const caller = yield* CurrentCaller
        if (caller.via.kind === 'system') return none
        // A view handle reaches only the tree whose content host it serves.
        if (caller.via.kind === 'handle' && caller.via.treeId !== node.treeId) {
          return none
        }
        const facts = yield* treeFacts(caller, node.treeId, asOf)
        // A suspended or deleted workspace reads as missing, for everyone.
        if (facts === null || facts.state !== 'live') return { ...none, facts }
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
          return { ...none, facts }
        }
        const email = caller.person?.email.toLowerCase() ?? null
        const shares =
          ids.length === 0
            ? []
            : (yield* query(() =>
                DB.prepare(
                  `select s.id, s.target_kind as targetKind, s.target, s.role,
                     n.origin = 'data' as onData
                   from shares s join nodes n on n.id = s.node_id
                   where s.node_id in (${ids.map(() => '?').join(', ')})
                     and (? is null or s.grant_order <= ?)`,
                )
                  .bind(...ids, asOf, asOf)
                  .all<{
                    id: ShareId
                    targetKind: 'email' | 'team' | 'workspace' | 'anyone'
                    target: string
                    role: Role
                    onData: number
                  }>(),
              )).results
        const grants: Grant[] = []
        for (const share of shares) {
          // A team belongs to one workspace: its shares reach its members
          // only in the trees of that workspace.
          const team =
            share.targetKind === 'team' &&
            facts.memberRole !== null &&
            caller.person !== null &&
            facts.teams.includes(share.target as TeamId)
          const matches =
            share.targetKind === 'anyone' ||
            (share.targetKind === 'email' && share.target === email) ||
            (share.targetKind === 'workspace' &&
              share.target === facts.workspaceId &&
              facts.memberRole !== null) ||
            team
          if (!matches) continue
          grants.push({
            role: share.role,
            onData: share.onData === 1,
            basis: {
              kind: 'share',
              shareId: share.id,
              role: share.role,
              targetKind: share.targetKind,
            },
            also:
              team && caller.person !== null
                ? {
                    kind: 'team-member',
                    teamId: share.target as TeamId,
                    workspaceId: facts.workspaceId,
                    userId: caller.person.id,
                  }
                : null,
          })
        }
        if (facts.memberRole === 'admin' && caller.person !== null) {
          grants.push({
            role: 'write',
            onData: false,
            also: null,
            basis: {
              kind: 'admin',
              workspaceId: facts.workspaceId,
              userId: caller.person.id,
            },
          })
        }
        // Whatever their role, people may read and withdraw what they wrote.
        const owns =
          caller.person !== null &&
          node.origin === 'data' &&
          node.deletedAt === null &&
          node.ownerId === caller.person.id
        return { grants, owns, facts }
      })

    /** The caller's roles on a node, counting only grants made by `asOf`. */
    const roleAt = (node: NodeRow, asOf: number | null) =>
      Effect.map(grantsOn(node, asOf), ({ grants, owns }) =>
        roleSetOf(grants, owns),
      )

    const roleOn = (node: NodeRow) => roleAt(node, null)

    const require = <A extends Action>(
      action: A,
      node: NodeRow | MissingNode,
    ) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        if (isMissing(node)) return yield* denied(caller, node.path)
        const { grants, owns, facts } = yield* grantsOn(node)
        if (facts !== null && facts.state !== 'live') {
          // People withdraw what they wrote wherever it sits, so deleting
          // an account leaves nothing of theirs in a closed workspace.
          if (
            action === 'withdraw-own' &&
            caller.via.kind === 'browser' &&
            caller.person !== null &&
            node.origin === 'data' &&
            node.deletedAt === null &&
            node.ownerId === caller.person.id
          ) {
            const owner: Basis = {
              kind: 'owner',
              nodeId: node.id,
              userId: caller.person.id,
            }
            return { ...node, basis: [owner] } as unknown as Granted<A>
          }
          if (
            facts.state === 'suspended' &&
            facts.memberRole !== null &&
            action !== 'read'
          ) {
            return yield* Effect.fail(
              suspendedError(facts.workspaceName, deployment, node.path),
            )
          }
          return yield* denied(caller, node.path)
        }
        const roles = roleSetOf(grants, owns)
        const data = node.origin === 'data'
        // People's data is read through private grants, a public data
        // folder, or ownership; authored files through any grant.
        const reads = data
          ? roles.privateCaps.has('read') || owns
          : roles.caps.has('read') || roles.caps.has('read-authored')
        // Answering into a shared file needs respond, not read: the form
        // that targets it already says it is there.
        const answers =
          action === 'respond' && data && roles.caps.has('respond')
        if (!reads && !answers) {
          // A `_` file is read through any node it is reached from.
          const reach = action === 'read' ? yield* reached(node) : null
          if (reach === null) return yield* denied(caller, node.path)
          return { ...node, basis: [reach] } as unknown as Granted<A>
        }
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
        if (action !== 'read' && !allows(action, roles)) {
          return yield* Effect.fail(
            dossierError('forbidden', undefined, null, node.path),
          )
        }
        const owner: Basis | null =
          owns && caller.person !== null
            ? { kind: 'owner', nodeId: node.id, userId: caller.person.id }
            : null
        return {
          ...node,
          basis: basisFor(action, roles, grants, owner),
        } as unknown as Granted<A>
      })

    /**
     * Phase 2's condition for the nodes of a tree the caller may read, over
     * the table `column` names: the caller's grants, without reach.
     */
    const grantedWhere = (treeId: TreeId, asOf: number | null = null) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        if (
          caller.via.kind === 'system' ||
          (caller.via.kind === 'handle' && caller.via.treeId !== treeId)
        ) {
          return null
        }
        const facts = yield* treeFacts(caller, treeId, asOf)
        if (facts === null || facts.state !== 'live') return null
        let scopePath: string | null = null
        if (caller.via.kind === 'agent' && caller.via.scope !== null) {
          const scopeNode = yield* query(() =>
            DB.prepare(
              'select path from nodes where id = ? and tree_id = ? and deleted_at is null',
            )
              .bind(caller.via.kind === 'agent' ? caller.via.scope : '', treeId)
              .first<{ path: string }>(),
          )
          if (scopeNode === null) return null
          scopePath = scopeNode.path
        }
        const email = caller.person?.email.toLowerCase() ?? null
        const member = facts.memberRole === null ? 0 : 1
        const admin = facts.memberRole === 'admin'
        const teams = JSON.stringify(member === 1 ? facts.teams : [])
        return (column: (name: 'tree_id' | 'path' | 'origin') => SQL): SQL => {
          const scope =
            scopePath === null
              ? sql`1`
              : underColumn(column('path'), sql`${scopePath}`)
          const inTree = sql`${column('tree_id')} = ${treeId} and ${scope}`
          if (admin) return inTree
          return sql`${inTree} and exists (
            select 1 from shares s join nodes a on a.id = s.node_id and a.deleted_at is null
            where s.tree_id = ${treeId}
              and (s.target_kind = 'anyone'
                or (s.target_kind = 'email' and s.target = ${email})
                or (s.target_kind = 'workspace' and s.target = ${facts.workspaceId} and ${member} = 1)
                or (s.target_kind = 'team' and s.target in (select value from json_each(${teams}))))
              and ${asOf === null ? sql`1` : sql`s.grant_order <= ${asOf}`}
              and ${underColumn(column('path'), sql`a.path`)}
              and (s.role <> 'respond' or ${column('origin')} = 'authored')
              and (s.target_kind <> 'anyone' or ${column('origin')} = 'authored'
                or a.origin = 'data'))`
        }
      })

    /** The data nodes the caller wrote, within what its key reaches. */
    const ownedWhere = (treeId: TreeId) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const person = caller.person
        if (
          person === null ||
          caller.via.kind === 'system' ||
          (caller.via.kind === 'handle' && caller.via.treeId !== treeId)
        ) {
          return null
        }
        let scope = sql`1`
        if (caller.via.kind === 'agent' && caller.via.scope !== null) {
          const scopeNode = yield* query(() =>
            DB.prepare(
              'select path from nodes where id = ? and tree_id = ? and deleted_at is null',
            )
              .bind(caller.via.kind === 'agent' ? caller.via.scope : '', treeId)
              .first<{ path: string }>(),
          )
          if (scopeNode === null) return null
          scope = underColumn(sql`${nodes.path}`, sql`${scopeNode.path}`)
        }
        return sql`${nodes.origin} = 'data' and ${nodes.ownerId} = ${person.id} and ${scope}`
      })

    /** The live nodes of the tree at or below `from` the caller may read. */
    const reachFrom = (
      grants: (column: (name: 'tree_id' | 'path' | 'origin') => SQL) => SQL,
      treeId: TreeId,
      from: SQL,
    ): SQL => {
      const r = (name: 'tree_id' | 'path' | 'origin') => sql.raw(`r.${name}`)
      return sql`exists (select 1 from nodes r
        where r.tree_id = ${treeId} and r.deleted_at is null
          and ${underColumn(sql`r.path`, from)}
          and ${grants(r)})`
    }

    /** Read on an authored `_` node through a node it is reached from. */
    const reached = (node: NodeRow, asOf: number | null = null) =>
      Effect.gen(function* () {
        const split = underscoreSplit(node.path)
        if (split === null || node.origin !== 'authored') return null
        const grants = yield* grantedWhere(node.treeId, asOf)
        if (grants === null) return null
        const condition = reachFrom(grants, node.treeId, sql`${split.from}`)
        const found = yield* query(() =>
          db({ DB })
            .select({ one: sql<number>`1` })
            .from(nodes)
            .where(sql`${nodes.id} = ${node.id} and ${condition}`)
            .limit(1)
            .all(),
        )
        return found.length === 0
          ? null
          : ({ kind: 'reach', from: split.from } satisfies Basis)
      })

    const readsAsOf = (node: NodeRow, order: number) =>
      Effect.gen(function* () {
        const roles = yield* roleAt(node, order)
        const reads =
          node.origin === 'data'
            ? roles.privateCaps.has('read') || roles.owns
            : roles.caps.has('read') || roles.caps.has('read-authored')
        if (reads) return true
        return (yield* reached(node, order)) !== null
      })

    const readable = (treeId: TreeId) =>
      Effect.gen(function* () {
        const grants = yield* grantedWhere(treeId)
        if (grants === null) return { where: sql`0` } satisfies ReadableNodes
        const own = grants((name) =>
          name === 'tree_id'
            ? sql`${nodes.treeId}`
            : name === 'path'
              ? sql`${nodes.path}`
              : sql`${nodes.origin}`,
        )
        const owned = (yield* ownedWhere(treeId)) ?? sql`0`
        return {
          where: sql`${nodes.treeId} = ${treeId} and ((${own}) or (${owned}) or (
            ${nodes.origin} = 'authored' and ${nodes.underscoreFrom} is not null
            and ${reachFrom(grants, treeId, sql`${nodes.underscoreFrom}`)}))`,
        } satisfies ReadableNodes
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
            `select m.role, w.suspended_at as suspendedAt, w.deleted_at as deletedAt
             from workspace_members m join workspaces w on w.id = m.workspace_id
             where m.workspace_id = ? and m.user_id = ?`,
          )
            .bind(workspace.id, person.id)
            .first<{
              role: 'admin' | 'member'
              suspendedAt: number | null
              deletedAt: number | null
            }>(),
        )
        if (row === null || row.deletedAt !== null) {
          return yield* denied(caller, workspace.name)
        }
        if (row.suspendedAt !== null) {
          return yield* Effect.fail(
            suspendedError(workspace.name, deployment, workspace.name),
          )
        }
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

    return { require, roleOn, readsAsOf, readable, member }
  }),
)

/** `column` is the path `prefix` or lies below it. */
const underColumn = (column: SQL, prefix: SQL): SQL =>
  sql`(${prefix} = '' or ${column} = ${prefix} or substr(${column}, 1, length(${prefix}) + 1) = ${prefix} || '/')`
