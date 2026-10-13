import {
  dossierError,
  type DossierError,
  type WorkspaceId,
} from '@dossier/contracts'
import { Clock, Context, Effect, Layer } from 'effect'

import { Bindings } from './bindings.ts'
import type { LimitValues } from './limits-values.ts'
import { Settings } from './settings.ts'

export {
  DEFAULT_LIMITS,
  DEFAULT_RETENTION_DAYS,
  LimitValuesSchema,
  type LimitValues,
} from './limits-values.ts'

export type Rate = 'push' | 'send'

export interface LimitsService {
  /** The saved values over the defaults, read once per request. */
  readonly current: () => Effect.Effect<LimitValues>
  /** Counts one request against the rate; past it, rate_limited. */
  readonly take: (
    rate: Rate,
    key: string,
  ) => Effect.Effect<void, DossierError<'rate_limited' | 'unavailable'>>
  /** The bytes a workspace's trees hold, every version included. */
  readonly storageUsed: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<number, DossierError<'unavailable'>>
  /** Refuses `bytes` more when they would pass the workspace's storage. */
  readonly requireStorage: (
    workspaceId: WorkspaceId,
    bytes: number,
  ) => Effect.Effect<void, DossierError<'too_large' | 'unavailable'>>
}

export class Limits extends Context.Tag('Limits')<Limits, LimitsService>() {}

const MINUTE = 60_000

const RATE_MESSAGES: Record<Rate, string> = {
  push: 'Too many pushes. Try again in a minute.',
  send: 'Too many sends. Try again in a minute.',
}

const UNITS = [
  ['TiB', 1024 ** 4],
  ['GiB', 1024 ** 3],
  ['MiB', 1024 ** 2],
  ['KiB', 1024],
] as const

/** "10 GiB", "1.5 MiB", "1 KiB", "900 bytes": how limits are named. */
export const bytesText = (bytes: number): string => {
  for (const [unit, size] of UNITS) {
    if (bytes >= size) {
      const value = Math.round((bytes / size) * 10) / 10
      return `${value.toLocaleString('en-US')} ${unit}`
    }
  }
  return `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`
}

/** Rates are counted in D1, one row per key over a fixed one-minute window. */
export const LimitsLive: Layer.Layer<Limits, never, Bindings | Settings> =
  Layer.effect(
    Limits,
    Effect.gen(function* () {
      const { DB } = yield* Bindings
      const settings = yield* Settings
      // A limit is never read as weaker than it is: unreadable settings
      // fail the request.
      const current = () =>
        settings.current().pipe(
          Effect.map((s) => s.limits),
          Effect.orDie,
        )

      const storageUsed = (workspaceId: WorkspaceId) =>
        Effect.tryPromise({
          try: () =>
            DB.prepare(
              `select coalesce(sum(coalesce(v.size, length(v.json_value), 0)), 0) as used
               from node_versions v join trees t on t.id = v.tree_id
               where t.workspace_id = ?`,
            )
              .bind(workspaceId)
              .first<{ used: number }>(),
          catch: (error) => {
            console.error('Reading storage used failed', error)
            return dossierError('unavailable')
          },
        }).pipe(Effect.map((row) => row?.used ?? 0))

      return {
        current,
        storageUsed,
        requireStorage: (workspaceId, bytes) =>
          Effect.gen(function* () {
            const { storageBytes } = yield* current()
            const used = yield* storageUsed(workspaceId)
            if (used + bytes > storageBytes) {
              return yield* Effect.fail(
                dossierError(
                  'too_large',
                  `This workspace has reached its ${bytesText(storageBytes)} storage limit. A super admin can raise it.`,
                  null,
                ),
              )
            }
          }),
        take: (rate, key) =>
          Effect.gen(function* () {
            const limits = yield* current()
            const allowed =
              rate === 'push' ? limits.pushesPerMinute : limits.sendsPerMinute
            const minute =
              Math.floor((yield* Clock.currentTimeMillis) / MINUTE) * MINUTE
            const row = yield* Effect.tryPromise({
              try: () =>
                DB.prepare(
                  `insert into rate_counters (key, window_start, count) values (?1, ?2, 1)
                   on conflict (key) do update set
                     count = case when window_start = ?2 then count + 1 else 1 end,
                     window_start = ?2
                   returning count`,
                )
                  .bind(`${rate}:${key}`, minute)
                  .first<{ count: number }>(),
              catch: (error) => {
                console.error('Counting a rate failed', error)
                return dossierError('unavailable')
              },
            })
            if ((row?.count ?? 0) > allowed) {
              return yield* Effect.fail(
                dossierError(
                  'rate_limited',
                  RATE_MESSAGES[rate],
                  `The limit is ${allowed} a minute. A super admin can raise it.`,
                ),
              )
            }
          }),
      } satisfies LimitsService
    }),
  )
