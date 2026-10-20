// Signing in with Microsoft through Better Auth's real routes and the
// stand-in Microsoft: who gets in, what is written, what is refused and with
// which notice, the one log line each refused or failed sign-in leaves, one
// person across Google and Microsoft, photos, and CLI logins.
import type { TreeId } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { SignIn, type Caller, type CurrentCaller } from '../src/core/index.ts'
import { Browser, signedIn } from './support/browser.ts'
import { count, exec, failingStatements, rows } from './support/d1.ts'
import type { FakeIdentity } from './support/fake-google.ts'
import {
  GRAPH_PHOTO,
  MICROSOFT_AUTHORIZE,
  PERSONAL_TID,
  refuseMicrosoftConsent,
  type FakeMicrosoftIdentity,
} from './support/fake-microsoft.ts'
import { harness, microsoft, ORIGIN, testRuntime } from './support/harness.ts'
import { everything as wholeAccount } from './support/keys.ts'
import { callerOf, fresh, run, runAs } from './support/people.ts'
import {
  agent,
  nodeAt,
  person,
  pushAll,
  share,
  visitorCaller,
  workspace,
} from './support/trees.ts'

afterEach(() => {
  vi.restoreAllMocks()
  harness.reset()
})

const CONTOSO = '72f988bf-86f1-41af-91ab-2d7cd011db47'
const FABRIKAM = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const issuerOf = (tid: string) =>
  `https://login.microsoftonline.com/${tid}/v2.0`

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
    `${ws.name}/m${crypto.randomUUID().slice(0, 8)}`,
    {
      'mine.html': '<!doctype html><title>Mine</title><p>Mine</p>',
      'theirs.html': '<!doctype html><title>Theirs</title><p>Theirs</p>',
    },
  )
  if (!('treeId' in pushed)) throw new Error('no tree')
  treeId = pushed.treeId
})

/** A Microsoft account no other test uses, in `tid`, at `domain`. */
const msAccount = (
  tid: string,
  domain: string,
  local = 'ana',
  over: Partial<FakeMicrosoftIdentity> = {},
): FakeMicrosoftIdentity => ({
  oid: crypto.randomUUID(),
  tid,
  email: fresh(domain, local).email,
  ...over,
})

/** A personal Outlook.com account. */
const outlook = (local = 'ana', over: Partial<FakeMicrosoftIdentity> = {}) =>
  msAccount(PERSONAL_TID, 'outlook.com', local, over)

/** A native Contoso work account whose domain Contoso verified. */
const contoso = (local = 'ana', over: Partial<FakeMicrosoftIdentity> = {}) =>
  msAccount(CONTOSO, 'contoso.test', local, { xms_edov: true, ...over })

const userIdOf = async (email: string) =>
  (
    await rows<{ id: string }>('select id from "user" where email = ?', email)
  )[0]?.id

const accountOf = async (provider: string, subject: string) =>
  (
    await rows<{ id: string; user_id: string }>(
      'select id, user_id from account where provider_id = ? and account_id = ?',
      provider,
      subject,
    )
  )[0]

const msAccountOf = (identity: FakeMicrosoftIdentity) =>
  accountOf('microsoft', identity.oid)

const storedUser = async (userId: string | undefined) =>
  (
    await rows<{
      email: string
      email_verified: number
      name: string
      image: string | null
    }>(
      'select email, email_verified, name, image from "user" where id = ?',
      userId,
    )
  )[0]

const observedOf = async (accountId: string | undefined) =>
  (
    await rows<{
      email: string
      email_authority: string
      organisation: string | null
      observed_at: number
    }>(
      'select email, email_authority, organisation, observed_at from account_emails where account_id = ?',
      accountId,
    )
  )[0]

const personAuthorityOf = async (userId: string | undefined) =>
  (
    await rows<{ email_authority: string }>(
      'select email_authority from people where user_id = ?',
      userId,
    )
  )[0]?.email_authority

const historyOf = async (userId: string) =>
  (
    await rows<{ kind: string; detail_json: string }>(
      'select kind, detail_json from person_history where user_id = ? order by created_at, rowid',
      userId,
    )
  ).map((row) => ({
    kind: row.kind,
    detail: JSON.parse(row.detail_json) as unknown,
  }))

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

const meOf = async (browser: Browser) => {
  const response = await browser.fetch('/_/api/me', { purpose: 'read' })
  if (response.status !== 200) return null
  return ((await response.json()) as { person: { id: string; email: string } })
    .person
}

const landing = (response: Response) =>
  new URL(response.headers.get('location') ?? '', ORIGIN)

const noticeOf = (kind: string | null, who: string | null) =>
  run(Effect.flatMap(SignIn, (signIn) => signIn.notice(kind, who)))

const asCaller = <A, E>(
  caller: Caller,
  use: (signIn: typeof SignIn.Service) => Effect.Effect<A, E, CurrentCaller>,
) => runAs(caller, Effect.flatMap(SignIn, use))

