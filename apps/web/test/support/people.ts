import type { Person, SessionId } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'

import {
  Background,
  backgroundInline,
  CurrentCaller,
  SignIn,
  type Caller,
  type CoreServices,
} from '../../src/core/index.ts'
import type { Browser } from './browser.ts'
import { harness } from './harness.ts'

let serial = 0
/** A fresh Google subject and an address no other test uses. */
export const fresh = (domain = 'gmail.com', local = 'person') => {
  serial += 1
  const tag = `${Date.now().toString(36)}${serial}`
  return { sub: `sub-${tag}`, email: `${local}-${tag}@${domain}` }
}

/** Runs an effect with the test Worker's runtime. */
export const run = <A, E>(effect: Effect.Effect<A, E, CoreServices>) =>
  harness.runtime().runPromise(effect)

/**
 * Runs an effect as `caller`. Work after a commit finishes before it
 * returns, as if no response were waiting.
 */
export const runAs = <A, E>(
  caller: Caller,
  effect: Effect.Effect<A, E, CoreServices | CurrentCaller | Background>,
) =>
  run(
    effect.pipe(
      Effect.provideService(CurrentCaller, caller),
      Effect.provideService(Background, backgroundInline),
    ),
  )

/** The caller a screen of this browser would run as. */
export const callerOf = async (browser: Browser): Promise<Caller> => {
  const session = await run(
    Effect.flatMap(SignIn, (signIn) =>
      signIn.session(new Headers({ cookie: browser.cookieHeader() })),
    ),
  )
  if (session === null) throw new Error('the browser is not signed in')
  return {
    person: session.person,
    via: { kind: 'browser', sessionId: session.sessionId },
    requestId: 'test',
  }
}

/**
 * A browser caller for a person made directly in D1: a Google account and a
 * live session behind it, as a real sign-in leaves them.
 */
export const sessionFor = async (who: Person): Promise<Caller> => {
  const now = Date.now()
  const accountId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare(
      `insert into account (id, user_id, provider_id, account_id, created_at, updated_at)
       values (?, ?, 'google', ?, ?, ?)`,
    ).bind(accountId, who.id, `sub-${accountId}`, now, now),
    env.DB.prepare(
      `insert into session (id, user_id, token, expires_at, google_account_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      sessionId,
      who.id,
      crypto.randomUUID(),
      now + 86_400_000,
      accountId,
      now,
      now,
    ),
  ])
  return {
    person: who,
    via: { kind: 'browser', sessionId: sessionId as SessionId },
    requestId: 'test',
  }
}
