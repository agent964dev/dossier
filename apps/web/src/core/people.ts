import {
  dossierError,
  isWorkspaceName,
  NAME_RULE,
  RESERVED_WORKSPACE_NAMES,
  type DossierError,
  type ErrorCode,
  type NodeId,
  type Person,
  type PersonId,
  type ShareId,
  type TeamId,
  type TreeId,
  type WorkspaceId,
} from '@dossier/contracts'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { Clock, Context, Effect, Layer, Schema } from 'effect'

import { db, schema } from '../db/client.ts'
import {
  Access,
  suspendedError,
  type Granted,
  type Membership,
} from './access.ts'
import type { Background } from './background.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller } from './caller.ts'
import { Config } from './config.ts'
import { Data } from './data.ts'
import { newId } from './ids.ts'
import {
  DEFAULT_LIMITS,
  LimitValuesSchema,
  type LimitValues,
} from './limits.ts'
import {
  Settings,
  settingsSaved,
  type Health,
  type SettingKey,
  type WorkspaceCreation,
} from './settings.ts'
import { closeStatements } from './sign-in.ts'
import {
  ancestorPaths,
  type NodeRow,
  type TreeRow,
  type WorkspaceRow,
} from './rows.ts'
import { TreeStore } from './tree-store.ts'

export type TreeSharing =
  | { readonly kind: 'private' }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'people'; readonly count: number }
  | { readonly kind: 'public' }

export type WorkspaceRole = 'admin' | 'member'

export interface TeamRef {
  readonly id: TeamId
  readonly name: string
}

export interface MemberRow {
  readonly person: Person
  readonly role: WorkspaceRole
  readonly teams: readonly TeamRef[]
  readonly isMe: boolean
}

export interface InvitationRow {
  readonly email: string
  readonly teams: readonly TeamRef[]
  /** The inviter's email. */
  readonly invitedBy: string
  readonly createdAt: number
}

export interface TeamSummary extends TeamRef {
  readonly members: number
}

export interface TeamDetail extends TeamRef {
  readonly members: readonly {
    readonly person: Person
    /** The names of the person's other teams in the workspace. */
    readonly otherTeams: readonly string[]
    readonly isMe: boolean
  }[]
  /** Workspace members not in the team. */
  readonly addable: readonly Person[]
}

export interface DeletionPreview {
  readonly submissions: number
  readonly entries: number
  readonly uploads: number
  /** 0 until comments exist. */
  readonly comments: number
  readonly keys: number
  readonly sessions: number
  /** The workspaces whose membership goes, by name. */
  readonly workspaces: readonly string[]
  readonly blockedBy:
    | { readonly kind: 'last_admin'; readonly workspace: string }
    | { readonly kind: 'last_super_admin' }
    | null
}

export interface AdminWorkspaceRow {
  readonly id: WorkspaceId
  readonly name: string
  readonly members: number
  readonly bytes: number
  readonly suspendedAt: number | null
  readonly deletedAt: number | null
}

export interface AdminOverview {
  readonly deployment: string
  /** No super admin has chosen who may create workspaces yet. */
  readonly firstRun: boolean
  readonly health: Health
  readonly workspaceCreation: WorkspaceCreation
  readonly creators: readonly {
    readonly entry: string
    readonly kind: 'email' | 'domain'
  }[]
  readonly limits: LimitValues
  readonly defaults: LimitValues
  readonly retentionDays: number
  readonly superAdmins: readonly {
    readonly person: Person
    /** Named in the deployment's SUPER_ADMINS. */
    readonly configured: boolean
    /** The email of the super admin who added them, when one did. */
    readonly addedBy: string | null
    readonly isMe: boolean
  }[]
  readonly workspaces: readonly AdminWorkspaceRow[]
}

type Fail<C extends ErrorCode> = DossierError<C>
type AdminFail = Fail<
  'sign_in_required' | 'not_found' | 'forbidden' | 'unavailable'
>

export interface PeopleService {
  /** Super admins always; others as the deployment setting says. */
  readonly mayCreateWorkspace: () => Effect.Effect<
    boolean,
    never,
    CurrentCaller
  >
  /** The creator is its first admin. */
  readonly createWorkspace: (i: {
    readonly name: string
  }) => Effect.Effect<
    WorkspaceRow,
    DossierError<
      'sign_in_required' | 'forbidden' | 'invalid' | 'conflict' | 'unavailable'
    >,
    CurrentCaller
  >
  readonly myWorkspaces: () => Effect.Effect<
    readonly Membership[],
    DossierError<'sign_in_required' | 'unavailable'>,
    CurrentCaller
  >
  /** The caller's teams in each of their workspaces, by workspace name. */
  readonly myTeams: () => Effect.Effect<
    ReadonlyMap<string, readonly string[]>,
    DossierError<'sign_in_required' | 'unavailable'>,
    CurrentCaller
  >
  /** The trees of a workspace the caller can open, with how each is shared. */
  readonly trees: (
    workspace: WorkspaceRow,
  ) => Effect.Effect<
    readonly { readonly tree: TreeRow; readonly sharing: TreeSharing }[],
    DossierError<'not_found' | 'sign_in_required' | 'unavailable'>,
    CurrentCaller
  >
  /** Who a node is shared with, through its own shares and its folders'. */
  readonly sharedWith: (
    node: NodeRow,
  ) => Effect.Effect<
    readonly { readonly targetKind: string; readonly target: string }[],
    DossierError<'unavailable'>
  >

  // Members and invitations, for the workspace's admins.
  readonly members: (workspace: string) => Effect.Effect<
    {
      readonly workspace: WorkspaceRow
      readonly members: readonly MemberRow[]
      readonly invitations: readonly InvitationRow[]
    },
    AdminFail,
    CurrentCaller
  >
  readonly invite: (i: {
    readonly workspace: string
    readonly email: string
    readonly teamIds: readonly TeamId[]
  }) => Effect.Effect<
    { readonly joined: boolean },
    AdminFail | Fail<'invalid' | 'conflict'>,
    CurrentCaller
  >
  readonly cancelInvitation: (i: {
    readonly workspace: string
    readonly email: string
  }) => Effect.Effect<void, AdminFail, CurrentCaller>
  readonly setRole: (i: {
    readonly workspace: string
    readonly userId: PersonId
    readonly role: WorkspaceRole
  }) => Effect.Effect<void, AdminFail | Fail<'last_admin'>, CurrentCaller>
  readonly removeMember: (i: {
    readonly workspace: string
    readonly userId: PersonId
  }) => Effect.Effect<void, AdminFail | Fail<'last_admin'>, CurrentCaller>
  /** Any member. */
  readonly leave: (i: {
    readonly workspace: string
  }) => Effect.Effect<void, AdminFail | Fail<'last_admin'>, CurrentCaller>

  // Teams, for the workspace's admins.
  readonly teams: (
    workspace: string,
  ) => Effect.Effect<readonly TeamSummary[], AdminFail, CurrentCaller>
  readonly team: (i: {
    readonly workspace: string
    readonly teamId: TeamId
  }) => Effect.Effect<TeamDetail, AdminFail, CurrentCaller>
  /** Any member: the teams a node may be shared with. */
  readonly teamsForSharing: (
    workspace: WorkspaceRow,
  ) => Effect.Effect<readonly TeamRef[], never, CurrentCaller>
  readonly createTeam: (i: {
    readonly workspace: string
    readonly name: string
  }) => Effect.Effect<
    TeamRef,
    AdminFail | Fail<'invalid' | 'conflict'>,
    CurrentCaller
  >
  readonly renameTeam: (i: {
    readonly workspace: string
    readonly teamId: TeamId
    readonly name: string
  }) => Effect.Effect<
    void,
    AdminFail | Fail<'invalid' | 'conflict'>,
    CurrentCaller
  >
  readonly deleteTeam: (i: {
    readonly workspace: string
    readonly teamId: TeamId
  }) => Effect.Effect<
    { readonly sharesRemoved: number },
    AdminFail | Fail<'conflict'>,
    CurrentCaller | Background
  >
  /** The person must be a member of the workspace. */
  readonly addToTeam: (i: {
    readonly workspace: string
    readonly teamId: TeamId
    readonly userId: PersonId
  }) => Effect.Effect<void, AdminFail | Fail<'invalid'>, CurrentCaller>
  readonly removeFromTeam: (i: {
    readonly workspace: string
    readonly teamId: TeamId
    readonly userId: PersonId
  }) => Effect.Effect<void, AdminFail, CurrentCaller>
  readonly moveToTeam: (i: {
    readonly workspace: string
    readonly from: TeamId
    readonly to: TeamId
    readonly userId: PersonId
  }) => Effect.Effect<void, AdminFail | Fail<'invalid'>, CurrentCaller>

