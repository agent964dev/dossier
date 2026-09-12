import { Effect, Layer } from 'effect'

import { renderStaticPage } from '../components/static-page'
import {
  Allowlist,
  CoreServicesLive,
  Session,
  Shoo,
  SignInRefused,
  WorkerEnv,
  type ShooClaims,
} from '../services'
import { workerEnvWithOptionalRateLimiter } from './request'

/**
 * The `/auth/*` surface: the three endpoints that move a person between shoo
 * and a dossier session. Everything here is a redirect or a server-rendered
 * page — no JSON, no JavaScript — so a failed sign-in is always readable.
 *
 * Ported from upstream `src/web.js`, with one difference that matters: upstream
 * created an account for any successful shoo sign-in. Here the verified email
 * must match an allowlist entry (PLAN section 5.1), and a miss renders the
 * invite-only refusal without writing anything.
 */

export function isAuthRoute(pathname: string): boolean {
  return pathname === '/auth' || pathname.startsWith('/auth/')
}

/** Only normalized same-origin paths, so `next` can never become an open redirect. */
export function safeNextPath(
  value: string | null,
  publicBaseUrl = 'https://dossier.invalid',
): string {
  if (typeof value !== 'string' || value.length === 0) return '/dashboard'
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return '/dashboard'
  }
  try {
    const origin = new URL(publicBaseUrl).origin
    const destination = new URL(value, origin)
    if (destination.origin !== origin) return '/dashboard'
    return `${destination.pathname}${destination.search}${destination.hash}`
  } catch {
    return '/dashboard'
  }
}

function claimText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim() || null
}

function redirect(location: string, cookies: readonly string[]): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 302, headers })
}

