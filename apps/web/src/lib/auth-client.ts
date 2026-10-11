// The browser's calls into Better Auth's own routes under /_/auth.

/** A same-origin path to continue to after sign-in, or the home. */
export const safeNext = (next: unknown): string =>
  typeof next === 'string' &&
  next.startsWith('/') &&
  !next.startsWith('//') &&
  !next.startsWith('/\\')
    ? next
    : '/'

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Starts Google sign-in, always letting the person choose the account. */
export async function startGoogleSignIn(next: string): Promise<void> {
  const target = safeNext(next)
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
