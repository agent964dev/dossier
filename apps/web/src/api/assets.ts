import { Effect, Layer } from 'effect'

import {
  Assets,
  CoreServicesLive,
  PersistenceError,
  StorageError,
  WorkerEnv,
} from '../services'
import { workerEnvWithOptionalRateLimiter } from './request'

function internalAssetError(error: unknown): Response {
  if (error instanceof PersistenceError || error instanceof StorageError) {
    console.error(`Dossier ${error.operation} failed`, error.cause)
  } else {
    console.error('Dossier asset serving request failed', error)
  }
  return new Response('Request failed', {
    status: 500,
    headers: {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'cross-origin-resource-policy': 'cross-origin',
      'x-content-type-options': 'nosniff',
    },
  })
}

export async function handleAssetRequest(
  request: Request,
  rawEnv: Cloudflare.Env,
): Promise<Response> {
  const env = workerEnvWithOptionalRateLimiter(rawEnv)
  const WorkerEnvLive = Layer.succeed(WorkerEnv, env)
  const CoreLive = CoreServicesLive.pipe(Layer.provideMerge(WorkerEnvLive))
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const assets = yield* Assets
      return yield* assets.serve(request)
    }).pipe(Effect.either, Effect.provide(CoreLive)),
  )
  return result._tag === 'Right'
    ? result.right
    : internalAssetError(result.left)
}
