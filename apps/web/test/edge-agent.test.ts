import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  SignIn,
  type CommitResult,
  type StageResult,
} from '../src/core/index.ts'
import { bearerOf } from '../src/edge/caller.ts'
import { Browser, signedIn } from './support/browser.ts'
import { harness, ORIGIN } from './support/harness.ts'
import { everything } from './support/keys.ts'
import { callerOf, fresh, runAs } from './support/people.ts'
import { agent, pushAll, ref, workspace } from './support/trees.ts'

afterEach(() => harness.reset())

const committed = (result: CommitResult | StageResult): CommitResult => {
  if (!('number' in result)) throw new Error('the push did not commit')
  return result
}

const PDF = '%PDF-1.7 0123456789'
const FILES = {
  'plan.html': '<!doctype html><title>Plan</title><p>The plan</p>',
  'plan.md': '# Plan\n\nThe agent version.\n',
  'notes/index.html': '<title>Notes</title><p>Notes</p>',
  'brief.pdf': PDF,
}

let owner: Browser
let key: string
let base: string

/** A real agent key of the browser's person, as settings would mint it. */
const keyOf = async (browser: Browser) =>
  (
    await runAs(
      await callerOf(browser),
      Effect.flatMap(SignIn, (signIn) =>
        signIn.createKey({ name: 'agent', ...everything }),
      ),
    )
  ).secret

beforeAll(async () => {
  owner = await signedIn(fresh())
  const caller = await callerOf(owner)
  const ws = await workspace(caller.person!)
  committed(
    await pushAll(await agent(caller.person!), `${ws.name}/acme`, FILES),
  )
  key = await keyOf(owner)
  base = `${ws.name}/acme`
})

