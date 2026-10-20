import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SignIn } from '../src/core/index.ts'
import { Browser, signedIn } from './support/browser.ts'
import { count, exec, rows } from './support/d1.ts'
import type { FakeIdentity } from './support/fake-google.ts'
import { ORIGIN } from './support/harness.ts'
import { run } from './support/people.ts'
import { person, workspace } from './support/trees.ts'

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'

const userOf = async (email: string) =>
  (
    await rows<{ id: string; email_verified: number }>(
      'select id, email_verified from "user" where email = ?',
      email,
    )
  )[0]

const accountsOf = (userId: string) =>
  rows<{ account_id: string }>(
    'select account_id from account where user_id = ? order by created_at',
    userId,
  )

const counts = async () => ({
  users: await count('user'),
  accounts: await count('account'),
  sessions: await count('session'),
  emails: await count('account_emails'),
  people: await count('people'),
})

const noticeOf = async (response: Response) => {
  const location = new URL(response.headers.get('location') ?? '', ORIGIN)
  const kind =
    location.searchParams.get('error') ?? location.searchParams.get('notice')
  const notice = await run(
    Effect.flatMap(SignIn, (signIn) =>
      signIn.notice(kind, location.searchParams.get('who')),
    ),
  )
  return { location, kind, notice }
}

const base64url = (text: string) =>
  btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const unbase64url = (value: string) =>
  atob(value.replaceAll('-', '+').replaceAll('_', '/'))

/**
 * Changes the claims of the ID tokens Google's stand-in issues until the
 * returned function runs. A key set to undefined leaves the claim out. The
 * sign-in library decodes the token without its signature, as it does in the
 * redirect sign-in.
 */
const rewriteTokens = (claims: Readonly<Record<string, unknown>>) => {
  const inner = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await inner(input, init)
    const url = new Request(input, init).url
    if (url !== GOOGLE_TOKEN || response.status !== 200) return response
    const body = (await response.json()) as { id_token: string }
    const [header = '', payload = '', signature = ''] = body.id_token.split('.')
    const decoded = JSON.parse(unbase64url(payload)) as Record<string, unknown>
    for (const [key, value] of Object.entries(claims)) {
      if (value === undefined) delete decoded[key]
      else decoded[key] = value
    }
    return Response.json({
      ...body,
      id_token: `${header}.${base64url(JSON.stringify(decoded))}.${signature}`,
    })
  }) as typeof fetch
  return () => {
    globalThis.fetch = inner
  }
}

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
  vi.restoreAllMocks()
})

/** Collects the diagnostic lines written from now on. */
const diagnostics = () => {
  const log = vi.spyOn(console, 'log')
  return () =>
    log.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((line) => line?.message === 'sign-in refused')
}

let serial = 0
const identity = (
  domain: string,
  extra: Partial<FakeIdentity> = {},
): FakeIdentity => {
  serial += 1
  const tag = `${Date.now().toString(36)}g${serial}`
  return { sub: `gate-${tag}`, email: `gate-${tag}@${domain}`, ...extra }
}

