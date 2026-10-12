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
  /**
   * Read on what a page share carries, on a shared file a respondent's form
   * writes, or on a page's comments: from the one read rule, never a basis
   * for a change.
   */
  | { readonly kind: 'carried' }
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
  /**
   * The caller reads this node, by every rule but the `_` reach: grants,
   * ownership, and what page shares, forms and comments carry.
   */
  readonly reads: boolean
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

/** A grant through an anyone share, directly or through a page's forms. */
const isPublic = (g: Grant): boolean =>
  g.basis.kind === 'share' && g.basis.targetKind === 'anyone'

const roleSetOf = (grants: readonly Grant[], owns: boolean): RoleSet => ({
  roles: new Set(grants.map((g) => g.role)),
  caps: capabilitiesOf(grants.map((g) => g.role)),
  privateCaps: capabilitiesOf(
    grants.filter((g) => g.onData || !isPublic(g)).map((g) => g.role),
  ),
  basis: grants.flatMap(basesOf),
  owns,
  reads: false,
})

/** Whether these roles read a node of this origin, before what is carried. */
const readsBy = (roles: RoleSet, origin: string): boolean =>
  origin === 'data'
    ? roles.privateCaps.has('read') || roles.owns
    : roles.caps.has('read') || roles.caps.has('read-authored')

interface ShareRow {
  readonly id: ShareId
  readonly targetKind: 'email' | 'team' | 'workspace' | 'anyone'
  readonly target: string
  readonly role: Role
  /** The share sits on a data node. */
  readonly onData: number
}

/** A share on a page that reaches the caller, with where its forms write. */
interface PageShare {
  readonly grant: Grant
  readonly pageId: NodeId
  readonly targets: readonly {
    readonly path: string
    readonly kind: 'folder' | 'json'
  }[]
}

