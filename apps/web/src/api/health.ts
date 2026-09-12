import { DossierApi } from '@dossier/contracts'
import { validateHtml } from '@dossier/policy'
import {
  HttpApiBuilder,
  HttpServer,
} from '@effect/platform'
import { Context, Effect, Layer } from 'effect'

export class WorkerEnv extends Context.Tag('@dossier/web/WorkerEnv')<
  WorkerEnv,
  Cloudflare.Env
>() {}

function commaSeparatedHosts(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

const SystemLive = HttpApiBuilder.group(DossierApi, 'system', (handlers) =>
  handlers
    .handle('healthz', () =>
      Effect.gen(function* () {
        yield* WorkerEnv
        return {
          ok: true as const,
          service: 'dossier' as const,
          version: '0.0.0',
        }
      }),
    )
    .handle('policyCheck', ({ payload }) =>
      Effect.gen(function* () {
        const env = yield* WorkerEnv
        return validateHtml(payload, {
          maxBytes: positiveInteger(env.MAX_HTML_BYTES, 'MAX_HTML_BYTES'),
          publicOrigin: env.PUBLIC_BASE_URL,
          styleHostAllowlist: commaSeparatedHosts(env.STYLE_HOST_ALLOWLIST),
          embedHostAllowlist: commaSeparatedHosts(env.EMBED_HOST_ALLOWLIST),
          scriptHostAllowlist: commaSeparatedHosts(env.SCRIPT_HOST_ALLOWLIST),
        })
      }),
    ),
)

const ApiLive = HttpApiBuilder.api(DossierApi).pipe(Layer.provide(SystemLive))

function bodyTooLargeResponse(maxBytes: number): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      code: 'body_too_large',
      message: `Request body exceeds the ${maxBytes} byte limit.`,
    }),
    {
      status: 413,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      },
    },
  )
}

async function readBoundedBody(
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

async function withBoundedPolicyBody(
  request: Request,
  maxBytes: number,
): Promise<Request | Response> {
  const body = await readBoundedBody(request, maxBytes)
  if (body === null) return bodyTooLargeResponse(maxBytes)

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: request.redirect,
    signal: request.signal,
  })
}

export async function handleApiRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'POST' && url.pathname === '/api/policy/check') {
    const bounded = await withBoundedPolicyBody(
      request,
      positiveInteger(env.MAX_REQUEST_BYTES, 'MAX_REQUEST_BYTES'),
    )
    if (bounded instanceof Response) return bounded
    request = bounded
  }

  const WorkerEnvLive = Layer.succeed(WorkerEnv, env)
  const RequestApiLive = ApiLive.pipe(Layer.provide(WorkerEnvLive))
  const { dispose, handler } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(RequestApiLive, HttpServer.layerContext),
  )

  try {
    return await handler(request)
  } finally {
    await dispose()
  }
}
