// What a Google sign-in shows when Dossier refuses it or keeps the person's
// email, through Better Auth's real routes and the stand-in Google: the
// notice in the redirect, what was written, and the one log line a failed
// token check leaves.
import type { TreeId } from '@dossier/contracts'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { SignIn } from '../src/core/index.ts'
import { Browser, signedIn } from './support/browser.ts'
import { count, exec, rows } from './support/d1.ts'
import type { FakeIdentity } from './support/fake-google.ts'
import { ORIGIN } from './support/harness.ts'
import { fresh, run } from './support/people.ts'
import {
  agent,
  nodeAt,
  person,
  pushAll,
  share,
  workspace,
} from './support/trees.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

const NEXT = '/agent964/acme/plan?x=1'
const NOTICE_KINDS = [
  'email_unconfirmed',
  'not_confirmed',
  'no_email',
  'email_in_use',
  'kept_unconfirmed',
]

let owner: Awaited<ReturnType<typeof person>>
let ws: { id: string; name: string }
let treeId: TreeId

beforeAll(async () => {
  owner = await person('owner')
  ws = await workspace(owner)
  const pushed = await pushAll(
    await agent(owner),
    `${ws.name}/n${crypto.randomUUID().slice(0, 8)}`,
    {
      'mine.html': '<!doctype html><title>Mine</title><p>Mine</p>',
      'theirs.html': '<!doctype html><title>Theirs</title><p>Theirs</p>',
    },
  )
  if (!('treeId' in pushed)) throw new Error('no tree')
  treeId = pushed.treeId
})

const userIdOf = async (email: string) =>
  (
    await rows<{ id: string }>('select id from "user" where email = ?', email)
  )[0]?.id

const accountOf = async (sub: string) =>
  (
    await rows<{ id: string; user_id: string }>(
      'select id, user_id from account where account_id = ?',
      sub,
    )
  )[0]

const storedUser = async (userId: string | undefined) =>
  (
    await rows<{ email: string; email_verified: number }>(
      'select email, email_verified from "user" where id = ?',
      userId,
    )
  )[0]

/** Everything a sign-in could write. */
const everything = async () => ({
  users: await count('user'),
  accounts: await count('account'),
  sessions: await count('session'),
  emails: await count('account_emails'),
  people: await count('people'),
  history: await count('person_history'),
  members: await count('workspace_members'),
  invitations: await count('invitations'),
})

const invite = (email: string) =>
  exec(
    `insert into invitations (workspace_id, email, team_ids_json, invited_by, created_at)
     values (?, ?, '[]', ?, ?)`,
    ws.id,
    email,
    owner.id,
    Date.now(),
  )

const shareWith = async (path: string, email: string) =>
  share(treeId, (await nodeAt(treeId, path))!.id, 'email', email, 'read', owner)

/** Whether this browser may open a page of the tree. */
const opens = async (browser: Browser, path: string) =>
  (
    await browser.fetch('/_/api/view', {
      method: 'POST',
      purpose: 'write',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tree: treeId, path }),
    })
  ).status === 200

const me = async (browser: Browser) => {
  const response = await browser.fetch('/_/api/me', { purpose: 'read' })
  if (response.status !== 200) return null
  return ((await response.json()) as { person: { id: string; email: string } })
    .person
}

const landing = (response: Response) =>
  new URL(response.headers.get('location') ?? '', ORIGIN)

const noticeOf = (kind: string | null, who: string | null) =>
  run(Effect.flatMap(SignIn, (signIn) => signIn.notice(kind, who)))

/** The sign-in diagnostic lines logged while `body` runs, and its result. */
const diagnostics = async <A>(body: () => Promise<A>) => {
  const log = vi.spyOn(console, 'log')
  const result = await body()
  const lines = log.mock.calls
    .map((call) => call[0])
    .filter((line): line is string => typeof line === 'string')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
    .filter((line) => line.message === 'sign-in refused')
  log.mockRestore()
  return { result, lines }
}

