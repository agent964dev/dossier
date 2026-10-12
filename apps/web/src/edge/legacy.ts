// CLI 0.2.x calls /api/… and /cli/… with `ds_` keys. Every such request
// gets one upgrade error, in the shape that CLI prints, and nothing else:
// no caller is looked up, D1 is not read and no cookie is set.

import { bearerOf } from './caller.ts'
import { plainPage } from './respond.ts'

export const UPGRADE_MESSAGE =
  'This deployment runs Dossier next. Update with `npm i -g @agent964/dossier`.'

/** Agent keys of CLI 0.2.x. This deployment's keys start with `dsk_`. */
export const OLD_KEY_PREFIX = 'ds_'

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`)

/**
 * A request of CLI 0.2.x: a path under /api or /cli, or an old key on any
 * path outside /_/. Dossier's own paths under /_/ are never legacy.
 */
export const isLegacy = (url: URL, headers: Headers): boolean => {
  if (url.pathname.startsWith('/_/')) return false
  if (under(url.pathname, '/api') || under(url.pathname, '/cli')) return true
  const bearer = bearerOf(headers.get('authorization'))
  return bearer.kind === 'key' && bearer.secret.startsWith(OLD_KEY_PREFIX)
}

const BODY = JSON.stringify({
  ok: false,
  code: 'not_found',
  message: UPGRADE_MESSAGE,
})

const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

const UPGRADE_PAGE = plainPage(
  'Update the Dossier CLI',
  `<h1>This deployment runs Dossier next.</h1>
<p>Update with <code>npm i -g @agent964/dossier</code>.</p>`,
)

const wantsHtml = (request: Request) =>
  (request.headers.get('accept') ?? '').toLowerCase().includes('text/html')

/**
 * The upgrade error: the plain page for a browser opening /cli/… (as
 * `dossier auth login` does), else CLI 0.2.x's own error body, 404 on its
 * paths and 410 for an old key anywhere else.
 */
export const legacyResponse = (request: Request): Response => {
  const { pathname } = new URL(request.url)
  const cli = under(pathname, '/cli')
  if (cli && request.method === 'GET' && wantsHtml(request)) {
    return new Response(UPGRADE_PAGE, {
      status: 404,
      headers: {
        ...HEADERS,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      },
    })
  }
  return new Response(BODY, {
    status: cli || under(pathname, '/api') ? 404 : 410,
    headers: { ...HEADERS, 'content-type': 'application/json' },
  })
}
