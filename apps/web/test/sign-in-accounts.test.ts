// A person's sign-in accounts in Settings: the list, Disconnect, and what
// Disconnect refuses, through the stand-in Google and real D1.
import { ErrorBody } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect, Schema } from 'effect'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'

import { SignIn, type Caller, type CurrentCaller } from '../src/core/index.ts'
import type { SignInAccountView } from '../src/core/sign-in.ts'
import type { AccountView } from '../src/server/account.ts'
import { Browser, signedIn } from './support/browser.ts'
import { beforeBatch, exec, rows } from './support/d1.ts'
import type { FakeIdentity } from './support/fake-google.ts'
import { harness, ORIGIN, testRuntime } from './support/harness.ts'
import { everything } from './support/keys.ts'
import { callerOf, fresh, runAs } from './support/people.ts'
import { agent, visitorCaller } from './support/trees.ts'

afterEach(() => harness.reset())

const asCaller = <A, E>(
  caller: Caller,
  use: (signIn: typeof SignIn.Service) => Effect.Effect<A, E, CurrentCaller>,
) => runAs(caller, Effect.flatMap(SignIn, use))

const listOf = (caller: Caller) =>
  asCaller(caller, (signIn) => signIn.signInAccounts())

const disconnect = (caller: Caller, accountId: string) =>
  asCaller(caller, (signIn) => signIn.disconnectSignInAccount(accountId))

/** The code Disconnect is refused with; fails if it succeeds. */
const refusalOf = async (caller: Caller, accountId: string) =>
  (
    await asCaller(caller, (signIn) =>
      signIn.disconnectSignInAccount(accountId).pipe(Effect.flip),
    )
  ).code

const me = (browser: Browser) => browser.fetch('/_/api/me', { purpose: 'read' })

const keyWorks = async (secret: string) =>
  (
    await SELF.fetch(`${ORIGIN}/_/api/me`, {
      headers: { authorization: `Bearer ${secret}` },
    })
  ).status === 200

const accountIdOf = async (sub: string) =>
  (
    await rows<{ id: string }>(
      'select id from account where account_id = ?',
      sub,
    )
  )[0]?.id

const userIdOf = async (email: string) =>
  (
    await rows<{ id: string }>('select id from "user" where email = ?', email)
  )[0]?.id

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

const createKey = async (caller: Caller, name: string) =>
  asCaller(caller, (signIn) => signIn.createKey({ name, ...everything }))

const revokedAtOf = async (keyId: string) =>
  (
    await rows<{ revoked_at: number | null }>(
      'select revoked_at from agent_keys where id = ?',
      keyId,
    )
  )[0]?.revoked_at

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

const approveAs = async (caller: Caller, code: DeviceCode) => {
  await asCaller(caller, (signIn) => signIn.devicePrompt(code.user_code))
  await asCaller(caller, (signIn) => signIn.approveDevice(code.user_code))
}

const statusOf = async (code: DeviceCode) =>
  (
    await rows<{ status: string }>(
      'select status from device_code where device_code = ?',
      code.device_code,
    )
  )[0]?.status

