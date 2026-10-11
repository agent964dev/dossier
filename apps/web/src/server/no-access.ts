import { dossierError } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import { CurrentCaller } from '../core/index.ts'
import { runScreen, type ScreenFailure } from './run.ts'

/** The one no-access page names who is signed in, and nothing else. */
export const noAccessView = createServerFn({ method: 'GET' }).handler(
  (): Promise<{ readonly email: string } | ScreenFailure> =>
    runScreen(
      Effect.gen(function* () {
        const { person } = yield* CurrentCaller
        if (person === null) {
          return yield* Effect.fail(
            dossierError('sign_in_required', 'Sign in to open this.'),
          )
        }
        return { email: person.email }
      }),
    ),
)
