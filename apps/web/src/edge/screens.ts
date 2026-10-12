import { AsyncLocalStorage } from 'node:async_hooks'

import type { Caller, CoreRuntime } from '../core/index.ts'

/** The request a screen renders for: who asks, and the services to ask. */
export interface ScreenScope {
  readonly caller: Caller
  readonly runtime: CoreRuntime
  /** Set when a screen's read failed because Dossier is unavailable. */
  unavailable: boolean
  /** Set when an action ended the session, so its cookie is cleared. */
  endSession?: boolean
}

/** Clears the session cookie Better Auth sets on the main host. */
export const END_SESSION_COOKIES: readonly string[] = [
  '__Secure-dossier.session_token=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax',
]

/** TanStack Start runs every screen and server function inside this. */
export const screenScope = new AsyncLocalStorage<ScreenScope>()