const keyWorks = async (secret: string) =>
  (
    await SELF.fetch(`${ORIGIN}/_/api/me`, {
      headers: { authorization: `Bearer ${secret}` },
    })
  ).status === 200

/** The sign-in diagnostic lines logged while `body` runs, and its result. */
const diagnostics = async <A>(body: () => Promise<A>) => {
  const log = vi.spyOn(console, 'log')
  const result = await body()
  const lines = refusalLines(log.mock.calls)
  log.mockRestore()
  return { result, lines }
}

/** The sign-in diagnostic lines among console.log calls. */
const refusalLines = (calls: readonly (readonly unknown[])[]) =>
  calls
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

/** A sign-in in a new browser. */
const signInFresh = async (
  identity: FakeMicrosoftIdentity | FakeIdentity,
  next = NEXT,
) => {
  const browser = new Browser()
  const response = await browser.signIn(identity, next)
  return { browser, response }
}

/** A sign-in in a new browser, with the lines it logged. */
const attempt = (identity: FakeMicrosoftIdentity | FakeIdentity, next = NEXT) =>
  diagnostics(() => signInFresh(identity, next))

interface Attempt {
  readonly browser: Browser
  readonly response: Response
}

/** Signed in, and sent on to `next`. */
const expectSignedIn = ({ browser, response }: Attempt, next = NEXT) => {
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe(next)
  expect(browser.sessionToken()).toBeDefined()
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

/**
 * Exactly one line, with exactly the diagnostic's keys and these values, and
 * nothing in it that names the person.
 */
const expectLine = (
  lines: readonly Record<string, unknown>[],
  expected: Record<string, unknown>,
  identity: { readonly email?: string; readonly name?: string },
) => {
  expect(lines).toHaveLength(1)
  const [line] = lines
  expect(Object.keys(line ?? {}).sort()).toEqual(LINE_KEYS)
  expect(line).toEqual({
    message: 'sign-in refused',
    provider: 'microsoft',
    error: null,
    check: null,
    ...expected,
  })
  const text = JSON.stringify(line)
  if (identity.email !== undefined) {
    expect(text).not.toContain(identity.email)
    expect(text).not.toContain(identity.email.split('@')[0])
  }
  if (identity.name !== undefined) expect(text).not.toContain(identity.name)
}

const CONSOLE = ['log', 'info', 'warn', 'error', 'debug'] as const

/** Everything a logged value holds, as text, including an error's own fields. */
const textOf = (value: unknown, seen = new Set<object>()): string => {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return String(value)
  if (seen.has(value)) return ''
  seen.add(value)
  return [
    String(value),
    ...Object.getOwnPropertyNames(value).map((key) =>
      textOf((value as Record<string, unknown>)[key], seen),
    ),
  ].join(' ')
}

/**
 * All that reached any console method while `body` runs, as text, and the
 * sign-in diagnostic lines among it. One capture serves both: a second spy on
 * the same method would take its calls away from this one.
 */
const consoleText = async <A>(body: () => Promise<A>) => {
  const spies = CONSOLE.map((method) => vi.spyOn(console, method))
  const result = await body()
  const text = spies
    .flatMap((spy) =>
      spy.mock.calls.map((call) => call.map((arg) => textOf(arg))),
    )
    .flat()
    .join('\n')
  const lines = refusalLines(spies[0].mock.calls)
  for (const spy of spies) spy.mockRestore()
  return { result, text, lines }
}

const photoBytes = (...tail: number[]) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, ...tail])

/** The bytes a data URL holds, or null when it is not an image data URL. */
const bytesOfDataUrl = (url: string | null | undefined) => {
  const match = /^data:image\/[a-z+.-]+;base64,(.*)$/s.exec(url ?? '')
  if (match === null) return null
  return [...atob((match[1] ?? '').trim())].map((c) => c.charCodeAt(0))
}

describe('starting a Microsoft sign-in', () => {
  it("asks Microsoft's common tenant, lets the person choose the account, and asks for the default scopes", async () => {
    const before = microsoft.log.length
    const url = new URL(await new Browser().startSignIn('microsoft', NEXT))
    expect(`${url.origin}${url.pathname}`).toBe(MICROSOFT_AUTHORIZE)
    expect(url.pathname.split('/')[1]).toBe('common')
    const params = url.searchParams
    expect(params.get('prompt')).toBe('select_account')
    expect((params.get('scope') ?? '').split(' ').sort()).toEqual(
      ['openid', 'profile', 'email', 'User.Read', 'offline_access'].sort(),
    )
    expect(params.get('client_id')).toBe(microsoft.clientId)
    expect(params.get('redirect_uri')).toBe(
      `${ORIGIN}/_/auth/callback/microsoft`,
    )
    expect(params.get('response_type')).toBe('code')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('state')).toEqual(expect.any(String))
    // Nothing reaches Microsoft until the person comes back.
    expect(microsoft.log.slice(before)).toEqual([])
  })
})

