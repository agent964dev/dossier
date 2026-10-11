import {
  defaultMessage,
  isErrorCode,
  PROTOCOL,
  PROTOCOL_HEADER,
  statusFor,
  type DossierError,
  type ErrorBody,
  type ErrorCode,
} from '@dossier/contracts'

import type { ShellBoot } from '@dossier/contracts/bridge'

import type { Served } from '../core/index.ts'
import type { RequestKind } from './dispatch.ts'

const NO_STORE = 'no-store'

const bodyOf = (
  code: ErrorCode,
  message: string,
  fix: string | null,
  path: string | null,
): ErrorBody => ({ error: { code, message, fix, path } })

/** A DossierError as its status and the one error body. */
export const errorResponse = (
  error: DossierError,
  requestId: string,
): Response =>
  Response.json(bodyOf(error.code, error.message, error.fix, error.path), {
    status: statusFor(error.code),
    headers: { 'cache-control': NO_STORE, 'x-request-id': requestId },
  })

export const codeResponse = (code: ErrorCode, requestId: string): Response =>
  Response.json(bodyOf(code, defaultMessage(code), null, null), {
    status: statusFor(code),
    headers: { 'cache-control': NO_STORE, 'x-request-id': requestId },
  })

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'invalid',
  401: 'sign_in_required',
  403: 'forbidden',
  404: 'not_found',
  405: 'not_found',
  409: 'conflict',
  413: 'too_large',
  426: 'protocol_mismatch',
  429: 'rate_limited',
}

/**
 * Rewrites an API error response to the error's own status and the one body.
 * The API encodes a DossierError with its tag; anything else maps by status.
 */
export const normalizeApiError = async (
  response: Response,
  requestId: string,
): Promise<Response> => {
  if (response.ok || (response.status >= 300 && response.status < 400)) {
    return response
  }
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = null
  }
  const value = parsed as {
    _tag?: unknown
    code?: unknown
    message?: unknown
    fix?: unknown
    path?: unknown
  } | null
  if (value?._tag === 'DossierError' && isErrorCode(value.code)) {
    return Response.json(
      bodyOf(
        value.code,
        typeof value.message === 'string'
          ? value.message
          : defaultMessage(value.code),
        typeof value.fix === 'string' ? value.fix : null,
        typeof value.path === 'string' ? value.path : null,
      ),
      {
        status: statusFor(value.code),
        headers: { 'cache-control': NO_STORE, 'x-request-id': requestId },
      },
    )
  }
  if (value?._tag === 'HttpApiDecodeError') {
    return Response.json(
      bodyOf(
        'invalid',
        typeof value.message === 'string'
          ? value.message
          : 'The request is not valid.',
        'Check the request against the API.',
        null,
      ),
      {
        status: statusFor('invalid'),
        headers: { 'cache-control': NO_STORE, 'x-request-id': requestId },
      },
    )
  }
  const code = STATUS_CODES[response.status] ?? 'unavailable'
  if (code === 'unavailable') {
    console.error('API failed', {
      requestId,
      status: response.status,
      body: text,
    })
  }
  return codeResponse(code, requestId)
}

