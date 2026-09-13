import type { AdminPurgeRequest } from '@dossier/contracts'
import { Effect, Layer } from 'effect'

import {
  CoreServicesLive,
  PersistenceError,
  Principal,
  Purge,
  StorageError,
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
      message: 'A deployment-admin or bootstrap Bearer key is required.',
    },
    401,
    { 'www-authenticate': 'Bearer' },
  )
}

function malformed(message: string): Response {
  return jsonResponse({ ok: false, code: 'policy_rejected', message }, 422)
}

function decodePayload(value: unknown): AdminPurgeRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) => !['dryRun', 'retentionDays'].includes(key),
    )
  ) {
    return null
  }
  if (record.dryRun !== undefined && typeof record.dryRun !== 'boolean') {
    return null
  }
  if (
    record.retentionDays !== undefined &&
    (!Number.isSafeInteger(record.retentionDays) ||
      (record.retentionDays as number) <= 0)
  ) {
    return null
  }
  return {
    ...(record.dryRun === undefined
      ? {}
      : { dryRun: record.dryRun as boolean }),
    ...(record.retentionDays === undefined
      ? {}
      : { retentionDays: record.retentionDays as number }),
  }
}

function configuredRetention(env: Cloudflare.Env): number {
  const retentionDays = Number(env.PURGE_RETENTION_DAYS)
  return Number.isSafeInteger(retentionDays) && retentionDays > 0
    ? retentionDays
    : 30
}

/** Deployment-only purge surface with dry-run as the safe default. */
export async function handleAdminPurgeRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const suppliedKey = bearerToken(request)
  const configuredKey = env.BOOTSTRAP_API_KEY
  const bootstrapAuthenticated = await constantTimeEqual(
    suppliedKey ?? '',
    configuredKey ?? '',
  )
  const bootstrap =
    suppliedKey !== null &&
    configuredKey !== undefined &&
    configuredKey.length > 0 &&
    bootstrapAuthenticated

  let rawPayload: unknown = {}
  let payloadError: string | null = null
  if (request.method === 'POST') {
    try {
      const text = await request.text()
      if (text.trim() !== '') rawPayload = JSON.parse(text)
    } catch {
      payloadError = 'The request body must be valid JSON.'
    }
  }
  const payload = payloadError === null ? decodePayload(rawPayload) : null
  if (payload === null && payloadError === null) {
    payloadError = 'The request body does not match the purge schema.'
  }
  const readOnlyAuthorization =
    request.method !== 'POST' ||
    payloadError !== null ||
    payload?.dryRun !== false

  const WorkerEnvLive = Layer.succeed(WorkerEnv, env)
  const ServicesLive = CoreServicesLive.pipe(Layer.provideMerge(WorkerEnvLive))
  if (!bootstrap) {
    if (suppliedKey === null) return unauthorized()
    const principal = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Principal
        return yield* readOnlyAuthorization
          ? service.resolveReadOnly(request)
          : service.resolve(request)
      }).pipe(Effect.either, Effect.provide(ServicesLive)),
    )
    if (principal._tag === 'Left' || !principal.right.deploymentAdmin) {
      return unauthorized()
    }
  }

  if (request.method !== 'POST') {
    return jsonResponse(
      {
        ok: false,
        code: 'method_not_allowed',
        message: 'Use POST /api/admin/purge.',
      },
      405,
      { allow: 'POST' },
    )
  }
  if (payload === null) {
    return malformed(payloadError ?? 'The request body is invalid.')
  }

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const purge = yield* Purge
      return yield* purge.runPurge({
        now: new Date(),
        dryRun: payload.dryRun ?? true,
        retentionDays:
          payload.retentionDays === undefined
            ? configuredRetention(env)
            : payload.retentionDays,
      })
    }).pipe(Effect.either, Effect.provide(ServicesLive)),
  )
  if (result._tag === 'Left') {
    const error = result.left
    if (storageOrPersistenceError(error)) {
      console.error(`Dossier ${error.operation} failed`, error.cause)
    } else {
      console.error('Dossier purge failed', error)
    }
    return jsonResponse(
      {
        ok: false,
        code: 'internal_error',
        message: 'The purge could not be completed.',
      },
      500,
    )
  }
  return jsonResponse(result.right, 200)
}

function storageOrPersistenceError(
  error: unknown,
): error is PersistenceError | StorageError {
  return error instanceof PersistenceError || error instanceof StorageError
}