describe('a Microsoft account whose email Microsoft confirms', () => {
  it.each([
    {
      account: 'a personal Outlook.com account',
      identity: () => outlook('outlook'),
      organisation: PERSONAL_TID,
    },
    {
      account: 'a native work account',
      identity: () => contoso('worker'),
      organisation: CONTOSO,
    },
    {
      account: 'a native work account whose idp is its own issuer',
      identity: () => contoso('native', { idp: issuerOf(CONTOSO) }),
      organisation: CONTOSO,
    },
  ])(
    '$account signs in as a new person, claims its invitation and opens what is shared with its email',
    async ({ identity: make, organisation }) => {
      const identity = { ...make(), name: 'Ana Silva' }
      const email = identity.email ?? ''
      await invite(email)
      await shareWith('theirs.html', email)
      const people = await count('people')

      const { result, lines } = await attempt(identity)
      expectSignedIn(result)
      const userId = await userIdOf(email)
      expect(userId).toBeDefined()
      expect(await count('people')).toBe(people + 1)
      expect(await meOf(result.browser)).toMatchObject({ id: userId, email })

      const account = await msAccountOf(identity)
      expect(account?.user_id).toBe(userId)
      expect(await count('account', 'user_id = ?', userId)).toBe(1)
      expect(
        await rows(
          'select sign_in_account_id from session where user_id = ?',
          userId,
        ),
      ).toEqual([{ sign_in_account_id: account?.id }])
      expect(await observedOf(account?.id)).toMatchObject({
        email,
        email_authority: 'microsoft',
        organisation,
      })
      expect(await personAuthorityOf(userId)).toBe('microsoft')
      expect((await storedUser(userId))?.name).toBe('Ana Silva')

      // The invitation became a membership, and the share opens.
      expect(await count('invitations', 'email = ?', email)).toBe(0)
      expect(
        await count(
          'workspace_members',
          'workspace_id = ? and user_id = ?',
          ws.id,
          userId,
        ),
      ).toBe(1)
      expect(await opens(result.browser, 'theirs')).toBe(true)
      expect(lines).toEqual([])
    },
  )

  it('signs a known account in again as the same person, and updates its email record from this sign-in', async () => {
    const identity = contoso('again', { name: 'Ana Silva' })
    await signedIn(identity)
    const userId = await userIdOf(identity.email ?? '')
    const account = await msAccountOf(identity)
    // An older record, which this sign-in replaces.
    await exec(
      `update account_emails set email_authority = 'none', organisation = null, observed_at = 1
         where account_id = ?`,
      account?.id,
    )
    const users = await count('user')

    const { result, lines } = await attempt({ ...identity, name: 'Ana S.' })
    expectSignedIn(result)
    expect(await count('user')).toBe(users)
    expect(await meOf(result.browser)).toMatchObject({ id: userId })
    expect((await msAccountOf(identity))?.id).toBe(account?.id)
    const observed = await observedOf(account?.id)
    expect(observed).toMatchObject({
      email: identity.email,
      email_authority: 'microsoft',
      organisation: CONTOSO,
    })
    expect(observed?.observed_at).toBeGreaterThan(1)
    expect((await storedUser(userId))?.name).toBe('Ana S.')
    expect(lines).toEqual([])
  })

  it('keeps a known work account signed in, recorded as none, when Microsoft stops confirming its unchanged email', async () => {
    const identity = contoso('lapsing')
    await signedIn(identity)
    const userId = await userIdOf(identity.email ?? '')
    const { result, lines } = await attempt({ ...identity, xms_edov: false })
    expectSignedIn(result)
    expect((await msAccountOf(identity))?.user_id).toBe(userId)
    expect(
      (await observedOf((await msAccountOf(identity))?.id))?.email_authority,
    ).toBe('none')
    expect(await personAuthorityOf(userId)).toBe('none')
    expect(lines).toEqual([])
  })
})

