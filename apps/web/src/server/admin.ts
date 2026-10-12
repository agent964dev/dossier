import type { PersonId, WorkspaceId } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import {
  bytesText,
  People,
  type AdminOverview,
  type AdminWorkspaceRow,
  type LimitValues,
  type WorkspaceCreation,
} from '../core/index.ts'
import { runScreen } from './run.ts'

/** One limit as the super admin screen lists it. */
export interface LimitRow {
  readonly key: keyof LimitValues
  readonly label: string
  readonly value: number
  /** '10 GiB', '2,000'. */
  readonly text: string
  readonly isDefault: boolean
  /** Edited as a size rather than a count. */
  readonly bytes: boolean
}

export interface AdminWorkspaceView extends AdminWorkspaceRow {
  /** '3 members · 1.2 GiB'. */
  readonly detail: string
  /** 'deleted 11 Oct', for a deleted workspace. */
  readonly deleted: string | null
}

export type AdminView = Omit<AdminOverview, 'workspaces'> & {
  readonly limitRows: readonly LimitRow[]
  readonly workspaces: readonly AdminWorkspaceView[]
}

/** The limits in the order the screen lists them. */
const LIMITS: readonly {
  readonly key: keyof LimitValues
  readonly label: string
  readonly bytes: boolean
}[] = [
  { key: 'storageBytes', label: 'Storage', bytes: true },
  { key: 'fileBytes', label: 'File size', bytes: true },
  { key: 'pushFiles', label: 'Files per push', bytes: false },
  { key: 'pushBytes', label: 'Push size', bytes: true },
  { key: 'uploadBytes', label: 'Uploads', bytes: true },
  { key: 'dataFileBytes', label: 'Data files', bytes: true },
  { key: 'sendsPerMinute', label: 'Sends a minute', bytes: false },
  { key: 'pushesPerMinute', label: 'Pushes a minute', bytes: false },
  { key: 'webhooksPerWorkspace', label: 'Webhooks', bytes: false },
]

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

const membersText = (count: number) =>
  count === 1 ? '1 member' : `${count.toLocaleString('en-US')} members`

/** Super admins only; anyone else gets `not_found`. */
export const adminView = createServerFn({ method: 'GET' }).handler(() =>
  runScreen(
    Effect.gen(function* () {
      const people = yield* People
      const overview = yield* people.adminOverview()
      return {
        ...overview,
        limitRows: LIMITS.map(({ key, label, bytes }) => {
          const value = overview.limits[key]
          return {
            key,
            label,
            value,
            text: bytes ? bytesText(value) : value.toLocaleString('en-US'),
            isDefault: value === overview.defaults[key],
            bytes,
          }
        }),
        workspaces: overview.workspaces.map((row) => ({
          ...row,
          detail: `${membersText(row.members)} · ${bytesText(row.bytes)}`,
          deleted:
            row.deletedAt === null
              ? null
              : `deleted ${DAY.format(new Date(row.deletedAt))}`,
        })),
      } satisfies AdminView
    }),
  ),
)

const CREATIONS: ReadonlySet<WorkspaceCreation> = new Set([
  'super_admins',
  'listed',
  'anyone',
])

export const setWorkspaceCreation = createServerFn({ method: 'POST' })
  .validator((input: { readonly value: WorkspaceCreation }) => ({
    value: CREATIONS.has(input.value) ? input.value : 'listed',
  }))
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(People, (people) =>
        people.setWorkspaceCreation(data.value),
      ),
    ),
  )

const entryOf = (input: { readonly entry: string }) => ({
  entry: String(input.entry),
})

export const addCreator = createServerFn({ method: 'POST' })
  .validator(entryOf)
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(People, (people) => people.addCreator(data.entry)),
    ),
  )

export const removeCreator = createServerFn({ method: 'POST' })
  .validator(entryOf)
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(People, (people) => people.removeCreator(data.entry)),
    ),
  )

export const setLimits = createServerFn({ method: 'POST' })
  .validator(
    (input: { readonly limits: Partial<LimitValues> | 'defaults' }) => {
      if (input.limits === 'defaults') return { limits: 'defaults' as const }
      const limits: Partial<Record<keyof LimitValues, number>> = {}
      for (const { key } of LIMITS) {
        const value = (input.limits as Record<string, unknown>)[key]
        if (value !== undefined) limits[key] = Number(value)
      }
      return { limits: limits as Partial<LimitValues> }
    },
  )
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(People, (people) => people.setLimits(data.limits)),
    ),
  )

export const setRetention = createServerFn({ method: 'POST' })
  .validator((input: { readonly days: number }) => ({
    days: Number(input.days),
  }))
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(People, (people) => people.setRetention(data.days)),
    ),
  )

export const addSuperAdmin = createServerFn({ method: 'POST' })
  .validator((input: { readonly email: string }) => ({
    email: String(input.email),
  }))
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(People, (people) => people.addSuperAdmin(data.email)),
    ),
  )

export const removeSuperAdmin = createServerFn({ method: 'POST' })
  .validator((input: { readonly userId: string }) => ({
    userId: String(input.userId) as PersonId,
  }))
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(People, (people) => people.removeSuperAdmin(data.userId)),
    ),
  )

const workspaceIdOf = (input: { readonly id: string }) => ({
  id: String(input.id) as WorkspaceId,
})

export const suspendWorkspace = createServerFn({ method: 'POST' })
  .validator(workspaceIdOf)
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(People, (people) => people.suspendWorkspace(data.id)),
    ),
  )

export const liftSuspension = createServerFn({ method: 'POST' })
  .validator(workspaceIdOf)
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(People, (people) => people.liftSuspension(data.id)),
    ),
  )

export const restoreWorkspace = createServerFn({ method: 'POST' })
  .validator(workspaceIdOf)
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(People, (people) => people.restoreWorkspace(data.id)),
    ),
  )
