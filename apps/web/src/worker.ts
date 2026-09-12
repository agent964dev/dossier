import tanstackServer from '@tanstack/react-start/server-entry'
import { handleApiRequest } from './api/health'

const effectRoutePrefixes = ['/api', '/d', '/a', '/auth'] as const

function isEffectRoute(pathname: string): boolean {
  return effectRoutePrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

export default {
  async fetch(request, env): Promise<Response> {
    if (isEffectRoute(new URL(request.url).pathname)) {
      return handleApiRequest(request, env)
    }

    return tanstackServer.fetch(request)
  },
} satisfies ExportedHandler<Cloudflare.Env>
