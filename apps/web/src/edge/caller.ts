import {
  CSRF_HEADER,
  fail,
  type AuthoredSeq,
  type DossierError,
  type TreeId,
} from '@dossier/contracts'
import { Effect } from 'effect'

import { Pages, SignIn, type Caller } from '../core/index.ts'
import type { RequestKind } from './dispatch.ts'

/**
 * The one reading of `Authorization` for agent keys, shared by
 * authentication and the link route's agent intent: no Bearer anywhere, one
 * well-formed Bearer key as the only credential, or anything else that
 * mentions Bearer or carries several credentials, which fails closed.
 * Duplicate headers arrive joined by commas, so a comma that starts a new
 * credential counts as a second one.
 */
export type BearerHeader =
  | { readonly kind: 'none' }
  | { readonly kind: 'key'; readonly secret: string }
  | { readonly kind: 'malformed' }

/** An auth scheme, then white space or the end: where a credential starts. */
const CREDENTIAL = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:[\t ]|$)/
const ANY_BEARER = /(?:^|[\t ,])bearer(?=[\t ,]|$)/i
const ONE_BEARER = /^bearer[\t ]+([^\t ,]+)$/i

export const bearerOf = (header: string | null): BearerHeader => {
  const value = (header ?? '').trim()
  if (value === '') return { kind: 'none' }
  const parts = value.split(',').map((part) => part.trim())
  const credentials = parts.filter((part) => CREDENTIAL.test(part)).length
  const one = ONE_BEARER.exec(value)
  if (one !== null) return { kind: 'key', secret: one[1]! }
  if (ANY_BEARER.test(value) || credentials > 1) return { kind: 'malformed' }
  return { kind: 'none' }
}

const BEARER_KINDS: ReadonlySet<RequestKind> = new Set([
  'link',
  'api-read',
  'api-write',
  'upgrade',
])

export const requestIdOf = (request: Request): string =>
  request.headers.get('cf-ray') ?? crypto.randomUUID()

const isReadMethod = (method: string) => method === 'GET' || method === 'HEAD'

/**
 * Whether a request of this kind may present the session cookie. A cookie
 * that fails its rule is ignored, never an error.
 */
export const cookieRuleHolds = (
  kind: RequestKind,
  request: Request,
  origin: string,
): boolean => {
  const headers = request.headers
  const site = headers.get('sec-fetch-site')
  const mode = headers.get('sec-fetch-mode')
  const sameOrigin = site === 'same-origin'
  // Our own origin: PUBLIC_ORIGIN, or the request's own URL on the main host,
  // which Wrangler's local HTTPS proxy turns into http. A page elsewhere can
  // name neither.
  const sender = headers.get('origin')
  const ownOrigin =
    sender !== null &&
    (sender === origin || sender === new URL(request.url).origin)
  const write = sameOrigin && headers.get(CSRF_HEADER) === '1' && ownOrigin
  switch (kind) {
    case 'link':
    case 'screen':
      return (
        isReadMethod(request.method) &&
        (mode === 'navigate' || (site === null && mode === null))
      )
    case 'api-read':
      return sameOrigin
    case 'api-write':
      return write
    case 'screen-call':
      return isReadMethod(request.method) ? sameOrigin : write
    case 'upgrade':
      return ownOrigin
    default:
      return false
  }
}

/** Turns a request into its caller, by the rules of its kind. */
export const callerFor = (
  kind: RequestKind,
  request: Request,
  origin: string,
): Effect.Effect<
  { readonly caller: Caller; readonly setCookie: readonly string[] },
  DossierError<'sign_in_required' | 'unavailable'>,
  SignIn
> =>
  Effect.gen(function* () {
    const signIn = yield* SignIn
    const requestId = requestIdOf(request)
    const bearer = bearerOf(request.headers.get('authorization'))
    // A Bearer header that is not one key is refused, never read past for
    // the session cookie.
    if (bearer.kind === 'malformed' && BEARER_KINDS.has(kind)) {
      return yield* fail(
        'sign_in_required',
        'The Authorization header must be "Bearer <agent key>".',
        'Send one agent key, or run dossier login to get one.',
      )
    }
    if (bearer.kind === 'key' && BEARER_KINDS.has(kind)) {
      const principal = yield* signIn.agent(bearer.secret)
      if (principal === null) {
        return yield* fail(
          'sign_in_required',
          'This agent key is unknown or revoked.',
          'Run dossier login to get a new key.',
        )
      }
      return {
        caller: {
          person: principal.person,
          via: {
            kind: 'agent',
            keyId: principal.key.id,
            scope: principal.key.scope,
            readOnly: principal.key.readOnly,
          },
          requestId,
        },
        setCookie: [],
      }
    }
    const nobody = {
      caller: {
        person: null,
        via: { kind: 'visitor', anonSessionId: null },
        requestId,
      } satisfies Caller,
      setCookie: [] as readonly string[],
    }
    if (!cookieRuleHolds(kind, request, origin)) return nobody
    const session = yield* signIn.session(request.headers)
    if (session === null) return nobody
    return {
      caller: {
        person: session.person,
        via: { kind: 'browser', sessionId: session.sessionId },
        requestId,
      },
      setCookie: session.setCookie,
    }
  })

/** A frame path: `/_/v/<handle>/<seq>/<link path inside the tree>`. */
export interface FramePath {
  readonly handle: string
  readonly seq: AuthoredSeq
  /** Encoded, as in the URL. */
  readonly linkPath: string
}

export const framePathOf = (pathname: string): FramePath | null => {
  const match = /^\/_\/v\/([^/]+)\/(\d{1,15})\/(.*)$/.exec(pathname)
  if (match === null) return null
  const [, handle = '', seq = '', linkPath = ''] = match
  return { handle, seq: Number(seq) as AuthoredSeq, linkPath }
}

/**
 * The frame rule: the view handle in the path, for the tree whose content
 * host was asked, and never a cookie. Null when the handle is refused.
 */
export const frameCallerFor = (
  request: Request,
  handle: string,
  treeId: TreeId,
): Effect.Effect<Caller | null, DossierError<'unavailable'>, Pages> =>
  Effect.gen(function* () {
    const pages = yield* Pages
    const caller = yield* pages.handleCaller(handle, treeId)
    return caller === null
      ? null
      : { ...caller, requestId: requestIdOf(request) }
  })
