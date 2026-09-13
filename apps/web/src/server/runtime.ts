import { Cause, Effect, Exit, Layer, Option } from 'effect'

import {
  Access,
  Allowlist,
  CoreServicesLive,
  Db,
  Documents,
  DossierError,
  Ids,
  Objects,
  PersistenceError,
  Principal,
  Publish,
  Serving,
  Session,
  SessionError,
  Shoo,
  WorkerEnv,
  Workspace,
} from '../services'
import { workerEnvWithOptionalRateLimiter } from '../api/request'
import { CsrfRejected } from './csrf'

/**
 * Every service the phase-one web surface may reach for, plus the per-request
 * bindings. `runCore` is the only place that builds the layer, so route files
 * and server functions stay free of Effect wiring.
 */
export type CoreServices =
  | WorkerEnv
  | Db
  | Objects
  | Ids
  | Session
  | Principal
  | Access
  | Allowlist
  | Shoo
  | Publish
  | Documents
  | Serving
  | Workspace

/**
 * The Cloudflare bindings, loaded lazily. The import is dynamic on purpose:
 * `cloudflare:workers` only resolves inside the Worker environment, and a
 * static import would pull the specifier into the browser module graph of any
 * route file that transitively imports a server function.
 */
export async function workerEnv(): Promise<Cloudflare.Env> {
  const module = await import('cloudflare:workers')
  return module.env as unknown as Cloudflare.Env
}

export function coreLayer(env: Cloudflare.Env) {
  const environment = Layer.succeed(WorkerEnv, workerEnvWithOptionalRateLimiter(env))
  return CoreServicesLive.pipe(Layer.provideMerge(environment))
}

/** Runs an Effect against the live services for this request. */
export async function runCore<A, E>(
  effect: Effect.Effect<A, E, CoreServices>,
): Promise<A> {
  const env = await workerEnv()
  return Effect.runPromise(
    Effect.scoped(Effect.provide(effect, coreLayer(env))),
  )
}

export interface SurfaceFailure {
  readonly ok: false
  readonly code: string
  readonly message: string
}

export function surfaceFailure(code: string, message: string): SurfaceFailure {
  return { ok: false, code, message }
}

/**
 * Turns the typed service errors into the plain, serialisable shape the pages
 * render inline. Anything unexpected becomes a generic failure rather than a
 * stack trace in the browser.
 */
export function toSurfaceFailure(
  error: unknown,
  fallback = 'Something went wrong. Please retry.',
): SurfaceFailure {
  if (error instanceof DossierError) {
    return surfaceFailure(error.code, error.message)
  }
  if (error instanceof CsrfRejected) {
    return surfaceFailure('csrf_rejected', error.message)
  }
  if (error instanceof PersistenceError || error instanceof SessionError) {
    return surfaceFailure('internal', fallback)
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    typeof (error as { _tag: unknown })._tag === 'string'
  ) {
    const tagged = error as { _tag: string; code?: unknown; message?: unknown }
    if (tagged._tag === 'DossierError' && typeof tagged.code === 'string') {
      return surfaceFailure(
        tagged.code,
        typeof tagged.message === 'string' ? tagged.message : fallback,
      )
    }
  }
  return surfaceFailure('internal', fallback)
}

/** Runs an Effect and folds any failure into a `SurfaceFailure` value. */
export async function runSurface<A, E>(
  effect: Effect.Effect<A, E, CoreServices>,
): Promise<A | SurfaceFailure> {
  const exit = await runCore(Effect.exit(effect))
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.failureOption(exit.cause)
  return Option.isSome(failure)
    ? toSurfaceFailure(failure.value)
    : surfaceFailure('internal', 'Something went wrong. Please retry.')
}
