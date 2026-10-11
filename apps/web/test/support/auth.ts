import { testUtils } from 'better-auth/plugins'
import { Effect, Layer } from 'effect'

import { Bindings, Config } from '../../src/core/index.ts'
import { Auth, makeAuthPort, type AuthHooks } from '../../src/ports/auth.ts'
import type { FakeGoogle } from './fake-google.ts'

/** Better Auth with its test utilities, against the stand-in Google. */
export const AuthTest = (
  google: FakeGoogle,
): Layer.Layer<Auth, never, Bindings | Config> =>
  Layer.effect(
    Auth,
    Effect.gen(function* () {
      const bindings = yield* Bindings
      const config = yield* Config
      if (config.google?.clientId !== google.clientId) {
        return yield* Effect.die(
          new Error('the test Worker is not set up for the fake Google'),
        )
      }
      return (hooks: AuthHooks) =>
        makeAuthPort(bindings, config, hooks, [testUtils()])
    }),
  )
