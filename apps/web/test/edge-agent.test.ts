import { SELF } from 'cloudflare:test'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  SignIn,
  type CommitResult,
  type StageResult,
} from '../src/core/index.ts'
import { Browser, signedIn } from './support/browser.ts'
import { harness, ORIGIN } from './support/harness.ts'
import { everything } from './support/keys.ts'
import { callerOf, fresh, runAs } from './support/people.ts'
import { agent, pushAll, workspace } from './support/trees.ts'

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
