import { dossierError, type DossierError } from '@dossier/contracts'
import { Clock, Context, Effect, Layer } from 'effect'

import { Bindings } from './bindings.ts'

/** The limit values; the defaults until super admins can change them. */
export interface LimitValues {
  /** One file in a push. */
  readonly fileBytes: number
  readonly pushFiles: number
  readonly pushBytes: number
  /** Per agent key. */
  readonly pushesPerMinute: number
  /** Per person. */
  readonly sendsPerMinute: number
  /** One file uploaded through a form. */
  readonly uploadBytes: number
  /** One data file written by a form or the page client. */
  readonly dataFileBytes: number
}

const MiB = 1024 * 1024

export const DEFAULT_LIMITS: LimitValues = {
  fileBytes: 50 * MiB,
  pushFiles: 2_000,
  pushBytes: 500 * MiB,
  pushesPerMinute: 30,
  sendsPerMinute: 30,
  uploadBytes: 10 * MiB,
  dataFileBytes: 1 * MiB,
}

export type Rate = 'push' | 'send'

export interface LimitsService {
  readonly current: () => Effect.Effect<LimitValues>
  /** Counts one request against the rate; past it, rate_limited. */
  readonly take: (
    rate: Rate,
    key: string,
  ) => Effect.Effect<void, DossierError<'rate_limited' | 'unavailable'>>
}

export class Limits extends Context.Tag('Limits')<Limits, LimitsService>() {}

const MINUTE = 60_000

const RATE_MESSAGES: Record<Rate, string> = {
  push: 'Too many pushes. Try again in a minute.',
  send: 'Too many sends. Try again in a minute.',
}

/** Rates are counted in D1, one row per key over a fixed one-minute window. */
export const LimitsLive: Layer.Layer<Limits, never, Bindings> = Layer.effect(
  Limits,
  Effect.gen(function* () {
    const { DB } = yield* Bindings
    const current = () => Effect.succeed(DEFAULT_LIMITS)
    return {
      current,
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
    }
  }),
)
