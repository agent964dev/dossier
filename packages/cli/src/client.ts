import {
  FetchHttpClient,
  HttpApiClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from '@effect/platform'
import {
  DossierApi,
  DossierError,
  dossierError,
  ErrorBody,
  type ErrorCode,
  PROTOCOL,
  PROTOCOL_HEADER,
} from '@dossier/contracts'
import { Duration, Effect, Either, Schema } from 'effect'

import { type Deployment, loginCommand } from './deployment.ts'
import { Cli, VERSION } from './io.ts'
import { CliProblem, problem } from './render.ts'

/** How long one request may take, answer included. */
export const REQUEST_TIMEOUT = Duration.seconds(30)

const decodeErrorBody = Schema.decodeUnknownEither(ErrorBody)

/** The fix this CLI gives where the deployment's own fix is for a browser. */
const cliFix = (
  code: ErrorCode,
  fix: string | null,
  deployment: Deployment,
): string | null => {
  switch (code) {
    case 'sign_in_required':
      return `Run ${loginCommand(deployment)} to sign in again.`
    case 'protocol_mismatch':
      return 'Run `dossier update` to get the CLI this deployment speaks.'
    default:
      return fix
  }
}

/** A failed answer as the error it carries, with the CLI's fix. */
export const errorFromResponse = (
  deployment: Deployment,
  status: number,
  body: unknown,
  location: string | null,
): DossierError | CliProblem => {
  if (status >= 300 && status < 400) {
    return problem(
      `${deployment.id} answered with a redirect` +
        `${location === null ? '' : ` to ${location}`}, which is not followed.`,
      'Check the deployment address; give the host the redirect names.',
    )
  }
  const decoded = decodeErrorBody(body)
  if (Either.isRight(decoded)) {
    const { code, message, fix, path } = decoded.right.error
    return new DossierError({
      code,
      message,
      fix: cliFix(code, fix, deployment),
      path,
    })
  }
  if (status === 426) {
    return dossierError(
      'protocol_mismatch',
      `${deployment.id} speaks a different protocol than this CLI.`,
      'Run `dossier update` to get the CLI this deployment speaks.',
    )
  }
  return problem(
    `${deployment.id} answered HTTP ${status}.`,
    'Check the deployment address, or try again shortly.',
  )
}

const failedResponse = (
  deployment: Deployment,
  response: HttpClientResponse.HttpClientResponse,
) =>
  response.json.pipe(
    Effect.orElseSucceed(() => null),
    Effect.flatMap((body) =>
      Effect.fail(
        errorFromResponse(
          deployment,
          response.status,
          body,
          response.headers.location ?? null,
        ),
      ),
    ),
  )

/**
 * The HTTP client for one deployment: every path under its origin, the
 * protocol header on every request, the agent key only to that origin, and
 * any answer but a 2xx turned into the error it carries.
 */
const httpClientFor = (deployment: Deployment, key: string | null) =>
  Effect.map(HttpClient.HttpClient, (client) =>
    client.pipe(
      HttpClient.mapRequest((request) => {
        const located = HttpClientRequest.prependUrl(
          request,
          deployment.origin.origin,
        )
        const marked = located.pipe(
          HttpClientRequest.setHeader(PROTOCOL_HEADER, String(PROTOCOL)),
          HttpClientRequest.setHeader('user-agent', `dossier/${VERSION}`),
          HttpClientRequest.acceptJson,
        )
        const sameOrigin =
          URL.canParse(marked.url) &&
          new URL(marked.url).origin === deployment.origin.origin
        return key !== null && sameOrigin
          ? HttpClientRequest.bearerToken(marked, key)
          : marked
      }),
      HttpClient.transformResponse((response) =>
        Effect.flatMap(response, (answer) =>
          answer.status >= 200 && answer.status < 300
            ? Effect.succeed(answer)
            : failedResponse(deployment, answer),
        ),
      ),
    ),
  )

const makeClient = (deployment: Deployment, key: string | null) =>
  Effect.flatMap(httpClientFor(deployment, key), (httpClient) =>
    HttpApiClient.makeWith(DossierApi, { httpClient }),
  )

export type DossierClient = Effect.Effect.Success<ReturnType<typeof makeClient>>

const unreachable = (deployment: Deployment, cause: unknown) =>
  problem(
    `Could not reach ${deployment.id}` +
      `${cause instanceof Error && cause.message ? `: ${cause.message}` : ''}.`,
    'Check the deployment address and your connection, then try again.',
  )

const notUnderstood = (deployment: Deployment) =>
  problem(
    `${deployment.id} answered with something this CLI does not understand.`,
    'Run `dossier update` to get the CLI this deployment speaks.',
  )

/**
 * Calls the deployment's API within the request timeout. Fails with the
 * deployment's `DossierError`, or a `CliProblem` when it cannot be reached
 * or understood.
 */
export const callApi = <A, E, R>(
  deployment: Deployment,
  key: string | null,
  call: (client: DossierClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, DossierError | CliProblem, R | Cli> =>
  Effect.gen(function* () {
    const { io } = yield* Cli
    return yield* Effect.flatMap(makeClient(deployment, key), call).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, io.fetch),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: 'manual',
      }),
      Effect.timeoutFail({
        duration: REQUEST_TIMEOUT,
        onTimeout: () =>
          problem(
            `${deployment.id} did not answer within ` +
              `${Duration.toSeconds(REQUEST_TIMEOUT)} seconds.`,
            'Try again shortly.',
          ),
      }),
      Effect.catchAll((error: unknown) =>
        Effect.fail(
          error instanceof DossierError || error instanceof CliProblem
            ? error
            : error instanceof HttpClientError.RequestError
              ? unreachable(deployment, error.cause)
              : notUnderstood(deployment),
        ),
      ),
    )
  })

