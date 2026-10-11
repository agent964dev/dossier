import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import { Config, CurrentCaller } from '../core/index.ts'
import { runScreen } from './run.ts'

export interface HomeView {
  readonly deployment: string
  /** Null renders the front page. */
  readonly me: { readonly email: string; readonly name: string } | null
  /** "Shared with me" rows arrive with sharing. */
  readonly shared: readonly never[]
}

export const homeView = createServerFn({ method: 'GET' }).handler(() =>
  runScreen(
    Effect.gen(function* () {
      const { person } = yield* CurrentCaller
      const config = yield* Config
      return {
        deployment: config.deploymentName,
        me: person === null ? null : { email: person.email, name: person.name },
        shared: [],
      } satisfies HomeView
    }),
  ),
)
