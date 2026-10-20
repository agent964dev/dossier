import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  safeNext,
  signOut,
  startSignIn,
  switchAccount,
} from '../src/lib/auth-client.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.unstubAllGlobals()
})

/** Requests the page sent, and an answer for each. */
const recording = (answer: () => Response) => {
  const sent: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return answer()
  }) as typeof fetch
  return sent
}

/** Where the page navigated to. */
const navigations = () => {
  const assigned: string[] = []
  vi.stubGlobal('window', {
    location: { assign: (url: string) => assigned.push(url) },
  })
  return assigned
}

const answering = (status: number) => {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response('{}', { status })
  }) as typeof fetch
  return calls
}

describe('signing out in the browser', () => {
  it('finishes when Better Auth ends the session', async () => {
    const calls = answering(200)
    await expect(signOut()).resolves.toBeUndefined()
    expect(calls).toEqual(['/_/auth/sign-out'])
  })

  it('fails when the sign-out request fails, so the screen can say so', async () => {
    answering(500)
    await expect(signOut()).rejects.toThrow('Sign-out did not finish (500)')
  })
})

describe('where sign-in continues to', () => {
  const origin = 'https://dossier.test'

  it('keeps a path on this origin as given', () => {
    expect(safeNext('/acme/plan?x=1#c', origin)).toBe('/acme/plan?x=1#c')
    expect(safeNext('/', origin)).toBe('/')
  })

  it("turns a URL on the deployment's own origin into its path, query and fragment", () => {
    expect(safeNext('https://dossier.test/acme/plan?x=1#c', origin)).toBe(
      '/acme/plan?x=1#c',
    )
    expect(safeNext('https://dossier.test', origin)).toBe('/')
  })

  it('sends anything that leaves the origin home', () => {
    for (const next of [
      'https://t1.content.test/acme/plan',
      'https://evil.test/acme/plan',
      'http://dossier.test/acme/plan',
      'https://dossier.test:8443/acme/plan',
      'https://dossier.test//evil.test/x',
      'https://dossier.test/\\evil.test/x',
      '//evil.test',
      '/\\evil.test',
      '/\t/evil.test',
      'javascript:alert(1)',
      'acme/plan',
      '',
      undefined,
      42,
    ]) {
      expect(safeNext(next, origin)).toBe('/')
    }
  })
})

describe('starting a sign-in in the browser', () => {
  it("posts the chosen provider and goes to the provider's page", async () => {
    for (const provider of ['google', 'microsoft'] as const) {
      const assigned = navigations()
      const sent = recording(() =>
        Response.json({ url: `https://${provider}.example/authorize` }),
      )
      await startSignIn(provider, '/acme/plan?x=1')
      expect(sent).toEqual([
        {
          url: '/_/auth/sign-in/social',
          body: {
            provider,
            callbackURL: '/acme/plan?x=1',
            errorCallbackURL: '/_/sign-in?next=%2Facme%2Fplan%3Fx%3D1',
          },
        },
      ])
      expect(assigned).toEqual([`https://${provider}.example/authorize`])
    }
  })

  it('continues to / for a next that leaves the deployment', async () => {
    navigations()
    const sent = recording(() => Response.json({ url: 'https://x.example' }))
    await startSignIn('microsoft', 'https://evil.test/x')
    expect(sent[0]?.body).toMatchObject({
      callbackURL: '/',
      errorCallbackURL: '/_/sign-in?next=%2F',
    })
  })

  it('throws when the start fails, so the screen can say so', async () => {
    const assigned = navigations()
    recording(() => new Response('{}', { status: 500 }))
    await expect(startSignIn('microsoft', '/')).rejects.toThrow(
      'Sign-in did not start (500)',
    )
    recording(() => Response.json({}))
    await expect(startSignIn('google', '/')).rejects.toThrow(
      'Sign-in did not start',
    )
    expect(assigned).toEqual([])
  })
})

describe('using another account', () => {
  it('signs out, then opens the sign-in screen with where to continue', async () => {
    const assigned = navigations()
    const calls = answering(200)
    await switchAccount('/acme/plan?x=1')
    expect(calls).toEqual(['/_/auth/sign-out'])
    expect(assigned).toEqual(['/_/sign-in?next=%2Facme%2Fplan%3Fx%3D1'])
  })

  it('stays when the sign-out fails', async () => {
    const assigned = navigations()
    answering(500)
    await expect(switchAccount('/')).rejects.toThrow('Sign-out did not finish')
    expect(assigned).toEqual([])
  })
})
