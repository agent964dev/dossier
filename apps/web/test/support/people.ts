import { Effect } from 'effect'

import {
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

/** Runs an effect as `caller`. */
export const runAs = <A, E>(
  caller: Caller,
  effect: Effect.Effect<A, E, CoreServices | CurrentCaller>,
) => run(Effect.provideService(effect, CurrentCaller, caller))

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