function withCookies(response: Response, cookies: readonly string[]): Response {
  const headers = new Headers(response.headers)
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * The refusal page. `SignInRefused` carries the reason the allowlist rejected
 * the identity; each one gets its own heading so the reader knows whether to
 * ask an admin, verify their email, or stop.
 */
function refusalPage(message: string, email: string | null): Response {
  const lower = message.toLowerCase()
  if (lower.includes('invite-only')) {
    return renderStaticPage({
      status: 403,
      tone: 'warn',
      title: 'Invite only',
      kicker: 'Sign-in refused',
      heading: 'This dossier is invite-only',
      body: 'Your shoo sign-in worked, but this deployment only admits addresses an admin has allowed. Nothing was created for your account.',
      detail: email,
      note: 'Ask an admin to allow your email address or your whole work domain, then sign in again.',
      actions: [
        { href: '/auth/sign-in', label: 'Try another account', primary: true },
        { href: '/', label: 'Back to dossier' },
      ],
    })
  }
  if (lower.includes('disabled')) {
    return renderStaticPage({
      status: 403,
      tone: 'danger',
      title: 'Account disabled',
      kicker: 'Sign-in refused',
      heading: 'This account is disabled',
      body: 'An admin has disabled this account. Its documents are untouched, but it cannot sign in or publish.',
      detail: email,
      actions: [{ href: '/', label: 'Back to dossier', primary: true }],
    })
  }
  return renderStaticPage({
    status: 403,
    tone: 'warn',
    title: 'Verified email required',
    kicker: 'Sign-in refused',
    heading: 'A verified email is required',
    body: message,
    detail: email,
    note: 'dossier matches the allowlist against verified addresses only, so an unverified one can never join a workspace.',
    actions: [
      { href: '/auth/sign-in', label: 'Try again', primary: true },
      { href: '/', label: 'Back to dossier' },
    ],
  })
}

function expiredPage(): Response {
  return renderStaticPage({
    status: 400,
    tone: 'warn',
    title: 'Sign-in expired',
    kicker: 'Sign-in incomplete',
    heading: 'That sign-in link expired',
    body: 'The one-time state that ties this browser to the sign-in it started is missing or no longer matches. That happens when the tab sat open too long, cookies were cleared, or the link was opened in a different browser.',
    actions: [
      { href: '/auth/sign-in', label: 'Start again', primary: true },
      { href: '/', label: 'Back to dossier' },
    ],
  })
}

function signIn(request: Request) {
  return Effect.gen(function* () {
    const env = yield* WorkerEnv
    const shoo = yield* Shoo
    const session = yield* Session
    const origin = new URL(env.PUBLIC_BASE_URL).origin
    const next = safeNextPath(
      new URL(request.url).searchParams.get('next'),
      origin,
    )
    const { state, verifier, challenge } = yield* shoo.buildPkce()
    const cookie = yield* session.createAuthStateCookie({
      state,
      verifier,
      next,
    })
    return redirect(
      shoo.buildAuthorizeUrl({
        redirectUri: `${origin}/auth/callback`,
        state,
        challenge,
      }),
      [cookie],
    )
  })
}

function callback(request: Request) {
  return Effect.gen(function* () {
    const env = yield* WorkerEnv
    const shoo = yield* Shoo
    const session = yield* Session
    const allowlist = yield* Allowlist

    // The state cookie is single-use: clear it on every outcome, success or not.
    const cleared = [session.clearAuthStateCookie()]
    const url = new URL(request.url)
    const error = url.searchParams.get('error')

    if (error === 'access_denied') {
      return withCookies(
        renderStaticPage({
          status: 403,
          tone: 'warn',
          title: 'Sign-in cancelled',
          kicker: 'Consent declined',
          heading: 'Sign-in was cancelled',
          body: 'You declined the consent screen, so shoo sent you back without an identity. dossier needs your verified email to match you against the allowlist, and your name and picture to label the documents you publish.',
          actions: [
            { href: '/auth/sign-in', label: 'Retry sign-in', primary: true },
            { href: '/', label: 'Back to dossier' },
          ],
        }),
        cleared,
      )
    }
    if (error !== null) {
      return withCookies(
        renderStaticPage({
          status: 400,
          tone: 'danger',
          title: 'Sign-in failed',
          kicker: 'Sign-in failed',
          heading: 'shoo could not complete the sign-in',
          body: 'The identity provider returned an error instead of an authorization code.',
          detail: error,
          actions: [
            { href: '/auth/sign-in', label: 'Retry sign-in', primary: true },
            { href: '/', label: 'Back to dossier' },
          ],
        }),
        cleared,
      )
    }

    const authState = yield* session.readAuthState(request)
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    if (
      authState === null ||
      typeof authState.state !== 'string' ||
      state === null ||
      state !== authState.state ||
      typeof authState.verifier !== 'string'
    ) {
      return withCookies(expiredPage(), cleared)
    }
    if (code === null || code.length === 0) {
      return withCookies(expiredPage(), cleared)
    }

    const origin = new URL(env.PUBLIC_BASE_URL).origin
    // Expired or replayed codes and shoo hiccups are expected OAuth outcomes:
    // render a retryable page rather than falling through to a 500.
    const claims = yield* shoo
      .exchangeCode({
        code,
        verifier: authState.verifier,
        redirectUri: `${origin}/auth/callback`,
      })
      .pipe(
        Effect.flatMap(({ idToken }) => shoo.verifyIdToken(idToken)),
        Effect.catchTag('ShooError', (shooError) => {
          console.error(
            'shoo sign-in failed:',
            shooError.message,
            shooError.cause,
          )
          return Effect.succeed(null)
        }),
      )
    if (claims === null) {
      return withCookies(
        renderStaticPage({
          status: 502,
          tone: 'danger',
          title: 'Sign-in failed',
          kicker: 'Sign-in failed',
          heading: 'Sign-in could not be completed',
          body: 'dossier could not exchange the authorization code with shoo. The code may have expired, or the identity service may be briefly unavailable.',
          actions: [
            { href: '/auth/sign-in', label: 'Retry sign-in', primary: true },
            { href: '/', label: 'Back to dossier' },
          ],
        }),
        cleared,
      )
    }

    const verified: ShooClaims = claims
    const email = claimText(verified.email)
    const resolution = yield* allowlist
      .resolveSignIn({
        provider: 'shoo',
        subject: verified.pairwise_sub,
        email: email ?? '',
        emailVerified: verified.email_verified === true,
        displayName: claimText(verified.name),
        pictureUrl: claimText(verified.picture),
        piiSubject: claimText(verified.pii_sub),
      })
      .pipe(
        Effect.catchTag('SignInRefused', (refused: SignInRefused) =>
          Effect.succeed(refused),
        ),
      )
    if (resolution instanceof SignInRefused) {
      return withCookies(refusalPage(resolution.message, email), cleared)
    }

    const sessionCookie = yield* session.createSessionCookie({
      accountId: resolution.accountId,
      workspaceId: resolution.workspaceId,
      accountName: claimText(verified.name) ?? resolution.email,
      email: resolution.email,
      pictureUrl: claimText(verified.picture),
    })
    const next =
      typeof authState.next === 'string'
        ? safeNextPath(authState.next, origin)
        : '/dashboard'
    return redirect(next, [...cleared, sessionCookie])
  })
}

function signOut(request: Request) {
  return Effect.gen(function* () {
    const env = yield* WorkerEnv
    const session = yield* Session

    // Sign-out changes state, so it is POST-only and Origin-checked, exactly
    // like the dashboard's server functions (PLAN section 6).
    const origin = request.headers.get('origin')
    const allowed = new Set([
      new URL(env.PUBLIC_BASE_URL).origin,
      new URL(request.url).origin,
    ])
    if (origin !== null && !allowed.has(origin)) {
      return renderStaticPage({
        status: 403,
        tone: 'danger',
        title: 'Blocked',
        kicker: 'Blocked',
        heading: 'That request came from another site',
        body: 'dossier only accepts sign-out from its own pages. Your session was left untouched.',
        actions: [{ href: '/', label: 'Back to dossier', primary: true }],
      })
    }
    return redirect('/', [session.clearSessionCookie()])
  })
}

function notFound(): Response {
  return renderStaticPage({
    status: 404,
    tone: 'warn',
    title: 'Not found',
    kicker: 'Not found',
    heading: 'There is nothing here',
    body: 'That authentication route does not exist.',
  })
}

function internalError(error: unknown): Response {
  console.error('Dossier auth request failed', error)
  return renderStaticPage({
    status: 500,
    tone: 'danger',
    title: 'Sign-in failed',
    kicker: 'Server error',
    heading: 'Sign-in could not be completed',
    body: 'Something went wrong on our side. Nothing about your account changed.',
    actions: [
      { href: '/auth/sign-in', label: 'Retry sign-in', primary: true },
      { href: '/', label: 'Back to dossier' },
    ],
  })
}

export async function handleAuthRequest(
  request: Request,
  rawEnv: Cloudflare.Env,
): Promise<Response> {
  const env = workerEnvWithOptionalRateLimiter(rawEnv)
  const pathname = new URL(request.url).pathname

  if (!env.SESSION_SECRET) {
    return renderStaticPage({
      status: 503,
      tone: 'danger',
      title: 'Not configured',
      kicker: 'Not configured',
      heading: 'Web sign-in is not configured',
      body: 'This deployment has no SESSION_SECRET, so it cannot issue or verify a session cookie.',
      actions: [{ href: '/', label: 'Back to dossier', primary: true }],
    })
  }

  const program =
    pathname === '/auth/sign-in' && request.method === 'GET'
      ? signIn(request)
      : pathname === '/auth/callback' && request.method === 'GET'
        ? callback(request)
        : pathname === '/auth/sign-out' && request.method === 'POST'
          ? signOut(request)
          : null

  if (program === null) {
    if (pathname === '/auth/sign-out' && request.method === 'GET') {
      return redirect('/', [])
    }
    return notFound()
  }

  const CoreLive = CoreServicesLive.pipe(
    Layer.provideMerge(Layer.succeed(WorkerEnv, env)),
  )
  const result = await Effect.runPromise(
    program.pipe(Effect.either, Effect.provide(CoreLive)),
  )
  return result._tag === 'Right' ? result.right : internalError(result.left)
}
