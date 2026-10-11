import {
  dossierError,
  isWorkspaceName,
  NAME_RULE,
  RESERVED_WORKSPACE_NAMES,
  type DossierError,
  type PersonId,
  type WorkspaceId,
} from '@dossier/contracts'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { Clock, Context, Effect, Layer } from 'effect'

import { db, schema } from '../db/client.ts'
import { Access, type Membership } from './access.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller } from './caller.ts'
import { newId } from './ids.ts'
import type { NodeRow, TreeRow, WorkspaceRow } from './rows.ts'
import { TreeStore } from './tree-store.ts'

export type TreeSharing =
  | { readonly kind: 'private' }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'people'; readonly count: number }
  | { readonly kind: 'public' }

export interface PeopleService {
  /** Super admins, until the deployment setting arrives. */
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
  /** The trees of a workspace the caller can open, with how each is shared. */
  readonly trees: (
    workspace: WorkspaceRow,
  ) => Effect.Effect<
    readonly { readonly tree: TreeRow; readonly sharing: TreeSharing }[],
    DossierError<'not_found' | 'sign_in_required' | 'unavailable'>,
    CurrentCaller
  >
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

export const PeopleLive: Layer.Layer<
  People,
  never,
  Bindings | Access | TreeStore
> = Layer.effect(
  People,
  Effect.gen(function* () {
    const bindings = yield* Bindings
    const access = yield* Access
    const database = db(bindings)

    const query = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: unavailable })

    const person = Effect.flatMap(CurrentCaller, (caller) =>
      caller.person === null
        ? Effect.fail(signInRequired())
        : Effect.succeed({ person: caller.person, via: caller.via }),
    )

    const mayCreateWorkspace = () =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        if (caller.person === null) return false
        const id = caller.person.id
        const row = yield* query(() =>
          database
            .select({ userId: schema.superAdmins.userId })
            .from(schema.superAdmins)
            .where(eq(schema.superAdmins.userId, id))
            .get(),
        ).pipe(Effect.orDie)
        return row !== undefined
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
            String(error).includes('UNIQUE constraint failed')
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

    return { mayCreateWorkspace, createWorkspace, myWorkspaces, trees }
  }),
)
