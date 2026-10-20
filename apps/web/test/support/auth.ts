import { testUtils } from 'better-auth/plugins'
import { Effect, Layer } from 'effect'

import { Bindings, Config } from '../../src/core/index.ts'
import { Auth, makeAuthPort, type AuthHooks } from '../../src/ports/auth.ts'
import type { FakeGoogle } from './fake-google.ts'
import type { FakeMicrosoft } from './fake-microsoft.ts'

/**
 * Better Auth with its test utilities, against the stand-in Google and
 * Microsoft. Every provider the test Worker turns on must be a stand-in's, so
 * no test reaches a real provider.
 */
export const AuthTest = (
  google: FakeGoogle,
  microsoft: FakeMicrosoft,
): Layer.Layer<Auth, never, Bindings | Config> =>
  Layer.effect(
    Auth,
    Effect.gen(function* () {
      const bindings = yield* Bindings
      const config = yield* Config
      const providers = [
        { name: 'Google', on: config.google, fake: google },
        { name: 'Microsoft', on: config.microsoft, fake: microsoft },
      ]
      if (providers.every(({ on }) => !on)) {
        return yield* Effect.die(
          new Error('the test Worker turns on no sign-in provider'),
        )
      }
      for (const { name, on, fake } of providers) {
        if (on && on.clientId !== fake.clientId) {
          return yield* Effect.die(
            new Error(`the test Worker is not set up for the fake ${name}`),
          )
        }
      }
      return (hooks: AuthHooks) =>
        makeAuthPort(bindings, config, hooks, [testUtils()])
    }),
  )
