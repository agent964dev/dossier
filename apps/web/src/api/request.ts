import { HttpServerResponse } from '@effect/platform'

import {
  apiError,
  DossierError,
  errorResponse,
  PersistenceError,
  StorageError,
} from '../services/errors'

const permissiveRateLimiter: RateLimit = {
  limit: async () => ({ success: true }),
}

export function workerEnvWithOptionalRateLimiter(
  env: Cloudflare.Env,
): Cloudflare.Env {
  if (env.UPLOAD_RATE_LIMITER) return env
  return workerEnvWithoutUploadRateLimit(env)
}

export function workerEnvWithoutUploadRateLimit(
  env: Cloudflare.Env,
): Cloudflare.Env {
  return {
    ...env,
    UPLOAD_RATE_LIMITER: permissiveRateLimiter,
  }
}

export function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await request.body?.cancel().catch(() => undefined)
      return null
    }
  }

  if (request.body === null) return new ArrayBuffer(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body: Uint8Array<ArrayBuffer> = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer
}

export function requestWithBody(request: Request, body: ArrayBuffer): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: request.redirect,
    signal: request.signal,
  })
}

export function bodyTooLargeResponse(maxBytes: number): Response {
  return errorResponse(
    apiError(
      'body_too_large',
      `Request body exceeds the ${maxBytes} byte limit.`,
    ),
  )
}

function errorHeaders(error: DossierError): Record<string, string> {
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
  }
  if (error.code === 'unauthenticated') {
    headers['www-authenticate'] = 'Bearer'
  }
  if (error.code === 'rate_limited' && error.retryAfter !== undefined) {
    headers['retry-after'] = String(error.retryAfter)
  }
  return headers
}

export function apiErrorServerResponse(error: unknown): HttpServerResponse.HttpServerResponse {
  if (error instanceof DossierError) {
    return HttpServerResponse.unsafeJson(
      {
        ok: false,
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
      { status: error.status, headers: errorHeaders(error) },
    )
  }

  if (error instanceof PersistenceError || error instanceof StorageError) {
    console.error(`Dossier ${error.operation} failed`, error.cause)
  } else {
    console.error('Dossier API request failed', error)
  }
  return HttpServerResponse.unsafeJson(
    {
      ok: false,
      code: 'internal_error',
      message: 'The request could not be completed.',
    },
    { status: 500, headers: { 'cache-control': 'no-store' } },
  )
}

export function apiErrorWebResponse(error: unknown): Response {
  return HttpServerResponse.toWeb(apiErrorServerResponse(error))
}

export function jsonServerResponse(
  body: unknown,
  status = 200,
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.unsafeJson(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}