/** A sign-in in a new browser, with the lines it logged. */
const attempt = (identity: FakeIdentity, next = NEXT) =>
  diagnostics(async () => {
    const browser = new Browser()
    const response = await browser.signIn(identity, next)
    return { browser, response }
  })

interface Attempt {
  readonly browser: Browser
  readonly response: Response
}

/** The sign-in screen with the refusal `notice` names, and no session. */
const expectRefusal = async (
  { browser, response }: Attempt,
  notice: { readonly kind: string } & Record<string, unknown>,
) => {
  expect(response.status).toBe(302)
  expect(browser.sessionToken()).toBeUndefined()
  const location = landing(response)
  expect(location.origin).toBe(ORIGIN)
  expect(location.pathname).toBe('/_/sign-in')
  expect(location.searchParams.get('error')).toBe(notice.kind)
  expect(location.searchParams.get('notice')).toBeNull()
  expect(location.searchParams.get('next')).toBe(NEXT)
  expect(
    await noticeOf(
      location.searchParams.get('error'),
      location.searchParams.get('who'),
    ),
  ).toEqual(notice)
}

/**
 * The sign-in screen with an error and no notice, so it shows "Sign-in did
 * not finish. Try again.", and no session.
 */
const expectGeneric = async ({ browser, response }: Attempt) => {
  expect(response.status).toBe(302)
  expect(browser.sessionToken()).toBeUndefined()
  const location = landing(response)
  expect(location.origin).toBe(ORIGIN)
  expect(location.pathname).toBe('/_/sign-in')
  const error = location.searchParams.get('error')
  expect(error).not.toBeNull()
  expect(NOTICE_KINDS).not.toContain(error)
  expect(location.searchParams.get('notice')).toBeNull()
  expect(location.searchParams.get('who')).toBeNull()
  expect(location.searchParams.get('next')).toBe(NEXT)
  expect(await noticeOf(error, null)).toBeNull()
}

const LINE_KEYS = [
  'account',
  'carried',
  'check',
  'error',
  'message',
  'provider',
  'reason',
  'xms_edov',
]

/** The one line a failed token check leaves, naming Google and the check. */
const expectTokenLine = (
  lines: readonly Record<string, unknown>[],
  check: string,
  identity: FakeIdentity,
) => {
  expect(lines).toHaveLength(1)
  const [line] = lines
  expect(Object.keys(line ?? {}).sort()).toEqual(LINE_KEYS)
  expect(line).toEqual({
    message: 'sign-in refused',
    provider: 'google',
    reason: 'token_check',
    error: null,
    check,
    account: null,
    carried: null,
    xms_edov: null,
  })
  const text = JSON.stringify(line)
  expect(text).not.toContain(identity.email)
  expect(text).not.toContain(identity.email.split('@')[0])
}

/** Tokens that each fail one check. */
const FAILED_CHECKS = [
  {
    token: 'a token for another client',
    check: 'audience',
    claims: () => ({ aud: 'another-client.apps.googleusercontent.com' }),
  },
  {
    token: 'a token from another issuer',
    check: 'issuer',
    claims: () => ({ iss: 'https://evil.example' }),
  },
  {
    token: 'an expired token',
    check: 'expired',
    claims: () => {
      const now = Math.floor(Date.now() / 1000)
      return { iat: now - 4200, exp: now - 600 }
    },
  },
] as const

