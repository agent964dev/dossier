// The browser's calls into Better Auth's own routes under /_/auth.

/** Any origin: a path that leaves it when resolved leaves every origin. */
const PATH_BASE = 'https://path.invalid'

/** A path that stays on the origin it is resolved against. */
const isLocalPath = (path: string) =>
  path.startsWith('/') &&
  URL.canParse(path, PATH_BASE) &&
  new URL(path, PATH_BASE).origin === PATH_BASE

/**
 * A path to continue to after sign-in: a same-origin path as given, an absolute URL on
 * `origin` as its path, query and fragment, anything else '/'.
 */
export const safeNext = (next: unknown, origin: string): string => {
  if (typeof next !== 'string') return '/'
  if (next.startsWith('/')) return isLocalPath(next) ? next : '/'
  if (!URL.canParse(next)) return '/'
  const url = new URL(next)
  const path = `${url.pathname}${url.search}${url.hash}`
  return url.origin === origin && isLocalPath(path) ? path : '/'
}

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Starts Google sign-in, always letting the person choose the account. */
export async function startGoogleSignIn(next: string): Promise<void> {
  // Callers pass a path; the origin matters only for an absolute URL.
  const target = safeNext(next, globalThis.location?.origin ?? '')
  const response = await post('/_/auth/sign-in/social', {
    provider: 'google',
    callbackURL: target,
    errorCallbackURL: `/_/sign-in?next=${encodeURIComponent(target)}`,
  })
  if (!response.ok)
    throw new Error(`Sign-in did not start (${response.status})`)
  const { url } = (await response.json()) as { url?: string }
  if (typeof url !== 'string') throw new Error('Sign-in did not start')
  window.location.assign(url)
}

/** Ends this browser's session. */
export async function signOut(): Promise<void> {
  const response = await post('/_/auth/sign-out', {})
  if (!response.ok)
    throw new Error(`Sign-out did not finish (${response.status})`)
}
