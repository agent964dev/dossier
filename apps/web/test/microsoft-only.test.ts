// A Deployment that turns on Microsoft and not Google, and the Microsoft pair
// read like Google's: on only when both values are set.
import { env } from 'cloudflare:workers'
import { Effect, Redacted } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { Config } from '../src/core/index.ts'
import { parseConfig } from '../src/core/config.ts'
import { Browser } from './support/browser.ts'
import { consent } from './support/fake-google.ts'
import { consentMicrosoft, PERSONAL_TID } from './support/fake-microsoft.ts'
import { harness, microsoft, ORIGIN, testRuntime } from './support/harness.ts'
import { fresh, run } from './support/people.ts'

afterEach(() => harness.reset())

const MICROSOFT_ONLY = { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }

/** The providers the running Deployment turned on, Google first. */
const providersOn = () =>
  run(
    Effect.map(Config, (config) =>
      [
        config.google === null ? null : 'google',
        config.microsoft === null ? null : 'microsoft',
      ].filter((provider) => provider !== null),
    ),
  )

const start = (browser: Browser, provider: 'google' | 'microsoft') =>
  browser.postAuth('/_/auth/sign-in/social', {
    provider,
    callbackURL: '/',
    errorCallbackURL: '/_/sign-in?next=%2F',
  })

describe('a Deployment with only the Microsoft pair', () => {
  it('turns on only Microsoft', async () => {
    harness.use(testRuntime({ env: MICROSOFT_ONLY }))
    expect(await providersOn()).toEqual(['microsoft'])
    const config = await run(Effect.map(Config, (c) => c))
    expect(config.google).toBeNull()
    expect(config.microsoft?.clientId).toBe(microsoft.clientId)
  })

  it('starts a Microsoft sign-in and signs the person in', async () => {
    harness.use(testRuntime({ env: MICROSOFT_ONLY }))
    const browser = new Browser()
    const started = await start(browser, 'microsoft')
    expect(started.status).toBe(200)
    const { url } = (await started.json()) as { url: string }
    expect(url).toMatch(
      /^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize\?/,
    )
    const identity = {
      oid: crypto.randomUUID(),
      tid: PERSONAL_TID,
      email: fresh('outlook.com', 'only').email,
    }
    const response = await browser.callback(consentMicrosoft(url, identity))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')
    expect(browser.sessionToken()).toBeDefined()
  })

  it('refuses a Google start, and a Google callback signs no one in', async () => {
    harness.use(testRuntime({ env: MICROSOFT_ONLY }))
    const browser = new Browser()
    const started = await start(browser, 'google')
    expect(started.status).toBeGreaterThanOrEqual(400)
    expect(browser.sessionToken()).toBeUndefined()

    // A Google consent started while Google was on, returning after it went off.
    harness.reset()
    const earlier = new Browser()
    const { url } = (await (await start(earlier, 'google')).json()) as {
      url: string
    }
    harness.use(testRuntime({ env: MICROSOFT_ONLY }))
    const callback = consent(url, fresh('gmail.com', 'late'))
    const response = await earlier.callback(callback)
    expect(earlier.sessionToken()).toBeUndefined()
    expect(
      new URL(response.headers.get('location') ?? '', ORIGIN).pathname,
    ).toBe('/_/sign-in')
  })
})

describe('a half-set Microsoft pair at run time', () => {
  it.each([
    { half: 'no secret', set: { MICROSOFT_CLIENT_SECRET: '' } },
    { half: 'no client ID', set: { MICROSOFT_CLIENT_ID: '  ' } },
  ])('counts as off with $half', async ({ set }) => {
    harness.use(testRuntime({ env: set }))
    expect(await providersOn()).toEqual(['google'])
    const started = await start(new Browser(), 'microsoft')
    expect(started.status).toBeGreaterThanOrEqual(400)
  })
})

describe("reading the Microsoft pair from the Worker's environment", () => {
  it('trims both values and turns Microsoft on only when both are set', () => {
    const on = parseConfig({
      ...env,
      MICROSOFT_CLIENT_ID: '  the-client  ',
      MICROSOFT_CLIENT_SECRET: '\tthe-secret\n',
    })
    expect(on.microsoft?.clientId).toBe('the-client')
    expect(
      on.microsoft === null || on.microsoft === undefined
        ? null
        : Redacted.value(on.microsoft.clientSecret),
    ).toBe('the-secret')
    for (const half of [
      { MICROSOFT_CLIENT_ID: 'the-client', MICROSOFT_CLIENT_SECRET: '' },
      { MICROSOFT_CLIENT_ID: '', MICROSOFT_CLIENT_SECRET: 'the-secret' },
      { MICROSOFT_CLIENT_ID: 'the-client', MICROSOFT_CLIENT_SECRET: ' ' },
      { MICROSOFT_CLIENT_ID: undefined, MICROSOFT_CLIENT_SECRET: undefined },
    ]) {
      expect(parseConfig({ ...env, ...half }).microsoft).toBeNull()
    }
  })

  it('keeps Google and Microsoft apart', () => {
    const both = parseConfig(env)
    expect(both.google?.clientId).toBe(env.GOOGLE_CLIENT_ID)
    expect(both.microsoft?.clientId).toBe(env.MICROSOFT_CLIENT_ID)
    const microsoftOnly = parseConfig({ ...env, ...MICROSOFT_ONLY })
    expect(microsoftOnly.google).toBeNull()
    expect(microsoftOnly.microsoft?.clientId).toBe(env.MICROSOFT_CLIENT_ID)
  })
})