describe('a sign-in whose email Google does not confirm', () => {
  it('refuses a new account with not_confirmed and creates nothing, claims nothing, opens nothing', async () => {
    const identity = { ...fresh('gmail.com', 'unsure'), email_verified: false }
    await invite(identity.email)
    await shareWith('theirs.html', identity.email)
    const before = await everything()
    const { result, lines } = await attempt(identity)
    await expectRefusal(result, {
      kind: 'not_confirmed',
      provider: 'google',
      email: identity.email,
    })
    expect(await everything()).toEqual(before)
    expect(await userIdOf(identity.email)).toBeUndefined()
    expect(await count('invitations', 'email = ?', identity.email)).toBe(1)
    // Google leaves a line only for a failed token check.
    expect(lines).toEqual([])
  })

  it('shows not_confirmed when Better Auth refuses an unconfirmed account joining a person first', async () => {
    const holder = fresh('gmail.com', 'holder')
    await signedIn(holder)
    const holderId = await userIdOf(holder.email)
    const before = await everything()
    const { result, lines } = await attempt({
      sub: `${holder.sub}-unconfirmed`,
      email: holder.email,
      email_verified: false,
    })
    await expectRefusal(result, {
      kind: 'not_confirmed',
      provider: 'google',
      email: holder.email,
    })
    expect(await everything()).toEqual(before)
    expect(await count('account', 'user_id = ?', holderId)).toBe(1)
    expect(await accountOf(`${holder.sub}-unconfirmed`)).toBeUndefined()
    expect(lines).toEqual([])
  })
})

describe('a sign-in that carries no email', () => {
  it('refuses a new account with no_email and creates nothing', async () => {
    const identity: FakeIdentity = {
      ...fresh('gmail.com', 'silent'),
      omit: ['email'],
    }
    const before = await everything()
    const { result, lines } = await attempt(identity)
    await expectRefusal(result, { kind: 'no_email', provider: 'google' })
    expect(await everything()).toEqual(before)
    expect(lines).toEqual([])
  })

  it('refuses a known account with no_email and leaves its person as they were', async () => {
    const known = fresh('gmail.com', 'known')
    await signedIn(known)
    const userId = await userIdOf(known.email)
    const before = await everything()
    const { result, lines } = await attempt({ ...known, omit: ['email'] })
    await expectRefusal(result, { kind: 'no_email', provider: 'google' })
    expect(await everything()).toEqual(before)
    expect((await storedUser(userId))?.email).toBe(known.email)
    expect(lines).toEqual([])
  })
})

describe('a token that fails its checks', () => {
  it.each(FAILED_CHECKS)(
    '$token shows the generic notice, creates nothing and logs one line naming $check',
    async ({ check, claims }) => {
      const identity: FakeIdentity = {
        ...fresh('gmail.com', 'checked'),
        name: 'Checked Person',
        claims: claims(),
      }
      const before = await everything()
      const { result, lines } = await attempt(identity)
      await expectGeneric(result)
      expect(await everything()).toEqual(before)
      expectTokenLine(lines, check, identity)
      expect(JSON.stringify(lines)).not.toContain('Checked Person')
    },
  )

  it.each(FAILED_CHECKS)(
    '$token that also carries no email still shows the generic notice and names $check',
    async ({ check, claims }) => {
      const identity: FakeIdentity = {
        ...fresh('gmail.com', 'checked-silent'),
        claims: claims(),
        omit: ['email'],
      }
      const before = await everything()
      const { result, lines } = await attempt(identity)
      await expectGeneric(result)
      expect(await everything()).toEqual(before)
      expectTokenLine(lines, check, identity)
    },
  )

  it.each(FAILED_CHECKS)(
    '$token for an unconfirmed join still shows the generic notice and names $check',
    async ({ check, claims }) => {
      const holder = fresh('gmail.com', 'checked-holder')
      await signedIn(holder)
      const identity: FakeIdentity = {
        sub: `${holder.sub}-unconfirmed`,
        email: holder.email,
        email_verified: false,
        claims: claims(),
      }
      const before = await everything()
      const { result, lines } = await attempt(identity)
      await expectGeneric(result)
      expect(await everything()).toEqual(before)
      expectTokenLine(lines, check, identity)
    },
  )

  it.each(FAILED_CHECKS)(
    '$token does not sign a known account in',
    async ({ check, claims }) => {
      const known = fresh('gmail.com', 'checked-known')
      await signedIn(known)
      const userId = await userIdOf(known.email)
      const before = await everything()
      const { result, lines } = await attempt({ ...known, claims: claims() })
      await expectGeneric(result)
      expect(await everything()).toEqual(before)
      expect((await storedUser(userId))?.email).toBe(known.email)
      expectTokenLine(lines, check, known)
    },
  )
})

