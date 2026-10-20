// A small browser over SELF: a cookie jar, manual redirects, the fetch
// metadata a real browser sends, and the stand-in Google's and Microsoft's
// consent.
import { SELF } from 'cloudflare:test'

import { consent, type FakeIdentity } from './fake-google.ts'
import {
  consentMicrosoft,
  type FakeMicrosoftIdentity,
} from './fake-microsoft.ts'
import { ORIGIN } from './harness.ts'

export const SESSION_COOKIE = '__Secure-dossier.session_token'

let addresses = 0
const freshAddress = () => {
  addresses += 1
  return `198.51.100.${addresses % 250}`
}

type Purpose = 'navigate' | 'read' | 'write' | 'none'

export class Browser {
  readonly jar = new Map<string, string>()
  constructor(readonly address: string = freshAddress()) {}

  cookieHeader(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  sessionToken(): string | undefined {
    return this.jar.get(SESSION_COOKIE)
  }

  /** Sends a request as this browser would for `purpose`. */
  async fetch(
    path: string,
    init: RequestInit & { purpose?: Purpose; host?: string } = {},
  ): Promise<Response> {
    const { purpose = 'navigate', host, ...rest } = init
    const url = new URL(path, host === undefined ? ORIGIN : `https://${host}`)
    const headers = new Headers(rest.headers)
    const cookie = this.cookieHeader()
    if (cookie !== '' && !headers.has('cookie')) headers.set('cookie', cookie)
    headers.set('cf-connecting-ip', this.address)
    if (purpose === 'navigate') {
      headers.set('sec-fetch-mode', 'navigate')
      headers.set('sec-fetch-site', 'same-origin')
    } else if (purpose === 'read') {
      headers.set('sec-fetch-mode', 'cors')
      if (!headers.has('sec-fetch-site'))
        headers.set('sec-fetch-site', 'same-origin')
    } else if (purpose === 'write') {
      headers.set('sec-fetch-mode', 'cors')
      if (!headers.has('sec-fetch-site'))
        headers.set('sec-fetch-site', 'same-origin')
      if (!headers.has('origin')) headers.set('origin', ORIGIN)
      if (!headers.has('dossier-csrf')) headers.set('dossier-csrf', '1')
    }
    const response = await SELF.fetch(url.href, {
      ...rest,
      headers,
      redirect: 'manual',
    })
    this.store(response)
    return response
  }

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = header.split(';')
      const at = pair.indexOf('=')
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      const gone = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a))
      if (gone || value === '') this.jar.delete(name)
      else this.jar.set(name, value)
    }
  }

  /** Better Auth's own routes, as the sign-in screen calls them. */
  postAuth(path: string, body: unknown): Promise<Response> {
    return this.fetch(path, {
      method: 'POST',
      purpose: 'write',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /**
   * Starts a provider's sign-in as the sign-in screen does, and returns the
   * provider's authorization URL.
   */
  async startSignIn(
    provider: 'google' | 'microsoft',
    next = '/',
  ): Promise<string> {
    const start = await this.postAuth('/_/auth/sign-in/social', {
      provider,
      callbackURL: next,
      errorCallbackURL: `/_/sign-in?next=${encodeURIComponent(next)}`,
    })
    if (start.status !== 200) {
      throw new Error(
        `sign-in did not start: ${start.status} ${await start.text()}`,
      )
    }
    const { url } = (await start.json()) as { url: string }
    return url
  }

  /** Returns from the provider to Dossier's callback. */
  callback(url: URL): Promise<Response> {
    return this.fetch(`${url.pathname}${url.search}`)
  }

  /**
   * The whole sign-in: start, the stand-in consent, the callback. A Microsoft
   * identity (one with `tid`) signs in with Microsoft, any other with Google.
   */
  async signIn(
    identity: FakeIdentity | FakeMicrosoftIdentity,
    next = '/',
  ): Promise<Response> {
    if (isMicrosoft(identity)) {
      const url = await this.startSignIn('microsoft', next)
      return this.callback(consentMicrosoft(url, identity))
    }
    const url = await this.startSignIn('google', next)
    return this.callback(consent(url, identity))
  }
}

const isMicrosoft = (
  identity: FakeIdentity | FakeMicrosoftIdentity,
): identity is FakeMicrosoftIdentity => 'tid' in identity

/** A browser already signed in as `identity`. */
export const signedIn = async (
  identity: FakeIdentity | FakeMicrosoftIdentity,
): Promise<Browser> => {
  const browser = new Browser()
  const response = await browser.signIn(identity)
  if (response.status !== 302 || browser.sessionToken() === undefined) {
    throw new Error(
      `sign-in failed: ${response.status} ${response.headers.get('location')}`,
    )
  }
  return browser
}
