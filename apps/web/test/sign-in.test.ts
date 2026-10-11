import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { SignIn } from '../src/core/index.ts'
import { Browser, SESSION_COOKIE, signedIn } from './support/browser.ts'
import { count, exec, rows } from './support/d1.ts'
import { ORIGIN } from './support/harness.ts'
import { callerOf, fresh, run, runAs } from './support/people.ts'

const userIdOf = async (email: string) =>
  (
    await rows<{ id: string }>('select id from "user" where email = ?', email)
  )[0]?.id

const accountIdOf = async (sub: string) =>
  (
    await rows<{ id: string }>(
      'select id from account where account_id = ?',
      sub,
    )
  )[0]?.id

const historyOf = async (userId: string) =>
  (
    await rows<{ kind: string; detail_json: string }>(
      'select kind, detail_json from person_history where user_id = ? order by created_at',
      userId,
    )
  ).map((row) => ({
    kind: row.kind,
    detail: JSON.parse(row.detail_json) as unknown,
  }))

const me = (browser: Browser) => browser.fetch('/_/api/me', { purpose: 'read' })

const keyWorks = async (key: string) =>
  (
    await SELF.fetch(`${ORIGIN}/_/api/me`, {
      headers: { authorization: `Bearer ${key}` },
    })
  ).status === 200

