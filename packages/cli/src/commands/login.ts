import { Args, Command } from '@effect/cli'
import {
  type DeviceToken,
  DossierError,
  dossierError,
} from '@dossier/contracts'
import { Effect, Either, Option, Schema } from 'effect'

import { callApi, postJson } from '../client.ts'
import { updateConfig } from '../config.ts'
import {
  attempt,
  currentDeployment,
  type Deployment,
  deploymentAddress,
  loginCommand,
} from '../deployment.ts'
import { Cli, sleep } from '../io.ts'
import { jsonOption, problem } from '../render.ts'

/** What Better Auth's device route answers, as RFC 8628 names it. */
const DeviceCode = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Number),
})
type DeviceCode = typeof DeviceCode.Type

/** What RFC 8628 adds to the polling interval on `slow_down`. */
const SLOW_DOWN_MS = 5_000
const DEFAULT_INTERVAL_MS = 5_000

/** `WDJBMJHT` reads as `WDJB-MJHT`. */
export const formatUserCode = (code: string): string =>
  /^[A-Z0-9]{8}$/i.test(code) ? `${code.slice(0, 4)}-${code.slice(4)}` : code

const decodeDeviceCode = Schema.decodeUnknownEither(DeviceCode)

const requestCode = (deployment: Deployment) =>
  Effect.gen(function* () {
    const { io } = yield* Cli
    const body = yield* postJson(deployment, '/_/auth/device/code', {
      client_id: 'dossier-cli',
      scope: 'agent-key',
      device_name: `cli on ${io.hostname ?? 'this machine'}`,
    })
    const code = decodeDeviceCode(body)
    if (Either.isLeft(code)) {
      return yield* Effect.fail(
        problem(
          `${deployment.id} answered the sign-in request with something ` +
            'this CLI does not understand.',
          'Run `dossier update`, then try again.',
        ),
      )
    }
    return code.right
  })

/** Prints the link and the code; opens the link if it is on the deployment. */
const showCode = (deployment: Deployment, code: DeviceCode) =>
  Effect.gen(function* () {
    const { io, output } = yield* Cli
    const link = code.verification_uri_complete ?? code.verification_uri
    output.note(
      `Open ${link} and confirm the code ${formatUserCode(code.user_code)}.`,
    )
    const sameOrigin =
      URL.canParse(link) && new URL(link).origin === deployment.origin.origin
    if (sameOrigin && io.openUrl) {
      try {
        io.openUrl(link)
      } catch {
        // The link is printed; a browser that does not open is not a failure.
      }
    }
  })

const isCode = (error: unknown, code: DossierError['code']) =>
  error instanceof DossierError && error.code === code

/**
 * Polls until the person allows or denies, waiting the interval before each
 * poll and five seconds longer after every `slow_down`.
 */
const pollForKey = (deployment: Deployment, code: DeviceCode) =>
  Effect.gen(function* () {
    const { io } = yield* Cli
    const wait = io.sleep ?? sleep
    let interval =
      code.interval !== undefined && code.interval > 0
        ? code.interval * 1000
        : DEFAULT_INTERVAL_MS
    let waited = 0
    for (;;) {
      yield* Effect.promise(() => wait(interval))
      waited += interval
      // The deployment says when a code expires; this only stops a loop
      // against one that never does.
      if (waited > code.expires_in * 1000) {
        return yield* Effect.fail(dossierError('device_expired'))
      }
      const outcome = yield* Effect.either(
        callApi(deployment, null, (client) =>
          client.device.token({ payload: { deviceCode: code.device_code } }),
        ),
      )
      if (Either.isRight(outcome)) return outcome.right
      if (isCode(outcome.left, 'device_pending')) continue
      if (isCode(outcome.left, 'slow_down')) {
        interval += SLOW_DOWN_MS
        continue
      }
      return yield* Effect.fail(outcome.left)
    }
  })

/** Requests a code, shows it, and polls for the key. */
const signIn = (deployment: Deployment) =>
  Effect.gen(function* () {
    const code = yield* requestCode(deployment)
    yield* showCode(deployment, code)
    return yield* pollForKey(deployment, code)
  })

const withLoginFix =
  (deployment: Deployment) =>
  (error: unknown): unknown => {
    if (isCode(error, 'device_expired')) {
      return dossierError(
        'device_expired',
        'The sign-in code expired before it was confirmed.',
        `Run ${loginCommand(deployment)} again and confirm the code ` +
          'before it expires.',
      )
    }
    if (isCode(error, 'access_denied')) {
      return dossierError(
        'access_denied',
        `Sign-in to ${deployment.id} was denied.`,
        `Run ${loginCommand(deployment)} again and choose Allow.`,
      )
    }
    return error
  }

export const login = Command.make(
  'login',
  {
    deployment: Args.text({ name: 'deployment' }).pipe(
      Args.withDescription(
        'The deployment to sign in to: its host or a link into it.',
      ),
      Args.optional,
    ),
    json: jsonOption,
  },
  ({ deployment: given }) =>
    Effect.gen(function* () {
      const { io, output } = yield* Cli
      const { deployment } = yield* currentDeployment(
        Option.getOrUndefined(given),
      )
      const token: DeviceToken = yield* signIn(deployment).pipe(
        // An expired code, or a key that failed to mint, starts over once.
        Effect.catchIf(
          (error) => isCode(error, 'device_expired'),
          () =>
            Effect.gen(function* () {
              output.note('The code expired. Here is a new one.')
              return yield* signIn(deployment)
            }),
        ),
        Effect.mapError(withLoginFix(deployment)),
      )
      yield* attempt(() =>
        updateConfig(io.configPath, (config) => ({
          ...config,
          default: deploymentAddress(deployment),
          deployments: {
            ...config.deployments,
            [deployment.id]: {
              key: token.key,
              keyName: token.name,
              person: token.person.email,
              savedAt: new Date().toISOString(),
            },
          },
        })),
      )
      output.result(
        `Signed in to ${deployment.id} as ${token.person.email}. ` +
          `The key "${token.name}" is saved.`,
        {
          deployment: deployment.id,
          person: token.person,
          key: { name: token.name },
        },
      )
    }),
).pipe(
  Command.withDescription(
    'Sign in through the browser and save an agent key for the deployment.',
  ),
)
