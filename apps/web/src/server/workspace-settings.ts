import type { PersonId, TeamId } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import {
  CurrentCaller,
  People,
  type InvitationRow,
  type MemberRow,
  type TeamDetail,
  type TeamRef,
  type TeamSummary,
  type WorkspaceRole,
} from '../core/index.ts'
import { menuOf, type WorkspaceMenuItem } from './home.ts'
import { runScreen } from './run.ts'

/** What every workspace settings tab shows above itself. */
export interface SettingsHeader {
  readonly email: string
  readonly workspace: string
  /** The person's workspaces, for the workspace menu. */
  readonly workspaces: readonly WorkspaceMenuItem[]
}

export interface MembersView {
  readonly workspace: string
  readonly members: readonly MemberRow[]
  readonly invitations: readonly InvitationRow[]
  readonly teams: readonly TeamRef[]
}

export interface TeamsView {
  readonly workspace: string
  readonly teams: readonly TeamSummary[]
}

export interface TeamView {
  readonly workspace: string
  readonly team: TeamDetail
  /** The workspace's other teams, where a member can move to. */
  readonly otherTeams: readonly TeamRef[]
}

export interface WorkspaceView {
  readonly workspace: string
  readonly retentionDays: number
}

const workspaceOf = (input: { readonly workspace: string }) => ({
  workspace: String(input.workspace),
})

/** Answers `not_found` to anyone who is not an admin of the workspace. */
export const settingsHeader = createServerFn({ method: 'GET' })
  .validator(workspaceOf)
  .handler(({ data }) =>
    runScreen(
      Effect.gen(function* () {
        const people = yield* People
        const { workspace } = yield* people.workspaceSettings(data.workspace)
        const { person } = yield* CurrentCaller
        return {
          email: person?.email ?? '',
          workspace: workspace.name,
          workspaces: menuOf(yield* people.myWorkspaces()),
        } satisfies SettingsHeader
      }),
    ),
  )

export const membersView = createServerFn({ method: 'GET' })
  .validator(workspaceOf)
  .handler(({ data }) =>
    runScreen(
      Effect.gen(function* () {
        const people = yield* People
        const { workspace, members, invitations } = yield* people.members(
          data.workspace,
        )
        const teams = yield* people.teams(data.workspace)
        return {
          workspace: workspace.name,
          members,
          invitations,
          teams: teams.map(({ id, name }) => ({ id, name })),
        } satisfies MembersView
      }),
    ),
  )

export const invite = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      readonly workspace: string
      readonly email: string
      readonly teamIds: readonly string[]
    }) => ({
      workspace: String(input.workspace),
      email: String(input.email),
      teamIds: Array.isArray(input.teamIds)
        ? input.teamIds.map((id) => String(id) as TeamId)
        : [],
    }),
  )
  .handler(({ data }) =>
    runScreen(Effect.flatMap(People, (people) => people.invite(data))),
  )

export const cancelInvitation = createServerFn({ method: 'POST' })
  .validator(
    (input: { readonly workspace: string; readonly email: string }) => ({
      workspace: String(input.workspace),
      email: String(input.email),
    }),
  )
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(People, (people) => people.cancelInvitation(data)),
    ),
  )

export const setRole = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      readonly workspace: string
      readonly userId: string
      readonly role: WorkspaceRole
    }) => ({
      workspace: String(input.workspace),
      userId: String(input.userId) as PersonId,
      role: (input.role === 'admin' ? 'admin' : 'member') as WorkspaceRole,
    }),
  )
  .handler(({ data }) =>
    runScreen(Effect.flatMap(People, (people) => people.setRole(data))),
  )

const memberOf = (input: {
  readonly workspace: string
  readonly userId: string
}) => ({
  workspace: String(input.workspace),
  userId: String(input.userId) as PersonId,
})

