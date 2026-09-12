import { Effect, Layer } from 'effect'

import {
  CoreServicesLive,
  PersistenceError,
  Serving,
  StorageError,
  WorkerEnv,
} from '../services'
import { workerEnvWithOptionalRateLimiter } from './request'

function internalServingError(error: unknown): Response {
  if (error instanceof PersistenceError || error instanceof StorageError) {
    console.error(`Dossier ${error.operation} failed`, error.cause)
  } else {
    console.error('Dossier serving request failed', error)
  }
  return new Response(
    '<!doctype html><html><head><meta charset="utf-8"><title>Error</title></head><body><h1>Request failed</h1></body></html>',
    {
      status: 500,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      },
    },
  )
}

export async function handleServingRequest(
  request: Request,
  rawEnv: Cloudflare.Env,
): Promise<Response> {
  const env = workerEnvWithOptionalRateLimiter(rawEnv)
  const WorkerEnvLive = Layer.succeed(WorkerEnv, env)
  const CoreLive = CoreServicesLive.pipe(Layer.provideMerge(WorkerEnvLive))
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const serving = yield* Serving
      return yield* serving.serve(request)
    }).pipe(Effect.either, Effect.provide(CoreLive)),
  )
  return result._tag === 'Right'
    ? result.right
    : internalServingError(result.left)
}
