import { DEFAULT_DEPLOYMENT } from '@dossier/contracts'
import { Effect } from 'effect'

import { type CliConfig, readConfig } from './config.ts'
import { Cli, type CliIo } from './io.ts'
import { CliProblem, problem, usage } from './render.ts'

export interface Deployment {
  /** The host, with the port for a loopback deployment. */
  readonly id: string
  readonly origin: URL
}

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  hostname === '[::1]' ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)

const notADeployment = (input: string) =>
  usage(
    `"${input}" is not a deployment.`,
    'Give its host, such as dossier.agent964.com, or a link into it.',
  )

/**
 * A deployment from its host, its `https://` origin, or a link into it. A
 * loopback deployment keeps the scheme it was given and its port; every other
 * deployment is HTTPS. Throws a usage failure for anything else.
 */
export const normalizeDeployment = (input: string): Deployment => {
  const trimmed = input.trim()
  if (trimmed === '' || /\s/.test(trimmed)) throw notADeployment(input)
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  let url: URL
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    throw notADeployment(input)
  }
  if (url.username !== '' || url.password !== '') {
    throw usage(
      'A deployment address cannot carry a user name or password.',
      'Give the host alone; sign in with `dossier login`.',
    )
  }
  const loopback = isLoopback(url.hostname)
  const schemeAllowed =
    url.protocol === 'https:' || (loopback && url.protocol === 'http:')
  if (!schemeAllowed) {
    throw usage(
      `"${input}" is not an HTTPS address.`,
      'Deployments are reached over HTTPS; only a local one may use http.',
    )
  }
  if (url.hostname === '' || (!loopback && !url.hostname.includes('.'))) {
    throw notADeployment(input)
  }
  return { id: url.host, origin: new URL(url.origin) }
}

export interface ResolvedDeployment {
  readonly deployment: Deployment
  /** The agent key for this deployment, or null when there is none. */
  readonly key: string | null
}

const present = (value: string | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * The deployment a command talks to: a link given on the command line, then
 * `DOSSIER_DEPLOYMENT`, then the deployment of the latest login, then the
 * owner's deployment. `DOSSIER_KEY` belongs to `DOSSIER_DEPLOYMENT` and a saved
 * key to its own deployment, so neither is sent anywhere else.
 */
export const resolveDeployment = (i: {
  readonly link?: string
  readonly env: CliIo['env']
  readonly config: CliConfig
}): ResolvedDeployment => {
  const envDeployment = present(i.env.DOSSIER_DEPLOYMENT)
  const envKey = present(i.env.DOSSIER_KEY)
  if (envKey !== null && envDeployment === null) {
    throw usage(
      'DOSSIER_KEY is set without DOSSIER_DEPLOYMENT.',
      'Set DOSSIER_DEPLOYMENT to the deployment the key belongs to.',
    )
  }
  const keyDeployment =
    envDeployment === null ? null : normalizeDeployment(envDeployment)
  const deployment =
    i.link !== undefined
      ? normalizeDeployment(i.link)
      : (keyDeployment ??
        normalizeDeployment(i.config.default ?? DEFAULT_DEPLOYMENT))
  if (envKey !== null && keyDeployment?.id === deployment.id) {
    return { deployment, key: envKey }
  }
  return {
    deployment,
    key: i.config.deployments[deployment.id]?.key ?? null,
  }
}

/**
 * How to name a deployment so it reads back the same: its host, or its whole
 * origin for a local deployment over http.
 */
export const deploymentAddress = (deployment: Deployment): string =>
  deployment.origin.protocol === 'https:'
    ? deployment.id
    : deployment.origin.origin

/** `dossier login`, naming the deployment unless it is the default one. */
export const loginCommand = (deployment: Deployment): string =>
  deployment.id === DEFAULT_DEPLOYMENT
    ? '`dossier login`'
    : `\`dossier login ${deploymentAddress(deployment)}\``

const asProblem = (error: unknown): CliProblem =>
  error instanceof CliProblem
    ? error
    : problem(error instanceof Error ? error.message : String(error))

/** Runs a promise of this CLI's, keeping its failure as the failure. */
export const attempt = <A>(
  run: () => Promise<A>,
): Effect.Effect<A, CliProblem> =>
  Effect.tryPromise({ try: run, catch: asProblem })

/** The config file, and the deployment and key a command uses. */
export const currentDeployment = (link?: string) =>
  Effect.gen(function* () {
    const { io } = yield* Cli
    const config = yield* attempt(() => readConfig(io.configPath))
    const resolved = yield* Effect.try({
      try: () => resolveDeployment({ link, env: io.env, config }),
      catch: asProblem,
    })
    return { config, ...resolved }
  })