const isUnder = (path: string, prefix: string): boolean =>
  prefix === '' || path === prefix || path.startsWith(`${prefix}/`)

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
  /**
   * Changes whenever a push lands or a share is made, removed or changed:
   * what a request may keep of the tree's page shares.
   */
  readonly stamp: string
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
    /** Page shares as a request found them, by the request's caller. */
    const pageShareCache = new WeakMap<
      Caller,
      Map<string, readonly PageShare[]>
    >()

    const query = <A>(run: () => Promise<A>) =>
      Effect.tryPromise(run).pipe(
        Effect.tapError((error) =>
          Effect.logError('An access read failed', error),
        ),
        Effect.orDie,
      )

    /**
     * The tree's workspace, whether the two are live, suspended or deleted,
     * and the caller's role and teams in it, counting only grants at or
     * below order `asOf`; null when no such tree exists.
     */
    const treeFacts = (
      caller: Caller,
      treeId: TreeId,
      asOf: number | null = null,
    ) =>
      query(() =>
        DB.prepare(
          `select t.workspace_id as workspaceId, w.name as workspaceName,
             t.authored_seq || ':' || (select count(*) || ':' || coalesce(max(grant_order), 0)
               from shares where tree_id = t.id) as stamp,
             case when w.deleted_at is not null or t.deleted_at is not null then 'deleted'
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
           where t.id = ?1`,
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
                stamp: row.stamp,
                state: row.state,
                memberRole: row.memberRole,
                teams: JSON.parse(row.teamsJson ?? '[]') as TeamId[],
              },
        ),
      )

    /** The grant a share gives the caller, or null when it does not reach them. */
    const grantOf = (
      caller: Caller,
      facts: TreeFacts,
      share: ShareRow,
    ): Grant | null => {
      const email = caller.person?.email.toLowerCase() ?? null
      // A team belongs to one workspace: its shares reach its members only
      // in the trees of that workspace.
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
      if (!matches) return null
      return {
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
      }
    }

    /**
     * The shares on pages of the tree that reach the caller, each with the
     * targets of the forms composed into its page now. A tree without page
     * shares costs this one query.
     */
    const pageSharesOf = (
      caller: Caller,
      facts: TreeFacts,
      treeId: TreeId,
      asOf: number | null,
    ) =>
      Effect.gen(function* () {
        // One lookup per request and state of the tree, however many checks.
        const key = `${treeId}:${asOf}:${facts.stamp}`
        const kept = pageShareCache.get(caller)?.get(key)
        if (kept !== undefined) return kept
        const found = yield* pageSharesNow(caller, facts, treeId, asOf)
        const forCaller = pageShareCache.get(caller) ?? new Map()
        forCaller.set(key, found)
        pageShareCache.set(caller, forCaller)
        return found
      })

    const pageSharesNow = (
      caller: Caller,
      facts: TreeFacts,
      treeId: TreeId,
      asOf: number | null,
    ) =>
      Effect.gen(function* () {
        const rows = yield* query(() =>
          DB.prepare(
            `select s.id, s.target_kind as targetKind, s.target, s.role, 0 as onData,
               n.id as pageId, n.path as pagePath
             from shares s join nodes n on n.id = s.node_id
             where s.tree_id = ? and n.deleted_at is null and n.kind = 'file'
               and n.origin = 'authored' and n.underscore_from is null
               and substr(n.path, -5) = '.html'
               and (? is null or s.grant_order <= ?)`,
          )
            .bind(treeId, asOf, asOf)
            .all<ShareRow & { pageId: NodeId; pagePath: string }>(),
        )
        const found: PageShare[] = []
        for (const row of rows.results) {
          const grant = grantOf(caller, facts, row)
          if (grant === null) continue
          const targets = yield* query(() =>
            db({ DB }).all<{ target: string; kind: string }>(
              pageTargetsSql(treeId, row.pagePath),
            ),
          )
          found.push({
            grant,
            pageId: row.pageId,
            targets: targets.map((t) => ({
              path: t.target.replace(/\/$/, ''),
              kind: t.kind === 'json' ? 'json' : 'folder',
            })),
          })
        }
        return found
      })

    /**
     * What page shares give on people's data in their form targets: read
     * from read or write on the page, respond from respond. A grant through
     * an anyone share stays public, so it never reads people's data.
     */
    const throughPages = (
      node: NodeRow,
      shares: readonly PageShare[],
    ): Grant[] =>
      node.origin !== 'data'
        ? []
        : shares
            .filter(({ targets }) =>
              targets.some((t) =>
                t.kind === 'folder'
                  ? isUnder(node.path, t.path)
                  : node.path === t.path,
              ),
            )
            .map(({ grant }) => ({
              ...grant,
              role: grant.role === 'respond' ? 'respond' : 'read',
              onData: false,
            }))

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
                  .all<ShareRow>(),
              )).results
        const grants: Grant[] = []
        for (const share of shares) {
          const grant = grantOf(caller, facts, share)
          if (grant !== null) grants.push(grant)
        }
        // What page shares carry follows the pages as they are now, so it
        // never counts toward what was readable at an earlier grant order.
        if (node.origin === 'data' && asOf === null) {
          grants.push(
            ...throughPages(
              node,
              yield* pageSharesOf(caller, facts, node.treeId, asOf),
            ),
          )
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
      Effect.gen(function* () {
        const { grants, owns, facts } = yield* grantsOn(node, asOf)
        const roles = roleSetOf(grants, owns)
        // What is carried follows the pages as they are now: never what was
        // readable at an earlier grant order, where a dependency a later
        // push added would reach back to versions nobody issued.
        const reads =
          readsBy(roles, node.origin) ||
          // Its arms hold their own key scope, the `_` reach outside it
          // included, as reach from grants does.
          (asOf === null && facts !== null && (yield* carries(node, null)))
        return { ...roles, reads } satisfies RoleSet
      })

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
        // What page shares, respondents' forms and comments carry is read
        // by the one read rule.
        const direct = readsBy(roles, node.origin)
        // A `_` file is read through any node it is reached from; that
        // reach is named first, as it was before anything was carried.
        if (!direct && action === 'read' && node.origin === 'authored') {
          const reach = yield* reached(node)
          if (reach !== null) {
            return { ...node, basis: [reach] } as unknown as Granted<A>
          }
        }
        // What is carried is read only, as reach is: any other action on a
        // node read only that way is refused as missing.
        const carried =
          !direct && action === 'read' && (yield* carries(node, null))
        const reads = direct || carried
        // Answering into a shared file needs respond, not read: the form
        // that targets it already says it is there.
        const answers =
          action === 'respond' && data && roles.caps.has('respond')
        if (!reads && !answers) return yield* denied(caller, node.path)
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
        const basis = basisFor(action, roles, grants, owner)
        return {
          ...node,
          basis:
            action === 'read' && carried
              ? [...basis, { kind: 'carried' } satisfies Basis]
              : basis,
        } as unknown as Granted<A>
      })

    /**
     * Phase 2's condition for the nodes of a tree the caller may read, over
     * the table `column` names: the caller's grants, without reach.
     */
    /**
     * The caller's facts on a tree as SQL values, and the tree's workspace:
     * null when nothing in the tree can be the caller's to read.
     */
    const factsOn = (treeId: TreeId, asOf: number | null = null) =>
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
        const member = facts.memberRole !== null
        return {
          workspaceId: facts.workspaceId,
          facts: {
            email: lit(caller.person?.email.toLowerCase() ?? null),
            person: lit(caller.person?.id ?? null),
            member: lit(member ? 1 : 0),
            admin: lit(facts.memberRole === 'admin' ? 1 : 0),
            teams: lit(JSON.stringify(member ? facts.teams : [])),
            within: (path: SQL) =>
              scopePath === null ? sql`1` : underColumn(path, lit(scopePath)),
          } satisfies CallerFacts,
        }
      })

    /**
     * Phase 2's condition for the nodes of a tree the caller may read, over
     * the table `column` names: the caller's grants, without reach.
     */
    const grantedWhere = (treeId: TreeId, asOf: number | null = null) =>
      Effect.map(factsOn(treeId, asOf), (on) =>
        on === null ? null : grantOn(treeId, on.workspaceId, on.facts, asOf),
      )

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
        if ((yield* roleAt(node, order)).reads) return true
        return (yield* reached(node, order)) !== null
      })

    /**
     * Whether the one read rule's carried part holds for the node, counting
     * grants at or below order `asOf`.
     */
    const carries = (node: NodeRow, asOf: number | null) =>
      Effect.gen(function* () {
        const on = yield* factsOn(node.treeId, asOf)
        if (on === null) return false
        const found = yield* query(() =>
          db({ DB })
            .select({ one: sql<number>`1` })
            .from(nodes)
            .where(
              sql`${nodes.id} = ${node.id} and ${carriedOn(node.treeId, on.workspaceId, on.facts, asOf)(nodeColumn)}`,
            )
            .limit(1)
            .all(),
        )
        return found.length > 0
      })

    const readable = (treeId: TreeId) =>
      Effect.map(factsOn(treeId), (on) =>
        on === null
          ? ({ where: sql`0` } satisfies ReadableNodes)
          : ({
              where: readableOn(treeId, on.workspaceId, on.facts)(nodeColumn),
            } satisfies ReadableNodes),
      )

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