/**
 * A plain request to the deployment outside its API, such as Better Auth's
 * device code route: same origin rules, no agent key, no redirects.
 */
export const postJson = (
  deployment: Deployment,
  path: string,
  body: unknown,
): Effect.Effect<unknown, DossierError | CliProblem, Cli> =>
  Effect.gen(function* () {
    const { io } = yield* Cli
    const url = new URL(path, deployment.origin)
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        io.fetch(url, {
          method: 'POST',
          redirect: 'manual',
          signal,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            [PROTOCOL_HEADER]: String(PROTOCOL),
            'user-agent': `dossier/${VERSION}`,
          },
          body: JSON.stringify(body),
        }),
      catch: (cause) => unreachable(deployment, cause),
    })
    const payload = yield* Effect.promise((): Promise<unknown> =>
      response.json().catch(() => null),
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        errorFromResponse(
          deployment,
          response.status,
          payload,
          response.headers.get('location'),
        ),
      )
    }
    return payload
  }).pipe(
    Effect.timeoutFail({
      duration: REQUEST_TIMEOUT,
      onTimeout: () =>
        problem(
          `${deployment.id} did not answer within ` +
            `${Duration.toSeconds(REQUEST_TIMEOUT)} seconds.`,
          'Try again shortly.',
        ),
    }),
  )

/** How long one upload or download of a file may take. */
export const TRANSFER_TIMEOUT = Duration.minutes(5)

/**
 * A raw request to the deployment's API outside the derived client, for the
 * bytes of a file: the same origin, the protocol header, the agent key only
 * to the deployment's own origin, no redirects, and any answer but a 2xx
 * turned into the error it carries.
 */
export const rawCall = (
  deployment: Deployment,
  key: string | null,
  request: {
    readonly method: 'GET' | 'PUT'
    /** The path and query under the deployment's origin. */
    readonly path: string
    readonly body?: Uint8Array
    readonly accept?: string
  },
): Effect.Effect<Response, DossierError | CliProblem, Cli> =>
  Effect.gen(function* () {
    const { io } = yield* Cli
    const url = new URL(request.path, deployment.origin)
    const headers: Record<string, string> = {
      accept: request.accept ?? 'application/json',
      [PROTOCOL_HEADER]: String(PROTOCOL),
      'user-agent': `dossier/${VERSION}`,
    }
    if (key !== null && url.origin === deployment.origin.origin) {
      headers.authorization = `Bearer ${key}`
    }
    if (request.body !== undefined) {
      headers['content-type'] = 'application/octet-stream'
      headers['content-length'] = String(request.body.byteLength)
    }
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        io.fetch(url, {
          method: request.method,
          redirect: 'manual',
          signal,
          headers,
          body: request.body as Uint8Array<ArrayBuffer> | undefined,
        }),
      catch: (cause) => unreachable(deployment, cause),
    })
    if (response.status < 200 || response.status >= 300) {
      const payload = yield* Effect.promise((): Promise<unknown> =>
        response.json().catch(() => null),
      )
      return yield* Effect.fail(
        errorFromResponse(
          deployment,
          response.status,
          payload,
          response.headers.get('location'),
        ),
      )
    }
    return response
  }).pipe(
    Effect.timeoutFail({
      duration: TRANSFER_TIMEOUT,
      onTimeout: () =>
        problem(
          `${deployment.id} did not answer within ` +
            `${Duration.toMinutes(TRANSFER_TIMEOUT)} minutes.`,
          'Try again shortly.',
        ),
    }),
  )