describe('a Microsoft email Microsoft does not confirm', () => {
  it.each([
    {
      account: 'a work account with xms_edov false',
      identity: () => contoso('unverified', { xms_edov: false }),
      line: {
        account: 'work',
        carried: { email: true, xms_edov: true, idp: false },
        xms_edov: false,
      },
    },
    {
      account: 'a work account without xms_edov',
      identity: () => contoso('silent', { xms_edov: undefined }),
      line: {
        account: 'work',
        carried: { email: true, xms_edov: false, idp: false },
        xms_edov: null,
      },
    },
    {
      account: 'a work account that says email_verified but not xms_edov',
      identity: () =>
        contoso('claims', {
          xms_edov: undefined,
          token: { email_verified: true },
        }),
      line: {
        account: 'work',
        carried: { email: true, xms_edov: false, idp: false },
        xms_edov: null,
      },
    },
    {
      account: 'a personal account on Gmail',
      identity: () => msAccount(PERSONAL_TID, 'gmail.com', 'personal'),
      line: {
        account: 'personal',
        carried: { email: true, xms_edov: false, idp: false },
        xms_edov: null,
      },
    },
    {
      account: 'a personal account on outlook.co.uk',
      identity: () => msAccount(PERSONAL_TID, 'outlook.co.uk', 'british'),
      line: {
        account: 'personal',
        carried: { email: true, xms_edov: false, idp: false },
        xms_edov: null,
      },
    },
  ])(
    '$account is refused with not_confirmed, and creates, claims and opens nothing',
    async ({ identity: make, line }) => {
      const identity = { ...make(), name: 'Refused Person' }
      const email = identity.email ?? ''
      await invite(email)
      await shareWith('theirs.html', email)
      const before = await everything()

      const { result, lines } = await attempt(identity)
      await expectRefusal(result, {
        kind: 'not_confirmed',
        provider: 'microsoft',
        email,
      })
      expect(await everything()).toEqual(before)
      expect(await userIdOf(email)).toBeUndefined()
      expect(await msAccountOf(identity)).toBeUndefined()
      expect(await count('invitations', 'email = ?', email)).toBe(1)
      expectLine(lines, { reason: 'not_confirmed', ...line }, identity)
    },
  )

  it.each([
    { claim: 'xms_edov false', over: { xms_edov: false } },
    { claim: 'no xms_edov', over: { xms_edov: undefined } },
  ])(
    "refuses a work account in another directory that types Ana's address, with $claim, before any join",
    async ({ over }) => {
      const ana: FakeIdentity = {
        ...fresh('contoso.test', 'ana'),
        hd: 'contoso.test',
      }
      const anaBrowser = await signedIn(ana)
      const anaId = await userIdOf(ana.email)
      const anaBefore = {
        accounts: await rows(
          'select id from account where user_id = ? order by id',
          anaId,
        ),
        sessions: await rows(
          'select id from session where user_id = ? order by id',
          anaId,
        ),
        user: await storedUser(anaId),
      }
      const before = await everything()

      const stranger: FakeMicrosoftIdentity = {
        oid: crypto.randomUUID(),
        tid: FABRIKAM,
        email: ana.email,
        name: 'Stranger',
        ...over,
      }
      const { result, lines } = await attempt(stranger)
      await expectRefusal(result, {
        kind: 'not_confirmed',
        provider: 'microsoft',
        email: ana.email,
      })
      expect(await everything()).toEqual(before)
      expect(await msAccountOf(stranger)).toBeUndefined()
      expect({
        accounts: await rows(
          'select id from account where user_id = ? order by id',
          anaId,
        ),
        sessions: await rows(
          'select id from session where user_id = ? order by id',
          anaId,
        ),
        user: await storedUser(anaId),
      }).toEqual(anaBefore)
      expect(await meOf(anaBrowser)).toMatchObject({ id: anaId })
      expectLine(
        lines,
        {
          reason: 'not_confirmed',
          account: 'work',
          carried: {
            email: true,
            xms_edov: over.xms_edov !== undefined,
            idp: false,
          },
          xms_edov: over.xms_edov ?? null,
        },
        stranger,
      )
    },
  )
})

describe('a Microsoft account that shares no email', () => {
  it('refuses a new account with no_email and creates nothing', async () => {
    const identity = contoso('noemail', { name: 'Quiet Person' })
    const { email: _sent, ...withoutEmail } = identity
    const before = await everything()
    const { result, lines } = await attempt(withoutEmail)
    await expectRefusal(result, { kind: 'no_email', provider: 'microsoft' })
    expect(await everything()).toEqual(before)
    expect(await msAccountOf(identity)).toBeUndefined()
    expectLine(
      lines,
      {
        reason: 'no_email',
        account: 'work',
        carried: { email: false, xms_edov: true, idp: false },
        xms_edov: true,
      },
      { email: identity.email, name: 'Quiet Person' },
    )
  })

  it('refuses a known account with no_email and leaves its person as they were', async () => {
    const identity = outlook('known', { name: 'Known Person' })
    await signedIn(identity)
    const userId = await userIdOf(identity.email ?? '')
    const { email: _sent, ...withoutEmail } = identity
    const before = await everything()
    const { result, lines } = await attempt(withoutEmail)
    await expectRefusal(result, { kind: 'no_email', provider: 'microsoft' })
    expect(await everything()).toEqual(before)
    expect((await storedUser(userId))?.email).toBe(identity.email)
    expectLine(
      lines,
      {
        reason: 'no_email',
        account: 'personal',
        carried: { email: false, xms_edov: false, idp: false },
        xms_edov: null,
      },
      identity,
    )
  })
})

