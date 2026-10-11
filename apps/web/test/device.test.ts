import { ErrorBody } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect, Layer, Schema } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { Bindings, Config, SignIn } from '../src/core/index.ts'
import { sha256Hex } from '../src/core/ids.ts'
import { Auth, makeAuthPort } from '../src/ports/auth.ts'
import { type Browser, signedIn } from './support/browser.ts'
import { count, exec, failingStatements, rows } from './support/d1.ts'
import { harness, ORIGIN, testRuntime } from './support/harness.ts'
import { callerOf, fresh, runAs } from './support/people.ts'

interface DeviceCode {
  readonly device_code: string
  readonly user_code: string
  readonly verification_uri: string
  readonly verification_uri_complete: string
  readonly expires_in: number
  readonly interval: number
}

afterEach(() => harness.reset())

const requestCode = async (deviceName = 'cli on m4'): Promise<DeviceCode> => {
  const response = await SELF.fetch(`${ORIGIN}/_/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: 'dossier-cli',
      scope: 'agent-key',
      device_name: deviceName,
    }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as DeviceCode
}

const poll = async (code: DeviceCode, form = false) => {
  const response = await SELF.fetch(`${ORIGIN}/_/api/device/token`, {
    method: 'POST',
    headers: {
      'content-type': form
        ? 'application/x-www-form-urlencoded'
        : 'application/json',
    },
    body: form
      ? new URLSearchParams({ deviceCode: code.device_code })
      : JSON.stringify({ deviceCode: code.device_code }),
  })
  const body: unknown = await response.json()
  return { response, body }
}

const codeOf = async (result: { body: unknown }) =>
  Schema.decodeUnknownSync(ErrorBody)(result.body).error.code

/** Lets the next poll through the five-second interval without waiting. */
const forgetLastPoll = (code: DeviceCode) =>
  exec(
    'update device_code set last_polled_at = null where device_code = ?',
    code.device_code,
  )

const approveAs = async (browser: Browser, code: DeviceCode) => {
  const caller = await callerOf(browser)
  const prompt = await runAs(
    caller,
    Effect.flatMap(SignIn, (signIn) => signIn.devicePrompt(code.user_code)),
  )
  await runAs(
    caller,
    Effect.flatMap(SignIn, (signIn) => signIn.approveDevice(code.user_code)),
  )
  return prompt
}

const keysOf = (email: string) =>
  rows<{
    name: string
    created_via: string
    google_account_id: string
    hash_sha256: string
  }>(
    `select k.name, k.created_via, k.google_account_id, k.hash_sha256 from agent_keys k
       join "user" u on u.id = k.user_id where u.email = ?`,
    email,
  )

const accountIdOf = async (sub: string) =>
  (
    await rows<{ id: string }>(
      'select id from account where account_id = ?',
      sub,
    )
  )[0]?.id

describe('dossier login', () => {
  it('issues a code with the device name, and redeems it once for an agent key and never a session', async () => {
    const code = await requestCode()
    expect(code.expires_in).toBe(600)
    expect(code.interval).toBe(5)
    expect(code.user_code).toMatch(/^[A-Z2-9]{8}$/)
    expect(code.verification_uri).toBe(`${ORIGIN}/_/device`)
    expect(code.verification_uri_complete).toBe(
      `${ORIGIN}/_/device?user_code=${code.user_code}`,
    )
    const [stored] = await rows<{
      device_name: string
      client_id: string
      scope: string
    }>(
      'select device_name, client_id, scope from device_code where device_code = ?',
      code.device_code,
    )
    expect(stored).toEqual({
      device_name: 'cli on m4',
      client_id: 'dossier-cli',
      scope: 'agent-key',
    })

    const pending = await poll(code)
    expect(pending.response.status).toBe(400)
    expect(await codeOf(pending)).toBe('device_pending')
    expect(await codeOf(await poll(code))).toBe('slow_down')

    const identity = fresh()
    const person = await signedIn(identity)
    const prompt = await approveAs(person, code)
    expect(prompt).toMatchObject({
      name: 'cli on m4',
      deployment: 'dossier.test',
    })

    await forgetLastPoll(code)
    const sessions = await count('session')
    const redeemed = await poll(code)
    expect(redeemed.response.status).toBe(200)
    expect(redeemed.response.headers.getSetCookie()).toEqual([])
    const token = redeemed.body as {
      key: string
      name: string
      deployment: string
      person: { email: string }
    }
    expect(token.key).toMatch(/^dsk_[A-Za-z0-9_-]{43}$/)
    expect(token).toMatchObject({
      name: 'cli on m4',
      deployment: 'dossier.test',
      person: { email: identity.email },
    })
    expect(await count('session')).toBe(sessions)

    const keys = await keysOf(identity.email)
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({
      name: 'cli on m4',
      created_via: 'device',
      google_account_id: await accountIdOf(identity.sub),
      hash_sha256: await sha256Hex(token.key),
    })
    const me = await SELF.fetch(`${ORIGIN}/_/api/me`, {
      headers: { authorization: `Bearer ${token.key}` },
    })
    expect(((await me.json()) as { key: { name: string } }).key.name).toBe(
      'cli on m4',
    )

    await forgetLastPoll(code)
    expect(await codeOf(await poll(code))).toBe('device_expired')
  })

  it('accepts form-encoded requests, as device clients send them', async () => {
    const response = await SELF.fetch(`${ORIGIN}/_/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'dossier-cli',
        device_name: 'ssh box',
      }),
    })
    expect(response.status).toBe(200)
    const code = (await response.json()) as DeviceCode
    expect(await codeOf(await poll(code, true))).toBe('device_pending')
  })

  it('refuses the plugin’s own session redemption and other clients', async () => {
    const code = await requestCode()
    const viaPlugin = await SELF.fetch(`${ORIGIN}/_/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: 'dossier-cli',
      }),
    })
    expect(viaPlugin.status).toBe(400)
    const other = await SELF.fetch(`${ORIGIN}/_/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'someone-else', device_name: 'x' }),
    })
    expect(other.status).toBe(400)
  })

  it('answers access_denied after Deny', async () => {
    const code = await requestCode()
    const person = await signedIn(fresh())
    const caller = await callerOf(person)
    await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) => signIn.denyDevice(code.user_code)),
    )
    expect(await codeOf(await poll(code))).toBe('access_denied')
  })

  it('answers device_expired for an expired code, and shows it expired', async () => {
    const code = await requestCode()
    await exec(
      'update device_code set expires_at = ? where device_code = ?',
      Date.now() - 1,
      code.device_code,
    )
    const person = await signedIn(fresh())
    const prompt = runAs(
      await callerOf(person),
      Effect.flatMap(SignIn, (signIn) => signIn.devicePrompt(code.user_code)),
    )
    await expect(prompt).rejects.toThrow('This code expired')
    expect(await codeOf(await poll(code))).toBe('device_expired')
  })

  it('binds a code to the first person who opens it', async () => {
    const code = await requestCode()
    const first = await callerOf(await signedIn(fresh()))
    await runAs(
      first,
      Effect.flatMap(SignIn, (signIn) => signIn.devicePrompt(code.user_code)),
    )
    const second = await callerOf(await signedIn(fresh()))
    for (const attempt of [
      Effect.flatMap(SignIn, (signIn) => signIn.devicePrompt(code.user_code)),
      Effect.flatMap(SignIn, (signIn) => signIn.approveDevice(code.user_code)),
    ]) {
      await expect(runAs(second, attempt)).rejects.toThrow('This code expired')
    }
    await runAs(
      first,
      Effect.flatMap(SignIn, (signIn) => signIn.approveDevice(code.user_code)),
    )
    await forgetLastPoll(code)
    expect((await poll(code)).response.status).toBe(200)
  })

  it('answers device_expired and mints nothing when minting fails after the claim', async () => {
    const code = await requestCode()
    const identity = fresh()
    await approveAs(await signedIn(identity), code)
    await forgetLastPoll(code)
    harness.use(
      testRuntime({
        env: {
          DB: failingStatements(env.DB, (sql) =>
            /insert into "?agent_keys/.test(sql),
          ),
        },
      }),
    )
    const failed = await poll(code)
    expect(await codeOf(failed)).toBe('device_expired')
    harness.reset()
    expect(await keysOf(identity.email)).toEqual([])
    expect(
      await count('device_code', 'device_code = ?', code.device_code),
    ).toBe(0)
  })

  it('refuses a code approved by an account a takeover detached before the poll', async () => {
    const lapsed = fresh('acme.test')
    const code = await requestCode()
    await approveAs(await signedIn(lapsed), code)
    await signedIn({
      sub: `${lapsed.sub}-ws`,
      email: lapsed.email,
      hd: 'acme.test',
    })
    const [row] = await rows<{ status: string }>(
      'select status from device_code where device_code = ?',
      code.device_code,
    )
    expect(row?.status).toBe('denied')
    await forgetLastPoll(code)
    expect(await codeOf(await poll(code))).toBe('access_denied')
    expect(await keysOf(lapsed.email)).toEqual([])
  })

  it('refuses a code whose approving account a takeover detached between the claim and the minting', async () => {
    const lapsed = fresh('acme.test')
    const code = await requestCode()
    await approveAs(await signedIn(lapsed), code)
    await forgetLastPoll(code)
    const approving = await accountIdOf(lapsed.sub)
    // The takeover lands right after the code is claimed.
    const racingAuth = Layer.effect(
      Auth,
      Effect.gen(function* () {
        const bindings = yield* Bindings
        const config = yield* Config
        return (hooks) => {
          const port = makeAuthPort(bindings, config, hooks)
          return {
            ...port,
            redeemDeviceCode: (deviceCode) =>
              port
                .redeemDeviceCode(deviceCode)
                .pipe(
                  Effect.tap(() =>
                    Effect.promise(() =>
                      exec('delete from account where id = ?', approving),
                    ),
                  ),
                ),
          }
        }
      }),
    )
    harness.use(testRuntime({ overrides: { auth: racingAuth } }))
    expect(await codeOf(await poll(code))).toBe('access_denied')
    expect(await keysOf(lapsed.email)).toEqual([])
  })
})
