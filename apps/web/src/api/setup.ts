import { Effect, Layer } from 'effect'

import {
  Allowlist,
  AllowlistLive,
  DbLive,
  IdsLive,
  PersistenceError,
  WorkerEnv,
} from '../services'

const encoder = new TextEncoder()

function jsonResponse(
  body: unknown,
  status: number,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  const match = authorization?.match(/^Bearer ([^\s]+)$/i)
  return match?.[1] ?? null
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return new Uint8Array(digest)
}

async function constantTimeEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)])
  let difference = 0
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash[index]! ^ rightHash[index]!
  }
  return difference === 0
}

function unauthorized(): Response {
  return jsonResponse(
    {
      ok: false,
      code: 'unauthenticated',
      message: 'A valid bootstrap Bearer key is required.',
    },
    401,
    { 'www-authenticate': 'Bearer' },
  )
}

/**
 * Deployment-only bootstrap surface. Authentication is completed before the
 * D1 layer is constructed, so an invalid request cannot perform a DB lookup.
 */
export async function handleSetupRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const suppliedKey = bearerToken(request)
  const configuredKey = env.BOOTSTRAP_API_KEY
  const authenticated = await constantTimeEqual(
    suppliedKey ?? '',
    configuredKey ?? '',
  )
  if (
    suppliedKey === null ||
    configuredKey === undefined ||
    configuredKey.length === 0 ||
    !authenticated
  ) {
    return unauthorized()
  }

  if (request.method !== 'POST') {
    return jsonResponse(
      {
        ok: false,
        code: 'method_not_allowed',
        message: 'Use POST /api/setup.',
      },
      405,
      { allow: 'POST' },
    )
  }

  const WorkerEnvLive = Layer.succeed(WorkerEnv, env)
  const FoundationLive = Layer.mergeAll(DbLive, IdsLive).pipe(
    Layer.provideMerge(WorkerEnvLive),
  )
  const SetupLive = AllowlistLive.pipe(Layer.provideMerge(FoundationLive))
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const allowlist = yield* Allowlist
      return yield* allowlist.seed()
    }).pipe(Effect.either, Effect.provide(SetupLive)),
  )

  if (result._tag === 'Left') {
    const error = result.left
    if (error instanceof PersistenceError) {
      console.error(`Dossier ${error.operation} failed`, error.cause)
    } else {
      console.error('Dossier setup failed', error)
    }
    return jsonResponse(
      { ok: false, code: 'setup_failed', message: 'Deployment setup failed.' },
      500,
    )
  }

  return jsonResponse({ ok: true, ...result.right }, 200)
}