describe('guests in a directory, each carrying xms_edov true', () => {
  it.each([
    { idp: 'live.com' },
    { idp: `https://sts.windows.net/${PERSONAL_TID}/` },
    { idp: issuerOf(PERSONAL_TID) },
  ])(
    'signs in a guest from a personal account on outlook.com (idp $idp)',
    async ({ idp }) => {
      const identity = msAccount(CONTOSO, 'outlook.com', 'guest', {
        idp,
        xms_edov: true,
      })
      const { result, lines } = await attempt(identity)
      expectSignedIn(result)
      const userId = await userIdOf(identity.email ?? '')
      expect((await msAccountOf(identity))?.user_id).toBe(userId)
      expect(await observedOf((await msAccountOf(identity))?.id)).toMatchObject(
        {
          email: identity.email,
          email_authority: 'microsoft',
          organisation: CONTOSO,
        },
      )
      expect(lines).toEqual([])
    },
  )

  const REFUSED = [
    {
      guest: 'a guest from a personal account on an outside address',
      identity: () =>
        msAccount(CONTOSO, 'gmail.com', 'outside', {
          idp: 'live.com',
          xms_edov: true,
        }),
      holder: (email: string): FakeIdentity => ({
        sub: `sub-${crypto.randomUUID()}`,
        email,
      }),
      line: { reason: 'not_confirmed', account: 'personal_guest' },
    },
    {
      guest: 'a guest from another directory',
      identity: () =>
        msAccount(CONTOSO, 'fabrikam.test', 'visiting', {
          idp: `https://sts.windows.net/${FABRIKAM}/`,
          xms_edov: true,
        }),
      holder: (email: string): FakeIdentity => ({
        sub: `sub-${crypto.randomUUID()}`,
        email,
        hd: 'fabrikam.test',
      }),
      line: { reason: 'guest', account: 'guest' },
    },
  ]

  it.each(REFUSED)(
    '$guest is refused, creates no person and claims nothing',
    async ({ identity: make, line }) => {
      const identity = { ...make(), name: 'Guest Person' }
      const email = identity.email ?? ''
      await invite(email)
      await shareWith('theirs.html', email)
      const before = await everything()
      const { result, lines } = await attempt(identity)
      await expectRefusal(result, {
        kind: 'not_confirmed',
        provider: 'microsoft',
        email,
      })
      expect(await everything()).toEqual(before)
      expect(await userIdOf(email)).toBeUndefined()
      expect(await count('invitations', 'email = ?', email)).toBe(1)
      expectLine(
        lines,
        {
          ...line,
          carried: { email: true, xms_edov: true, idp: true },
          xms_edov: true,
        },
        identity,
      )
    },
  )

  it.each(REFUSED)(
    '$guest joins no one when a person holds its email',
    async ({ identity: make, holder: holderOf, line }) => {
      const identity = make()
      const email = identity.email ?? ''
      const holder = holderOf(email)
      const holderBrowser = await signedIn(holder)
      const holderId = await userIdOf(email)
      const before = await everything()
      const { result, lines } = await attempt(identity)
      await expectRefusal(result, {
        kind: 'not_confirmed',
        provider: 'microsoft',
        email,
      })
      expect(await everything()).toEqual(before)
      expect(await msAccountOf(identity)).toBeUndefined()
      expect(await count('account', 'user_id = ?', holderId)).toBe(1)
      expect(await meOf(holderBrowser)).toMatchObject({ id: holderId })
      expectLine(
        lines,
        {
          ...line,
          carried: { email: true, xms_edov: true, idp: true },
          xms_edov: true,
        },
        identity,
      )
    },
  )
})

describe('a Microsoft token that fails its checks', () => {
  const FAILED = [
    {
      token: 'a token for another client',
      check: 'audience',
      token_claims: () => ({ aud: 'another-client' }),
    },
    {
      token: 'a token whose issuer names another tenant',
      check: 'issuer',
      token_claims: () => ({ iss: issuerOf(FABRIKAM) }),
    },
    {
      token: 'a token whose tenant is not a GUID',
      check: 'issuer',
      token_claims: () => ({ tid: 'contoso', iss: issuerOf('contoso') }),
    },
    {
      token: 'an expired token',
      check: 'expired',
      token_claims: () => {
        const now = Math.floor(Date.now() / 1000)
        return { iat: now - 4200, nbf: now - 4200, exp: now - 600 }
      },
    },
  ] as const

  it.each(FAILED)(
    '$token shows the generic notice, creates nothing and logs one line naming $check',
    async ({ check, token_claims }) => {
      const identity = contoso('checked', {
        name: 'Checked Person',
        token: token_claims(),
      })
      const before = await everything()
      const { result, lines } = await attempt(identity)
      await expectGeneric(result)
      expect(await everything()).toEqual(before)
      expectLine(
        lines,
        {
          reason: 'token_check',
          check,
          account: 'work',
          carried: { email: true, xms_edov: true, idp: false },
          xms_edov: true,
        },
        identity,
      )
    },
  )

  it.each(FAILED)(
    '$token that also carries no email still shows the generic notice and names $check',
    async ({ check, token_claims }) => {
      const { email: _sent, ...identity } = contoso('checked-silent', {
        token: token_claims(),
      })
      const before = await everything()
      const { result, lines } = await attempt(identity)
      await expectGeneric(result)
      expect(await everything()).toEqual(before)
      expectLine(
        lines,
        {
          reason: 'token_check',
          check,
          account: 'work',
          carried: { email: false, xms_edov: true, idp: false },
          xms_edov: true,
        },
        identity,
      )
    },
  )

  it.each(FAILED)(
    '$token does not sign a known account in',
    async ({ check, token_claims }) => {
      const known = contoso('checked-known')
      await signedIn(known)
      const userId = await userIdOf(known.email ?? '')
      const before = await everything()
      const { result, lines } = await attempt({
        ...known,
        token: token_claims(),
      })
      await expectGeneric(result)
      expect(await everything()).toEqual(before)
      expect((await storedUser(userId))?.email).toBe(known.email)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ reason: 'token_check', check })
    },
  )
})

