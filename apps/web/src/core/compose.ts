import { Layer, ManagedRuntime } from 'effect'

import { Auth, AuthLive } from '../ports/auth.ts'
import { Access, AccessLive } from './access.ts'
import { BaseLayer, BaseLayerLive } from './base-layer.ts'
import { Bindings } from './bindings.ts'
import { ChangeFeed, ChangeFeedLive } from './change-feed.ts'
import { Config, ConfigLive } from './config.ts'
import { Data, DataLive } from './data.ts'
import { Files, FilesLive } from './files.ts'
import { Limits, LimitsLive } from './limits.ts'
import { LookSettings, LookSettingsLive } from './look.ts'
import { PageCache, PageCacheLive } from './page-cache.ts'
import { Pages, PagesLive } from './pages.ts'
import { People, PeopleLive } from './people.ts'
import { Purge, PurgeLive } from './purge.ts'
import { Push, PushLive } from './push.ts'
import { Search, SearchLive } from './search.ts'
import { Settings, SettingsLive } from './settings.ts'
import { Shares, SharesLive } from './shares.ts'
import { SignIn, SignInLive } from './sign-in.ts'
import { TreeStore, TreeStoreLive } from './tree-store.ts'
import { Watch, WatchLive } from './watch.ts'

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
  | Data
  | Settings
  | ChangeFeed
  | Watch
  | LookSettings
  | Shares
  | Purge
  | Search

/** The seams a test may replace. */
export interface Overrides {
  readonly auth?: Layer.Layer<Auth, never, Bindings | Config>
  readonly base?: Layer.Layer<BaseLayer>
  readonly pageCache?: Layer.Layer<PageCache>
  /** Where commits are published; the tree hubs by default. */
  readonly changeFeed?: Layer.Layer<ChangeFeed>
}

/** The one composition, for production and tests alike. */
export const makeLayer = (
  env: Env,
  overrides: Overrides = {},
): Layer.Layer<CoreServices> => {
  const bindings = Layer.succeed(Bindings, env)
  const config = ConfigLive.pipe(Layer.provideMerge(bindings))
  const base = overrides.base ?? BaseLayerLive.pipe(Layer.provide(bindings))
  const settings = SettingsLive.pipe(Layer.provideMerge(config))
  const feed =
    overrides.changeFeed ??
    ChangeFeedLive.pipe(Layer.provide(AccessLive), Layer.provide(bindings))
  const trees = TreeStoreLive.pipe(
    Layer.provideMerge(feed),
    Layer.provideMerge(AccessLive),
    Layer.provideMerge(LimitsLive.pipe(Layer.provideMerge(settings))),
    Layer.provideMerge(base),
    Layer.provideMerge(overrides.pageCache ?? PageCacheLive),
    Layer.provideMerge(config),
  )
  const auth = (overrides.auth ?? AuthLive).pipe(Layer.provideMerge(trees))
  // A withdrawal hands the bytes it released to the purge.
  const data = DataLive.pipe(Layer.provideMerge(PurgeLive))
  const people = PeopleLive.pipe(Layer.provide(data))
  const shares = SharesLive.pipe(Layer.provideMerge(people))
  // Deleting a comment from a listing blanks it through Data.
  const files = FilesLive.pipe(Layer.provide(data))
  return Layer.mergeAll(
    SignInLive,
    PushLive.pipe(Layer.provide(shares)),
    shares,
    LookSettingsLive.pipe(Layer.provide(people)),
    PagesLive.pipe(Layer.provideMerge(files), Layer.provide(data)),
    data,
    WatchLive,
    SearchLive,
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
