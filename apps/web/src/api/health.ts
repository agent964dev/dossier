import { SystemApi } from '@dossier/contracts'
import { validateHtml } from '@dossier/policy'
import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { Effect, Layer } from 'effect'

import { WorkerEnv } from '../services/env'
import {
  bodyTooLargeResponse,
  positiveInteger,
  readBoundedBody,
  requestWithBody,
  stateFeatureAvailable,
} from './request'

export { WorkerEnv } from '../services/env'

/** Injected by Vite `define` at build time; absent under the test runner. */
declare const __DOSSIER_BUILD_VERSION__: string | undefined

/** Returns the git commit the Worker was built from, or "unknown". */
function buildVersion(): string {
  return typeof __DOSSIER_BUILD_VERSION__ === 'string'
    ? __DOSSIER_BUILD_VERSION__
    : 'unknown'
}

function commaSeparatedHosts(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export const SystemLive = HttpApiBuilder.group(
  SystemApi,
  'system',
  (handlers) =>
    handlers
      .handle('healthz', () =>
        Effect.gen(function* () {
          const env = yield* WorkerEnv
          return {
            ok: true as const,
            service: 'dossier' as const,
            version: buildVersion(),
            features: stateFeatureAvailable(env) ? ['state'] : [],
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

const ApiLive = HttpApiBuilder.api(SystemApi).pipe(Layer.provide(SystemLive))

export async function handleSystemRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'POST' && url.pathname === '/api/policy/check') {
    const maxBytes = positiveInteger(env.MAX_REQUEST_BYTES, 'MAX_REQUEST_BYTES')
    const body = await readBoundedBody(request, maxBytes)
    if (body === null) return bodyTooLargeResponse(maxBytes)
    request = requestWithBody(request, body)
  }

  const WorkerEnvLive = Layer.succeed(WorkerEnv, env)
  const RequestApiLive = ApiLive.pipe(Layer.provide(WorkerEnvLive))
  const { dispose, handler } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(RequestApiLive, HttpServer.layerContext),
  )

  try {
    const response = await handler(request)
    response.headers.set('cache-control', 'no-store')
    return response
  } finally {
    await dispose()
  }
}
