import { describe, expect, it } from 'vitest'

import { graphPhoto } from '../src/ports/auth.ts'

const PHOTO = 'https://graph.microsoft.com/v1.0/me/photos/48x48/$value'

/** A fetch that answers every request with `answer`, recording what it was asked. */
const graph = (answer: () => Response | Promise<Response>) => {
  const asked: { url: string; authorization: string | null }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    })
    return answer()
  }) as typeof fetch
  return { fetcher, asked }
}

describe('the Microsoft profile photo from Graph', () => {
  it('asks Graph for the 48×48 photo with the access token, and keeps it as a data URL', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const { fetcher, asked } = graph(
      () =>
        new Response(bytes, {
          headers: { 'content-type': 'image/jpeg; charset=binary' },
        }),
    )
    expect(await graphPhoto('access-token', fetcher)).toBe(
      `data:image/jpeg;base64,${btoa(String.fromCharCode(...bytes))}`,
    )
    expect(asked).toEqual([
      { url: PHOTO, authorization: 'Bearer access-token' },
    ])
  })

  it('is none for an account without a photo, a failed download, or anything but an image', async () => {
    for (const answer of [
      () =>
        Response.json({ error: { code: 'ImageNotFound' } }, { status: 404 }),
      () => new Response('busy', { status: 503 }),
      () =>
        new Response('<html></html>', {
          headers: { 'content-type': 'text/html' },
        }),
      () =>
        new Response(new Uint8Array(), {
          headers: { 'content-type': 'image/png' },
        }),
      () => Promise.reject(new TypeError('Network connection lost.')),
    ]) {
      expect(await graphPhoto('access-token', graph(answer).fetcher)).toBeNull()
    }
  })

  it('is none when Graph does not answer in time, so the sign-in goes on', async () => {
    const stalled = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        )
      })) as typeof fetch
    expect(await graphPhoto('access-token', stalled, 20)).toBeNull()
  })
})
