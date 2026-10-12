import { DossierApi } from '@dossier/contracts'
import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { Context, Layer } from 'effect'

import {
  CurrentCaller,
  visitor,
  type Caller,
  type CoreRuntime,
} from '../../core/index.ts'
import { DataApiLive } from './data.ts'
import { DeviceLive } from './device.ts'
import { FilesLive } from './files.ts'
import { MeLive } from './me.ts'
import { PushesLive } from './pushes.ts'
import { ReadLive } from './read.ts'
import { SystemLive } from './system.ts'
import { ViewLive } from './view.ts'

export type ApiHandler = (request: Request, caller: Caller) => Promise<Response>

const handlers = new WeakMap<CoreRuntime, Promise<ApiHandler>>()

const build = async (runtime: CoreRuntime): Promise<ApiHandler> => {
  const core = await runtime.runtime()
  const api = HttpApiBuilder.api(DossierApi).pipe(
    Layer.provide([
      SystemLive,
      MeLive,
      DeviceLive,
      PushesLive,
      FilesLive,
      ViewLive,
      ReadLive,
      DataApiLive,
    ]),
    Layer.provide(Layer.succeedContext(core.context)),
    // Every request passes its own caller; this one only satisfies the build.
    Layer.provide(Layer.succeed(CurrentCaller, visitor('build'))),
  )
  const { handler } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(api, HttpServer.layerContext),
  )
  return (request, caller) =>
    handler(
      request,
      Context.make(CurrentCaller, caller) as Context.Context<never>,
    )
}

/** The API's web handler, built once per runtime. */
export const apiHandlerFor = (runtime: CoreRuntime): Promise<ApiHandler> => {
  let handler = handlers.get(runtime)
  if (handler === undefined) {
    handler = build(runtime)
    handlers.set(runtime, handler)
  }
  return handler
}