describe("a known account's new email Google does not confirm", () => {
  it.each([true, false])(
    'signs in, keeps the stored email and its stored verified flag (%s), and the attempted address claims and opens nothing',
    async (verified) => {
      const lina = fresh('gmail.com', 'lina')
      await signedIn(lina)
      const userId = await userIdOf(lina.email)
      await exec(
        'update "user" set email_verified = ? where id = ?',
        verified ? 1 : 0,
        userId,
      )
      const attempted = fresh('gmail.com', 'lina-new').email
      await invite(attempted)
      await shareWith('theirs.html', attempted)
      await shareWith('mine.html', lina.email)

      const { result, lines } = await attempt({
        sub: lina.sub,
        email: attempted,
        email_verified: false,
      })
      const { browser, response } = result
      expect(response.status).toBe(302)
      expect(browser.sessionToken()).toBeDefined()
      const location = landing(response)
      expect(location.pathname).toBe('/_/sign-in')
      expect(location.searchParams.get('notice')).toBe('kept_unconfirmed')
      expect(location.searchParams.get('error')).toBeNull()
      expect(location.searchParams.get('next')).toBe(NEXT)
      expect(
        await noticeOf('kept_unconfirmed', location.searchParams.get('who')),
      ).toEqual({
        kind: 'kept_unconfirmed',
        provider: 'google',
        email: attempted,
      })

      expect(await storedUser(userId)).toEqual({
        email: lina.email,
        email_verified: verified ? 1 : 0,
      })
      expect(await me(browser)).toMatchObject({ id: userId, email: lina.email })
      expect(await userIdOf(attempted)).toBeUndefined()
      // The invitation waits, and the share to the attempted address stays
      // closed; the person's own share opens.
      expect(await count('invitations', 'email = ?', attempted)).toBe(1)
      expect(
        await count(
          'workspace_members',
          'workspace_id = ? and user_id = ?',
          ws.id,
          userId,
        ),
      ).toBe(0)
      expect(await opens(browser, 'theirs')).toBe(false)
      expect(await opens(browser, 'mine')).toBe(true)
      expect(lines).toEqual([])
    },
  )

  it('keeps the email, then a second Google account with authority for it joins the same person', async () => {
    const ana = { ...fresh('acme.test', 'ana'), hd: 'acme.test' }
    await signedIn(ana)
    const userId = await userIdOf(ana.email)

    const kept = await signedIn({
      sub: ana.sub,
      email: fresh('acme.test', 'ana-new').email,
      hd: 'acme.test',
      email_verified: false,
    })
    expect((await storedUser(userId))?.email).toBe(ana.email)

    const second = await signedIn({
      sub: `${ana.sub}-second`,
      email: ana.email,
      hd: 'acme.test',
    })
    expect(await count('user', 'email = ?', ana.email)).toBe(1)
    expect((await storedUser(userId))?.email).toBe(ana.email)
    expect((await accountOf(ana.sub))?.user_id).toBe(userId)
    expect((await accountOf(`${ana.sub}-second`))?.user_id).toBe(userId)
    expect(await count('account', 'user_id = ?', userId)).toBe(2)
    expect(await me(second)).toMatchObject({ id: userId, email: ana.email })
    expect(await me(kept)).toMatchObject({ id: userId, email: ana.email })
  })
})

