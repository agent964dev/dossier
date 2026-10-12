import { Layer, ManagedRuntime } from 'effect'

import { Auth, AuthLive } from '../ports/auth.ts'
import { Access, AccessLive } from './access.ts'
import { BaseLayer, BaseLayerLive } from './base-layer.ts'
import { Bindings } from './bindings.ts'
import { Config, ConfigLive } from './config.ts'
import { Files, FilesLive } from './files.ts'
import { Limits, LimitsLive } from './limits.ts'
import { PageCache, PageCacheLive } from './page-cache.ts'
import { Pages, PagesLive } from './pages.ts'
import { People, PeopleLive } from './people.ts'
import { Push, PushLive } from './push.ts'
import { SignIn, SignInLive } from './sign-in.ts'
import { TreeStore, TreeStoreLive } from './tree-store.ts'

/** Every service the edge and the screens reach. */
export type CoreServices =
  | Bindings
  | Config
  | Auth
  | SignIn
  | Access
  | TreeStore
  | Limits
  | Push
  | Files
  | People
  | Pages
  | BaseLayer
  | PageCache

/** The seams a test may replace. */
export interface Overrides {
  readonly auth?: Layer.Layer<Auth, never, Bindings | Config>
  readonly base?: Layer.Layer<BaseLayer>
  readonly pageCache?: Layer.Layer<PageCache>
}

/** The one composition, for production and tests alike. */
export const makeLayer = (
  env: Env,
  overrides: Overrides = {},
): Layer.Layer<CoreServices> => {
  const bindings = Layer.succeed(Bindings, env)
  const config = ConfigLive.pipe(Layer.provideMerge(bindings))
  const base = overrides.base ?? BaseLayerLive.pipe(Layer.provide(bindings))
  const trees = TreeStoreLive.pipe(
    Layer.provideMerge(AccessLive),
    Layer.provideMerge(LimitsLive),
    Layer.provideMerge(base),
    Layer.provideMerge(overrides.pageCache ?? PageCacheLive),
    Layer.provideMerge(config),
  )
  const auth = (overrides.auth ?? AuthLive).pipe(Layer.provideMerge(trees))
  return Layer.mergeAll(
    SignInLive,
    PushLive,
    FilesLive,
    PeopleLive,
    PagesLive,
  ).pipe(Layer.provideMerge(auth))
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
