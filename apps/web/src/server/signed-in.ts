import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import type { SignedInPerson } from '../components/avatar.tsx'
import { CurrentCaller } from '../core/index.ts'
import { isScreenFailure } from './failure.ts'
import { runScreen } from './run.ts'

/** Who is signed in, for the account chip of every screen; null for nobody. */
export const signedInPerson = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SignedInPerson | null> => {
    const result = await runScreen(
      Effect.map(CurrentCaller, ({ person }) =>
        person === null
          ? null
          : { email: person.email, name: person.name, image: person.image },
      ),
    )
    return isScreenFailure(result) ? null : result
  },
)
