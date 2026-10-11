import { AsyncLocalStorage } from 'node:async_hooks'

import type { Caller, CoreRuntime } from '../core/index.ts'

/** The request a screen renders for: who asks, and the services to ask. */
export interface ScreenScope {
  readonly caller: Caller
  readonly runtime: CoreRuntime
  /** Set when a screen's read failed because Dossier is unavailable. */
  unavailable: boolean
}

/** TanStack Start runs every screen and server function inside this. */
export const screenScope = new AsyncLocalStorage<ScreenScope>()
