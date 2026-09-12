import { Effect, Layer } from 'effect'

import {
  CoreServicesLive,
  DossierError,
  errorResponse,
  PersistenceError,
  Principal,
  Serving,
  StorageError,
  Tree,
  WorkerEnv,
} from '../services'
import { renderHubPage } from './hub'
import { workerEnvWithOptionalRateLimiter } from './request'

function notFound(): Response {
  return new Response(
    '<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Not found</h1></body></html>',
    {
      status: 404,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      },
    },
  )
}

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
  const hubMatch = /^\/d\/([a-z0-9]{12})\/tree$/.exec(new URL(request.url).pathname)
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      if (hubMatch) {
        const authorization = request.headers.get('authorization')
        const bearerSupplied = authorization !== null && /^Bearer(?:\s|$)/i.test(authorization)
        const principals = yield* Principal
        const principalResult = yield* principals.resolve(request).pipe(Effect.either)
        if (principalResult._tag === 'Left' && bearerSupplied) {
          const error = principalResult.left
          return error instanceof DossierError && error.code === 'unauthenticated'
            ? errorResponse(error)
            : notFound()
        }
        const principal = principalResult._tag === 'Right' ? principalResult.right : null
        const tree = yield* Tree
        const response = yield* tree.get(hubMatch[1], principal).pipe(Effect.either)
        return response._tag === 'Right' ? renderHubPage(response.right) : notFound()
      }
      const serving = yield* Serving
      return yield* serving.serve(request)
    }).pipe(Effect.either, Effect.provide(CoreLive)),
  )
  return result._tag === 'Right'
    ? result.right
    : internalServingError(result.left)
}
