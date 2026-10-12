import type { Person } from '@dossier/contracts'
import { Effect } from 'effect'

import { SignIn } from '../../src/core/index.ts'
import { runAs, sessionFor } from './people.ts'

/** A key that reaches the whole account and can write. */
export const everything = {
  reach: { kind: 'everything' },
  readOnly: false,
} as const

/** A real agent key's secret for `who`, made from a live session. */
export const keySecretFor = async (
  who: Person,
  reach: Parameters<Effect.Effect.Success<typeof SignIn>['createKey']>[0] = {
    name: 'test',
    ...everything,
  },
): Promise<string> => {
  const { secret } = await runAs(
    await sessionFor(who),
    Effect.flatMap(SignIn, (signIn) => signIn.createKey(reach)),
  )
  return secret
}