const withKey = (path: string, secret: string, accept?: string) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${secret}`,
      ...(accept === undefined ? {} : { accept }),
    },
  })

const apiRead = async (path: string, secret: string) => {
  const response = await SELF.fetch(
    `${ORIGIN}/_/api/read?path=${encodeURIComponent(path)}`,
    { headers: { authorization: `Bearer ${secret}` } },
  )
  expect(response.status).toBe(200)
  return (await response.json()) as { text: string }
}

describe('a link asked by an agent', () => {
  it('returns the read endpoint’s text to Accept: text/markdown with a session and to an agent key alone', async () => {
    const expected = (await apiRead(`${base}/plan`, key)).text
    expect(expected).toBe(
      '# Plan\n\nThe agent version.\n\nData: none · Comments: 0\n',
    )

    const bySession = await owner.fetch(`/${base}/plan`, {
      headers: { accept: 'text/markdown' },
    })
    const byKey = await withKey(`/${base}/plan`, key)
    for (const response of [bySession, byKey]) {
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(
        'text/markdown; charset=utf-8',
      )
      expect(response.headers.get('vary')).toContain('Accept')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-security-policy')).toBe('sandbox')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await response.text()).toBe(expected)
    }
  })

  it('reads through the link’s redirects rather than answering them', async () => {
    const folder = await withKey(`/${base}`, key)
    expect(folder.status).toBe(200)
    expect(await folder.text()).toBe((await apiRead(`${base}/`, key)).text)
    const page = await withKey(`/${base}/plan.html`, key)
    expect(page.status).toBe(200)
    expect(await page.text()).toBe((await apiRead(`${base}/plan`, key)).text)
  })

  it('takes text/markdown only with a q above 0', async () => {
    const refused = await owner.fetch(`/${base}/plan`, {
      headers: { accept: 'text/markdown;q=0, text/html' },
    })
    expect(refused.headers.get('content-type')).toContain('text/html')
    expect(refused.headers.get('vary')).toContain('Accept')
  })

  it('gives the shell to a browser, varying by Accept', async () => {
    const shell = await owner.fetch(`/${base}/plan`)
    expect(shell.status).toBe(200)
    expect(shell.headers.get('content-type')).toContain('text/html')
    expect(shell.headers.get('vary')).toContain('Accept')
    const listing = await owner.fetch(`/${base}/`)
    expect(listing.headers.get('vary')).toContain('Accept')
  })

  it('downloads an attachment, never showing it on the main host', async () => {
    const response = await withKey(`/${base}/brief.pdf`, key, 'text/markdown')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''brief.pdf",
    )
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    )
    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(PDF)
  })

  it('answers a visitor with 401 and the error body, not the sign-in redirect', async () => {
    const response = await new Browser().fetch(`/${base}/plan`, {
      headers: { accept: 'text/markdown' },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.json()).toMatchObject({
      error: { code: 'sign_in_required', path: 'plan' },
    })
  })

  it('answers a refused key with 401 and the error body', async () => {
    const response = await withKey(`/${base}/plan`, 'dsk_unknown')
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'sign_in_required' },
    })
  })

  it('answers a person without access with 404 and the same error body for a path that exists and one that does not', async () => {
    const outsiderKey = await keyOf(await signedIn(fresh()))
    const bodies: unknown[] = []
    for (const path of ['plan', 'nowhere']) {
      const response = await withKey(`/${base}/${path}`, outsiderKey)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/json')
      const body = (await response.json()) as {
        error: { code: string; path: string }
      }
      expect(body.error).toMatchObject({ code: 'not_found', path })
      bodies.push({ ...body.error, path: null })
    }
    expect(bodies[0]).toEqual(bodies[1])
  })
})

describe('a malformed Bearer header', () => {
  /** The owner's key reaching only notes/, as settings would mint it. */
  const scopedKey = async () =>
    (
      await runAs(
        await callerOf(owner),
        Effect.flatMap(SignIn, (signIn) =>
          signIn.createKey({
            name: 'notes only',
            reach: { kind: 'node', ref: ref(`${base}/notes/`) },
            readOnly: false,
          }),
        ),
      )
    ).secret

  /** Ages the owner's session past the renewal age, so a lookup renews it. */
  const ageSession = async () => {
    const token = decodeURIComponent(owner.sessionToken() ?? '').split('.')[0]
    await env.DB.prepare('update session set expires_at = ? where token = ?')
      .bind(Date.now() + 30 * 86_400_000 - 2 * 3_600_000, token)
      .run()
  }

  const malformed = (secret: string) => [
    `Bearer ${secret} extra-token`,
    'Bearer',
    'Bearer ',
    `bearer\t${secret}\textra`,
  ]

  it('fails closed on a link: 401 and the error body, never the session cookie', async () => {
    const secret = await scopedKey()
    // The scoped key alone cannot read the private sibling; the cookie can.
    expect((await withKey(`/${base}/plan`, secret)).status).toBe(404)
    await ageSession()
    const control = await owner.fetch(`/${base}/plan`, {
      headers: { accept: 'text/markdown' },
    })
    expect(control.status).toBe(200)
    expect(control.headers.getSetCookie()).not.toEqual([])
    for (const header of malformed(secret)) {
      await ageSession()
      const response = await owner.fetch(`/${base}/plan`, {
        headers: { authorization: header },
      })
      expect(response.status, header).toBe(401)
      expect(response.headers.getSetCookie(), header).toEqual([])
      expect(await response.json()).toMatchObject({
        error: { code: 'sign_in_required' },
      })
    }
  })

  it('fails closed on the API the same way', async () => {
    const secret = await scopedKey()
    for (const header of malformed(secret)) {
      await ageSession()
      const response = await owner.fetch(
        `/_/api/read?path=${encodeURIComponent(`${base}/plan`)}`,
        { purpose: 'read', headers: { authorization: header } },
      )
      expect(response.status, header).toBe(401)
      expect(response.headers.getSetCookie(), header).toEqual([])
    }
  })

  it('leaves another scheme to the cookie rules, as before', async () => {
    const response = await owner.fetch(`/${base}/plan`, {
      headers: { authorization: 'Basic dXNlcjpwYXNz', accept: 'text/markdown' },
    })
    expect(response.status).toBe(200)
  })
})

describe('a folder beside a page of the same name', () => {
  it('reads open/ as the folder and open as the page, for a key scoped to the folder too', async () => {
    const caller = await callerOf(owner)
    const ws = await workspace(caller.person!)
    committed(
      await pushAll(await agent(caller.person!), `${ws.name}/twins`, {
        'open.html': '<title>Open page</title><p>The page</p>',
        'open/note.txt': 'A note in the folder',
      }),
    )
    const read = async (path: string, secret: string) => {
      const response = await SELF.fetch(
        `${ORIGIN}/_/api/read?path=${encodeURIComponent(path)}`,
        { headers: { authorization: `Bearer ${secret}` } },
      )
      return { status: response.status, body: (await response.json()) as never }
    }
    expect((await read(`${ws.name}/twins/open/`, key)).body).toMatchObject({
      kind: 'folder',
      path: 'open',
    })
    expect((await read(`${ws.name}/twins/open`, key)).body).toMatchObject({
      kind: 'page',
      path: 'open.html',
    })
    const scoped = (
      await runAs(
        caller,
        Effect.flatMap(SignIn, (signIn) =>
          signIn.createKey({
            name: 'open only',
            reach: { kind: 'node', ref: ref(`${ws.name}/twins/open/`) },
            readOnly: true,
          }),
        ),
      )
    ).secret
    const own = await read(`${ws.name}/twins/open/`, scoped)
    expect(own.status).toBe(200)
    expect(own.body).toMatchObject({ kind: 'folder', path: 'open' })
    expect((await read(`${ws.name}/twins/open`, scoped)).status).toBe(404)
  })
})

describe('several credentials in one Authorization value', () => {
  const scopedKey = async () =>
    (
      await runAs(
        await callerOf(owner),
        Effect.flatMap(SignIn, (signIn) =>
          signIn.createKey({
            name: 'notes only, twice',
            reach: { kind: 'node', ref: ref(`${base}/notes/`) },
            readOnly: false,
          }),
        ),
      )
    ).secret

  it('reads only a lone well-formed Bearer as a key, and every other Bearer as malformed', () => {
    expect(bearerOf('Bearer dsk_a')).toEqual({ kind: 'key', secret: 'dsk_a' })
    expect(bearerOf('Basic abc')).toEqual({ kind: 'none' })
    expect(bearerOf('Digest username="a", realm="b", nonce="c"')).toEqual({
      kind: 'none',
    })
    for (const value of [
      'Basic abc, Bearer dsk_a extra',
      'Basic abc, Bearer dsk_a',
      'Bearer dsk_a, Basic abc',
      'Bearer dsk_a, Bearer dsk_b',
      'Basic abc, Basic def',
      'Bearer dsk_a,',
      'Basic Bearer',
    ]) {
      expect(bearerOf(value), value).toEqual({ kind: 'malformed' })
    }
  })

  it('fails closed when duplicate Authorization headers coalesce, on a link and on the API', async () => {
    const secret = await scopedKey()
    for (const [first, second] of [
      ['Basic abc', `Bearer ${secret} extra`],
      ['Basic abc', `Bearer ${secret}`],
      [`Bearer ${secret}`, 'Basic abc'],
    ]) {
      const headers = new Headers()
      headers.append('authorization', first!)
      headers.append('authorization', second!)
      const link = await owner.fetch(`/${base}/plan`, { headers })
      expect(link.status, `${first} + ${second}`).toBe(401)
      expect(link.headers.getSetCookie()).toEqual([])
      const api = await owner.fetch(
        `/_/api/read?path=${encodeURIComponent(`${base}/plan`)}`,
        { purpose: 'read', headers },
      )
      expect(api.status, `${first} + ${second}`).toBe(401)
    }
  })
})
