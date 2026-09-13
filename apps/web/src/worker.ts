import tanstackServer from '@tanstack/react-start/server-entry'
import { Effect, Layer } from 'effect'

import { handleApiRequest } from './api'
import { handleAssetRequest } from './api/assets'
import { handleAuthRequest } from './api/auth'
import { handleServingRequest } from './api/serving'
import { CoreServicesLive, Purge, WorkerEnv } from './services'

function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

function retentionDays(env: Cloudflare.Env): number {
  const configured = Number(env.PURGE_RETENTION_DAYS)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 30
}

async function runScheduledPurge(env: Cloudflare.Env): Promise<void> {
  const WorkerEnvLive = Layer.succeed(WorkerEnv, env)
  const ServicesLive = CoreServicesLive.pipe(Layer.provideMerge(WorkerEnvLive))
  const report = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Purge).runPurge({
        now: new Date(),
        retentionDays: retentionDays(env),
        dryRun: false,
      })
    }).pipe(Effect.provide(ServicesLive)),
  )
  console.log(JSON.stringify(report))
}

export function scheduled(
  _controller: ScheduledController,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
): void {
  ctx.waitUntil(runScheduledPurge(env))
}

const worker = {
  async fetch(request, env): Promise<Response> {
    const pathname = new URL(request.url).pathname
    if (hasPrefix(pathname, '/api')) {
      return handleApiRequest(request, env)
    }
    if (hasPrefix(pathname, '/a')) {
      return handleAssetRequest(request, env)
    }
    if (hasPrefix(pathname, '/d')) {
      return handleServingRequest(request, env)
    }
    if (hasPrefix(pathname, '/auth')) {
      return handleAuthRequest(request, env)
    }
    return tanstackServer.fetch(request)
  },
  scheduled,
} satisfies ExportedHandler<Cloudflare.Env>

export default worker