describe('a Microsoft sign-in that fails before Dossier reads a profile', () => {
  const PROVIDER_ERROR = {
    reason: 'provider_error',
    account: null,
    carried: null,
    xms_edov: null,
  }

  it('shows the generic notice and logs access_denied when the person refuses consent', async () => {
    const before = await everything()
    const { result, lines } = await diagnostics(async () => {
      const browser = new Browser()
      const url = await browser.startSignIn('microsoft', NEXT)
      const response = await browser.callback(refuseMicrosoftConsent(url))
      return { browser, response }
    })
    await expectGeneric(result)
    expect(await everything()).toEqual(before)
    expectLine(lines, { ...PROVIDER_ERROR, error: 'access_denied' }, {})
  })

  it("shows the generic notice and logs Better Auth's code when Microsoft refuses the client secret", async () => {
    harness.use(
      testRuntime({ env: { MICROSOFT_CLIENT_SECRET: 'an-expired-secret' } }),
    )
    const identity = contoso('expired', { name: 'Expired Secret' })
    const before = await everything()
    const logged = microsoft.log.length
    const { result, lines } = await attempt(identity)
    await expectGeneric(result)
    expect(await everything()).toEqual(before)
    expect(microsoft.log.slice(logged)).toContain(
      'POST https://login.microsoftonline.com/common/oauth2/v2.0/token',
    )
    expectLine(lines, { ...PROVIDER_ERROR, error: 'invalid_code' }, identity)
  })

  it("shows the generic notice and logs Better Auth's code for an ID token without oid", async () => {
    const identity = contoso('no-oid', {
      name: 'Missing Oid',
      token: { oid: undefined },
    })
    const before = await everything()
    const { result, lines } = await attempt(identity)
    await expectGeneric(result)
    expect(await everything()).toEqual(before)
    expectLine(
      lines,
      { ...PROVIDER_ERROR, error: 'unable_to_get_user_info' },
      identity,
    )
  })

  it("writes none of the token endpoint's error text to the logs", async () => {
    const sentinel = `sentinel-${crypto.randomUUID().slice(0, 8)}`
    const identity = contoso(sentinel, {
      name: `Sentinel ${sentinel}`,
      tokenError: {
        error: 'invalid_grant',
        error_description: `AADSTS50126: ${sentinel}@contoso.test (Sentinel ${sentinel}) could not sign in.`,
      },
    })
    const before = await everything()
    const { result, text, lines } = await consoleText(() =>
      signInFresh(identity),
    )
    await expectGeneric(result)
    expect(await everything()).toEqual(before)
    expectLine(lines, { ...PROVIDER_ERROR, error: 'invalid_code' }, identity)
    expect(text).not.toContain(sentinel)
    expect(text).not.toContain('AADSTS50126')
  })
})

describe('a Microsoft sign-in that fails after Dossier reads a profile', () => {
  it('shows the generic notice and logs one provider_error line with the claims the token carried', async () => {
    const known = contoso('d1-down', { name: 'Down Person' })
    await signedIn(known)
    const userId = await userIdOf(known.email ?? '')
    harness.use(
      testRuntime({
        env: {
          DB: failingStatements(env.DB, (sql) =>
            sql.startsWith('select "email" from "user"'),
          ),
        },
      }),
    )
    const before = await everything()
    const { result, text, lines } = await consoleText(() => signInFresh(known))
    await expectGeneric(result)
    expect(await everything()).toEqual(before)
    expect((await storedUser(userId))?.email).toBe(known.email)
    expectLine(
      lines,
      {
        reason: 'provider_error',
        error: 'validation_failed',
        account: 'work',
        carried: { email: true, xms_edov: true, idp: false },
        xms_edov: true,
      },
      known,
    )
    expect(text).not.toContain(known.email)
    expect(text).not.toContain(known.name)
  })
})

