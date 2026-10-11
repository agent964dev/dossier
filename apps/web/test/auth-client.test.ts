import { afterEach, describe, expect, it } from 'vitest'

import { signOut } from '../src/lib/auth-client.ts'

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