const pollCode = async (code: DeviceCode) => {
  await exec(
    'update device_code set last_polled_at = null where device_code = ?',
    code.device_code,
  )
  const response = await SELF.fetch(`${ORIGIN}/_/api/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCode: code.device_code }),
  })
  return Schema.decodeUnknownSync(ErrorBody)(await response.json()).error.code
}

/** Everything a disconnect could change for these people, to compare. */
const stateOf = async (...userIds: string[]) => {
  const ids = userIds.map(() => '?').join(', ')
  return {
    users: await rows(
      `select id, email from "user" where id in (${ids}) order by id`,
      ...userIds,
    ),
    people: await rows(
      `select * from people where user_id in (${ids}) order by user_id`,
      ...userIds,
    ),
    accounts: await rows(
      `select id, user_id, provider_id, account_id from account where user_id in (${ids}) order by id`,
      ...userIds,
    ),
    emails: await rows(
      `select e.* from account_emails e join account a on a.id = e.account_id
         where a.user_id in (${ids}) order by e.account_id`,
      ...userIds,
    ),
    sessions: await rows(
      `select id, sign_in_account_id from session where user_id in (${ids}) order by id`,
      ...userIds,
    ),
    keys: await rows(
      `select id, revoked_at from agent_keys where user_id in (${ids}) order by id`,
      ...userIds,
    ),
    devices: await rows(
      `select id, status from device_code where user_id in (${ids}) order by id`,
      ...userIds,
    ),
    history: await rows(
      `select id, kind, detail_json from person_history where user_id in (${ids}) order by id`,
      ...userIds,
    ),
  }
}

/** A Gmail person with two Google accounts, signed in once with each. */
const twoGmailAccounts = async () => {
  const first = fresh('gmail.com', 'ana')
  const second: FakeIdentity = {
    sub: `${first.sub}-second`,
    email: first.email,
  }
  const firstBrowser = await signedIn(first)
  const secondBrowser = await signedIn(second)
  const userId = await userIdOf(first.email)
  const firstId = await accountIdOf(first.sub)
  const secondId = await accountIdOf(second.sub)
  if (userId === undefined || firstId === undefined || secondId === undefined) {
    throw new Error('the two accounts did not join one person')
  }
  return {
    first,
    second,
    firstBrowser,
    secondBrowser,
    userId,
    firstId,
    secondId,
  }
}

describe('the sign-in accounts list', () => {
  it("holds every account of the person with its provider, email, live key count and this session's mark", async () => {
    const { first, firstBrowser, secondBrowser, firstId, secondId } =
      await twoGmailAccounts()
    const onFirst = await callerOf(firstBrowser)
    const onSecond = await callerOf(secondBrowser)
    await createKey(onFirst, 'first laptop')
    await createKey(onSecond, 'second laptop')
    await createKey(onSecond, 'second ci')
    const gone = await createKey(onSecond, 'second gone')
    await asCaller(onSecond, (signIn) => signIn.revokeKey(gone.key.id))

    expect(await listOf(onFirst)).toEqual([
      {
        id: firstId,
        provider: 'google',
        email: first.email,
        current: true,
        agentKeys: 1,
      },
      {
        id: secondId,
        provider: 'google',
        email: first.email,
        current: false,
        agentKeys: 2,
      },
    ] satisfies SignInAccountView[])
    // Seen from the other account's session, that one is first and current.
    expect(await listOf(onSecond)).toEqual([
      {
        id: secondId,
        provider: 'google',
        email: first.email,
        current: true,
        agentKeys: 2,
      },
      {
        id: firstId,
        provider: 'google',
        email: first.email,
        current: false,
        agentKeys: 1,
      },
    ])
    // The Settings view carries the same rows.
    expectTypeOf<AccountView['signInAccounts']>().toEqualTypeOf<
      readonly SignInAccountView[]
    >()
  })

  it("lists this session's account first, then the others by first sign-in", async () => {
    const { first, secondBrowser, firstId, secondId } = await twoGmailAccounts()
    const third: FakeIdentity = {
      sub: `${first.sub}-third`,
      email: first.email,
    }
    const thirdBrowser = await signedIn(third)
    const thirdId = await accountIdOf(third.sub)
    const idsSeenBy = async (browser: Browser) =>
      (await listOf(await callerOf(browser))).map((row) => row.id)
    expect(await idsSeenBy(thirdBrowser)).toEqual([thirdId, firstId, secondId])
    expect(await idsSeenBy(secondBrowser)).toEqual([secondId, firstId, thirdId])
  })

  it('shows one row for a person with one account', async () => {
    const only = fresh('gmail.com', 'only')
    const caller = await callerOf(await signedIn(only))
    expect(await listOf(caller)).toEqual([
      {
        id: await accountIdOf(only.sub),
        provider: 'google',
        email: only.email,
        current: true,
        agentKeys: 0,
      },
    ])
  })

  it('needs a signed-in person', async () => {
    const refused = await asCaller(visitorCaller(), (signIn) =>
      signIn.signInAccounts().pipe(Effect.flip),
    )
    expect(refused.code).toBe('sign_in_required')
  })
})

describe('disconnecting a sign-in account', () => {
  it('ends only its sessions, revokes only its keys, denies only the CLI logins it approved, and removes it', async () => {
    const {
      first,
      second,
      firstBrowser,
      secondBrowser,
      userId,
      firstId,
      secondId,
    } = await twoGmailAccounts()
    const secondAgain = await signedIn(second)
    const onFirst = await callerOf(firstBrowser)
    const onSecond = await callerOf(secondBrowser)

    const firstKey = await createKey(onFirst, 'first laptop')
    const secondKey = await createKey(onSecond, 'second laptop')
    const secondKeyToo = await createKey(onSecond, 'second ci')
    const revokedEarlier = await createKey(onSecond, 'second old')
    await asCaller(onSecond, (signIn) =>
      signIn.revokeKey(revokedEarlier.key.id),
    )
    const revokedEarlierAt = await revokedAtOf(revokedEarlier.key.id)
    expect(revokedEarlierAt).toEqual(expect.any(Number))

    const approvedBySecond = await requestCode()
    await approveAs(onSecond, approvedBySecond)
    const approvedByFirst = await requestCode()
    await approveAs(onFirst, approvedByFirst)
    const pending = await requestCode()

    // Someone else, who must not notice.
    const other = fresh('gmail.com', 'other')
    const otherBrowser = await signedIn(other)
    const otherKey = await createKey(await callerOf(otherBrowser), 'theirs')
    const otherId = await userIdOf(other.email)
    const otherBefore = await stateOf(otherId ?? '')

    await disconnect(onFirst, secondId)

    // Its sessions end; the others stay.
    expect((await me(secondBrowser)).status).toBe(401)
    expect((await me(secondAgain)).status).toBe(401)
    expect(
      await rows(
        'select id from session where sign_in_account_id = ?',
        secondId,
      ),
    ).toEqual([])
    expect((await me(firstBrowser)).status).toBe(200)
    expect((await me(otherBrowser)).status).toBe(200)

    // Its live keys stop working; a key revoked before keeps its time.
    expect(await keyWorks(secondKey.secret)).toBe(false)
    expect(await keyWorks(secondKeyToo.secret)).toBe(false)
    expect(await revokedAtOf(secondKey.key.id)).toEqual(expect.any(Number))
    expect(await revokedAtOf(secondKeyToo.key.id)).toEqual(expect.any(Number))
    expect(await revokedAtOf(revokedEarlier.key.id)).toBe(revokedEarlierAt)
    expect(await keyWorks(firstKey.secret)).toBe(true)
    expect(await keyWorks(otherKey.secret)).toBe(true)

    // The CLI login it approved is cancelled; others are not.
    expect(await statusOf(approvedBySecond)).toBe('denied')
    expect(await pollCode(approvedBySecond)).toBe('access_denied')
    expect(await statusOf(approvedByFirst)).toBe('approved')
    expect(await statusOf(pending)).toBe('pending')

    // The account and its email record are gone; the person and the other account stay.
    expect(await accountIdOf(second.sub)).toBeUndefined()
    expect(
      await rows('select 1 from account_emails where account_id = ?', secondId),
    ).toEqual([])
    expect(await accountIdOf(first.sub)).toBe(firstId)
    expect(
      await rows(
        'select email from account_emails where account_id = ?',
        firstId,
      ),
    ).toEqual([{ email: first.email }])
    expect(await userIdOf(first.email)).toBe(userId)
    expect(
      await rows('select 1 from people where user_id = ?', userId),
    ).toHaveLength(1)

    // Person history records it once, naming the account and its provider.
    const disconnected = (await historyOf(userId)).filter(
      (entry) => entry.kind === 'disconnected',
    )
    expect(disconnected).toEqual([
      {
        kind: 'disconnected',
        detail: { accountId: secondId, provider: 'google' },
      },
    ])

    expect(await listOf(onFirst)).toEqual([
      {
        id: firstId,
        provider: 'google',
        email: first.email,
        current: true,
        agentKeys: 1,
      },
    ])
    expect(await stateOf(otherId ?? '')).toEqual(otherBefore)
  })

  it('refuses the last account, the account this session uses, and anyone else’s account, changing nothing', async () => {
    const { first, second, firstBrowser, secondBrowser, userId, firstId } =
      await twoGmailAccounts()
    const onFirst = await callerOf(firstBrowser)
    const onSecond = await callerOf(secondBrowser)
    await createKey(onFirst, 'first laptop')
    await createKey(onSecond, 'second laptop')
    await approveAs(onFirst, await requestCode())

    const lone = fresh('gmail.com', 'lone')
    const loneBrowser = await signedIn(lone)
    const onLone = await callerOf(loneBrowser)
    await createKey(onLone, 'lone laptop')
    await approveAs(onLone, await requestCode())
    const loneUserId = (await userIdOf(lone.email)) ?? ''
    const loneId = (await accountIdOf(lone.sub)) ?? ''

    const before = await stateOf(userId, loneUserId)
    const unchanged = async () =>
      expect(await stateOf(userId, loneUserId)).toEqual(before)

    // The account this session uses.
    expect(await refusalOf(onFirst, firstId)).toBe('account_in_use')
    await unchanged()

    // The person's only account.
    expect(await refusalOf(onLone, loneId)).toBe('last_account')
    await unchanged()

    // Someone else's account, by its id or its provider subject, and accounts
    // that do not exist.
    for (const accountId of [
      loneId,
      lone.sub,
      second.sub,
      first.sub,
      'no-such-account',
      '',
      `${firstId}' or 1 = 1 --`,
    ]) {
      expect(await refusalOf(onFirst, accountId)).toBe('not_found')
      await unchanged()
    }
    expect(await refusalOf(onLone, firstId)).toBe('not_found')
    await unchanged()

    expect((await me(firstBrowser)).status).toBe(200)
    expect((await me(secondBrowser)).status).toBe(200)
    expect((await me(loneBrowser)).status).toBe(200)
  })

  it('is refused to an agent key and to a visitor, changing nothing', async () => {
    const { firstBrowser, userId, secondId } = await twoGmailAccounts()
    const person = (await callerOf(firstBrowser)).person
    if (person === null) throw new Error('not signed in')
    const byKey = await agent(person)
    const before = await stateOf(userId)
    expect(await refusalOf(byKey, secondId)).toBe('sign_in_required')
    expect(await refusalOf(visitorCaller(), secondId)).toBe('sign_in_required')
    expect(await stateOf(userId)).toEqual(before)
  })

  it('changes nothing when another request disconnected the account first', async () => {
    const { first, firstBrowser, userId, secondId } = await twoGmailAccounts()
    const onFirst = await callerOf(firstBrowser)
    // Settings open in another browser, signed in with the same account.
    const otherTab = await callerOf(await signedIn(first))
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) => /delete\s+from\s+["`]?account_emails/i.test(sql),
            async () => {
              harness.reset()
              await disconnect(otherTab, secondId)
            },
          ),
        },
      }),
    )
    expect(await refusalOf(onFirst, secondId)).toBe('not_found')
    harness.reset()
    expect(
      (await historyOf(userId)).filter(
        (entry) => entry.kind === 'disconnected',
      ),
    ).toHaveLength(1)
    expect((await me(firstBrowser)).status).toBe(200)
  })

  it('never leaves a person without an account when two sessions disconnect each other’s', async () => {
    const {
      first,
      second,
      firstBrowser,
      secondBrowser,
      userId,
      firstId,
      secondId,
    } = await twoGmailAccounts()
    const onFirst = await callerOf(firstBrowser)
    const onSecond = await callerOf(secondBrowser)
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) => /delete\s+from\s+["`]?account_emails/i.test(sql),
            async () => {
              harness.reset()
              await disconnect(onSecond, firstId)
            },
          ),
        },
      }),
    )
    const code = await refusalOf(onFirst, secondId)
    harness.reset()
    expect(['last_account', 'sign_in_required']).toContain(code)
    expect(await accountIdOf(first.sub)).toBeUndefined()
    expect(await accountIdOf(second.sub)).toBe(secondId)
    expect((await me(secondBrowser)).status).toBe(200)
    expect(
      (await historyOf(userId)).filter(
        (entry) => entry.kind === 'disconnected',
      ),
    ).toEqual([
      {
        kind: 'disconnected',
        detail: { accountId: firstId, provider: 'google' },
      },
    ])
  })
})

