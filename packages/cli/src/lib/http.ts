import { CliError, ExitCode } from './errors.js'

export interface DossierHttpOptions {
  readonly apiUrl: string
  readonly apiKey?: string
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
  readonly accept?: string
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  )
}

export function normalizeApiUrl(apiUrl: string): URL {
  let url: URL
  try {
    url = new URL(apiUrl)
  } catch {
    throw new CliError(`invalid API URL: ${apiUrl}`, ExitCode.Usage)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new CliError(
      `API URL must use HTTPS except on loopback: ${apiUrl}`,
      ExitCode.Usage,
    )
  }
  if (url.username !== '' || url.password !== '') {
    throw new CliError('API URL must not contain credentials', ExitCode.Usage)
  }
  return url
}

async function decodeError(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  if (contentType.includes('json') || text.trimStart().startsWith('{')) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>
      const message = ['message', 'error', 'code']
        .map((key) => body[key])
        .find((value): value is string =>
          typeof value === 'string' && value !== '',
        )
      if (message) {
        const details = body.details
        const rawErrors =
          typeof details === 'object' && details !== null
            ? (details as Record<string, unknown>).errors
            : undefined
        const detailErrors = Array.isArray(rawErrors)
          ? rawErrors.filter(
              (error: unknown): error is string =>
                typeof error === 'string' && error.trim() !== '',
            )
          : []
        return detailErrors.length > 0
          ? `${message}\n${detailErrors.map((error) => `  - ${error}`).join('\n')}`
          : message
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
  if (!headers.has('accept')) headers.set('accept', options.accept ?? 'application/json')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
  const onAbort = () => controller.abort()
  init.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      ...init,
      headers,
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status >= 300 && response.status < 400) {
      throw new CliError('redirects are not allowed')
    }
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
