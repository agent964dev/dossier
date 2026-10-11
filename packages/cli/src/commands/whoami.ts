import { Command } from '@effect/cli'
import { dossierError, type Me } from '@dossier/contracts'
import { Effect } from 'effect'

import { callApi } from '../client.ts'
import {
  currentDeployment,
  type Deployment,
  loginCommand,
} from '../deployment.ts'
import { Cli } from '../io.ts'
import { jsonOption } from '../render.ts'

/** No agent key for this deployment, in the environment or the config file. */
export const notSignedIn = (deployment: Deployment) =>
  dossierError(
    'sign_in_required',
    `Not signed in to ${deployment.id}.`,
    `Run ${loginCommand(deployment)} to sign in.`,
  )

export const describeMe = (me: Me): string =>
  `${me.person.email} on ${me.deployment}` +
  (me.key === null ? '' : ` (key "${me.key.name}")`)

export const whoami = Command.make('whoami', { json: jsonOption }, () =>
  Effect.gen(function* () {
    const { output } = yield* Cli
    const { deployment, key } = yield* currentDeployment()
    if (key === null) return yield* Effect.fail(notSignedIn(deployment))
    const me = yield* callApi(deployment, key, (client) => client.me.me())
    output.result(describeMe(me), me)
  }),
).pipe(
  Command.withDescription(
    'Show the person, deployment and agent key this CLI acts with.',
  ),
)