describe("a known account's email", () => {
  it('follows a confirmed new email nobody holds', async () => {
    const lina = fresh('gmail.com', 'moving')
    await signedIn(lina)
    const userId = await userIdOf(lina.email)
    const renamed = fresh('gmail.com', 'moved').email
    const users = await count('user')
    const { result } = await attempt({ sub: lina.sub, email: renamed })
    expect(result.response.status).toBe(302)
    expect(result.response.headers.get('location')).toBe(NEXT)
    expect(result.browser.sessionToken()).toBeDefined()
    expect((await storedUser(userId))?.email).toBe(renamed)
    expect(await count('user')).toBe(users)
    expect(await me(result.browser)).toMatchObject({
      id: userId,
      email: renamed,
    })
  })

  it.each([
    { when: 'loses its hosted domain', change: {} },
    {
      when: 'is no longer confirmed',
      change: { hd: 'acme.test', email_verified: false },
    },
  ])(
    'stays attached and is recorded as none when Google stops being the authority: it $when',
    async ({ change }) => {
      const sara = { ...fresh('acme.test', 'sara'), hd: 'acme.test' }
      await signedIn(sara)
      const userId = await userIdOf(sara.email)
      const authorities = async () => ({
        account: (
          await rows<{ email_authority: string }>(
            'select email_authority from account_emails where account_id = ?',
            (await accountOf(sara.sub))?.id,
          )
        )[0]?.email_authority,
        person: (
          await rows<{ email_authority: string }>(
            'select email_authority from people where user_id = ?',
            userId,
          )
        )[0]?.email_authority,
      })
      expect(await authorities()).toEqual({
        account: 'google',
        person: 'google',
      })

      const { result } = await attempt({
        sub: sara.sub,
        email: sara.email,
        ...change,
      })
      expect(result.response.status).toBe(302)
      expect(result.response.headers.get('location')).toBe(NEXT)
      expect(result.browser.sessionToken()).toBeDefined()
      expect((await accountOf(sara.sub))?.user_id).toBe(userId)
      expect((await storedUser(userId))?.email).toBe(sara.email)
      expect(await authorities()).toEqual({ account: 'none', person: 'none' })
      expect(await me(result.browser)).toMatchObject({ id: userId })
    },
  )
})

describe('the notices name Google', () => {
  it('refuses a confirmed account without authority joining a person with email_unconfirmed', async () => {
    const holder = { ...fresh('acme.test', 'held'), hd: 'acme.test' }
    await signedIn(holder)
    const before = await everything()
    const { result, lines } = await attempt({
      sub: `${holder.sub}-personal`,
      email: holder.email,
    })
    await expectRefusal(result, {
      kind: 'email_unconfirmed',
      provider: 'google',
      email: holder.email,
    })
    expect(await everything()).toEqual(before)
    expect(lines).toEqual([])
  })

  it("keeps a known account's email when Google's new address belongs to another person, with email_in_use", async () => {
    const lina = fresh('gmail.com', 'lina')
    const other = fresh('gmail.com', 'other')
    await signedIn(lina)
    await signedIn(other)
    const linaId = await userIdOf(lina.email)
    const { result, lines } = await attempt({
      sub: lina.sub,
      email: other.email,
    })
    expect(result.browser.sessionToken()).toBeDefined()
    const location = landing(result.response)
    expect(location.pathname).toBe('/_/sign-in')
    expect(location.searchParams.get('notice')).toBe('email_in_use')
    expect(location.searchParams.get('next')).toBe(NEXT)
    expect(
      await noticeOf('email_in_use', location.searchParams.get('who')),
    ).toEqual({ kind: 'email_in_use', provider: 'google', email: other.email })
    expect((await storedUser(linaId))?.email).toBe(lina.email)
    expect(await count('user', 'email = ?', other.email)).toBe(1)
    expect(lines).toEqual([])
  })
})

describe('joining a person whose stored email is not marked verified', () => {
  it('lets a Workspace account with authority join', async () => {
    const sara = { ...fresh('acme.test', 'unmarked'), hd: 'acme.test' }
    await signedIn(sara)
    const userId = await userIdOf(sara.email)
    await exec('update "user" set email_verified = 0 where id = ?', userId)

    const { result } = await attempt({
      sub: `${sara.sub}-second`,
      email: sara.email,
      hd: 'acme.test',
    })
    expect(result.response.status).toBe(302)
    expect(result.response.headers.get('location')).toBe(NEXT)
    expect(result.browser.sessionToken()).toBeDefined()
    expect(await count('user', 'email = ?', sara.email)).toBe(1)
    expect((await accountOf(`${sara.sub}-second`))?.user_id).toBe(userId)
    expect(await count('account', 'user_id = ?', userId)).toBe(2)
    expect(await me(result.browser)).toMatchObject({ id: userId })
  })
})