describe('the sign-in gate', () => {
  it('refuses a new account whose email Google does not confirm, and creates nothing', async () => {
    const lines = diagnostics()
    const before = await counts()
    const unconfirmed = identity('gmail.com', { email_verified: false })
    const browser = new Browser()
    const response = await browser.signIn(unconfirmed, '/agent964/acme/plan')
    expect(await counts()).toEqual(before)
    expect(browser.sessionToken()).toBeUndefined()
    const { location, kind, notice } = await noticeOf(response)
    expect(location.pathname).toBe('/_/sign-in')
    expect(kind).toBe('not_confirmed')
    expect(location.searchParams.get('next')).toBe('/agent964/acme/plan')
    expect(notice).toEqual({
      kind: 'not_confirmed',
      provider: 'google',
      email: unconfirmed.email,
    })
    // Google writes a line only for a failed token check.
    expect(lines()).toEqual([])
  })

  it('shows the same refusal when the sign-in library refuses an unconfirmed join first', async () => {
    const holder = identity('acme.test', { hd: 'acme.test' })
    await signedIn(holder)
    const before = await counts()
    const response = await new Browser().signIn({
      sub: `${holder.sub}-unconfirmed`,
      email: holder.email,
      email_verified: false,
    })
    expect(await counts()).toEqual(before)
    const { kind, notice } = await noticeOf(response)
    expect(kind).toBe('not_confirmed')
    expect(notice).toEqual({
      kind: 'not_confirmed',
      provider: 'google',
      email: holder.email,
    })
  })

  it('refuses a token that carries no email', async () => {
    const before = await counts()
    restore = rewriteTokens({ email: undefined })
    const response = await new Browser().signIn(identity('gmail.com'))
    expect(await counts()).toEqual(before)
    const { kind, notice } = await noticeOf(response)
    expect(kind).toBe('no_email')
    expect(notice).toEqual({ kind: 'no_email', provider: 'google' })
  })

  it.each([
    ['issuer', { iss: 'https://accounts.example.com' }],
    ['audience', { aud: 'another-client' }],
    ['audience', { aud: undefined }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 120 }],
  ] as const)(
    'refuses a token that fails the %s check with the generic message and one line',
    async (check, claims) => {
      const lines = diagnostics()
      const before = await counts()
      restore = rewriteTokens(claims)
      const browser = new Browser()
      const response = await browser.signIn(identity('gmail.com'))
      expect(await counts()).toEqual(before)
      expect(browser.sessionToken()).toBeUndefined()
      const { location, notice } = await noticeOf(response)
      expect(location.pathname).toBe('/_/sign-in')
      expect(location.searchParams.get('error')).not.toBeNull()
      expect(location.searchParams.get('who')).toBeNull()
      expect(notice).toBeNull()
      expect(lines()).toEqual([
        {
          message: 'sign-in refused',
          provider: 'google',
          reason: 'token_check',
          error: null,
          check,
          account: null,
          carried: null,
          xms_edov: null,
        },
      ])
    },
  )

  it('lets a token with the client among its audiences through', async () => {
    const lines = diagnostics()
    restore = rewriteTokens({ aud: ['another-client', env.GOOGLE_CLIENT_ID] })
    const browser = new Browser()
    const response = await browser.signIn(identity('gmail.com'))
    expect(response.headers.get('location')).toBe('/')
    expect(browser.sessionToken()).toBeDefined()
    expect(lines()).toEqual([])
  })

  it('puts the token check before the refusals the sign-in library makes first', async () => {
    const holder = identity('acme.test', { hd: 'acme.test' })
    await signedIn(holder)
    const lines = diagnostics()
    restore = rewriteTokens({ iss: 'https://accounts.example.com' })
    const join = await new Browser().signIn({
      sub: `${holder.sub}-unconfirmed`,
      email: holder.email,
      email_verified: false,
    })
    expect((await noticeOf(join)).notice).toBeNull()
    restore()
    restore = rewriteTokens({
      iss: 'https://accounts.example.com',
      email: undefined,
    })
    const empty = await new Browser().signIn(identity('gmail.com'))
    expect((await noticeOf(empty)).notice).toBeNull()
    expect(lines().map((line) => [line?.reason, line?.check])).toEqual([
      ['token_check', 'issuer'],
      ['token_check', 'issuer'],
    ])
  })

  it.each([true, false])(
    "keeps a known account's stored email and its verified flag (%s) when Google does not confirm the new one",
    async (verified) => {
      const lina = identity('gmail.com')
      await signedIn(lina)
      const linaId = (await userOf(lina.email))?.id ?? ''
      await exec(
        'update "user" set email_verified = ? where id = ?',
        verified ? 1 : 0,
        linaId,
      )
      const attempted = identity('gmail.com').email
      const admin = await person('inviter')
      const ws = await workspace(admin)
      await exec(
        `insert into invitations (workspace_id, email, team_ids_json, invited_by, created_at)
         values (?, ?, '[]', ?, ?)`,
        ws.id,
        attempted,
        admin.id,
        Date.now(),
      )

      const browser = new Browser()
      const response = await browser.signIn(
        { sub: lina.sub, email: attempted, email_verified: false },
        '/next/page',
      )
      expect(browser.sessionToken()).toBeDefined()
      expect(await userOf(lina.email)).toEqual({
        id: linaId,
        email_verified: verified ? 1 : 0,
      })
      expect(await userOf(attempted)).toBeUndefined()
      expect(await count('workspace_members', 'user_id = ?', linaId)).toBe(0)
      expect(await count('invitations', 'email = ?', attempted)).toBe(1)
      const { location, kind, notice } = await noticeOf(response)
      expect(kind).toBe('kept_unconfirmed')
      expect(location.searchParams.get('next')).toBe('/next/page')
      expect(notice).toEqual({
        kind: 'kept_unconfirmed',
        provider: 'google',
        email: attempted,
      })
      const [kept] = await rows<{ detail_json: string }>(
        `select detail_json from person_history where user_id = ? and kind = 'email_kept'`,
        linaId,
      )
      expect(JSON.parse(kept?.detail_json ?? '{}')).toMatchObject({
        kept: lina.email,
        attempted,
        because: 'unconfirmed',
      })
    },
  )

  it('lets an account with authority join a person whose account kept its email', async () => {
    const lina = identity('gmail.com')
    await signedIn(lina)
    const linaId = (await userOf(lina.email))?.id ?? ''
    await signedIn({
      sub: lina.sub,
      email: identity('gmail.com').email,
      email_verified: false,
    })
    const second = await signedIn({
      sub: `${lina.sub}-second`,
      email: lina.email,
    })
    expect(second.sessionToken()).toBeDefined()
    expect(await count('user', 'email = ?', lina.email)).toBe(1)
    const accounts = (await accountsOf(linaId)).map((a) => a.account_id)
    expect(accounts).toHaveLength(2)
    expect(accounts).toEqual(
      expect.arrayContaining([lina.sub, `${lina.sub}-second`]),
    )
  })

  it('records an account whose provider stops vouching for its email as none, and keeps it', async () => {
    const sara = identity('acme.test', { hd: 'acme.test' })
    await signedIn(sara)
    const saraId = (await userOf(sara.email))?.id ?? ''
    const browser = await signedIn({ sub: sara.sub, email: sara.email })
    expect(browser.sessionToken()).toBeDefined()
    expect(
      await rows(
        'select email_authority from people where user_id = ?',
        saraId,
      ),
    ).toEqual([{ email_authority: 'none' }])
    expect(await accountsOf(saraId)).toEqual([{ account_id: sara.sub }])
  })

  it('lets a Workspace account join a person whose stored email is not marked verified', async () => {
    const lapsed = identity('acme.test')
    await signedIn(lapsed)
    const userId = (await userOf(lapsed.email))?.id ?? ''
    await exec('update "user" set email_verified = 0 where id = ?', userId)
    const owner = await signedIn({
      sub: `${lapsed.sub}-workspace`,
      email: lapsed.email,
      hd: 'acme.test',
    })
    expect(owner.sessionToken()).toBeDefined()
    expect(await accountsOf(userId)).toEqual([
      { account_id: `${lapsed.sub}-workspace` },
    ])
  })
})