/**
 * A value written into SQL as a literal: the read rule repeats the caller's
 * facts many times, more than a query may bind. Strings are quoted with
 * their quotes doubled, as SQLite reads them; numbers are integers.
 */
export const lit = (value: string | number | null): SQL =>
  value === null
    ? sql.raw('null')
    : typeof value === 'number'
      ? sql.raw(String(Math.trunc(value)))
      : sql.raw(`'${value.replaceAll("'", "''")}'`)

/**
 * `sql` with every run of white space in its text made one space: the read
 * rule is long, repeated in every query that lists what a caller reads, and
 * a statement has a size limit.
 */
const tight = (strings: TemplateStringsArray, ...values: unknown[]): SQL =>
  sql(
    Object.assign(
      strings.map((part) => part.replace(/\s+/g, ' ')),
      { raw: strings.raw },
    ) as unknown as TemplateStringsArray,
    ...(values as never[]),
  )

/**
 * Who asks, as SQL values: one caller's facts as bound literals, or many
 * callers' as the columns of a table, so one rule serves both.
 */
export interface CallerFacts {
  /** Lower-cased, or NULL for a visitor. */
  readonly email: SQL
  /** The person's id, or NULL for a visitor. */
  readonly person: SQL
  /** 1 when a member of the tree's workspace. */
  readonly member: SQL
  /** 1 when an admin of it. */
  readonly admin: SQL
  /** A JSON array of the person's team ids there. */
  readonly teams: SQL
  /** Holds when a path is within what the caller's key reaches. */
  readonly within: (path: SQL) => SQL
}

