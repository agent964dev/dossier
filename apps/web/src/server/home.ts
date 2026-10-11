import { linkFor } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import {
  Config,
  CurrentCaller,
  People,
  type TreeSharing,
} from '../core/index.ts'
import { runScreen } from './run.ts'

export interface HomeTree {
  readonly name: string
  /** The tree's link on this deployment, `/workspace/tree/`. */
  readonly href: string
  readonly sharing: TreeSharing
}

export interface HomeView {
  readonly deployment: string
  /** Null renders the front page. */
  readonly me: { readonly email: string; readonly name: string } | null
  /** The person's workspaces, by name. */
  readonly workspaces: readonly {
    readonly name: string
    readonly role: 'admin' | 'member'
  }[]
  /** The workspace the home shows: `?w=`, or the first one. */
  readonly workspace: string | null
  readonly trees: readonly HomeTree[]
  /** "Shared with me" rows arrive with sharing. */
  readonly shared: readonly never[]
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
            workspaces: [],
            workspace: null,
            trees: [],
          } satisfies HomeView
        }
        const people = yield* People
        const memberships = yield* people.myWorkspaces()
        const chosen =
          memberships.find((m) => m.workspace.name === data.w) ?? memberships[0]
        const trees =
          chosen === undefined ? [] : yield* people.trees(chosen.workspace)
        return {
          ...base,
          me: { email: person.email, name: person.name },
          workspaces: memberships.map((m) => ({
            name: m.workspace.name,
            role: m.role,
          })),
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
          })),
        } satisfies HomeView
      }),
    ),
  )
