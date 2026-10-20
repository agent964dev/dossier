import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import {
  Config,
  CurrentCaller,
  SignIn,
  type SignInNotice,
} from '../core/index.ts'
import { runScreen } from './run.ts'

export interface SignInView {
  readonly deployment: string
  /** False until the deployment has its Google client. */
  readonly ready: boolean
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
          ready: config.google !== null,
          signedInAs: person?.email ?? null,
          notice,
          origin: config.origin.origin,
        } satisfies SignInView
      }),
    ),
  )
