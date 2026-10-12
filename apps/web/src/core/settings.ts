import { dossierError, type DossierError } from '@dossier/contracts'
import { Clock, Context, Effect, Layer, Option } from 'effect'

import { Bindings } from './bindings.ts'
import { CurrentCaller, type Caller } from './caller.ts'
import { Config } from './config.ts'
import {
  DEFAULT_LIMITS,
  DEFAULT_RETENTION_DAYS,
  type LimitValues,
} from './limits-values.ts'

/** Who may create workspaces, besides super admins. */
export type WorkspaceCreation = 'super_admins' | 'listed' | 'anyone'

export interface DeploymentSettings {
  readonly workspaceCreation: WorkspaceCreation
  readonly limits: LimitValues
  /** 1 to 365. */
  readonly retentionDays: number
  /** A super admin has chosen who may create workspaces. */
  readonly firstRunDone: boolean
}

export interface HealthCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string | null
}

export interface Health {
  readonly ok: boolean
  readonly checkedAt: number
  readonly checks: readonly HealthCheck[]
}

export interface SettingsService {
  /** Read once per request, so a saved value applies from the next one. */
  readonly current: () => Effect.Effect<
    DeploymentSettings,
    DossierError<'unavailable'>
  >
  readonly health: () => Effect.Effect<Health>
}

export class Settings extends Context.Tag('Settings')<
  Settings,
  SettingsService
>() {}

/** The keys super admins save; absent keys read as the defaults. */
export type SettingKey = 'workspace_creation' | 'limits' | 'retention_days'

const CREATIONS: ReadonlySet<string> = new Set([
  'super_admins',
  'listed',
  'anyone',
])

const LIMIT_FIELDS = Object.keys(DEFAULT_LIMITS) as (keyof LimitValues)[]

/** The saved fields over the defaults; anything malformed is left out. */
export const overlayLimits = (saved: unknown): LimitValues => {
  const out: Record<string, number> = { ...DEFAULT_LIMITS }
  if (typeof saved !== 'object' || saved === null) return DEFAULT_LIMITS
  for (const field of LIMIT_FIELDS) {
    const value = (saved as Record<string, unknown>)[field]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      out[field] = value
    }
  }
  return out as unknown as LimitValues
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** What the rows say, every absent or malformed value read as its default. */
export const settingsOf = (
  rows: readonly { readonly key: string; readonly valueJson: string }[],
): DeploymentSettings => {
  const saved = new Map(rows.map((row) => [row.key, parse(row.valueJson)]))
  const creation = saved.get('workspace_creation')
  const retention = saved.get('retention_days')
  return {
    workspaceCreation:
      typeof creation === 'string' && CREATIONS.has(creation)
        ? (creation as WorkspaceCreation)
        : 'listed',
    limits: overlayLimits(saved.get('limits')),
    retentionDays:
      typeof retention === 'number' &&
      Number.isInteger(retention) &&
      retention >= 1 &&
      retention <= 365
        ? retention
        : DEFAULT_RETENTION_DAYS,
    firstRunDone: saved.has('workspace_creation'),
  }
}

/**
 * Settings read by a request, by its caller. A save in this isolate moves
 * the generation, so the request that saved reads the new values too.
 */
const cache = new WeakMap<
  Caller,
  { readonly generation: number; readonly value: DeploymentSettings }
>()
let generation = 0

/** Called after every save of deployment settings. */
export const settingsSaved = (): void => {
  generation += 1
}

/** The file the base layer always holds, read to check Static Assets. */
const HEALTH_KEY = 'health/probe'

export const SettingsLive: Layer.Layer<Settings, never, Bindings | Config> =
  Layer.effect(
    Settings,
    Effect.gen(function* () {
      const { DB, BLOBS, ASSETS } = yield* Bindings
      const config = yield* Config

      const read = Effect.tryPromise({
        try: () =>
          DB.prepare(
            'select key, value_json as valueJson from deployment_settings',
          ).all<{ key: string; valueJson: string }>(),
        catch: (error) => {
          console.error('Reading the deployment settings failed', error)
          return dossierError('unavailable')
        },
      }).pipe(Effect.map((rows) => settingsOf(rows.results)))

      const current = () =>
        Effect.gen(function* () {
          const caller = Option.getOrNull(
            yield* Effect.serviceOption(CurrentCaller),
          )
          const cached = caller === null ? undefined : cache.get(caller)
          if (cached !== undefined && cached.generation === generation) {
            return cached.value
          }
          const at = generation
          const value = yield* read
          if (caller !== null) cache.set(caller, { generation: at, value })
          return value
        })

      const check = (
        name: string,
        run: () => Promise<string | null>,
      ): Effect.Effect<HealthCheck> =>
        Effect.tryPromise(run).pipe(
          Effect.map((detail) => ({ name, ok: detail === null, detail })),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.error(`The ${name} health check failed`, error)
              return { name, ok: false, detail: 'Did not answer.' }
            }),
          ),
        )

      const health = () =>
        Effect.gen(function* () {
          const checks = yield* Effect.all(
            [
              check('Database', async () => {
                await DB.prepare('select 1').first()
                return null
              }),
              check('File storage', async () => {
                await BLOBS.head(HEALTH_KEY)
                return null
              }),
              check('Base layer', async () => {
                const url = new URL(
                  `/_/base/${config.baseVersion}/client.js`,
                  config.origin,
                )
                const response = await ASSETS.fetch(url)
                await response.body?.cancel()
                return response.ok
                  ? null
                  : `Static Assets answered ${response.status}.`
              }),
            ],
            { concurrency: 'unbounded' },
          )
          return {
            ok: checks.every((c) => c.ok),
            checkedAt: yield* Clock.currentTimeMillis,
            checks,
          } satisfies Health
        })

      return { current, health } satisfies SettingsService
    }),
  )