export const removeMember = createServerFn({ method: 'POST' })
  .validator(memberOf)
  .handler(({ data }) =>
    runScreen(Effect.flatMap(People, (people) => people.removeMember(data))),
  )

export const teamsView = createServerFn({ method: 'GET' })
  .validator(workspaceOf)
  .handler(({ data }) =>
    runScreen(
      Effect.gen(function* () {
        const people = yield* People
        return {
          workspace: data.workspace,
          teams: yield* people.teams(data.workspace),
        } satisfies TeamsView
      }),
    ),
  )

const teamOf = (input: {
  readonly workspace: string
  readonly teamId: string
}) => ({
  workspace: String(input.workspace),
  teamId: String(input.teamId) as TeamId,
})

export const teamView = createServerFn({ method: 'GET' })
  .validator(teamOf)
  .handler(({ data }) =>
    runScreen(
      Effect.gen(function* () {
        const people = yield* People
        const team = yield* people.team(data)
        const teams = yield* people.teams(data.workspace)
        return {
          workspace: data.workspace,
          team,
          otherTeams: teams
            .filter(({ id }) => id !== team.id)
            .map(({ id, name }) => ({ id, name })),
        } satisfies TeamView
      }),
    ),
  )

export const createTeam = createServerFn({ method: 'POST' })
  .validator(
    (input: { readonly workspace: string; readonly name: string }) => ({
      workspace: String(input.workspace),
      name: String(input.name),
    }),
  )
  .handler(({ data }) =>
    runScreen(Effect.flatMap(People, (people) => people.createTeam(data))),
  )

export const renameTeam = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      readonly workspace: string
      readonly teamId: string
      readonly name: string
    }) => ({ ...teamOf(input), name: String(input.name) }),
  )
  .handler(({ data }) =>
    runScreen(Effect.flatMap(People, (people) => people.renameTeam(data))),
  )

export const deleteTeam = createServerFn({ method: 'POST' })
  .validator(teamOf)
  .handler(({ data }) =>
    runScreen(Effect.flatMap(People, (people) => people.deleteTeam(data))),
  )

const teamMemberOf = (input: {
  readonly workspace: string
  readonly teamId: string
  readonly userId: string
}) => ({ ...teamOf(input), userId: String(input.userId) as PersonId })

export const addToTeam = createServerFn({ method: 'POST' })
  .validator(teamMemberOf)
  .handler(({ data }) =>
    runScreen(Effect.flatMap(People, (people) => people.addToTeam(data))),
  )

export const removeFromTeam = createServerFn({ method: 'POST' })
  .validator(teamMemberOf)
  .handler(({ data }) =>
    runScreen(Effect.flatMap(People, (people) => people.removeFromTeam(data))),
  )

export const moveToTeam = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      readonly workspace: string
      readonly from: string
      readonly to: string
      readonly userId: string
    }) => ({
      workspace: String(input.workspace),
      from: String(input.from) as TeamId,
      to: String(input.to) as TeamId,
      userId: String(input.userId) as PersonId,
    }),
  )
  .handler(({ data }) =>
    runScreen(Effect.flatMap(People, (people) => people.moveToTeam(data))),
  )

export const workspaceView = createServerFn({ method: 'GET' })
  .validator(workspaceOf)
  .handler(({ data }) =>
    runScreen(
      Effect.gen(function* () {
        const people = yield* People
        const { workspace, retentionDays } = yield* people.workspaceSettings(
          data.workspace,
        )
        return {
          workspace: workspace.name,
          retentionDays,
        } satisfies WorkspaceView
      }),
    ),
  )

export const deleteWorkspace = createServerFn({ method: 'POST' })
  .validator(
    (input: { readonly workspace: string; readonly confirm: string }) => ({
      workspace: String(input.workspace),
      confirm: String(input.confirm),
    }),
  )
  .handler(({ data }) =>
    runScreen(Effect.flatMap(People, (people) => people.deleteWorkspace(data))),
  )
