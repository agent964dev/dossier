import { Layer, ManagedRuntime } from 'effect'

import { Auth, AuthLive } from '../ports/auth.ts'
import { Bindings } from './bindings.ts'
import { Config, ConfigLive } from './config.ts'
import { SignIn, SignInLive } from './sign-in.ts'

/** Every service the edge and the screens reach. */
export type CoreServices = Bindings | Config | Auth | SignIn

/** The seams a test may replace. */
export interface Overrides {
  readonly auth?: Layer.Layer<Auth, never, Bindings | Config>
}

/** The one composition, for production and tests alike. */
export const makeLayer = (
  env: Env,
  overrides: Overrides = {},
): Layer.Layer<CoreServices> => {
  const config = ConfigLive.pipe(
    Layer.provideMerge(Layer.succeed(Bindings, env)),
  )
  const auth = (overrides.auth ?? AuthLive).pipe(Layer.provideMerge(config))
  return SignInLive.pipe(Layer.provideMerge(auth))
}

export type CoreRuntime = ManagedRuntime.ManagedRuntime<CoreServices, never>

const runtimes = new WeakMap<Env, CoreRuntime>()

/** The isolate's runtime, built once for its environment. */
export const runtimeFor = (env: Env): CoreRuntime => {
  let runtime = runtimes.get(env)
  if (runtime === undefined) {
    runtime = ManagedRuntime.make(makeLayer(env))
    runtimes.set(env, runtime)
  }
  return runtime
}
