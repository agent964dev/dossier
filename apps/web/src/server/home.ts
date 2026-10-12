import { linkFor } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import {
  Bindings,
  Config,
  CurrentCaller,
  People,
  Settings,
  Shares,
  strongest,
  type Membership,
  type SharedRow,
  type TreeSharing,
  mentionedInTree,
  unseenMentions,
} from '../core/index.ts'
import { runScreen } from './run.ts'

export interface HomeTree {
  readonly name: string
  /** The tree's link on this deployment, `/workspace/tree/`. */
  readonly href: string
  readonly sharing: TreeSharing
  /** A mention of the viewer waits unseen on a page in the tree. */
  readonly mentioned: boolean
}

/** A workspace in the workspace menu. */
export interface WorkspaceMenuItem {
  readonly name: string
  readonly role: 'admin' | 'member'
  /** Its admins see "Settings" beside it. */
  readonly isAdmin: boolean
  readonly suspended: boolean
}

export const menuOf = (
  memberships: readonly Membership[],
): readonly WorkspaceMenuItem[] =>
  memberships.map((m) => ({
    name: m.workspace.name,
    role: m.role,
    isAdmin: m.role === 'admin',
    suspended: m.workspace.suspendedAt !== null,
  }))

/** Something another person shared with the viewer. */
export interface SharedWithMe {
  readonly title: string
  readonly kind: 'folder' | 'page' | 'file'
  /** 'acme/questions'. */
  readonly place: string
  /** The workspace it is in: "from agent964". */
  readonly from: string
  /** When it was shared, ISO 8601. */
  readonly date: string
  readonly label: 'waiting for your answer' | 'mentioned you' | null
  readonly action: 'Respond' | 'Read' | 'Write'
  readonly link: string
}

const ACTIONS = { read: 'Read', respond: 'Respond', write: 'Write' } as const

const sharedRow = (row: SharedRow): SharedWithMe => ({
  title: row.title,
  kind: row.kind,
  place: row.place,
  from: row.workspace.name,
  date: new Date(row.sharedAt).toISOString(),
  label: row.waiting
    ? 'waiting for your answer'
    : row.mentioned
      ? 'mentioned you'
      : null,
  action: ACTIONS[strongest(row.roles)],
  link: row.link,
})

export interface HomeView {
  readonly deployment: string
  /** Null renders the front page. */
  readonly me: { readonly email: string; readonly name: string } | null
  /** A super admin before anyone chose who may create workspaces. */
  readonly firstRun: boolean
  /** The person's workspaces, by name. */
  readonly workspaces: readonly WorkspaceMenuItem[]
  /** The workspace the home shows: `?w=`, or the first one. */
  readonly workspace: string | null
  readonly trees: readonly HomeTree[]
  /** What others shared with the viewer, newest first. */
  readonly shared: readonly SharedWithMe[]
}

export const homeView = createServerFn({ method: 'GET' })
  .validator((input: { readonly w?: string } | undefined) => ({
    w: typeof input?.w === 'string' ? input.w : null,
  }))
  .handler(({ data }) =>
    runScreen(
      Effect.gen(function* () {
        const { person } = yield* CurrentCaller
        const config = yield* Config
        const base = {
          deployment: config.deploymentName,
          shared: [],
        }
        if (person === null) {
          return {
            ...base,
            me: null,
            firstRun: false,
            workspaces: [],
            workspace: null,
            trees: [],
          } satisfies HomeView
        }
        const people = yield* People
        const settings = yield* Settings
        const firstRun =
          (yield* people.isSuperAdmin()) &&
          !(yield* settings.current()).firstRunDone
        const memberships = yield* people.myWorkspaces()
        const chosen =
          memberships.find((m) => m.workspace.name === data.w) ?? memberships[0]
        const trees =
          chosen === undefined ? [] : yield* people.trees(chosen.workspace)
        const shared = yield* (yield* Shares).sharedWithMe()
        const mentions = yield* unseenMentions((yield* Bindings).DB, person)
        return {
          ...base,
          shared: shared.map(sharedRow),
          me: { email: person.email, name: person.name },
          firstRun,
          workspaces: menuOf(memberships),
          workspace: chosen?.workspace.name ?? null,
          trees: trees.map(({ tree, sharing }) => ({
            name: tree.name,
            href: linkFor(config.origin, {
              workspace: chosen?.workspace.name ?? '',
              tree: tree.name,
              path: '',
              kind: 'folder',
            }),
            sharing,
            mentioned: mentionedInTree(mentions, tree.id),
          })),
        } satisfies HomeView
      }),
    ),
  )