describe('signing in again with a disconnected account', () => {
  it('joins the person again when Google confirms the Gmail address', async () => {
    const { second, firstBrowser, secondBrowser, userId, secondId } =
      await twoGmailAccounts()
    await disconnect(await callerOf(firstBrowser), secondId)
    expect((await me(secondBrowser)).status).toBe(401)

    const back = await signedIn(second)
    const backId = await accountIdOf(second.sub)
    expect(backId).toBeDefined()
    expect(
      (
        await rows<{ user_id: string }>(
          'select user_id from account where id = ?',
          backId,
        )
      )[0]?.user_id,
    ).toBe(userId)
    const body = (await (await me(back)).json()) as { person: { id: string } }
    expect(body.person.id).toBe(userId)
    expect((await historyOf(userId)).map((entry) => entry.kind)).toEqual([
      'linked',
      'disconnected',
      'linked',
    ])
  })

  it('is refused when its provider is not the email authority for the person’s email', async () => {
    const owner = { ...fresh('acme.test', 'ines'), hd: 'acme.test' }
    const ownerBrowser = await signedIn(owner)
    const joining = {
      sub: `${owner.sub}-second`,
      email: owner.email,
      hd: 'acme.test',
    }
    await signedIn(joining)
    const userId = (await userIdOf(owner.email)) ?? ''
    const joiningId = (await accountIdOf(joining.sub)) ?? ''
    expect(
      (
        await rows<{ user_id: string }>(
          'select user_id from account where id = ?',
          joiningId,
        )
      )[0]?.user_id,
    ).toBe(userId)
    await disconnect(await callerOf(ownerBrowser), joiningId)

    // The same Google account, now without its Workspace domain.
    const before = await stateOf(userId)
    const browser = new Browser()
    const response = await browser.signIn({
      sub: joining.sub,
      email: joining.email,
    })
    const location = new URL(response.headers.get('location') ?? '', ORIGIN)
    expect(location.pathname).toBe('/_/sign-in')
    expect(location.searchParams.get('error')).toBe('email_unconfirmed')
    expect(browser.sessionToken()).toBeUndefined()
    expect(await accountIdOf(joining.sub)).toBeUndefined()
    expect(await stateOf(userId)).toEqual(before)
  })
})

describe("the sign-in library's own account routes", () => {
  it('answer not found, and unlink nothing', async () => {
    const { second, secondBrowser, firstBrowser, userId } =
      await twoGmailAccounts()
    const before = await stateOf(userId)

    const link = await firstBrowser.postAuth('/_/auth/link-social', {
      provider: 'google',
      callbackURL: '/',
    })
    expect(link.status).toBe(404)

    const list = await firstBrowser.fetch('/_/auth/list-accounts', {
      purpose: 'read',
    })
    expect(list.status).toBe(404)

    const unlink = await firstBrowser.postAuth('/_/auth/unlink-account', {
      providerId: 'google',
      accountId: second.sub,
    })
    expect(unlink.status).toBe(404)

    expect(await stateOf(userId)).toEqual(before)
    expect((await me(secondBrowser)).status).toBe(200)
  })
})