  // The workspace.
  readonly workspaceSettings: (
    workspace: string,
  ) => Effect.Effect<
    { readonly workspace: WorkspaceRow; readonly retentionDays: number },
    AdminFail,
    CurrentCaller
  >
  readonly deleteWorkspace: (i: {
    readonly workspace: string
    readonly confirm: string
  }) => Effect.Effect<void, AdminFail | Fail<'invalid'>, CurrentCaller>

  // The person.
  readonly deletionPreview: () => Effect.Effect<
    DeletionPreview,
    Fail<'sign_in_required' | 'unavailable'>,
    CurrentCaller
  >
  readonly deleteAccount: () => Effect.Effect<
    void,
    Fail<'sign_in_required' | 'last_admin' | 'conflict' | 'unavailable'>,
    CurrentCaller | Background
  >

  // Super admins.
  readonly isSuperAdmin: () => Effect.Effect<boolean, never, CurrentCaller>
  readonly adminOverview: () => Effect.Effect<
    AdminOverview,
    AdminFail,
    CurrentCaller
  >
  readonly setWorkspaceCreation: (
    value: WorkspaceCreation,
  ) => Effect.Effect<void, AdminFail | Fail<'invalid'>, CurrentCaller>
  /** An email, or a domain such as acme.com. */
  readonly addCreator: (
    entry: string,
  ) => Effect.Effect<void, AdminFail | Fail<'invalid'>, CurrentCaller>
  readonly removeCreator: (
    entry: string,
  ) => Effect.Effect<void, AdminFail, CurrentCaller>
  readonly setLimits: (
    limits: Partial<LimitValues> | 'defaults',
  ) => Effect.Effect<LimitValues, AdminFail | Fail<'invalid'>, CurrentCaller>
  readonly setRetention: (
    days: number,
  ) => Effect.Effect<void, AdminFail | Fail<'invalid'>, CurrentCaller>
  /** The person must have signed in once. */
  readonly addSuperAdmin: (
    email: string,
  ) => Effect.Effect<void, AdminFail | Fail<'invalid'>, CurrentCaller>
  readonly removeSuperAdmin: (
    userId: PersonId,
  ) => Effect.Effect<void, AdminFail | Fail<'last_admin'>, CurrentCaller>
  readonly suspendWorkspace: (
    id: WorkspaceId,
  ) => Effect.Effect<void, AdminFail, CurrentCaller>
  readonly liftSuspension: (
    id: WorkspaceId,
  ) => Effect.Effect<void, AdminFail, CurrentCaller>
  /** Within the retention period, while its name is free. */
  readonly restoreWorkspace: (
    id: WorkspaceId,
  ) => Effect.Effect<void, AdminFail | Fail<'conflict'>, CurrentCaller>
}

export class People extends Context.Tag('People')<People, PeopleService>() {}

const unavailable = (error: unknown) => {
  console.error('A people read failed', error)
  return dossierError('unavailable')
}

const signInRequired = () =>
  dossierError(
    'sign_in_required',
    'Sign in to continue.',
    'Sign in with Google, or run dossier login.',
  )

const notFound = (path: string | null) =>
  dossierError(
    'not_found',
    'Nothing is here, or you cannot open it.',
    null,
    path,
  )

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(\.(?!-)[a-z0-9-]{1,63})+$/
const TEAM_NAME_MAX = 60
const DAY = 24 * 60 * 60_000

const lastAdmin = (workspace: string) =>
  dossierError(
    'last_admin',
    `You're the last admin of ${workspace}. Make another member an admin first.`,
    null,
    workspace,
  )

const lastSuperAdmin = () =>
  dossierError('last_admin', 'Name another super admin first.', null)

/** A guard row: the batch fails unless the workspace keeps an admin. */
const keepsAdmin = (DB: D1Database, guardId: string, workspaceId: string) => [
  DB.prepare(
    `insert into change_guards (id, reason, ok)
     select ?, 'admins', (select count(*) from workspace_members
       where workspace_id = ? and role = 'admin') >= 1`,
  ).bind(guardId, workspaceId),
  DB.prepare('delete from change_guards where id = ?').bind(guardId),
]

const isAdminsGuard = (error: unknown) =>
  String(error instanceof Error ? error.message : error).includes(
    'change_guard_admins',
  )

const isUnique = (error: unknown) =>
  String(error instanceof Error ? error.message : error).includes(
    'UNIQUE constraint failed',
  )

interface PersonRaw {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly image: string | null
}

const personOf = (row: PersonRaw): Person => ({
  id: row.id as PersonId,
  email: row.email,
  name: row.name,
  image: row.image ?? null,
})

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })

const CREATIONS: ReadonlySet<string> = new Set([
  'super_admins',
  'listed',
  'anyone',
])

export const PeopleLive: Layer.Layer<
  People,
  never,
  Bindings | Access | TreeStore | Settings | Data | Config
