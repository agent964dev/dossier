import { afterEach, describe, expect, it } from 'vitest'

import { safeNext, signOut } from '../src/lib/auth-client.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

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
