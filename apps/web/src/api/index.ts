import { handleSystemRequest } from './health'
import { handleProtectedApiRequest } from './surfaces'

export async function handleApiRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  const pathname = new URL(request.url).pathname
  if (pathname === '/api/healthz' || pathname === '/api/policy/check') {
    return handleSystemRequest(request, env)
  }
  return handleProtectedApiRequest(request, env)
}