describe('one person across Google and Microsoft', () => {
  it("joins Ana's Google person with her Microsoft work account, takes over her lapsed Google account, and lists both", async () => {
    const workspaceAccount: FakeIdentity = {
      ...fresh('contoso.test', 'ana'),
      hd: 'contoso.test',
    }
    const email = workspaceAccount.email
    const lapsed: FakeIdentity = {
      sub: `${workspaceAccount.sub}-lapsed`,
      email,
      hd: 'contoso.test',
    }
    const workspaceBrowser = await signedIn(workspaceAccount)
    const anaId = (await userIdOf(email)) ?? ''
    await signedIn(lapsed)
    // Google stops vouching for the second account: it lapses.
    const lapsedBrowser = await signedIn({ sub: lapsed.sub, email })
    const lapsedId = (await accountOf('google', lapsed.sub))?.id
    expect((await observedOf(lapsedId))?.email_authority).toBe('none')
    const lapsedKey = await asCaller(await callerOf(lapsedBrowser), (signIn) =>
      signIn.createKey({ name: 'old laptop', ...wholeAccount }),
    )
    const keptKey = await asCaller(await callerOf(workspaceBrowser), (signIn) =>
      signIn.createKey({ name: 'laptop', ...wholeAccount }),
    )
    await exec(
      `insert into workspace_members (workspace_id, user_id, role, created_at)
       values (?, ?, 'member', ?)`,
      ws.id,
      anaId,
      Date.now(),
    )

    const work: FakeMicrosoftIdentity = {
      oid: crypto.randomUUID(),
      tid: CONTOSO,
      email,
      xms_edov: true,
    }
    const { result, lines } = await attempt(work)
    expectSignedIn(result)
    expect(lines).toEqual([])
    const workId = (await msAccountOf(work))?.id
    expect(await count('user', 'email = ?', email)).toBe(1)
    expect(await meOf(result.browser)).toMatchObject({ id: anaId, email })
    expect((await msAccountOf(work))?.user_id).toBe(anaId)
    expect(await observedOf(workId)).toMatchObject({
      email,
      email_authority: 'microsoft',
      organisation: CONTOSO,
    })

    // The lapsed account is taken over; the Workspace account stays.
    expect(await accountOf('google', lapsed.sub)).toBeUndefined()
    expect(await meOf(lapsedBrowser)).toBeNull()
    expect(await keyWorks(lapsedKey.secret)).toBe(false)
    expect((await accountOf('google', workspaceAccount.sub))?.user_id).toBe(
      anaId,
    )
    expect(await meOf(workspaceBrowser)).toMatchObject({ id: anaId })
    expect(await keyWorks(keptKey.secret)).toBe(true)
    expect(
      (await historyOf(anaId)).filter((entry) => entry.kind === 'takeover'),
    ).toEqual([
      { kind: 'takeover', detail: { by: workId, detached: [lapsedId] } },
    ])
    // Same workspaces.
    expect(
      await count(
        'workspace_members',
        'workspace_id = ? and user_id = ?',
        ws.id,
        anaId,
      ),
    ).toBe(1)

    // Settings lists both accounts, this session's first.
    const listed = await asCaller(await callerOf(result.browser), (signIn) =>
      signIn.signInAccounts(),
    )
    expect(
      listed.map(({ provider, email: shown, current }) => ({
        provider,
        email: shown,
        current,
      })),
    ).toEqual([
      { provider: 'microsoft', email, current: true },
      { provider: 'google', email, current: false },
    ])
  })

  it('keeps a Google account and a Microsoft account that are both the authority side by side', async () => {
    const work = contoso('both')
    const email = work.email ?? ''
    const workBrowser = await signedIn(work)
    const userId = (await userIdOf(email)) ?? ''
    const google: FakeIdentity = {
      sub: `sub-${crypto.randomUUID()}`,
      email,
      hd: 'contoso.test',
    }
    const { result, lines } = await attempt(google)
    expectSignedIn(result)
    expect(lines).toEqual([])
    expect((await accountOf('google', google.sub))?.user_id).toBe(userId)
    expect((await msAccountOf(work))?.user_id).toBe(userId)
    expect(await count('account', 'user_id = ?', userId)).toBe(2)
    expect(await meOf(workBrowser)).toMatchObject({ id: userId })
    expect(
      (await historyOf(userId)).filter((entry) => entry.kind === 'takeover'),
    ).toEqual([])

    // And the other way round: Microsoft signing in again takes nothing over.
    await signedIn(work)
    expect(await count('account', 'user_id = ?', userId)).toBe(2)
    expect(await meOf(result.browser)).toMatchObject({ id: userId })
  })
})

