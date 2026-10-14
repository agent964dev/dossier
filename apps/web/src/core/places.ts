// Where the caller can work, for `dossier ls` with no tree: their
// workspaces with the trees they can open, what others shared with them,
// and a workspace's teams for its members. The home screen's rules:
// People.myWorkspaces and People.trees for a member's trees,
// Shares.sharedWithMe for shares, and nothing else for anyone. A key
// limited to a node is told only that node.
import {
  dossierError,
  isWorkspaceName,
  linkFor,
  parseTarget,
  type Can,
  type ScopePlace,
  type SharedPlace,
  type TreePlace,
  type WorkspaceResponse,
  type WorkspacesResponse,
} from '@dossier/contracts'
import { Effect } from 'effect'

import { Access, type RoleSet } from './access.ts'
import { CurrentCaller } from './caller.ts'
import { Config } from './config.ts'
import { People } from './people.ts'
import type { WorkspaceRow } from './rows.ts'
import { Shares, type SharedRow } from './shares.ts'
import { SignIn } from './sign-in.ts'
import { TreeStore } from './tree-store.ts'

const notFound = (path: string) =>
  dossierError(
    'not_found',
    'Nothing is here, or you cannot open it.',
    'Check the name, or run dossier ls to see where you can work.',
    path,
  )

const signInRequired = () =>
  dossierError(
    'sign_in_required',
    'Sign in to continue.',
    'Sign in with Google, or run dossier login.',
  )

/** What the caller's roles let them do at a node; null when nothing. */
const canOf = (roles: RoleSet): Can | null =>
  roles.caps.has('write')
    ? 'write'
    : roles.caps.has('respond')
      ? 'respond'
      : roles.caps.has('read') || roles.caps.has('read-authored')
        ? 'read'
        : null

/** The person, and what their agent key narrows, if they came with one. */
const who = Effect.gen(function* () {
  const caller = yield* CurrentCaller
  if (caller.person === null) return yield* Effect.fail(signInRequired())
  const agent = caller.via.kind === 'agent' ? caller.via : null
  return {
    person: caller.person,
    scoped: agent !== null && agent.scope !== null,
    readOnly: agent !== null && agent.readOnly,
  }
})

/** A read-only key opens, and never answers or changes. */
const narrowed = (can: Can, readOnly: boolean): Can => (readOnly ? 'read' : can)

/** 'https://host/agent964/acme/q' → 'agent964/acme/q', as the CLI takes it. */
const targetOf = (link: string): string =>
  new URL(link).pathname
    .slice(1)
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/')

/**
 * The node the caller's key is limited to, with what they may do there now:
 * nothing about it but that, missing and unreadable alike.
 */
const scopePlace = (readOnly: boolean) =>
  Effect.gen(function* () {
    const me = yield* (yield* SignIn).me()
    const target = me.key?.scope ?? null
    // A scoped key whose scope cannot be read back answers nothing at all.
    if (target === null) return yield* Effect.fail(signInRequired())
    const config = yield* Config
    const workspace = target.split('/')[0] ?? ''
    const none: ScopePlace = { target, workspace, link: null, can: null }
    const ref = parseTarget(target, config.origin)
    if (ref === null) return none
    const located = yield* (yield* TreeStore)
      .locate(ref)
      .pipe(Effect.orElseSucceed(() => null))
    if (located === null || 'missing' in located) return none
    const access = yield* Access
    const node = located.node
    // Grants say what more than reading they allow; a node read only as its
    // owner, or as what a page carries, still reads.
    const can =
      canOf(yield* access.roleOn(node)) ??
      ((yield* Effect.isSuccess(access.require('read', node))) ? 'read' : null)
    if (can === null) return none
    const kind =
      node.kind === 'folder'
        ? 'folder'
        : node.path.endsWith('.html')
          ? 'page'
          : 'file'
    return {
      target,
      workspace,
      link: linkFor(config.origin, {
        workspace: ref.workspace,
        tree: ref.tree,
        path: node.path,
        kind,
      }),
      can: narrowed(can, readOnly),
    } satisfies ScopePlace
  })

