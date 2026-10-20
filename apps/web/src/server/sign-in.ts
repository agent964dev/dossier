import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import {
  Config,
  CurrentCaller,
  SignIn,
  signInProviders,
  type SignInNotice,
} from '../core/index.ts'
import type { SignInProviderId } from '../ports/auth.ts'
import { runScreen } from './run.ts'

export interface SignInView {
  readonly deployment: string
  /** The providers turned on, Google first; none: sign-in is not set up yet. */
  readonly providers: readonly SignInProviderId[]
  /** The signed-in person's email, when there is one. */
  readonly signedInAs: string | null
  readonly notice: SignInNotice | null
  /** The Deployment's own origin, PUBLIC_ORIGIN. */
  readonly origin: string
}

export interface SignInQuery {
  readonly error?: string
  readonly notice?: string
  readonly who?: string
}

export const signInView = createServerFn({ method: 'GET' })
  .validator((query: SignInQuery) => query)
  .handler(({ data }) =>
    runScreen(
      Effect.gen(function* () {
        const config = yield* Config
        const { person } = yield* CurrentCaller
        const signIn = yield* SignIn
        const notice = yield* signIn.notice(
          data.error ?? data.notice ?? null,
          data.who ?? null,
        )
        return {
          deployment: config.deploymentName,
          providers: signInProviders(config),
          signedInAs: person?.email ?? null,
          notice,
          origin: config.origin.origin,
        } satisfies SignInView
      }),
    ),
  )