describe("a Microsoft account's name and photo", () => {
  it('stores the 48×48 Graph photo as a data URL at the first sign-in, and replaces it at the next', async () => {
    const first = photoBytes(1, 2, 3)
    const identity = outlook('photo', { name: 'Ana Silva', photo: first })
    const logged = microsoft.log.length
    await signedIn(identity)
    expect(microsoft.log.slice(logged)).toContain(`GET ${GRAPH_PHOTO}`)
    const userId = await userIdOf(identity.email ?? '')
    const stored = await storedUser(userId)
    expect(stored?.name).toBe('Ana Silva')
    expect(bytesOfDataUrl(stored?.image)).toEqual([...first])

    const second = photoBytes(9, 8, 7, 6)
    await signedIn({ ...identity, name: 'Ana S.', photo: second })
    const replaced = await storedUser(userId)
    expect(replaced?.name).toBe('Ana S.')
    expect(bytesOfDataUrl(replaced?.image)).toEqual([...second])
  })

  it.each([
    { failure: 'Microsoft has no photo (404)', photo: null },
    { failure: 'the photo download fails', photo: 'network-error' as const },
  ])(
    'signs in and clears the stored photo when $failure',
    async ({ photo }) => {
      const identity = outlook('nophoto', { photo: photoBytes(4, 5) })
      await signedIn(identity)
      const userId = await userIdOf(identity.email ?? '')
      expect(bytesOfDataUrl((await storedUser(userId))?.image)).not.toBeNull()

      const { result, lines } = await attempt({ ...identity, photo })
      expectSignedIn(result)
      expect((await storedUser(userId))?.image).toBeNull()
      expect(lines).toEqual([])
    },
  )

  it('clears a photo an earlier Google sign-in set when the Microsoft sign-in has none', async () => {
    const google: FakeIdentity = {
      ...fresh('contoso.test', 'pictured'),
      hd: 'contoso.test',
      name: 'Pictured Person',
    }
    await signedIn(google)
    const userId = await userIdOf(google.email)
    expect((await storedUser(userId))?.image).toBe(
      `https://lh3.googleusercontent.com/a/${google.sub}`,
    )
    const work: FakeMicrosoftIdentity = {
      oid: crypto.randomUUID(),
      tid: CONTOSO,
      email: google.email,
      xms_edov: true,
      name: 'Pictured At Work',
      photo: null,
    }
    const { result } = await attempt(work)
    expectSignedIn(result)
    expect((await msAccountOf(work))?.user_id).toBe(userId)
    expect(await storedUser(userId)).toMatchObject({
      name: 'Pictured At Work',
      image: null,
    })
  })
})

interface DeviceCode {
  readonly device_code: string
  readonly user_code: string
}

const requestCode = async (): Promise<DeviceCode> => {
  const response = await SELF.fetch(`${ORIGIN}/_/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: 'dossier-cli',
      scope: 'agent-key',
      device_name: 'cli on m4',
    }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as DeviceCode
}

const redeem = async (code: DeviceCode) => {
  await exec(
    'update device_code set last_polled_at = null where device_code = ?',
    code.device_code,
  )
  const response = await SELF.fetch(`${ORIGIN}/_/api/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCode: code.device_code }),
  })
  return { status: response.status, body: (await response.json()) as unknown }
}

describe('CLI logins and Microsoft', () => {
  it('sends a signed-out visitor on /_/device to sign in, and a Microsoft sign-in back to the device page', async () => {
    const code = await requestCode()
    const refused = await asCaller(visitorCaller(), (signIn) =>
      signIn.devicePrompt(code.user_code).pipe(Effect.flip),
    )
    expect(refused.code).toBe('sign_in_required')

    const device = `/_/device?user_code=${encodeURIComponent(code.user_code)}`
    const identity = outlook('device')
    const browser = new Browser()
    const response = await browser.signIn(identity, device)
    expect(response.status).toBe(302)
    const location = landing(response)
    expect(`${location.pathname}${location.search}`).toBe(device)
    expect(browser.sessionToken()).toBeDefined()
    const prompt = await asCaller(await callerOf(browser), (signIn) =>
      signIn.devicePrompt(code.user_code),
    )
    expect(prompt).toMatchObject({ name: 'cli on m4' })
  })

  it('records the Microsoft account that approved a key, and revokes the key when that account is disconnected', async () => {
    const google: FakeIdentity = {
      ...fresh('contoso.test', 'cli'),
      hd: 'contoso.test',
    }
    const googleBrowser = await signedIn(google)
    const work: FakeMicrosoftIdentity = {
      oid: crypto.randomUUID(),
      tid: CONTOSO,
      email: google.email,
      xms_edov: true,
    }
    const workBrowser = await signedIn(work)
    const workId = (await msAccountOf(work))?.id ?? ''
    const onWork = await callerOf(workBrowser)

    const code = await requestCode()
    await asCaller(onWork, (signIn) => signIn.devicePrompt(code.user_code))
    await asCaller(onWork, (signIn) => signIn.approveDevice(code.user_code))
    expect(
      await rows(
        'select approved_by_account_id from device_code where device_code = ?',
        code.device_code,
      ),
    ).toEqual([{ approved_by_account_id: workId }])

    const redeemed = await redeem(code)
    expect(redeemed.status).toBe(200)
    const { key } = redeemed.body as { key: string }
    expect(await keyWorks(key)).toBe(true)
    expect(
      await rows(
        `select created_by_account_id, created_via from agent_keys
           where user_id = ? and created_via = 'device'`,
        await userIdOf(google.email),
      ),
    ).toEqual([{ created_by_account_id: workId, created_via: 'device' }])

    await asCaller(await callerOf(googleBrowser), (signIn) =>
      signIn.disconnectSignInAccount(workId),
    )
    expect(await keyWorks(key)).toBe(false)
    expect(await meOf(workBrowser)).toBeNull()
    expect(await meOf(googleBrowser)).not.toBeNull()
  })
})