> = Layer.effect(
  People,
  Effect.gen(function* () {
    const bindings = yield* Bindings
    const access = yield* Access
    const store = yield* TreeStore
    const settings = yield* Settings
    const data = yield* Data
    const config = yield* Config
    const database = db(bindings)
    const DB = bindings.DB

    const query = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: unavailable })

    const all = <T>(statement: D1PreparedStatement) =>
      query(() => statement.all<T>()).pipe(Effect.map((r) => r.results))

    const first = <T>(statement: D1PreparedStatement) =>
      query(() => statement.first<T>())

    const person = Effect.flatMap(CurrentCaller, (caller) =>
      caller.person === null
        ? Effect.fail(signInRequired())
        : Effect.succeed({ person: caller.person, via: caller.via }),
    )

    /** Settings are screen actions of a person in a browser. */
    const browserPerson = Effect.flatMap(person, (who) =>
      who.via.kind === 'browser'
        ? Effect.succeed({ person: who.person, sessionId: who.via.sessionId })
        : Effect.fail(notFound(null)),
    )

    /**
     * The guard rows of an action taken on someone's authority: the batch
     * fails unless, as it commits, the session still lives and `holds` is
     * true, so authority lost between the check and the batch writes
     * nothing.
     */
    const onAuthority = (
      who: { readonly sessionId: string },
      holds: string,
      binds: readonly unknown[],
      at: number,
    ) => {
      const guardId = newId()
      return {
        first: DB.prepare(
          `insert into change_guards (id, reason, ok)
           select ?, 'basis', coalesce((exists (select 1 from session
             where id = ? and expires_at > ?) and (${holds})), 0)`,
        ).bind(guardId, who.sessionId, at, ...binds),
        last: DB.prepare('delete from change_guards where id = ?').bind(
          guardId,
        ),
      }
    }

    const isBasisGuard = (error: unknown) =>
      String(error instanceof Error ? error.message : error).includes(
        'change_guard_basis',
      )

    /** Runs a batch on the authority of a still-live check. */
    const guardedBatch = <R, O = never>(
      guard: {
        readonly first: D1PreparedStatement
        readonly last: D1PreparedStatement
      },
      statements: readonly D1PreparedStatement[],
      refused: () => R,
      other: (error: unknown) => O | null = () => null,
    ) =>
      Effect.tryPromise({
        try: () => DB.batch([guard.first, ...statements, guard.last]),
        catch: (error): R | O | DossierError<'unavailable'> =>
          isBasisGuard(error)
            ? refused()
            : (other(error) ?? unavailable(error)),
      }).pipe(Effect.map((results) => results.slice(1, -1)))

    /** The live workspace by name, or null. */
    const workspaceNamed = (name: string) =>
      first<Record<string, unknown>>(
        DB.prepare(
          `select id, name, created_by as createdBy, created_at as createdAt,
             suspended_at as suspendedAt, deleted_at as deletedAt
           from workspaces where name = ? and deleted_at is null`,
        ).bind(name),
      ).pipe(Effect.map((row) => row as WorkspaceRow | null))

    /**
     * The workspace when the caller administers it; anyone else learns
     * nothing. A suspended workspace refuses its admins' changes.
     */
    const adminOf = (name: string, opts: { readonly reads?: boolean } = {}) =>
      Effect.gen(function* () {
        const { person: me, sessionId } = yield* browserPerson
        const workspace = yield* workspaceNamed(name)
        if (workspace === null) return yield* Effect.fail(notFound(name))
        const row = yield* first<{ role: string }>(
          DB.prepare(
            'select role from workspace_members where workspace_id = ? and user_id = ?',
          ).bind(workspace.id, me.id),
        )
        if (row?.role !== 'admin') return yield* Effect.fail(notFound(name))
        if (workspace.suspendedAt !== null && opts.reads !== true) {
          return yield* Effect.fail(
            suspendedError(
              workspace.name,
              config.deploymentName,
              workspace.name,
            ),
          )
        }
        return { workspace, me, sessionId }
      })

    /**
     * An admin's batch: it writes only if, as it commits, the caller still
     * administers the workspace and the workspace is neither suspended nor
     * deleted.
     */
    const adminBatch = <O = never>(
      ctx: {
        readonly workspace: WorkspaceRow
        readonly me: Person
        readonly sessionId: string
      },
      statements: readonly D1PreparedStatement[],
      other: (error: unknown) => O | null = () => null,
    ) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        guardedBatch(
          onAuthority(
            ctx,
            `select 1 from workspace_members m join workspaces w on w.id = m.workspace_id
             where m.workspace_id = ? and m.user_id = ? and m.role = 'admin'
               and w.deleted_at is null and w.suspended_at is null`,
            [ctx.workspace.id, ctx.me.id],
            at,
          ),
          statements,
          () => notFound(ctx.workspace.name),
          other,
        ),
      )

    const isSuperAdminId = (id: string) =>
      first<{ one: number }>(
        DB.prepare('select 1 as one from super_admins where user_id = ?').bind(
          id,
        ),
      ).pipe(Effect.map((row) => row !== null))

    const isSuperAdmin = () =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        if (caller.person === null) return false
        return yield* isSuperAdminId(caller.person.id).pipe(
          Effect.orElseSucceed(() => false),
        )
      })

    /** A super admin in a browser; anyone else learns nothing. */
    const superAdminCtx = Effect.gen(function* () {
      const who = yield* browserPerson
      if (!(yield* isSuperAdminId(who.person.id))) {
        return yield* Effect.fail(notFound(null))
      }
      return who
    })
    const superAdmin = Effect.map(superAdminCtx, (who) => who.person)

    /** A super admin's batch: it writes only while they still are one. */
    const superBatch = <O = never>(
      statements: readonly D1PreparedStatement[],
      other: (error: unknown) => O | null = () => null,
    ) =>
      Effect.gen(function* () {
        const who = yield* superAdminCtx
        const at = yield* Clock.currentTimeMillis
        return yield* guardedBatch(
          onAuthority(
            who,
            'select 1 from super_admins where user_id = ?',
            [who.person.id],
            at,
          ),
          statements,
          () => notFound(null),
          other,
        )
      })

    const saveSetting = (key: SettingKey, value: unknown, by: string) =>
      Effect.map(Clock.currentTimeMillis, (at) =>
        DB.prepare(
          `insert into deployment_settings (key, value_json, updated_by, updated_at)
           values (?, ?, ?, ?)
           on conflict (key) do update set value_json = excluded.value_json,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        ).bind(key, JSON.stringify(value), by, at),
      )

    const runSaved = (statements: readonly D1PreparedStatement[]) =>
      superBatch(statements).pipe(Effect.tap(() => Effect.sync(settingsSaved)))

    const mayCreateWorkspace = () =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const me = caller.person
        if (me === null) return false
        if (yield* isSuperAdmin()) return true
        const current = yield* settings.current().pipe(Effect.orDie)
        switch (current.workspaceCreation) {
          case 'anyone':
            return true
          case 'super_admins':
            return false
          case 'listed': {
            // The person's current email, as the deployment holds it.
            const row = yield* first<{ email: string }>(
              DB.prepare(
                'select lower(email) as email from "user" where id = ?',
              ).bind(me.id),
            ).pipe(Effect.orDie)
            const email = row?.email ?? me.email.toLowerCase()
            const domain = email.slice(email.lastIndexOf('@') + 1)
            const listed = yield* first<{ one: number }>(
              DB.prepare(
                `select 1 as one from workspace_creators
                 where (kind = 'email' and entry = ?) or (kind = 'domain' and entry = ?)`,
              ).bind(email, domain),
            ).pipe(Effect.orDie)
            return listed !== null
          }
        }
      })

    const createWorkspace = ({ name }: { readonly name: string }) =>
      Effect.gen(function* () {
        const { person: me, via } = yield* person
        const trimmed = name.trim()
        if (!(yield* mayCreateWorkspace())) {
          return yield* Effect.fail(
            dossierError(
              'forbidden',
              'Only the people this deployment allows can create workspaces.',
              'Ask a super admin of this deployment.',
            ),
          )
        }
        if (via.kind === 'agent' && via.readOnly) {
          return yield* Effect.fail(dossierError('forbidden'))
        }
        if (RESERVED_WORKSPACE_NAMES.has(trimmed)) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `"${trimmed}" is reserved.`,
              'Choose another name.',
              'name',
            ),
          )
        }
        if (!isWorkspaceName(trimmed)) {
          return yield* Effect.fail(
            dossierError('invalid', NAME_RULE, 'Choose another name.', 'name'),
          )
        }
        const at = yield* Clock.currentTimeMillis
        const workspace = {
          id: newId() as WorkspaceId,
          name: trimmed,
          createdBy: me.id,
          createdAt: at,
          suspendedAt: null,
          deletedAt: null,
        } satisfies WorkspaceRow
        yield* Effect.tryPromise({
          try: () =>
            database.batch([
              database.insert(schema.workspaces).values(workspace),
              database.insert(schema.workspaceMembers).values({
                workspaceId: workspace.id,
                userId: me.id,
                role: 'admin',
                createdAt: at,
              }),
            ]),
          catch: (error) =>
            isUnique(error)
              ? dossierError(
                  'conflict',
                  `The name ${trimmed} is taken.`,
                  'Choose another name.',
                  'name',
                )
              : unavailable(error),
        })
        return workspace
      })

    const myWorkspaces = () =>
      Effect.gen(function* () {
        const { person: me } = yield* person
        const rows = yield* query(() =>
          database
            .select({
              workspace: schema.workspaces,
              role: schema.workspaceMembers.role,
            })
            .from(schema.workspaceMembers)
            .innerJoin(
              schema.workspaces,
              eq(schema.workspaces.id, schema.workspaceMembers.workspaceId),
            )
            .where(
              and(
                eq(schema.workspaceMembers.userId, me.id),
                isNull(schema.workspaces.deletedAt),
              ),
            )
            .orderBy(asc(schema.workspaces.name))
            .all(),
        )
        return rows.map((row): Membership => {
          const role = row.role === 'admin' ? 'admin' : 'member'
          return {
            workspace: row.workspace as WorkspaceRow,
            role,
            basis: {
              kind: role,
              workspaceId: row.workspace.id as WorkspaceId,
              userId: me.id as PersonId,
            },
          }
        })
      })

    const myTeams: PeopleService['myTeams'] = () =>
      Effect.gen(function* () {
        const { person: me } = yield* person
        const rows = yield* all<{ workspace: string; name: string }>(
          DB.prepare(
            `select w.name as workspace, t.name from team_members tm
             join teams t on t.id = tm.team_id
             join workspaces w on w.id = t.workspace_id
             where tm.user_id = ? and w.deleted_at is null`,
          ).bind(me.id),
        )
        const out = new Map<string, string[]>()
        for (const row of [...rows].sort(byName)) {
          out.set(row.workspace, [...(out.get(row.workspace) ?? []), row.name])
        }
        return out
      })

    const trees = (workspace: WorkspaceRow) =>
      Effect.gen(function* () {
        const { person: me } = yield* person
        const member = yield* query(() =>
          database
            .select({ role: schema.workspaceMembers.role })
            .from(schema.workspaceMembers)
            .where(
              and(
                eq(schema.workspaceMembers.workspaceId, workspace.id),
                eq(schema.workspaceMembers.userId, me.id),
              ),
            )
            .get(),
        )
        if (member === undefined || workspace.deletedAt !== null) {
          return yield* Effect.fail(
            dossierError(
              'not_found',
              'Nothing is here, or you cannot open it.',
              null,
              workspace.name,
            ),
          )
        }
        const rows = yield* query(() =>
          database
            .select({ tree: schema.trees, root: schema.nodes })
            .from(schema.trees)
            .innerJoin(
              schema.nodes,
              eq(schema.nodes.id, schema.trees.rootNodeId),
            )
            .where(
              and(
                eq(schema.trees.workspaceId, workspace.id),
                isNull(schema.trees.deletedAt),
              ),
            )
            .orderBy(asc(schema.trees.name))
            .all(),
        )
        const result: { tree: TreeRow; sharing: TreeSharing }[] = []
        for (const row of rows) {
          const roles = yield* access.roleOn(row.root as NodeRow)
          if (!roles.caps.has('read') && !roles.caps.has('read-authored')) {
            continue
          }
          const tree = row.tree as TreeRow
          const shares = yield* query(() =>
            database
              .select({
                targetKind: schema.shares.targetKind,
                target: schema.shares.target,
                createdBy: schema.shares.createdBy,
              })
              .from(schema.shares)
              .where(eq(schema.shares.nodeId, tree.rootNodeId))
              .all(),
          )
          const creator = yield* query(() =>
            database
              .select({ email: schema.user.email })
              .from(schema.user)
              .where(eq(schema.user.id, tree.createdBy))
              .get(),
          )
          const people = shares.filter(
            (s) =>
              s.targetKind === 'email' &&
              s.target !== creator?.email.toLowerCase(),
          ).length
          const sharing: TreeSharing = shares.some(
            (s) => s.targetKind === 'anyone',
          )
            ? { kind: 'public' }
            : shares.some((s) => s.targetKind === 'workspace')
              ? { kind: 'workspace' }
              : people > 0
                ? { kind: 'people', count: people }
                : { kind: 'private' }
          result.push({ tree, sharing })
        }
        return result
      })

    const sharedWith = (node: NodeRow) =>
      Effect.gen(function* () {
        const paths = ancestorPaths(node.path)
        const rows = yield* query(() =>
          bindings.DB.prepare(
            `select s.target_kind as targetKind, s.target from shares s
               join nodes a on a.id = s.node_id and a.deleted_at is null
             where s.tree_id = ? and a.path in (${paths.map(() => '?').join(', ')})
             order by s.created_at, s.target`,
          )
            .bind(node.treeId, ...paths)
            .all<{ targetKind: string; target: string }>(),
        )
        return rows.results
      })

    // Members and invitations.

    /** Each member's teams in the workspace, by person. */
    const teamsByPerson = (workspaceId: string) =>
      all<{ userId: string; id: TeamId; name: string }>(
        DB.prepare(
          `select tm.user_id as userId, t.id, t.name from team_members tm
           join teams t on t.id = tm.team_id where t.workspace_id = ?`,
        ).bind(workspaceId),
      ).pipe(
        Effect.map((rows) => {
          const out = new Map<string, TeamRef[]>()
          for (const row of rows) {
            const list = out.get(row.userId) ?? []
            list.push({ id: row.id, name: row.name })
            out.set(row.userId, list)
          }
          for (const list of out.values()) list.sort(byName)
          return out
        }),
      )

    const teamsOf = (workspaceId: string) =>
      all<{ id: TeamId; name: string; members: number }>(
        DB.prepare(
          `select t.id, t.name,
             (select count(*) from team_members tm where tm.team_id = t.id) as members
           from teams t where t.workspace_id = ?`,
        ).bind(workspaceId),
      ).pipe(Effect.map((rows): TeamSummary[] => [...rows].sort(byName)))

    const members: PeopleService['members'] = (name) =>
      Effect.gen(function* () {
        const { workspace, me } = yield* adminOf(name, { reads: true })
        const rows = yield* all<PersonRaw & { role: string }>(
          DB.prepare(
            `select u.id, u.email, u.name, u.image, m.role from workspace_members m
             join "user" u on u.id = m.user_id where m.workspace_id = ?
             order by u.email`,
          ).bind(workspace.id),
        )
        const teams = yield* teamsByPerson(workspace.id)
        const named = new Map(
          (yield* teamsOf(workspace.id)).map((t) => [t.id as string, t.name]),
        )
        const invited = yield* all<{
          email: string
          teamIdsJson: string
          invitedBy: string
          createdAt: number
        }>(
          DB.prepare(
            `select i.email, i.team_ids_json as teamIdsJson, u.email as invitedBy,
               i.created_at as createdAt
             from invitations i join "user" u on u.id = i.invited_by
             where i.workspace_id = ? order by i.created_at`,
          ).bind(workspace.id),
        )
        const memberRows = rows.map((row): MemberRow => ({
          person: personOf(row),
          role: row.role === 'admin' ? 'admin' : 'member',
          teams: teams.get(row.id) ?? [],
          isMe: row.id === me.id,
        }))
        // You first, then admins, then everyone by email.
        memberRows.sort(
          (a, b) =>
            Number(b.isMe) - Number(a.isMe) ||
            Number(b.role === 'admin') - Number(a.role === 'admin') ||
            a.person.email.localeCompare(b.person.email),
        )
        return {
          workspace,
          members: memberRows,
          invitations: invited.map((row): InvitationRow => ({
            email: row.email,
            teams: (JSON.parse(row.teamIdsJson) as string[]).flatMap((id) => {
              const teamName = named.get(id)
              return teamName === undefined
                ? []
                : [{ id: id as TeamId, name: teamName }]
            }),
            invitedBy: row.invitedBy,
            createdAt: row.createdAt,
          })),
        }
      })

    const invite: PeopleService['invite'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        const { workspace, me } = ctx
        const email = i.email.trim().toLowerCase()
        if (!EMAIL.test(email) || email.length > 254) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'Write an email address, such as sara@acme.com.',
              null,
              'email',
            ),
          )
        }
        const teamIds = [...new Set(i.teamIds)]
        if (teamIds.length > 0) {
          const found = yield* all<{ id: string }>(
            DB.prepare(
              `select id from teams where workspace_id = ?
                 and id in (select value from json_each(?))`,
            ).bind(workspace.id, JSON.stringify(teamIds)),
          )
          if (found.length !== teamIds.length) {
            return yield* Effect.fail(
              dossierError(
                'invalid',
                `Choose teams of ${workspace.name}.`,
                null,
                'teams',
              ),
            )
          }
        }
        const already = () =>
          dossierError(
            'conflict',
            `${email} is already a member.`,
            null,
            'email',
          )
        const member = yield* first<{ one: number }>(
          DB.prepare(
            `select 1 as one from workspace_members m join "user" u on u.id = m.user_id
             where m.workspace_id = ? and u.email = ?`,
          ).bind(workspace.id, email),
        )
        if (member !== null) return yield* Effect.fail(already())
        const at = yield* Clock.currentTimeMillis
        // Decided in the batch: someone who signed in and has not deleted
        // their account joins at once; anyone else is invited.
        const joined = `exists (select 1 from workspace_members m join "user" u on u.id = m.user_id
          where m.workspace_id = ?1 and u.email = ?2)`
        const results = yield* adminBatch(
          ctx,
          [
            DB.prepare(
              `insert into workspace_members (workspace_id, user_id, role, created_at)
               select ?1, u.id, 'member', ?3 from "user" u
               join people p on p.user_id = u.id and p.deleted_at is null
               where u.email = ?2`,
            ).bind(workspace.id, email, at),
            DB.prepare(
              `insert into team_members (team_id, user_id, created_at)
               select t.id, m.user_id, ?3 from teams t
               join workspace_members m on m.workspace_id = t.workspace_id
               join "user" u on u.id = m.user_id and u.email = ?2
               where t.workspace_id = ?1 and t.id in (select value from json_each(?4))
               on conflict do nothing`,
            ).bind(workspace.id, email, at, JSON.stringify(teamIds)),
            DB.prepare(
              `insert into invitations (workspace_id, email, team_ids_json, invited_by, created_at)
               select ?1, ?2, ?4, ?5, ?3 where not ${joined}
               on conflict (workspace_id, email) do update set
                 team_ids_json = excluded.team_ids_json, invited_by = excluded.invited_by,
                 created_at = excluded.created_at`,
            ).bind(workspace.id, email, at, JSON.stringify(teamIds), me.id),
            DB.prepare(
              `delete from invitations where workspace_id = ?1 and email = ?2 and ${joined}`,
            ).bind(workspace.id, email),
            DB.prepare(`select ${joined} as joined`).bind(workspace.id, email),
          ],
          (error) => (isUnique(error) ? already() : null),
        )
        const row = results[4]?.results[0] as { joined: number } | undefined
        return { joined: row?.joined === 1 }
      })

    const cancelInvitation: PeopleService['cancelInvitation'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        yield* adminBatch(ctx, [
          DB.prepare(
            'delete from invitations where workspace_id = ? and email = ?',
          ).bind(ctx.workspace.id, i.email.trim().toLowerCase()),
        ])
      })

    /** A member's row in the workspace, or not_found. */
    const memberOf = (workspace: WorkspaceRow, userId: string) =>
      Effect.gen(function* () {
        const row = yield* first<{ role: string }>(
          DB.prepare(
            'select role from workspace_members where workspace_id = ? and user_id = ?',
          ).bind(workspace.id, userId),
        )
        if (row === null) return yield* Effect.fail(notFound(workspace.name))
        return row
      })

    /** A membership change that must leave the workspace an admin. */
    const guarded = (
      workspace: WorkspaceRow,
      statements: readonly D1PreparedStatement[],
    ) =>
      Effect.tryPromise({
        try: () =>
          DB.batch([...statements, ...keepsAdmin(DB, newId(), workspace.id)]),
        catch: (error) =>
          isAdminsGuard(error) ? lastAdmin(workspace.name) : unavailable(error),
      })

    /** The membership and its places in the workspace's teams go. */
    const leaving = (workspace: WorkspaceRow, userId: string) => [
      DB.prepare(
        `delete from team_members where user_id = ?
           and team_id in (select id from teams where workspace_id = ?)`,
      ).bind(userId, workspace.id),
      DB.prepare(
        'delete from workspace_members where workspace_id = ? and user_id = ?',
      ).bind(workspace.id, userId),
    ]

    /** An admin's membership change, which must leave the workspace an admin. */
    const adminGuarded = (
      ctx: {
        readonly workspace: WorkspaceRow
        readonly me: Person
        readonly sessionId: string
      },
      statements: readonly D1PreparedStatement[],
    ) =>
      adminBatch(
        ctx,
        [...statements, ...keepsAdmin(DB, newId(), ctx.workspace.id)],
        (error) =>
          isAdminsGuard(error) ? lastAdmin(ctx.workspace.name) : null,
      )

    const setRole: PeopleService['setRole'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        yield* memberOf(ctx.workspace, i.userId)
        const role = i.role === 'admin' ? 'admin' : 'member'
        yield* adminGuarded(ctx, [
          DB.prepare(
            'update workspace_members set role = ? where workspace_id = ? and user_id = ?',
          ).bind(role, ctx.workspace.id, i.userId),
        ])
      })

    const removeMember: PeopleService['removeMember'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        yield* memberOf(ctx.workspace, i.userId)
        yield* adminGuarded(ctx, leaving(ctx.workspace, i.userId))
      })

    const leave: PeopleService['leave'] = (i) =>
      Effect.gen(function* () {
        const { person: me } = yield* browserPerson
        const workspace = yield* workspaceNamed(i.workspace)
        if (workspace === null) {
          return yield* Effect.fail(notFound(i.workspace))
        }
        yield* memberOf(workspace, me.id)
        yield* guarded(workspace, leaving(workspace, me.id))
      })

    // Teams.

    const teams: PeopleService['teams'] = (name) =>
      Effect.gen(function* () {
        const { workspace } = yield* adminOf(name, { reads: true })
        return yield* teamsOf(workspace.id)
      })

    const teamIn = (workspace: WorkspaceRow, teamId: TeamId) =>
      Effect.gen(function* () {
        const row = yield* first<{ id: TeamId; name: string }>(
          DB.prepare(
            'select id, name from teams where id = ? and workspace_id = ?',
          ).bind(teamId, workspace.id),
        )
        if (row === null) return yield* Effect.fail(notFound(workspace.name))
        return row
      })

    const team: PeopleService['team'] = (i) =>
      Effect.gen(function* () {
        const { workspace, me } = yield* adminOf(i.workspace, { reads: true })
        const found = yield* teamIn(workspace, i.teamId)
        const everyone = yield* all<PersonRaw>(
          DB.prepare(
            `select u.id, u.email, u.name, u.image from workspace_members m
             join "user" u on u.id = m.user_id where m.workspace_id = ? order by u.email`,
          ).bind(workspace.id),
        )
        const inTeams = yield* teamsByPerson(workspace.id)
        const inThis = (id: string) =>
          (inTeams.get(id) ?? []).some((t) => t.id === found.id)
        return {
          ...found,
          members: everyone
            .filter((p) => inThis(p.id))
            .map((p) => ({
              person: personOf(p),
              otherTeams: (inTeams.get(p.id) ?? [])
                .filter((t) => t.id !== found.id)
                .map((t) => t.name),
              isMe: p.id === me.id,
            })),
          addable: everyone.filter((p) => !inThis(p.id)).map(personOf),
        } satisfies TeamDetail
      })

    const teamsForSharing: PeopleService['teamsForSharing'] = (workspace) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        if (caller.person === null) return []
        const member = yield* first<{ one: number }>(
          DB.prepare(
            'select 1 as one from workspace_members where workspace_id = ? and user_id = ?',
          ).bind(workspace.id, caller.person.id),
        )
        if (member === null) return []
        const rows = yield* teamsOf(workspace.id)
        return rows.map((t): TeamRef => ({ id: t.id, name: t.name }))
      }).pipe(Effect.orElseSucceed((): readonly TeamRef[] => []))

    const teamName = (name: string) =>
      Effect.gen(function* () {
        const trimmed = name.trim()
        if (trimmed === '' || trimmed.length > TEAM_NAME_MAX) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `A team name has 1 to ${TEAM_NAME_MAX} characters.`,
              null,
              'name',
            ),
          )
        }
        return trimmed
      })

    const nameTaken = (name: string) =>
      dossierError(
        'conflict',
        `There is already a team called ${name}.`,
        'Choose another name.',
        'name',
      )

    const createTeam: PeopleService['createTeam'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        const name = yield* teamName(i.name)
        const id = newId() as TeamId
        const at = yield* Clock.currentTimeMillis
        yield* adminBatch(
          ctx,
          [
            DB.prepare(
              `insert into teams (id, workspace_id, name, created_by, created_at)
               values (?, ?, ?, ?, ?)`,
            ).bind(id, ctx.workspace.id, name, ctx.me.id, at),
          ],
          (error) => (isUnique(error) ? nameTaken(name) : null),
        )
        return { id, name }
      })

    const renameTeam: PeopleService['renameTeam'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        yield* teamIn(ctx.workspace, i.teamId)
        const name = yield* teamName(i.name)
        yield* adminBatch(
          ctx,
          [
            DB.prepare(
              'update teams set name = ? where id = ? and workspace_id = ?',
            ).bind(name, i.teamId, ctx.workspace.id),
          ],
          (error) => (isUnique(error) ? nameTaken(name) : null),
        )
      })

    /** One tree's shares to a team go in one change, an event per share. */
    const revokeTeamShares = (
      workspace: WorkspaceRow,
      teamLabel: string,
      treeId: TreeId,
      list: readonly { readonly id: ShareId; readonly nodeId: NodeId }[],
    ) =>
      Effect.gen(function* () {
        const granted: { on: Granted<'share'>; shareId: ShareId }[] = []
        for (const share of list) {
          const node = yield* query(() =>
            database
              .select()
              .from(schema.nodes)
              .where(
                and(
                  eq(schema.nodes.id, share.nodeId),
                  isNull(schema.nodes.deletedAt),
                ),
              )
              .get(),
          )
          if (node === undefined) continue
          // An admin holds share on every node of the workspace.
          const on = yield* access
            .require('share', node as NodeRow)
            .pipe(Effect.mapError(() => notFound(workspace.name)))
          granted.push({ on, shareId: share.id })
        }
        if (granted.length === 0) return 0
        yield* store
          .change(treeId, (cs) =>
            Effect.sync(() => {
              for (const g of granted) {
                cs.revoke(g.on, g.shareId)
                cs.event({ type: 'share', path: g.on.path, node: g.on })
              }
              return {}
            }),
          )
          .pipe(
            Effect.mapError(
              (
                error,
              ): DossierError<'unavailable'> | DossierError<'conflict'> =>
                error.code === 'unavailable'
                  ? dossierError('unavailable')
                  : dossierError(
                      'conflict',
                      `Shares to ${teamLabel} changed meanwhile.`,
                      'Try again.',
                    ),
            ),
          )
        return granted.length
      })

    const deleteTeam: PeopleService['deleteTeam'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        const { workspace } = ctx
        const found = yield* teamIn(workspace, i.teamId)
        let removed = 0
        for (let tried = 1; ; tried += 1) {
          const shares = yield* all<{
            id: ShareId
            nodeId: NodeId
            treeId: TreeId
          }>(
            DB.prepare(
              `select s.id, s.node_id as nodeId, s.tree_id as treeId from shares s
               join nodes n on n.id = s.node_id and n.deleted_at is null
               where s.target_kind = 'team' and s.target = ? order by s.tree_id`,
            ).bind(found.id),
          )
          const byTree = new Map<TreeId, typeof shares>()
          for (const share of shares) {
            byTree.set(share.treeId, [
              ...(byTree.get(share.treeId) ?? []),
              share,
            ])
          }
          for (const [treeId, list] of byTree) {
            removed += yield* revokeTeamShares(
              workspace,
              found.name,
              treeId,
              list,
            )
          }
          // Shares on deleted nodes go with the team, and a share made to
          // it meanwhile stops the deletion, to be revoked on the next try.
          const guardId = newId()
          const moved = { code: 'moved' } as const
          const done = yield* adminBatch(
            ctx,
            [
              DB.prepare(
                `delete from shares where target_kind = 'team' and target = ?
                   and node_id in (select id from nodes where deleted_at is not null)`,
              ).bind(found.id),
              DB.prepare(
                `insert into change_guards (id, reason, ok)
                 select ?, 'state', not exists (select 1 from shares
                   where target_kind = 'team' and target = ?)`,
              ).bind(guardId, found.id),
              DB.prepare('delete from teams where id = ?').bind(found.id),
              DB.prepare('delete from change_guards where id = ?').bind(
                guardId,
              ),
            ],
            (error) =>
              String(error).includes('change_guard_state') ? moved : null,
          ).pipe(
            Effect.as(true),
            Effect.catchAll((error) =>
              error === moved
                ? Effect.succeed(false)
                : Effect.fail(error as Exclude<typeof error, typeof moved>),
            ),
          )
          if (done) return { sharesRemoved: removed }
          if (tried >= 3) {
            return yield* Effect.fail(
              dossierError(
                'conflict',
                `People kept sharing with ${found.name}.`,
                'Try again.',
              ),
            )
          }
        }
      })

    const notMember = (workspace: WorkspaceRow) =>
      dossierError(
        'invalid',
        `Only members of ${workspace.name} can join its teams.`,
        null,
        'person',
      )

    /** A place in a team, only for a member of its workspace. */
    const joinTeam =
      (workspace: WorkspaceRow, teamId: TeamId, at: number) =>
      (userId: string) =>
        DB.prepare(
          `insert into team_members (team_id, user_id, created_at)
           select ?1, ?2, ?3 where exists (select 1 from workspace_members
             where workspace_id = ?4 and user_id = ?2)
           on conflict do nothing`,
        ).bind(teamId, userId, at, workspace.id)

    const addToTeam: PeopleService['addToTeam'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        const { workspace } = ctx
        const found = yield* teamIn(workspace, i.teamId)
        const at = yield* Clock.currentTimeMillis
        const results = yield* adminBatch(ctx, [
          joinTeam(workspace, found.id, at)(i.userId),
          DB.prepare(
            'select 1 from team_members where team_id = ? and user_id = ?',
          ).bind(found.id, i.userId),
        ])
        if ((results[1]?.results.length ?? 0) === 0) {
          return yield* Effect.fail(notMember(workspace))
        }
      })

    const removeFromTeam: PeopleService['removeFromTeam'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        const found = yield* teamIn(ctx.workspace, i.teamId)
        yield* adminBatch(ctx, [
          DB.prepare(
            'delete from team_members where team_id = ? and user_id = ?',
          ).bind(found.id, i.userId),
        ])
      })

    const moveToTeam: PeopleService['moveToTeam'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        const { workspace } = ctx
        const from = yield* teamIn(workspace, i.from)
        const to = yield* teamIn(workspace, i.to)
        if (from.id === to.id) return
        const at = yield* Clock.currentTimeMillis
        const results = yield* adminBatch(ctx, [
          joinTeam(workspace, to.id, at)(i.userId),
          DB.prepare(
            `delete from team_members where team_id = ?1 and user_id = ?2
               and exists (select 1 from team_members where team_id = ?3 and user_id = ?2)`,
          ).bind(from.id, i.userId, to.id),
          DB.prepare(
            'select 1 from team_members where team_id = ? and user_id = ?',
          ).bind(to.id, i.userId),
        ])
        if ((results[2]?.results.length ?? 0) === 0) {
          return yield* Effect.fail(notMember(workspace))
        }
      })

    // The workspace.

    const workspaceSettings: PeopleService['workspaceSettings'] = (name) =>
      Effect.gen(function* () {
        const { workspace } = yield* adminOf(name, { reads: true })
        const current = yield* settings.current()
        return { workspace, retentionDays: current.retentionDays }
      })

    const deleteWorkspace: PeopleService['deleteWorkspace'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        const { workspace } = ctx
        if (i.confirm.trim() !== workspace.name) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `Type ${workspace.name} to confirm.`,
              null,
              'confirm',
            ),
          )
        }
        const at = yield* Clock.currentTimeMillis
        yield* adminBatch(ctx, [
          DB.prepare(
            'update workspaces set deleted_at = ? where id = ? and deleted_at is null',
          ).bind(at, workspace.id),
        ])
      })

    // The person.

    /** What stops the person deleting their account, if anything. */
    const blockerOf = (userId: string) =>
      Effect.gen(function* () {
        const lone = yield* first<{ name: string }>(
          DB.prepare(
            `select w.name from workspace_members m join workspaces w on w.id = m.workspace_id
             where m.user_id = ?1 and m.role = 'admin' and w.deleted_at is null
               and (select count(*) from workspace_members o
                      where o.workspace_id = w.id and o.role = 'admin') = 1
             order by w.name limit 1`,
          ).bind(userId),
        )
        if (lone !== null) {
          return { kind: 'last_admin', workspace: lone.name } as const
        }
        const supers = yield* first<{ mine: number; total: number }>(
          DB.prepare(
            `select exists (select 1 from super_admins where user_id = ?) as mine,
               (select count(*) from super_admins) as total`,
          ).bind(userId),
        )
        if (supers?.mine === 1 && supers.total === 1) {
          return { kind: 'last_super_admin' } as const
        }
        return null
      })

    const deletionPreview: PeopleService['deletionPreview'] = () =>
      Effect.gen(function* () {
        const { person: me } = yield* person
        const counts = yield* data.mineCounts()
        const at = yield* Clock.currentTimeMillis
        const held = yield* first<{ keys: number; sessions: number }>(
          DB.prepare(
            `select
               (select count(*) from agent_keys where user_id = ?1 and revoked_at is null) as keys,
               (select count(*) from session where user_id = ?1 and expires_at > ?2) as sessions`,
          ).bind(me.id, at),
        )
        const names = yield* all<{ name: string }>(
          DB.prepare(
            `select w.name from workspace_members m join workspaces w on w.id = m.workspace_id
             where m.user_id = ? and w.deleted_at is null order by w.name`,
          ).bind(me.id),
        )
        return {
          ...counts,
          comments: 0,
          keys: held?.keys ?? 0,
          sessions: held?.sessions ?? 0,
          workspaces: names.map((n) => n.name),
          blockedBy: yield* blockerOf(me.id),
        } satisfies DeletionPreview
      })

    const deleteAccount: PeopleService['deleteAccount'] = () =>
      Effect.gen(function* () {
        const { person: me, via } = yield* person
        if (via.kind !== 'browser') {
          return yield* Effect.fail(
            dossierError(
              'sign_in_required',
              'An account is deleted in account settings.',
              'Sign in with Google and open account settings.',
            ),
          )
        }
        const blocker = yield* blockerOf(me.id)
        if (blocker !== null) {
          return yield* Effect.fail(
            blocker.kind === 'last_admin'
              ? dossierError(
                  'last_admin',
                  `You're the last admin of ${blocker.workspace}. Hand over admin to another member first. Then you can delete your answers and account.`,
                  null,
                  blocker.workspace,
                )
              : lastSuperAdmin(),
          )
        }
        // Each step finishes what an interrupted earlier press left. The
        // closing batch holds only while nothing of theirs lives, so an
        // answer sent meanwhile is withdrawn on the next round.
        const totals = { submissions: 0, entries: 0, uploads: 0 }
        for (let tried = 1; ; tried += 1) {
          const withdrawn = yield* data.withdrawMine()
          totals.submissions += withdrawn.submissions
          totals.entries += withdrawn.entries
          totals.uploads += withdrawn.uploads
          const at = yield* Clock.currentTimeMillis
          const held = yield* first<{ keys: number; sessions: number }>(
            DB.prepare(
              `select
                 (select count(*) from agent_keys where user_id = ?1 and revoked_at is null) as keys,
                 (select count(*) from session where user_id = ?1) as sessions`,
            ).bind(me.id),
          )
          const adminsId = newId()
          const leftId = newId()
          const outcome = yield* Effect.tryPromise({
            try: () =>
              DB.batch([
                // Read before the person goes: every live workspace they
                // administer keeps another admin, and the deployment another
                // super admin if they are one.
                DB.prepare(
                  `insert into change_guards (id, reason, ok)
                   select ?1, 'admins', not exists (
                       select 1 from workspace_members m
                       join workspaces w on w.id = m.workspace_id
                       where m.user_id = ?2 and m.role = 'admin' and w.deleted_at is null
                         and not exists (select 1 from workspace_members o
                           where o.workspace_id = m.workspace_id and o.role = 'admin'
                             and o.user_id <> ?2))
                     and (not exists (select 1 from super_admins where user_id = ?2)
                       or exists (select 1 from super_admins where user_id <> ?2))`,
                ).bind(adminsId, me.id),
                DB.prepare(
                  `insert into change_guards (id, reason, ok)
                   select ?, 'state', not exists (select 1 from nodes
                     where owner_id = ? and origin = 'data' and kind = 'file'
                       and deleted_at is null)`,
                ).bind(leftId, me.id),
                DB.prepare('delete from team_members where user_id = ?').bind(
                  me.id,
                ),
                DB.prepare(
                  'delete from workspace_members where user_id = ?',
                ).bind(me.id),
                DB.prepare('delete from super_admins where user_id = ?').bind(
                  me.id,
                ),
                ...closeStatements(DB, me.id, at, {
                  ...totals,
                  keys: held?.keys ?? 0,
                  sessions: held?.sessions ?? 0,
                }),
                DB.prepare('delete from change_guards where id in (?, ?)').bind(
                  adminsId,
                  leftId,
                ),
              ]),
            catch: (error) => error,
          }).pipe(
            Effect.as('closed' as const),
            Effect.catchAll((error) =>
              isAdminsGuard(error)
                ? Effect.succeed('blocked' as const)
                : String(error).includes('change_guard_state')
                  ? Effect.succeed('answered' as const)
                  : Effect.fail(unavailable(error)),
            ),
          )
          if (outcome === 'closed') return
          if (outcome === 'blocked') {
            const now = yield* blockerOf(me.id)
            return yield* Effect.fail(
              now?.kind === 'last_super_admin'
                ? lastSuperAdmin()
                : dossierError(
                    'last_admin',
                    `You're the last admin of ${now?.kind === 'last_admin' ? now.workspace : 'a workspace'}. Hand over admin to another member first. Then you can delete your answers and account.`,
                    null,
                    now?.kind === 'last_admin' ? now.workspace : null,
                  ),
            )
          }
          if (tried >= 3) {
            return yield* Effect.fail(
              dossierError(
                'conflict',
                'New answers kept arriving while your account was being deleted.',
                'Press Delete again.',
              ),
            )
          }
        }
      })

    // Super admins.

    const adminOverview: PeopleService['adminOverview'] = () =>
      Effect.gen(function* () {
        const me = yield* superAdmin
        const current = yield* settings.current()
        const health = yield* settings.health()
        const creators = yield* all<{
          entry: string
          kind: 'email' | 'domain'
        }>(
          DB.prepare(
            'select entry, kind from workspace_creators order by kind desc, entry',
          ),
        )
        const supers = yield* all<PersonRaw & { addedBy: string | null }>(
          DB.prepare(
            `select u.id, u.email, u.name, u.image, a.email as addedBy
             from super_admins s join "user" u on u.id = s.user_id
             left join "user" a on a.id = s.added_by
             order by s.created_at, u.email`,
          ),
        )
        // Only names, member counts and sizes: never pages or data.
        const workspaces = yield* all<AdminWorkspaceRow>(
          DB.prepare(
            `select w.id, w.name, w.suspended_at as suspendedAt, w.deleted_at as deletedAt,
               (select count(*) from workspace_members m where m.workspace_id = w.id) as members,
               (select coalesce(sum(coalesce(v.size, length(v.json_value), 0)), 0)
                  from node_versions v join trees t on t.id = v.tree_id
                  where t.workspace_id = w.id) as bytes
             from workspaces w order by w.deleted_at is not null, w.name`,
          ),
        )
        return {
          deployment: config.deploymentName,
          firstRun: !current.firstRunDone,
          health,
          workspaceCreation: current.workspaceCreation,
          creators,
          limits: current.limits,
          defaults: DEFAULT_LIMITS,
          retentionDays: current.retentionDays,
          superAdmins: supers.map((row) => ({
            person: personOf(row),
            configured: config.superAdmins.has(row.email.toLowerCase()),
            addedBy: row.addedBy,
            isMe: row.id === me.id,
          })),
          workspaces,
        } satisfies AdminOverview
      })

    const setWorkspaceCreation: PeopleService['setWorkspaceCreation'] = (
      value,
    ) =>
      Effect.gen(function* () {
        const me = yield* superAdmin
        if (!CREATIONS.has(value)) {
          return yield* Effect.fail(
            dossierError('invalid', 'Choose who may create workspaces.'),
          )
        }
        const current = yield* settings.current()
        const at = yield* Clock.currentTimeMillis
        const save = yield* saveSetting('workspace_creation', value, me.id)
        // The first choice of listed people lists the one who made it.
        const listSelf =
          !current.firstRunDone && value === 'listed'
            ? [
                DB.prepare(
                  `insert into workspace_creators (entry, kind, added_by, created_at)
                   values (?, 'email', ?, ?) on conflict do nothing`,
                ).bind(me.email.toLowerCase(), me.id, at),
              ]
            : []
        yield* runSaved([save, ...listSelf])
      })

    const addCreator: PeopleService['addCreator'] = (entry) =>
      Effect.gen(function* () {
        const me = yield* superAdmin
        const value = entry.trim().toLowerCase().replace(/^@/, '')
        const kind = value.includes('@')
          ? EMAIL.test(value)
            ? 'email'
            : null
          : DOMAIN.test(value)
            ? 'domain'
            : null
        if (kind === null) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'Write an email such as sara@acme.com, or a domain such as acme.com.',
              null,
              'entry',
            ),
          )
        }
        const at = yield* Clock.currentTimeMillis
        yield* superBatch([
          DB.prepare(
            `insert into workspace_creators (entry, kind, added_by, created_at)
             values (?, ?, ?, ?) on conflict do nothing`,
          ).bind(value, kind, me.id, at),
        ])
      })

    const removeCreator: PeopleService['removeCreator'] = (entry) =>
      Effect.gen(function* () {
        yield* superBatch([
          DB.prepare('delete from workspace_creators where entry = ?').bind(
            entry.trim().toLowerCase(),
          ),
        ])
      })

    const setLimits: PeopleService['setLimits'] = (input) =>
      Effect.gen(function* () {
        const me = yield* superAdmin
        const clear = DB.prepare(
          "delete from deployment_settings where key = 'limits'",
        )
        if (input === 'defaults') {
          yield* runSaved([clear])
          return DEFAULT_LIMITS
        }
        const decoded = yield* Schema.decodeUnknown(LimitValuesSchema)(
          input,
        ).pipe(
          Effect.mapError(() =>
            dossierError('invalid', 'Each limit is a whole number above 0.'),
          ),
        )
        const current = yield* settings.current()
        const next: LimitValues = { ...current.limits, ...decoded }
        // Only values that differ from the defaults are kept.
        const saved = Object.fromEntries(
          Object.entries(next).filter(
            ([field, value]) =>
              DEFAULT_LIMITS[field as keyof LimitValues] !== value,
          ),
        )
        yield* runSaved(
          Object.keys(saved).length === 0
            ? [clear]
            : [yield* saveSetting('limits', saved, me.id)],
        )
        return next
      })

    const setRetention: PeopleService['setRetention'] = (days) =>
      Effect.gen(function* () {
        const me = yield* superAdmin
        if (!Number.isInteger(days) || days < 1 || days > 365) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'The retention period is 1 to 365 days.',
              null,
              'days',
            ),
          )
        }
        yield* runSaved([yield* saveSetting('retention_days', days, me.id)])
      })

    const addSuperAdmin: PeopleService['addSuperAdmin'] = (email) =>
      Effect.gen(function* () {
        const me = yield* superAdmin
        const address = email.trim().toLowerCase()
        const found = yield* first<{ id: string }>(
          DB.prepare(
            `select u.id from "user" u join people p on p.user_id = u.id
             where u.email = ? and p.deleted_at is null`,
          ).bind(address),
        )
        if (found === null) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `${address} hasn't signed in to ${config.deploymentName} yet. Ask them to sign in once, then add them.`,
              null,
              'email',
            ),
          )
        }
        const at = yield* Clock.currentTimeMillis
        // Only someone still signed up, decided in the batch.
        yield* superBatch([
          DB.prepare(
            `insert into super_admins (user_id, added_by, created_at)
             select ?1, ?2, ?3 where exists (select 1 from people
               where user_id = ?1 and deleted_at is null)
             on conflict do nothing`,
          ).bind(found.id, me.id, at),
        ])
      })

    const removeSuperAdmin: PeopleService['removeSuperAdmin'] = (userId) =>
      Effect.gen(function* () {
        const guardId = newId()
        yield* superBatch(
          [
            DB.prepare('delete from super_admins where user_id = ?').bind(
              userId,
            ),
            DB.prepare(
              `insert into change_guards (id, reason, ok)
               select ?, 'admins', (select count(*) from super_admins) >= 1`,
            ).bind(guardId),
            DB.prepare('delete from change_guards where id = ?').bind(guardId),
          ],
          (error) => (isAdminsGuard(error) ? lastSuperAdmin() : null),
        )
      })

    /** Sets or clears a workspace's suspension; not_found if nothing moved. */
    const mark = (statement: (at: number) => D1PreparedStatement) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const [result] = yield* superBatch([statement(at)])
        if ((result?.meta.changes ?? 0) === 0) {
          return yield* Effect.fail(notFound(null))
        }
      })

    const suspendWorkspace: PeopleService['suspendWorkspace'] = (id) =>
      mark((at) =>
        DB.prepare(
          `update workspaces set suspended_at = coalesce(suspended_at, ?)
           where id = ? and deleted_at is null`,
        ).bind(at, id),
      )

    const liftSuspension: PeopleService['liftSuspension'] = (id) =>
      mark(() =>
        DB.prepare(
          'update workspaces set suspended_at = null where id = ? and deleted_at is null',
        ).bind(id),
      )

    const restoreWorkspace: PeopleService['restoreWorkspace'] = (id) =>
      Effect.gen(function* () {
        yield* superAdmin
        const row = yield* first<{ name: string; deletedAt: number | null }>(
          DB.prepare(
            'select name, deleted_at as deletedAt from workspaces where id = ?',
          ).bind(id),
        )
        if (row === null || row.deletedAt === null) {
          return yield* Effect.fail(notFound(null))
        }
        const { retentionDays } = yield* settings.current()
        const at = yield* Clock.currentTimeMillis
        if (row.deletedAt < at - retentionDays * DAY) {
          return yield* Effect.fail(
            dossierError(
              'conflict',
              `${row.name} was deleted more than ${retentionDays} days ago.`,
              null,
            ),
          )
        }
        // It comes back only with an admin, who keeps a write holder on
        // every tree; within the retention period as the batch sees it.
        const [restored] = yield* superBatch([
          DB.prepare(
            `update workspaces set deleted_at = null
             where id = ?1 and deleted_at is not null and deleted_at >= ?2
               and exists (select 1 from workspace_members m
                 join people p on p.user_id = m.user_id and p.deleted_at is null
                 where m.workspace_id = ?1 and m.role = 'admin')`,
          ).bind(id, at - retentionDays * DAY),
        ])
        if ((restored?.meta.changes ?? 0) === 0) {
          return yield* Effect.fail(
            dossierError(
              'conflict',
              `${row.name} has no admin left, so it cannot be restored.`,
              null,
            ),
          )
        }
      })

    return {
      mayCreateWorkspace,
      createWorkspace,
      myWorkspaces,
      myTeams,
      trees,
      sharedWith,
      members,
      invite,
      cancelInvitation,
      setRole,
      removeMember,
      leave,
      teams,
      team,
      teamsForSharing,
      createTeam,
      renameTeam,
      deleteTeam,
      addToTeam,
      removeFromTeam,
      moveToTeam,
      workspaceSettings,
      deleteWorkspace,
      deletionPreview,
      deleteAccount,
      isSuperAdmin,
      adminOverview,
      setWorkspaceCreation,
      addCreator,
      removeCreator,
      setLimits,
      setRetention,
      addSuperAdmin,
      removeSuperAdmin,
      suspendWorkspace,
      liftSuspension,
      restoreWorkspace,
    } satisfies PeopleService
  }),
)
