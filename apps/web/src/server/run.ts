import {
  defaultMessage,
  isDossierError,
  type DossierError,
} from '@dossier/contracts'
import { Cause, Effect, Exit, Option } from 'effect'

import { CurrentCaller, type CoreServices } from '../core/index.ts'
import { screenScope } from '../edge/screens.ts'
import type { ScreenFailure } from './failure.ts'

export { isScreenFailure, type ScreenFailure } from './failure.ts'

/**
 * Runs a screen's read or action as the request's caller. A failure comes
 * back as data; an unavailable one also tells the edge to answer with the
 * plain error page.
 */
export const runScreen = async <A>(
  effect: Effect.Effect<A, DossierError, CoreServices | CurrentCaller>,
): Promise<A | ScreenFailure> => {
  const scope = screenScope.getStore()
  if (scope === undefined) {
    throw new Error('A screen ran outside a Dossier request')
  }
  const exit = await scope.runtime.runPromiseExit(
    Effect.provideService(effect, CurrentCaller, scope.caller),
  )
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.failureOption(exit.cause)
  if (Option.isSome(failure) && isDossierError(failure.value)) {
    const error = failure.value
    if (error.code === 'unavailable') scope.unavailable = true
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        fix: error.fix,
        path: error.path,
      },
    }
  }
  console.error('A screen failed', {
    requestId: scope.caller.requestId,
    cause: Cause.pretty(exit.cause),
  })
  scope.unavailable = true
  return {
    ok: false,
    error: {
      code: 'unavailable',
      message: defaultMessage('unavailable'),
      fix: null,
      path: null,
    },
  }
}

/** Clears the session cookie on this screen call's answer. */
export const endSessionCookie = (): void => {
  const scope = screenScope.getStore()
  if (scope !== undefined) scope.endSession = true
}
