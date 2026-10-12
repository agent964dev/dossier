import { dossierError, parseTarget, type AgentKeyId } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import {
  Config,
  CurrentCaller,
  People,
  SignIn,
  type AgentKeyView,
  type DeletionPreview,
  type KeyReach,
} from '../core/index.ts'
import { isScreenFailure } from './failure.ts'
import { endSessionCookie, runScreen } from './run.ts'

export interface WorkspaceRowView {
  readonly name: string
  readonly role: 'admin' | 'member'
  /** The person's teams in it, by name. */
  readonly teams: readonly string[]
}

export interface AccountView {
  readonly email: string
  readonly name: string
  readonly keys: readonly AgentKeyView[]
  readonly workspaces: readonly WorkspaceRowView[]
  /** Whether "Create workspace" is offered. */
  readonly mayCreateWorkspace: boolean
  /** The trees a new key may be limited to, as `workspace/tree/`. */
  readonly trees: readonly string[]
}

export const accountView = createServerFn({ method: 'GET' }).handler(() =>
  runScreen(
    Effect.gen(function* () {
      const signIn = yield* SignIn
      const people = yield* People
      const keys = yield* signIn.keys()
      const { person } = yield* CurrentCaller
      const memberships = yield* people.myWorkspaces()
      const teams = yield* people.myTeams()
      const trees: string[] = []
      for (const membership of memberships) {
        for (const { tree } of yield* people
          .trees(membership.workspace)
          .pipe(Effect.orElseSucceed(() => []))) {
          trees.push(`${membership.workspace.name}/${tree.name}/`)
        }
      }
      return {
        email: person?.email ?? '',
        name: person?.name ?? '',
        keys,
        workspaces: memberships.map((m) => ({
          name: m.workspace.name,
          role: m.role,
          teams: teams.get(m.workspace.name) ?? [],
        })),
        mayCreateWorkspace: yield* people.mayCreateWorkspace(),
        trees,
      } satisfies AccountView
    }),
  ),
)

export interface NewKeyInput {
  readonly name: string
  /** Null for everything; otherwise `workspace/tree[/path]`. */
  readonly reach: string | null
  readonly readOnly: boolean
}

export const createKey = createServerFn({ method: 'POST' })
  .validator((input: NewKeyInput) => ({
    name: String(input.name),
    reach: input.reach === null ? null : String(input.reach),
    readOnly: input.readOnly === true,
  }))
  .handler(({ data }) =>
    runScreen(
      Effect.gen(function* () {
        const config = yield* Config
        let reach: KeyReach = { kind: 'everything' }
        if (data.reach !== null) {
          const ref = parseTarget(data.reach, config.origin)
          if (ref === null) {
            return yield* Effect.fail(
              dossierError(
                'invalid',
                `"${data.reach}" is not a path in a tree.`,
                'Write it as workspace/tree/path, such as agent964/acme/plans/.',
                'reach',
              ),
            )
          }
          reach = { kind: 'node', ref }
        }
        const signIn = yield* SignIn
        return yield* signIn.createKey({
          name: data.name,
          reach,
          readOnly: data.readOnly,
        })
      }),
    ),
  )

export const createWorkspace = createServerFn({ method: 'POST' })
  .validator((input: { readonly name: string }) => ({
    name: String(input.name),
  }))
  .handler(({ data }) =>
    runScreen(
      Effect.gen(function* () {
        const people = yield* People
        const workspace = yield* people.createWorkspace(data)
        return { name: workspace.name }
      }),
    ),
  )

export const revokeKey = createServerFn({ method: 'POST' })
  .validator((input: { readonly id: string }) => ({ id: String(input.id) }))
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(SignIn, (signIn) =>
        signIn.revokeKey(data.id as AgentKeyId),
      ),
    ),
  )

export const signOutEverywhere = createServerFn({ method: 'POST' }).handler(
  () =>
    runScreen(Effect.flatMap(SignIn, (signIn) => signIn.signOutEverywhere())),
)

/** Any member; the last admin is told to hand over first. */
export const leaveWorkspace = createServerFn({ method: 'POST' })
  .validator((input: { readonly workspace: string }) => ({
    workspace: String(input.workspace),
  }))
  .handler(({ data }) =>
    runScreen(Effect.flatMap(People, (people) => people.leave(data))),
  )

/** What deleting the account removes, counted, or what blocks it. */
export const deletionPreview = createServerFn({ method: 'GET' }).handler(() =>
  runScreen<DeletionPreview>(
    Effect.flatMap(People, (people) => people.deletionPreview()),
  ),
)

/** Withdraws the person's answers and closes the account and this session. */
export const deleteAccount = createServerFn({ method: 'POST' }).handler(
  async () => {
    const result = await runScreen(
      Effect.flatMap(People, (people) => people.deleteAccount()),
    )
    if (!isScreenFailure(result)) endSessionCookie()
    return result
  },
)
