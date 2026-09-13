import { handleAdminPurgeRequest } from './admin'
import { handleSystemRequest } from './health'
import { handleSetupRequest } from './setup'
import { handleProtectedApiRequest } from './surfaces'

export async function handleApiRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const pathname = new URL(request.url).pathname
  if (pathname === '/api/healthz' || pathname === '/api/policy/check') {
    return handleSystemRequest(request, env)
  }
  if (pathname === '/api/admin/purge') {
    return handleAdminPurgeRequest(request, env)
  }
  if (pathname === '/api/setup') {
    return handleSetupRequest(request, env)
  }
  return handleProtectedApiRequest(request, env)
}
