import { env } from 'cloudflare:workers'
import { ManagedRuntime } from 'effect'

import {
  makeLayer,
  type CoreRuntime,
  type Overrides,
} from '../../src/core/index.ts'
import { AuthTest } from './auth.ts'
import { installFakeGoogle } from './fake-google.ts'

export const google = installFakeGoogle({
  clientId: env.GOOGLE_CLIENT_ID ?? '',
  clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
})

export const ORIGIN = env.PUBLIC_ORIGIN

/** A runtime over the test Worker's environment, with the stand-in Google. */
export const testRuntime = (
  options: { readonly env?: Partial<Env>; readonly overrides?: Overrides } = {},
): CoreRuntime =>
  ManagedRuntime.make(
    makeLayer(
      { ...env, ...options.env },
      { auth: AuthTest(google), ...options.overrides },
    ),
  )

let current: CoreRuntime | undefined

/** The runtime the test Worker serves with; a test may swap it for a while. */
export const harness = {
  runtime: (): CoreRuntime => (current ??= testRuntime()),
  use: (runtime: CoreRuntime) => {
    current = runtime
  },
  reset: () => {
    current = undefined
  },
}

/**
 * Runs `body` while the Worker serves with `runtime`, then restores the
 * default runtime.
 */
export const withRuntime = async <A>(
  runtime: CoreRuntime,
  body: () => Promise<A>,
): Promise<A> => {
  const previous = current
  current = runtime
  try {
    return await body()
  } finally {
    current = previous
  }
}
