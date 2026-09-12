import tanstackServer from '@tanstack/react-start/server-entry'
import { handleApiRequest } from './api'
import { handleAssetRequest } from './api/assets'
import { handleAuthRequest } from './api/auth'
import { handleServingRequest } from './api/serving'

function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export default {
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
} satisfies ExportedHandler<Cloudflare.Env>