describe('signing in with Google', () => {
  it('creates a new person and nothing else', async () => {
    const identity = fresh('gmail.com', 'sara')
    const before = {
      people: await count('people'),
      superAdmins: await count('super_admins'),
      keys: await count('agent_keys'),
      history: await count('person_history'),
    }
    const browser = new Browser()
    const response = await browser.signIn(identity, '/agent964/acme/plan')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/agent964/acme/plan')

    const userId = await userIdOf(identity.email)
    expect(userId).toBeDefined()
    expect(await count('account', 'user_id = ?', userId)).toBe(1)
    expect(await count('session', 'user_id = ?', userId)).toBe(1)
    expect((await count('people')) - before.people).toBe(1)
    expect(await count('super_admins')).toBe(before.superAdmins)
    expect(await count('agent_keys')).toBe(before.keys)
    expect(await count('person_history')).toBe(before.history)
    const [person] = await rows<{ email_authority: string }>(
      'select email_authority from people where user_id = ?',
      userId,
    )
    expect(person?.email_authority).toBe('google')
    const [google] = await rows<{
      email: string
      email_authority: string
      hosted_domain: string | null
    }>(
      'select email, email_authority, hosted_domain from google_accounts where account_id = ?',
      await accountIdOf(identity.sub),
    )
    expect(google).toEqual({
      email: identity.email,
      email_authority: 'google',
      hosted_domain: null,
    })

    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    expect(cookie).toBeDefined()
    const attributes = (cookie ?? '')
      .split(';')
      .map((part) => part.trim().toLowerCase())
    expect(attributes).toEqual(
      expect.arrayContaining([
        'max-age=2592000',
        'path=/',
        'httponly',
        'secure',
        'samesite=lax',
      ]),
    )
    expect(attributes.some((part) => part.startsWith('domain='))).toBe(false)
    expect((await me(browser)).status).toBe(200)
  })

  it('joins a second Google account with the same Gmail address to the person', async () => {
    const first = fresh('gmail.com', 'twice')
    await signedIn(first)
    const userId = await userIdOf(first.email)
    const second = { sub: `${first.sub}-second`, email: first.email }
    const browser = await signedIn(second)
    expect(await count('user', 'email = ?', first.email)).toBe(1)
    expect(await count('account', 'user_id = ?', userId)).toBe(2)
    expect((await historyOf(userId ?? '')).map((h) => h.kind)).toEqual([
      'linked',
    ])
    const body = (await (await me(browser)).json()) as {
      person: { id: string }
    }
    expect(body.person.id).toBe(userId)
  })

  it('lets a Workspace account take over a person whose account Google cannot vouch for', async () => {
    const lapsed = fresh('acme.test', 'lina')
    const lapsedBrowser = await signedIn(lapsed)
    const userId = await userIdOf(lapsed.email)
    const lapsedAccount = await accountIdOf(lapsed.sub)
    const [authority] = await rows<{ email_authority: string }>(
      'select email_authority from people where user_id = ?',
      userId,
    )
    expect(authority?.email_authority).toBe('none')
    const key = await runAs(
      await callerOf(lapsedBrowser),
      Effect.flatMap(SignIn, (signIn) =>
        signIn.createKey({ name: 'old laptop' }),
      ),
    )
    expect(await keyWorks(key.secret)).toBe(true)

    const owner = {
      sub: `${lapsed.sub}-workspace`,
      email: lapsed.email,
      hd: 'acme.test',
    }
    const ownerBrowser = await signedIn(owner)

    expect(await accountIdOf(lapsed.sub)).toBeUndefined()
    expect(
      await count('google_accounts', 'account_id = ?', lapsedAccount),
    ).toBe(0)
    expect((await me(lapsedBrowser)).status).toBe(401)
    expect(await keyWorks(key.secret)).toBe(false)
    expect((await me(ownerBrowser)).status).toBe(200)
    const history = await historyOf(userId ?? '')
    expect(history.map((h) => h.kind)).toEqual([
      'key_created',
      'linked',
      'takeover',
    ])
    expect(history[2]?.detail).toEqual({
      by: await accountIdOf(owner.sub),
      detached: [lapsedAccount],
    })
    const [person] = await rows<{ email_authority: string }>(
      'select email_authority from people where user_id = ?',
      userId,
    )
    expect(person?.email_authority).toBe('google')

    // The detached account cannot come back: Google still cannot vouch for it.
    const again = new Browser()
    const refused = await again.signIn(lapsed)
    expect(refused.headers.get('location')).toContain('error=email_unconfirmed')
    expect(await accountIdOf(lapsed.sub)).toBeUndefined()
  })

  it('refuses an account Google cannot vouch for whose email belongs to a person, and names the email', async () => {
    const holder = fresh('gmail.com', 'held')
    const holderEmail = holder.email.replace('@gmail.com', '@acme.test')
    await signedIn({ ...holder, email: holderEmail, hd: 'acme.test' })
    const counts = async () => ({
      users: await count('user'),
      accounts: await count('account'),
      sessions: await count('session'),
      google: await count('google_accounts'),
      history: await count('person_history'),
    })
    const before = await counts()
    const stranger = new Browser()
    const response = await stranger.signIn(
      { sub: `${holder.sub}-stranger`, email: holderEmail },
      '/agent964/acme/plan',
    )
    expect(response.status).toBe(302)
    expect(await counts()).toEqual(before)
    expect(stranger.sessionToken()).toBeUndefined()
    const location = new URL(response.headers.get('location') ?? '', ORIGIN)
    expect(location.pathname).toBe('/_/sign-in')
    expect(location.searchParams.get('error')).toBe('email_unconfirmed')
    expect(location.searchParams.get('next')).toBe('/agent964/acme/plan')
    const notice = await run(
      Effect.flatMap(SignIn, (signIn) =>
        signIn.notice('email_unconfirmed', location.searchParams.get('who')),
      ),
    )
    expect(notice).toEqual({ kind: 'email_unconfirmed', email: holderEmail })
    // A tampered value names nobody.
    const forged = await run(
      Effect.flatMap(SignIn, (signIn) =>
        signIn.notice(
          'email_unconfirmed',
          `${location.searchParams.get('who')}x`,
        ),
      ),
    )
    expect(forged).toBeNull()
  })

  it("keeps a known account's email when Google's new address belongs to someone else", async () => {
    const lina = fresh('gmail.com', 'lina')
    const other = fresh('gmail.com', 'other')
    await signedIn(lina)
    await signedIn(other)
    const linaId = await userIdOf(lina.email)

    const browser = new Browser()
    const response = await browser.signIn(
      { sub: lina.sub, email: other.email },
      '/next/page',
    )
    expect(await userIdOf(lina.email)).toBe(linaId)
    expect(await count('user', 'email = ?', other.email)).toBe(1)
    const history = await historyOf(linaId ?? '')
    expect(history.map((h) => h.kind)).toEqual(['email_kept'])
    expect(history[0]?.detail).toMatchObject({
      kept: lina.email,
      attempted: other.email,
    })
    const location = new URL(response.headers.get('location') ?? '', ORIGIN)
    expect(location.pathname).toBe('/_/sign-in')
    expect(location.searchParams.get('notice')).toBe('email_in_use')
    expect(location.searchParams.get('next')).toBe('/next/page')
    const body = (await (await me(browser)).json()) as {
      person: { email: string }
    }
    expect(body.person.email).toBe(lina.email)

    // A change to a free address follows Google.
    const free = fresh('gmail.com', 'renamed')
    await signedIn({ sub: lina.sub, email: free.email })
    expect(await userIdOf(free.email)).toBe(linaId)
  })

  it('seeds super admins from SUPER_ADMINS at their first sign-in only', async () => {
    await exec(
      `delete from "user" where email in ('root@example.com', 'chief@example.com')`,
    )
    await signedIn({ sub: 'root-1', email: 'root@example.com' })
    await signedIn({ sub: 'chief-1', email: 'Chief@Example.com' })
    const rootId = await userIdOf('root@example.com')
    const chiefId = await userIdOf('chief@example.com')
    const [seeded] = await rows<{ added_by: string | null }>(
      'select added_by from super_admins where user_id = ?',
      rootId,
    )
    expect(seeded).toEqual({ added_by: null })
    expect(await count('super_admins', 'user_id = ?', chiefId)).toBe(1)

    await exec('delete from super_admins where user_id = ?', rootId)
    await signedIn({ sub: 'root-1', email: 'root@example.com' })
    expect(await count('super_admins', 'user_id = ?', rootId)).toBe(0)

    const nobody = fresh()
    await signedIn(nobody)
    expect(
      await count('super_admins', 'user_id = ?', await userIdOf(nobody.email)),
    ).toBe(0)
  })

  it('keeps sessions for 30 days and renews them after an hour of use', async () => {
    const identity = fresh()
    const browser = await signedIn(identity)
    const userId = await userIdOf(identity.email)
    const day = 24 * 60 * 60 * 1000

    const fresher = await me(browser)
    expect(fresher.status).toBe(200)
    expect(fresher.headers.getSetCookie()).toEqual([])

    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
    await exec(
      'update session set updated_at = ?, expires_at = ? where user_id = ?',
      twoHoursAgo,
      twoHoursAgo + 30 * day,
      userId,
    )
    const renewed = await me(browser)
    expect(renewed.status).toBe(200)
    const cookie = renewed.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    expect(cookie?.toLowerCase()).toContain('max-age=2592000')
    const [session] = await rows<{ expires_at: number }>(
      'select expires_at from session where user_id = ?',
      userId,
    )
    expect(session?.expires_at).toBeGreaterThan(Date.now() + 30 * day - 60_000)

    // Renewal reaches a screen's response too.
    await exec(
      'update session set updated_at = ?, expires_at = ? where user_id = ?',
      twoHoursAgo,
      twoHoursAgo + 30 * day,
      userId,
    )
    const screen = await browser.fetch('/')
    expect(
      screen.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${SESSION_COOKIE}=`)),
    ).toBe(true)
  })

  it('reads sessions signed the way dev-session.ts signs them', async () => {
    const { signedSessionCookie } = await import('../scripts/session-cookie.ts')
    const identity = fresh()
    await signedIn(identity)
    const userId = await userIdOf(identity.email)
    const token = 'abcdefghijklmnopqrstuvwxyz012345'
    const now = Date.now()
    await exec(
      'insert into session (id, user_id, token, expires_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
      `minted-${now}`,
      userId,
      token,
      now + 60_000_000,
      now,
      now,
    )
    const cookie = await signedSessionCookie(token, env.BETTER_AUTH_SECRET)
    const response = await SELF.fetch(`${ORIGIN}/_/api/me`, {
      headers: {
        cookie: `${SESSION_COOKIE}=${cookie}`,
        'sec-fetch-site': 'same-origin',
      },
    })
    expect(response.status).toBe(200)
  })
})
