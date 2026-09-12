import { CliError, ExitCode } from './errors.js'

export interface DossierHttpOptions {
  readonly apiUrl: string
  readonly apiKey?: string
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

function normalizeApiUrl(apiUrl: string): URL {
  let url: URL
  try {
    url = new URL(apiUrl)
  } catch {
    throw new CliError(`invalid API URL: ${apiUrl}`, ExitCode.Usage)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError(`API URL must use http or https: ${apiUrl}`, ExitCode.Usage)
  }
  return url
}

async function decodeError(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  if (contentType.includes('json') || text.trimStart().startsWith('{')) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>
      for (const key of ['message', 'error', 'code']) {
        if (typeof body[key] === 'string' && body[key] !== '') return body[key]
      }
    } catch {
      // Fall through to the raw response below.
    }
  }
  return text.trim() || response.statusText || `HTTP ${response.status}`
}

export async function dossierFetch(
  target: string | URL,
  options: DossierHttpOptions,
  init: RequestInit = {},
): Promise<Response> {
  const api = normalizeApiUrl(options.apiUrl)
  const url = target instanceof URL ? target : new URL(target, api)
  const headers = new Headers(init.headers)
  if (options.apiKey && url.origin === api.origin) {
    headers.set('authorization', `Bearer ${options.apiKey}`)
  }
  headers.set('accept', 'application/json')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
  const onAbort = () => controller.abort()
  init.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      ...init,
      headers,
      signal: controller.signal,
    })
    if (!response.ok) {
      const message = await decodeError(response)
      throw new CliError(
        `${response.status} ${response.statusText || 'request failed'}: ${message}`,
        response.status === 401 ? ExitCode.Auth : ExitCode.Failure,
        { status: response.status },
      )
    }
    return response
  } catch (error) {
    if (error instanceof CliError) throw error
    if (controller.signal.aborted) {
      throw new CliError(`request timed out after ${options.timeoutMs ?? 30_000} ms`)
    }
    throw new CliError(
      `request failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timeout)
    init.signal?.removeEventListener('abort', onAbort)
  }
}

export async function dossierJson<A>(
  target: string | URL,
  options: DossierHttpOptions,
  init?: RequestInit,
): Promise<A> {
  const response = await dossierFetch(target, options, init)
  try {
    return (await response.json()) as A
  } catch {
    throw new CliError(`server returned invalid JSON for ${response.url}`)
  }
}