export type NodeColumn = (
  name:
    | 'id'
    | 'tree_id'
    | 'path'
    | 'origin'
    | 'kind'
    | 'owner_id'
    | 'underscore_from',
) => SQL

/** The unaliased `nodes` table's columns. */
export const nodeColumn: NodeColumn = (name) => sql.raw(`"nodes"."${name}"`)

/**
 * The caller's grants on a node of the tree, without reach: admin write, or
 * a share on it or a folder above it whose target is the caller, where a
 * respond share reads authored files only and an anyone share reaches
 * people's data only when it sits on a data node.
 */
export const grantOn =
  (
    treeId: TreeId,
    workspaceId: string,
    f: CallerFacts,
    asOf: number | null = null,
  ) =>
  (column: (name: 'tree_id' | 'path' | 'origin') => SQL): SQL =>
    tight`${column('tree_id')} = ${lit(treeId)} and ${f.within(column('path'))} and (${f.admin} = 1 or exists (
      select 1 from shares s join nodes a on a.id = s.node_id and a.deleted_at is null
      where s.tree_id = ${lit(treeId)}
        and (s.target_kind = 'anyone'
          or (s.target_kind = 'email' and s.target = ${f.email})
          or (s.target_kind = 'workspace' and s.target = ${lit(workspaceId)} and ${f.member} = 1)
          or (s.target_kind = 'team' and s.target in (select value from json_each(${f.teams}))))
        and ${asOf === null ? tight`1` : tight`s.grant_order <= ${lit(asOf)}`}
        and ${underColumn(column('path'), tight`a.path`)}
        and (s.role <> 'respond' or ${column('origin')} = 'authored')
        and (s.target_kind <> 'anyone' or ${column('origin')} = 'authored'
          or a.origin = 'data')))`

/** The live nodes of the tree at or below `from` the caller may read. */
export const reachFrom = (
  grants: (column: (name: 'tree_id' | 'path' | 'origin') => SQL) => SQL,
  treeId: TreeId,
  from: SQL,
): SQL => {
  const r = (name: 'tree_id' | 'path' | 'origin') => sql.raw(`r.${name}`)
  return tight`exists (select 1 from nodes r
    where r.tree_id = ${lit(treeId)} and r.deleted_at is null
      and ${underColumn(tight`r.path`, from)}
      and ${grants(r)})`
}

/**
 * The one read rule over a node's columns: the caller's grants, their own
 * data within what their key reaches, and an authored `_` node through a
 * readable node at or below where its `_` part starts. The tree must be
 * live, which the caller of this checks.
 */
export const readableOn =
  (treeId: TreeId, workspaceId: string, f: CallerFacts) =>
  (column: NodeColumn): SQL => {
    const grants = grantOn(treeId, workspaceId, f)
    return tight`${column('tree_id')} = ${lit(treeId)} and ((${grants(column)})
      or (${column('origin')} = 'data' and ${f.person} is not null
        and ${column('owner_id')} = ${f.person}
        and ${f.within(column('path'))})
      or (${column('origin')} = 'authored' and ${column('underscore_from')} is not null
        and ${reachFrom(grants, treeId, column('underscore_from'))})
      or (${carriedOn(treeId, workspaceId, f)(column)}))`
  }

