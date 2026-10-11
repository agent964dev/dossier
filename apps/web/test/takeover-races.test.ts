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
    // Better Auth's own session routes do not accept it either.
    const session = await late.fetch('/_/auth/get-session', { purpose: 'read' })
    expect(await session.json()).toBeNull()
    const rename = await late.postAuth('/_/auth/update-user', {
      name: 'not yours',
    })
    expect(rename.status).toBe(401)
    expect(
      await rows(
        'select 1 from "user" where email = ? and name = ?',
        lapsed.email,
        'not yours',
      ),
    ).toEqual([])
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

/** An Auth whose sign-in, for `sub`, first lets `meanwhile` run. */
const pausing = (sub: string, meanwhile: () => Promise<void>) => {
  let armed = true
  return Layer.effect(
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
              if (armed && signIn.claims.sub === sub) {
                armed = false
                await meanwhile()
              }
              await hooks.afterSignIn(signIn)
            },
          },
          [testUtils()],
        )
    }),
  )
}

describe('takeovers happen only when an account joins', () => {
  it('leaves a joining Workspace account alone when another vouched account signs in meanwhile', async () => {
    const first = fresh('acme.test', 'vouched')
    const firstIdentity = { ...first, hd: 'acme.test' }
    await signedIn(firstIdentity)
    const joining = {
      sub: `${first.sub}-second`,
      email: first.email,
      hd: 'acme.test',
    }
    harness.use(
      testRuntime({
        overrides: {
          auth: pausing(joining.sub, async () => {
            await new Browser().signIn(firstIdentity)
          }),
        },
      }),
    )
    const joiner = new Browser()
    await joiner.signIn(joining)
    expect(await accountIdOf(joining.sub)).toBeDefined()
    expect(await accountIdOf(first.sub)).toBeDefined()
    expect((await me(joiner)).status).toBe(200)
    const kinds = await rows<{ kind: string }>(
      `select kind from person_history h join "user" u on u.id = h.user_id where u.email = ?`,
      first.email,
    )
    expect(kinds.map((row) => row.kind)).toEqual(['linked'])
  })

  it('does not detach an account that later loses its vouching when another account signs in', async () => {
    const first = fresh('acme.test', 'keeps')
    const firstIdentity = { ...first, hd: 'acme.test' }
    await signedIn(firstIdentity)
    const second = {
      sub: `${first.sub}-second`,
      email: first.email,
      hd: 'acme.test',
    }
    await signedIn(second)
    // The second account comes back without its hosted domain.
    const lapsedBrowser = await signedIn({
      sub: second.sub,
      email: second.email,
    })
    const [metadata] = await rows<{ email_authority: string }>(
      'select email_authority from google_accounts where account_id = ?',
      await accountIdOf(second.sub),
    )
    expect(metadata?.email_authority).toBe('none')
    await signedIn(firstIdentity)
    expect(await accountIdOf(second.sub)).toBeDefined()
    expect((await me(lapsedBrowser)).status).toBe(200)
  })
})

describe('a join paused before its batch', () => {
  const historyOf = async (email: string) =>
    (
      await rows<{ kind: string; detail_json: string }>(
        `select h.kind, h.detail_json from person_history h join "user" u on u.id = h.user_id
           where u.email = ? order by h.created_at, h.rowid`,
        email,
      )
    ).map((row) => ({
      kind: row.kind,
      detail: JSON.parse(row.detail_json) as unknown,
    }))

  /** Serves `body` with B's first sign-in paused just before its batch while `meanwhile` runs. */
  const pausedJoin = (meanwhile: () => Promise<void>) =>
    harness.use(
      testRuntime({
        env: {
          DB: beforeBatch(
            env.DB,
            (sql) => /insert into "?google_accounts/.test(sql),
            async () => {
              harness.reset()
              await meanwhile()
            },
          ),
        },
      }),
    )

  it('does nothing when another sign-in finished the same join meanwhile', async () => {
    const lapsed = fresh('acme.test', 'paused')
    await signedIn(lapsed)
    const vouched = { ...lapsed, hd: 'acme.test' }
    const joining = {
      sub: `${lapsed.sub}-join`,
      email: lapsed.email,
      hd: 'acme.test',
    }
    pausedJoin(async () => {
      await signedIn(vouched) // the first account regains its vouching
      await signedIn(joining) // a second sign-in finishes the join
      await signedIn(lapsed) // the first account loses its vouching again
    })
    await new Browser().signIn(joining)
    harness.reset()
    expect(await accountIdOf(lapsed.sub)).toBeDefined()
    expect((await historyOf(lapsed.email)).map((h) => h.kind)).toEqual([
      'linked',
    ])
  })

  it('records only the accounts the takeover actually detached', async () => {
    const lapsed = fresh('acme.test', 'regains')
    await signedIn(lapsed)
    const joining = {
      sub: `${lapsed.sub}-join`,
      email: lapsed.email,
      hd: 'acme.test',
    }
    pausedJoin(async () => {
      await signedIn({ ...lapsed, hd: 'acme.test' })
    })
    await new Browser().signIn(joining)
    harness.reset()
    expect(await accountIdOf(lapsed.sub)).toBeDefined()
    expect((await historyOf(lapsed.email)).map((h) => h.kind)).toEqual([
      'linked',
    ])
  })

  it('records the detached accounts of a takeover that happens', async () => {
    const lapsed = fresh('acme.test', 'detached')
    await signedIn(lapsed)
    const lapsedAccount = await accountIdOf(lapsed.sub)
    const joining = {
      sub: `${lapsed.sub}-join`,
      email: lapsed.email,
      hd: 'acme.test',
    }
    await signedIn(joining)
    expect(await historyOf(lapsed.email)).toEqual([
      { kind: 'linked', detail: { accountId: await accountIdOf(joining.sub) } },
      {
        kind: 'takeover',
        detail: {
          by: await accountIdOf(joining.sub),
          detached: [lapsedAccount],
        },
      },
    ])
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
            /delete from "?account"? /.test(sql),
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