/** Each share with what the caller may do there now; none they cannot open. */
const sharedPlaces = (rows: readonly SharedRow[], readOnly: boolean) =>
  Effect.gen(function* () {
    const access = yield* Access
    const out: SharedPlace[] = []
    for (const row of rows) {
      const can = canOf(yield* access.roleOn(row.node))
      if (can === null) continue
      out.push({
        workspace: row.workspace.name,
        tree: row.tree.name,
        path: row.node.path,
        kind: row.kind,
        title: row.title,
        target: targetOf(row.link),
        link: row.link,
        can: narrowed(can, readOnly),
        sharedAt: new Date(row.sharedAt).toISOString(),
        waiting: row.waiting,
        mentioned: row.mentioned,
      })
    }
    return out
  })

/** A member's trees, as the home screen lists them. */
const treePlaces = (workspace: WorkspaceRow, readOnly: boolean) =>
  Effect.gen(function* () {
    const config = yield* Config
    const trees = yield* (yield* People).trees(workspace).pipe(
      Effect.catchIf(
        (error) => error.code === 'not_found',
        () => Effect.succeed([]),
      ),
    )
    return trees.map(({ tree, can }): TreePlace => {
      const link = linkFor(config.origin, {
        workspace: workspace.name,
        tree: tree.name,
        path: '',
        kind: 'folder',
      })
      return {
        name: tree.name,
        target: targetOf(link),
        link,
        can: narrowed(can, readOnly),
      }
    })
  })

/** `GET /_/api/workspaces`: where the caller can work. */
export const workspacePlaces = Effect.gen(function* () {
  const { scoped, readOnly } = yield* who
  if (scoped) {
    return {
      scope: yield* scopePlace(readOnly),
      workspaces: [],
      shared: [],
    } satisfies WorkspacesResponse
  }
  const people = yield* People
  const memberships = yield* people.myWorkspaces()
  const workspaces: WorkspacesResponse['workspaces'][number][] = []
  for (const m of memberships) {
    workspaces.push({
      name: m.workspace.name,
      role: m.role,
      suspended: m.workspace.suspendedAt !== null,
      trees: yield* treePlaces(m.workspace, readOnly),
    })
  }
  const shared = yield* sharedPlaces(
    yield* (yield* Shares).sharedWithMe(),
    readOnly,
  )
  return { scope: null, workspaces, shared } satisfies WorkspacesResponse
})

/**
 * `GET /_/api/workspaces/<name>`: a member's trees and teams, or only what
 * was shared with someone who is not a member. Anyone with neither, and a
 * key limited to a node elsewhere, finds nothing there.
 */
export const workspacePlace = (name: string) =>
  Effect.gen(function* () {
    const { scoped, readOnly } = yield* who
    if (!isWorkspaceName(name)) return yield* Effect.fail(notFound(name))
    if (scoped) {
      const scope = yield* scopePlace(readOnly)
      if (scope.workspace !== name) return yield* Effect.fail(notFound(name))
      return {
        name,
        role: null,
        suspended: false,
        trees: [],
        shared: [],
        teams: null,
        createsTrees: false,
        scope,
      } satisfies WorkspaceResponse
    }
    const workspace = yield* (yield* TreeStore).workspace(name)
    if (workspace === null) return yield* Effect.fail(notFound(name))
    const people = yield* People
    const membership = (yield* people.myWorkspaces()).find(
      (m) => m.workspace.id === workspace.id,
    )
    const shared = yield* sharedPlaces(
      (yield* (yield* Shares).sharedWithMe()).filter(
        (row) => row.workspace.id === workspace.id,
      ),
      readOnly,
    )
    if (membership === undefined) {
      if (shared.length === 0) return yield* Effect.fail(notFound(name))
      return {
        name: workspace.name,
        role: null,
        suspended: false,
        trees: [],
        shared,
        teams: null,
        createsTrees: false,
        scope: null,
      } satisfies WorkspaceResponse
    }
    const suspended = membership.workspace.suspendedAt !== null
    const teams = yield* people.teamsForMembers(membership.workspace)
    return {
      name: workspace.name,
      role: membership.role,
      suspended,
      trees: yield* treePlaces(membership.workspace, readOnly),
      shared,
      teams: teams.map((t) => ({ name: t.name, members: t.members })),
      createsTrees: !suspended && !readOnly,
      scope: null,
    } satisfies WorkspaceResponse
  })