/** A share's target is the caller, counting grants at or below `asOf`. */
const reachesCaller = (
  workspaceId: string,
  f: CallerFacts,
  asOf: number | null,
): SQL =>
  tight`(s.target_kind = 'anyone'
    or (s.target_kind = 'email' and s.target = ${f.email})
    or (s.target_kind = 'workspace' and s.target = ${lit(workspaceId)} and ${f.member} = 1)
    or (s.target_kind = 'team' and s.target in (select value from json_each(${f.teams}))))
    and ${asOf === null ? tight`1` : tight`s.grant_order <= ${lit(asOf)}`}`

/**
 * A share `s` reaching the caller on a live page `p`, and what the page
 * carries as `pn` (page_needs) of the kinds given.
 */
const pageCarries = (kinds: SQL): SQL =>
  tight`from shares s
    join nodes p on p.id = s.node_id and p.deleted_at is null and p.kind = 'file'
      and p.origin = 'authored' and p.underscore_from is null
      and substr(p.path, -5) = '.html'
    join page_needs pn on pn.tree_id = s.tree_id and pn.page_path = p.path
      and pn.kind ${kinds}`

/**
 * The authored node `as` that a shared page renders with, then what more
 * the arm joins, selecting `select`.
 */
const neededArm = (
  treeId: TreeId,
  workspaceId: string,
  f: CallerFacts,
  asOf: number | null,
  arm: { readonly as: string; readonly joins: SQL; readonly select: SQL },
): SQL => {
  const N = sql.raw(arm.as)
  return tight`select ${arm.select} ${pageCarries(tight`= 'render'`)}
    join nodes ${N} on ${N}.tree_id = s.tree_id and ${N}.path = pn.need_path
      and ${N}.deleted_at is null and ${N}.origin = 'authored'
    ${arm.joins}
    where s.tree_id = ${lit(treeId)} and ${reachesCaller(workspaceId, f, asOf)}
      and ${N}.id <> p.id and ${f.within(tight`${N}.path`)}`
}

/**
 * Every node the read rule carries beyond grants, ownership and reach: the
 * files shared pages render with, and the `_` files reached from them; the
 * data in a page's form targets for a private read or write share on it;
 * for a private respond share, the shared files (nobody's own) that forms
 * of its page, or of the pages in and layouts above its folder, write; and
 * the data in the comments folder of a page the caller reads. Each is a
 * flat select of its own, so the rule stays light for SQLite.
 */
