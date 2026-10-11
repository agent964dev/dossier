import { TREE_TOKEN } from '@dossier/contracts'
import { Context, Effect, Layer, Redacted } from 'effect'

import { Bindings } from './bindings.ts'

declare const __DOSSIER_BUILD_VERSION__: string | undefined
declare const __BASE_VERSION__: string | undefined

/** The deployment's settings, parsed once from the Worker's environment. */
export interface DeploymentConfig {
  /** PUBLIC_ORIGIN: the main host. */
  readonly origin: URL
  /** CONTENT_HOST: the pattern of each tree's own host, with `{tree}`. */
  readonly contentHost: string
  readonly deploymentName: string
  /** SUPER_ADMINS, trimmed and lower-cased. */
  readonly superAdmins: ReadonlySet<string>
  readonly betterAuthSecret: Redacted.Redacted<string>
  readonly handleSecret: Redacted.Redacted<string>
  readonly google: {
    readonly clientId: string
    readonly clientSecret: Redacted.Redacted<string>
  } | null
  /** The commit the Worker was built from. */
  readonly buildVersion: string
  /** The base layer version Static Assets hold. */
  readonly baseVersion: string
}

export class Config extends Context.Tag('Config')<Config, DeploymentConfig>() {}

class ConfigProblem extends Error {
  override readonly name = 'ConfigProblem'
}

const required = (env: Env, name: keyof Env): string => {
  const value = env[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigProblem(`${name} is not set`)
  }
  return value.trim()
}

/** The base layer's version: a hash of its built files, set by the build. */
const baseVersion = (fallback: string): string =>
  typeof __BASE_VERSION__ === 'string' && __BASE_VERSION__ !== ''
    ? __BASE_VERSION__
    : fallback

const buildVersion = (): string =>
  typeof __DOSSIER_BUILD_VERSION__ === 'string' &&
  __DOSSIER_BUILD_VERSION__ !== ''
    ? __DOSSIER_BUILD_VERSION__
    : 'dev'

/** Reads and checks the deployment's settings. Throws on a broken one. */
export const parseConfig = (env: Env): DeploymentConfig => {
  const origin = new URL(required(env, 'PUBLIC_ORIGIN'))
  if (origin.protocol !== 'https:') {
    throw new ConfigProblem('PUBLIC_ORIGIN must use https')
  }
  const contentHost = required(env, 'CONTENT_HOST').toLowerCase()
  const firstLabel = contentHost.split('.')[0] ?? ''
  if (
    contentHost.split(TREE_TOKEN).length !== 2 ||
    !firstLabel.includes(TREE_TOKEN) ||
    contentHost.replace(TREE_TOKEN, '') === origin.host
  ) {
    throw new ConfigProblem(
      'CONTENT_HOST must hold {tree} once, in its first label',
    )
  }
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? ''
  const version = buildVersion()
  return {
    origin,
    contentHost,
    deploymentName: required(env, 'DEPLOYMENT_NAME'),
    superAdmins: new Set(
      (env.SUPER_ADMINS ?? '')
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email !== ''),
    ),
    betterAuthSecret: Redacted.make(required(env, 'BETTER_AUTH_SECRET')),
    handleSecret: Redacted.make(required(env, 'HANDLE_SECRET')),
    google:
      clientId !== '' && clientSecret !== ''
        ? { clientId, clientSecret: Redacted.make(clientSecret) }
        : null,
    buildVersion: version,
    baseVersion: baseVersion(version),
  }
}

/** A broken setting is a defect, logged when the isolate first builds it. */
export const ConfigLive: Layer.Layer<Config, never, Bindings> = Layer.effect(
  Config,
  Effect.flatMap(Bindings, (env) =>
    Effect.try(() => parseConfig(env)).pipe(
      Effect.tapError((problem) =>
        Effect.logError('The deployment is misconfigured', problem.error),
      ),
      Effect.orDie,
    ),
  ),
)
