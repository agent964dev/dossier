import { Command } from '@effect/cli'
import { DossierError } from '@dossier/contracts'
import { Effect } from 'effect'

import { callApi } from '../client.ts'
import { type CliConfig, updateConfig } from '../config.ts'
import { attempt, currentDeployment } from '../deployment.ts'
import { Cli } from '../io.ts'
import { jsonOption } from '../render.ts'
import { notSignedIn } from './whoami.ts'

/** The config without this key, if it is still the one saved there. */
const withoutKey = (
  config: CliConfig,
  deploymentId: string,
  key: string,
): CliConfig => ({
  ...config,
  deployments: Object.fromEntries(
    Object.entries(config.deployments).filter(
      ([id, saved]) => id !== deploymentId || saved.key !== key,
    ),
  ),
})

const refused = (error: unknown) =>
  error instanceof DossierError && error.code === 'sign_in_required'

export const logout = Command.make('logout', { json: jsonOption }, () =>
  Effect.gen(function* () {
    const { io, output } = yield* Cli
    const { config, deployment, key } = yield* currentDeployment()
    if (key === null) return yield* Effect.fail(notSignedIn(deployment))
    const saved = Object.hasOwn(config.deployments, deployment.id)
      ? config.deployments[deployment.id]
      : undefined
    const savedHere = saved !== undefined && saved.key === key

    const revoke = callApi(deployment, key, (client) =>
      Effect.gen(function* () {
        const me = yield* client.me.me()
        yield* client.me.revokeCurrentKey()
        return me.key?.name ?? saved?.keyName ?? 'agent key'
      }),
    ).pipe(Effect.map((name) => ({ name, alreadyRevoked: false })))
    // A saved key the deployment no longer knows is still signed out of here.
    const outcome = yield* savedHere
      ? revoke.pipe(
          Effect.catchIf(refused, () =>
            Effect.succeed({ name: saved.keyName, alreadyRevoked: true }),
          ),
        )
      : revoke

    if (savedHere) {
      yield* attempt(() =>
        updateConfig(io.configPath, (current) =>
          withoutKey(current, deployment.id, key),
        ),
      )
    }
    output.result(
      outcome.alreadyRevoked
        ? `Signed out of ${deployment.id}. The key "${outcome.name}" ` +
            'was already revoked and is removed from this machine.'
        : `Signed out of ${deployment.id}. ` +
            `The key "${outcome.name}" is revoked.`,
      {
        deployment: deployment.id,
        key: { name: outcome.name },
        revoked: true,
        removedFromConfig: savedHere,
      },
    )
  }),
).pipe(
  Command.withDescription(
    'Revoke the agent key this CLI uses and remove it from this machine.',
  ),
)
