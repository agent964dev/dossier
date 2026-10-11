// A takeover racing the requests of the account it detaches, and a takeover
// that fails partway and is retried.
import { env } from 'cloudflare:workers'
import { testUtils } from 'better-auth/plugins'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { Bindings, Config, SignIn } from '../src/core/index.ts'
import { Auth, makeAuthPort } from '../src/ports/auth.ts'
import { Browser, signedIn } from './support/browser.ts'
import { beforeBatch, failingStatements, rows } from './support/d1.ts'
import { harness, testRuntime } from './support/harness.ts'
import { everything } from './support/keys.ts'
import { callerOf, fresh, runAs } from './support/people.ts'

afterEach(() => harness.reset())

const me = (browser: Browser) => browser.fetch('/_/api/me', { purpose: 'read' })

const accountIdOf = async (sub: string) =>
  (
    await rows<{ id: string }>(
      'select id from account where account_id = ?',
      sub,
    )
  )[0]?.id

/** A person whose only account Google cannot vouch for, and the Workspace account that takes it over. */
const lapsedAndOwner = () => {
  const lapsed = fresh('acme.test', 'lapsed')
  return {
    lapsed,
    owner: { sub: `${lapsed.sub}-ws`, email: lapsed.email, hd: 'acme.test' },
  }
}

const keyNamed = (name: string, userEmail: string) =>
  rows<{ id: string }>(
    `select k.id from agent_keys k
       join "user" u on u.id = k.user_id where u.email = ? and k.name = ?`,
    userEmail,
    name,
  )

describe('a takeover racing the account it detaches', () => {
  it('leaves no working session for a sign-in whose session is written after the takeover', async () => {
    const { lapsed, owner } = lapsedAndOwner()
    await signedIn(lapsed)
    let armed = true
    // The lapsed account signs in again; the owner's takeover lands after its
    // sign-in hooks ran and before Better Auth writes its session.
    const racing = Layer.effect(
      Auth,
      Effect.gen(function* () {
        const bindings = yield* Bindings
        const config = yield* Config
        return (hooks) =>
          makeAuthPort(
            bindings,
            config,
            {
              ...hooks,
              afterSignIn: async (signIn) => {
                await hooks.afterSignIn(signIn)
                if (armed && signIn.claims.sub === lapsed.sub) {
                  armed = false
                  await new Browser().signIn(owner)
                }
              },
            },
            [testUtils()],
          )
      }),
    )
    harness.use(testRuntime({ overrides: { auth: racing } }))
    const late = new Browser()
    await late.signIn(lapsed)
    expect(armed).toBe(false)
    expect(await accountIdOf(lapsed.sub)).toBeUndefined()
    expect((await me(late)).status).toBe(401)
  })

  it('refuses a settings key asked for after the takeover ended the session', async () => {
    const { lapsed, owner } = lapsedAndOwner()
    const caller = await callerOf(await signedIn(lapsed))
    await signedIn(owner)
    const refused = await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) =>
        signIn.createKey({ name: 'after takeover', ...everything }),
      ).pipe(Effect.flip),
    )
    expect(refused.code).toBe('sign_in_required')
    expect(await keyNamed('after takeover', lapsed.email)).toEqual([])
  })

  it('refuses a settings key when the takeover lands between its checks and its write', async () => {
    const { lapsed, owner } = lapsedAndOwner()
    const caller = await callerOf(await signedIn(lapsed))
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) => /insert into "?agent_keys/.test(sql),
            async () => {
              harness.reset()
              await signedIn(owner)
            },
          ),
        },
      }),
    )
    const refused = await runAs(
      caller,
      Effect.flatMap(SignIn, (signIn) =>
        signIn.createKey({ name: 'racing takeover', ...everything }),
      ).pipe(Effect.flip),
    )
    expect(refused.code).toBe('sign_in_required')
    expect(await keyNamed('racing takeover', lapsed.email)).toEqual([])
  })
})

describe('a takeover that fails partway', () => {
  it('is carried out at the owner’s next sign-in', async () => {
    const { lapsed, owner } = lapsedAndOwner()
    const lapsedBrowser = await signedIn(lapsed)
    harness.use(
      testRuntime({
        env: {
          DB: failingStatements(env.DB, (sql) =>
            /delete from "account"/.test(sql),
          ),
        },
      }),
    )
    const failed = new Browser()
    await failed.signIn(owner)
    expect(failed.sessionToken()).toBeUndefined()
    harness.reset()

    const ownerBrowser = await signedIn(owner)
    expect((await me(ownerBrowser)).status).toBe(200)
    expect(await accountIdOf(lapsed.sub)).toBeUndefined()
    expect((await me(lapsedBrowser)).status).toBe(401)
  })
})