const PLAIN_ERROR = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Something went wrong</title>
<style>
  html { color-scheme: dark; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
    background: #031119; color: #e6eef0;
    font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { padding: 24px; text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 16px; }
  a { display: inline-block; padding: 10px 16px; border-radius: 8px;
    background: #3eebff; color: #031119; font-weight: 600; text-decoration: none; }
  a:focus-visible { outline: 3px solid #3eebff80; outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>Something went wrong. Try again.</h1>
<a href="" onclick="location.reload(); return false">Try again</a>
</main>
</body>
</html>
`

/** The plain error page: inline HTML, no stack trace, never cached. */
export const plainErrorPage = (requestId: string): Response =>
  new Response(PLAIN_ERROR, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': NO_STORE,
      'x-request-id': requestId,
    },
  })

const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Not found</title>
<style>
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
    background: #031119; color: #e6eef0;
    font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { padding: 24px; text-align: center; }
  a { color: #3eebff; }
</style>
</head>
<body>
<main>
<h1>This page does not exist, or you cannot open it.</h1>
<p><a href="/">Go home</a></p>
</main>
</body>
</html>
`

export const notFoundPage = (requestId: string): Response =>
  new Response(NOT_FOUND_PAGE, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': NO_STORE,
      'x-request-id': requestId,
    },
  })

export const plainNotFound = (): Response =>
  new Response('Not found.\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })

const API_KINDS: ReadonlySet<RequestKind> = new Set([
  'api-read',
  'api-write',
  'upgrade',
])
const SCREEN_KINDS: ReadonlySet<RequestKind> = new Set([
  'screen',
  'screen-call',
  'link',
])

/**
 * The headers every response gets, plus the renewal cookie on the main host.
 * A content host never sets a cookie.
 */
export const withCommonHeaders = (
  response: Response,
  kind: RequestKind | null,
  setCookie: readonly string[],
  host: 'main' | 'content',
): Response => {
  const headers = new Headers(response.headers)
  headers.set('x-content-type-options', 'nosniff')
  if (!headers.has('referrer-policy')) {
    headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  }
  if (kind !== null && API_KINDS.has(kind)) {
    headers.set(PROTOCOL_HEADER, String(PROTOCOL))
    if (!headers.has('cache-control')) headers.set('cache-control', NO_STORE)
  }
  if (
    kind !== null &&
    SCREEN_KINDS.has(kind) &&
    !headers.has('content-security-policy')
  ) {
    headers.set('content-security-policy', "frame-ancestors 'none'")
  }
  if (host === 'content') {
    headers.delete('set-cookie')
  } else {
    for (const cookie of setCookie) headers.append('set-cookie', cookie)
  }
  // A 101 carries its WebSocket, which a plain copy of the response drops.
  if (response.status === 101) {
    return new Response(null, {
      status: 101,
      statusText: response.statusText,
      headers,
      webSocket: response.webSocket,
    })
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** The frame's sandbox: in the shell's iframe and on every content response. */
export const SANDBOX_TOKENS = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-modals',
  'allow-downloads',
  'allow-presentation',
  'allow-top-navigation-by-user-activation',
] as const

const SANDBOX = SANDBOX_TOKENS.join(' ')
const FRAME_ALLOW = 'fullscreen; clipboard-write; autoplay; picture-in-picture'

const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/**
 * The shell: a small first-party document that frames the page from its
 * tree's content host. It adds nothing visible, and its title is only the
 * deployment's name, so a link preview shows nothing of a private page.
 */
export const renderShell = (boot: ShellBoot): Response => {
  const data = JSON.stringify(boot).replaceAll('<', '\\u003c')
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(boot.deployment.name)}</title>
<link rel="icon" href="/_/app/favicon.svg" type="image/svg+xml">
<style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style>
<script type="application/json" id="dossier-shell">${data}</script>
<script type="module" src="/_/base/${encodeURIComponent(boot.base)}/shell.js"></script>
</head>
<body><iframe id="dossier-page" title="" sandbox="${SANDBOX}" allow="${FRAME_ALLOW}"></iframe></body>
</html>
`
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': NO_STORE,
      'referrer-policy': 'same-origin',
      'content-security-policy': [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'unsafe-inline'",
        "img-src 'self'",
        "connect-src 'self'",
        `frame-src ${boot.contentOrigin}`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  })
}

/** The headers every content-host response carries. */
const contentHeaders = (cache: string): Headers =>
  new Headers({
    'content-security-policy': `sandbox ${SANDBOX}`,
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'cache-control': cache,
  })

const PAGE_CACHE = 'private, no-cache'
/** A file at a pinned sequence never changes. */
const PINNED_CACHE = 'private, max-age=86400'

/** A frame request that fails: plain text, never a redirect to sign-in. */
export const frameFailure = (status: 404 | 503): Response => {
  const headers = contentHeaders(NO_STORE)
  headers.set('content-type', 'text/plain; charset=utf-8')
  return new Response(
    status === 404 ? 'Not found.\n' : 'Something went wrong. Try again.\n',
    { status, headers },
  )
}

/** What Pages.frame answered, as the content host's response. */
export const frameResponse = (served: Served): Response => {
  switch (served.kind) {
    case 'framePage': {
      const headers = contentHeaders(PAGE_CACHE)
      headers.set('content-type', 'text/html; charset=utf-8')
      headers.set('etag', `"${served.etag}"`)
      return new Response(served.html, { status: 200, headers })
    }
    case 'file': {
      const cache = served.cache === 'pinned' ? PINNED_CACHE : PAGE_CACHE
      const headers = contentHeaders(cache)
      headers.set('content-type', served.contentType)
      headers.set('etag', `"${served.etag}"`)
      if (served.download) headers.set('content-disposition', 'attachment')
      if (served.range === null) {
        headers.set('content-length', String(served.size))
        return new Response(served.body, { status: 200, headers })
      }
      const { offset, length } = served.range
      headers.set('content-length', String(length))
      headers.set(
        'content-range',
        `bytes ${offset}-${offset + length - 1}/${served.size}`,
      )
      return new Response(served.body, { status: 206, headers })
    }
    case 'notModified': {
      const headers = contentHeaders(PAGE_CACHE)
      headers.set('etag', `"${served.etag}"`)
      return new Response(null, { status: 304, headers })
    }
    case 'unsatisfiable': {
      const headers = contentHeaders(NO_STORE)
      headers.set('content-range', `bytes */${served.size}`)
      return new Response(null, { status: 416, headers })
    }
    case 'redirect': {
      const headers = contentHeaders(NO_STORE)
      headers.set('location', served.to)
      return new Response(null, { status: served.status, headers })
    }
    case 'shell':
    case 'listing':
      return frameFailure(404)
  }
}

/** A redirect on the main host. */
export const redirectTo = (location: string, status: 301 | 302): Response =>
  new Response(null, {
    status,
    headers: { location, 'cache-control': NO_STORE },
  })
