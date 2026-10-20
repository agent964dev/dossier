// Starting a sign-in from the browser: the provider the person chose goes to
// Better Auth's start route, and a start that fails throws so the screen can
// say so.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startSignIn } from '../src/lib/auth-client.ts'

const realFetch = globalThis.fetch
const scope = globalThis as unknown as { window?: unknown }
const realWindow = scope.window

/** Where the browser was sent. */
let assigned: string[] = []

beforeEach(() => {
  assigned = []
  scope.window = {
    location: {
      origin: 'https://dossier.test',
      assign: (url: string) => {
        assigned.push(url)
      },
    },
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
  scope.window = realWindow
})

interface Sent {
  readonly url: string
  readonly method: string | undefined
  readonly contentType: string | null
  readonly body: unknown
}

const answering = (status: number, body: unknown) => {
  const sent: Sent[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method,
      contentType: new Headers(init?.headers).get('content-type'),
      body: JSON.parse(String(init?.body ?? 'null')) as unknown,
    })
    return Response.json(body, { status })
  }) as typeof fetch
  return sent
}

describe('starting a sign-in in the browser', () => {
  it.each([
    {
      provider: 'microsoft',
      url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1',
    },
    {
      provider: 'google',
      url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
    },
  ] as const)(
    'posts $provider to the start route and goes to the provider',
    async ({ provider, url }) => {
      const sent = answering(200, { url, redirect: true })
      await expect(
        startSignIn(provider, '/acme/plan?x=1#c'),
      ).resolves.toBeUndefined()
      expect(sent).toEqual([
        {
          url: '/_/auth/sign-in/social',
          method: 'POST',
          contentType: 'application/json',
          body: {
            provider,
            callbackURL: '/acme/plan?x=1#c',
            errorCallbackURL: `/_/sign-in?next=${encodeURIComponent('/acme/plan?x=1#c')}`,
          },
        },
      ])
      expect(assigned).toEqual([url])
    },
  )

  it('continues to the front page when next leaves the origin', async () => {
    const sent = answering(200, { url: 'https://login.microsoftonline.com/x' })
    await startSignIn('microsoft', 'https://evil.test/acme')
    expect(sent[0]?.body).toMatchObject({
      provider: 'microsoft',
      callbackURL: '/',
      errorCallbackURL: `/_/sign-in?next=${encodeURIComponent('/')}`,
    })
  })

  it.each([400, 404, 500])(
    'throws and goes nowhere when the start answers %i',
    async (status) => {
      answering(status, { message: 'Provider not found' })
      await expect(startSignIn('microsoft', '/')).rejects.toThrow(
        'Sign-in did not start',
      )
      expect(assigned).toEqual([])
    },
  )

  it('throws and goes nowhere when the start names no provider URL', async () => {
    answering(200, { redirect: true })
    await expect(startSignIn('google', '/')).rejects.toThrow(
      'Sign-in did not start',
    )
    expect(assigned).toEqual([])
  })

  it('throws when the start cannot be reached', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Network connection lost.')
    }) as unknown as typeof fetch
    await expect(startSignIn('microsoft', '/')).rejects.toThrow()
    expect(assigned).toEqual([])
  })
})
