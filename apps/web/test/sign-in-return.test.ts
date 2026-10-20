// Signing in from a public page: the page sends the sign-in screen an absolute
// URL on the Deployment's own origin, and the person comes back to it.
import { describe, expect, it } from 'vitest'

import { safeNext } from '../src/lib/auth-client.ts'
import { Browser, signedIn } from './support/browser.ts'
import type { FakeIdentity } from './support/fake-google.ts'
import { ORIGIN } from './support/harness.ts'
import { fresh } from './support/people.ts'

/**
 * Opens the sign-in screen with `next`, as a public page's sign-in link does,
 * then signs in as the screen starts it: with `safeNext` of its `next` on the
 * Deployment's own origin, through the stand-in Google.
 */
const signInFromScreen = async (
  browser: Browser,
  identity: FakeIdentity,
  next: string,
): Promise<URL> => {
  const screen = await browser.fetch(
    `/_/sign-in?next=${encodeURIComponent(next)}`,
  )
  expect(screen.status).toBe(200)
  const response = await browser.signIn(identity, safeNext(next, ORIGIN))
  expect(response.status).toBe(302)
  return new URL(response.headers.get('location') ?? '', ORIGIN)
}

const landing = (url: URL) => `${url.pathname}${url.search}${url.hash}`

describe('signing in from a public page', () => {
  it("comes back to the page when next is an absolute URL on the Deployment's own origin", async () => {
    const browser = new Browser()
    const back = await signInFromScreen(
      browser,
      fresh(),
      `${ORIGIN}/agent964/acme/questions?x=1`,
    )
    expect(back.origin).toBe(ORIGIN)
    expect(landing(back)).toBe('/agent964/acme/questions?x=1')
    expect(browser.sessionToken()).toBeDefined()
  })

  it('keeps the query and fragment when the sign-in ends on a notice', async () => {
    // A known account whose Google address now belongs to someone else is
    // signed in with its old address, and the notice offers to continue.
    const lina = fresh('gmail.com', 'lina')
    const other = fresh('gmail.com', 'other')
    await signedIn(lina)
    await signedIn(other)
    const back = await signInFromScreen(
      new Browser(),
      { sub: lina.sub, email: other.email },
      `${ORIGIN}/agent964/acme/questions?x=1#c`,
    )
    expect(back.pathname).toBe('/_/sign-in')
    expect(back.searchParams.get('notice')).toBe('email_in_use')
    expect(back.searchParams.get('next')).toBe('/agent964/acme/questions?x=1#c')
  })

  it('goes to the front page when next is on a content host', async () => {
    const back = await signInFromScreen(
      new Browser(),
      fresh(),
      'https://t1.content.test/agent964/acme/questions',
    )
    expect(back.origin).toBe(ORIGIN)
    expect(landing(back)).toBe('/')
  })

  it('goes to the front page when next is on another origin', async () => {
    for (const next of [
      'https://evil.test/agent964/acme/questions',
      '//evil.test/agent964/acme/questions',
    ]) {
      const back = await signInFromScreen(new Browser(), fresh(), next)
      expect(back.origin, next).toBe(ORIGIN)
      expect(landing(back), next).toBe('/')
    }
  })
})