const carriedArms = (
  treeId: TreeId,
  workspaceId: string,
  f: CallerFacts,
  asOf: number | null,
): SQL[] => {
  const T = lit(treeId)
  const caller = reachesCaller(workspaceId, f, asOf)
  // The data in a page's comments folder, for a page `q` the caller reads:
  // `cf` is the folder and `x` what lies in it.
  const inComments = tight`join nodes cf on cf.tree_id = q.tree_id
      and cf.path = substr(q.path, 1, length(q.path) - 5) || '.comments'
      and cf.deleted_at is null and cf.kind = 'folder'
    join nodes x on x.tree_id = q.tree_id and x.origin = 'data'
      and ${underColumn(tight`x.path`, tight`cf.path`)}`
  const page = tight`q.tree_id = ${T} and q.deleted_at is null and q.kind = 'file'
    and q.origin = 'authored' and substr(q.path, -5) = '.html'`
  return [
    neededArm(treeId, workspaceId, f, asOf, {
      as: 'x',
      joins: tight``,
      select: tight`x.id`,
    }),
    // The `_` files reached from a node a page share carries, as from any
    // node the caller reads.
    neededArm(treeId, workspaceId, f, asOf, {
      as: 'r',
      joins: tight`join nodes k on k.tree_id = r.tree_id and k.origin = 'authored'
        and k.underscore_from is not null
        and ${underColumn(tight`r.path`, tight`k.underscore_from`)}`,
      select: tight`k.id`,
    }),
    tight`select x.id ${pageCarries(tight`in ('folder', 'json')`)}
      join nodes x on x.tree_id = s.tree_id and x.origin = 'data'
        and ((pn.kind = 'folder' and ${underColumn(tight`x.path`, tight`pn.need_path`)})
          or (pn.kind = 'json' and x.path = pn.need_path))
      where s.tree_id = ${T} and ${caller} and s.role <> 'respond'
        and s.target_kind <> 'anyone' and ${f.within(tight`x.path`)}`,
    tight`select x.id ${pageCarries(tight`= 'json'`)}
      join nodes x on x.tree_id = s.tree_id and x.path = pn.need_path
        and x.origin = 'data' and x.kind = 'file' and x.owner_id is null
      where s.tree_id = ${T} and ${caller} and s.role = 'respond'
        and s.target_kind <> 'anyone' and ${f.within(tight`x.path`)}`,
    tight`select x.id from shares s join nodes a on a.id = s.node_id
      join forms fm on fm.tree_id = s.tree_id and fm.kind = 'shared'
      join nodes h on h.id = fm.host_node_id and h.current_version_id = fm.host_version_id
        and h.deleted_at is null
      join nodes x on x.tree_id = s.tree_id and x.path = fm.target_path
        and x.origin = 'data' and x.kind = 'file' and x.owner_id is null
      where s.tree_id = ${T} and a.deleted_at is null and a.kind = 'folder'
        and s.role = 'respond' and s.target_kind <> 'anyone' and ${caller}
        and (${underColumn(tight`h.path`, tight`a.path`)}
          or (h.name = '_layout.html'
            and ${underColumn(tight`a.path`, tight`h.underscore_from`)}))
        and ${f.within(tight`x.path`)}`,
    // Comments on a page the caller reads through a grant: as an admin, or
    // a share on it or a folder above (a page is authored: every role reads
    // it), or through what a page share carries.
    tight`select x.id from nodes q ${inComments}
      where ${page} and ${f.admin} = 1 and ${f.within(tight`q.path`)}
        and ${f.within(tight`x.path`)}`,
    tight`select x.id from nodes q ${inComments}
      join shares s on s.tree_id = q.tree_id and ${caller}
      join nodes a on a.id = s.node_id and a.deleted_at is null
        and ${underColumn(tight`q.path`, tight`a.path`)}
      where ${page} and ${f.within(tight`q.path`)} and ${f.within(tight`x.path`)}`,
    tight`${neededArm(treeId, workspaceId, f, asOf, {
      as: 'q',
      joins: inComments,
      select: tight`x.id`,
    })} and substr(q.path, -5) = '.html' and ${f.within(tight`x.path`)}`,
  ]
}

/** The node is in what the read rule carries (carriedArms). */
export const carriedOn =
  (
    treeId: TreeId,
    workspaceId: string,
    f: CallerFacts,
    asOf: number | null = null,
  ) =>
  (column: NodeColumn): SQL =>
    anyOf(
      carriedArms(treeId, workspaceId, f, asOf).map(
        (arm) => tight`${column('id')} in (${arm})`,
      ),
    )

/**
 * The places a share on a page writes to through its forms, as the read
 * rule reads them: for the derived grants on people's data there.
 */
export const pageTargetsSql = (treeId: TreeId, pagePath: string): SQL =>
  tight`select need_path as target, kind from page_needs
    where tree_id = ${treeId} and page_path = ${pagePath} and kind in ('folder', 'json')`

/**
 * Conditions joined by `or` as a balanced tree, so many of them add only
 * their logarithm to SQLite's expression depth.
 */
const anyOf = (parts: readonly SQL[]): SQL => {
  if (parts.length === 0) return tight`0`
  if (parts.length === 1) return tight`(${parts[0]!})`
  const half = Math.ceil(parts.length / 2)
  return tight`(${anyOf(parts.slice(0, half))} or ${anyOf(parts.slice(half))})`
}

/** `column` is the path `prefix` or lies below it. */
export const underColumn = (column: SQL, prefix: SQL): SQL =>
  tight`(${prefix} = '' or ${column} = ${prefix} or substr(${column}, 1, length(${prefix}) + 1) = ${prefix} || '/')`
