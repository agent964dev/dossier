import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// What production must look like, in one file: the next change of a
// resource edits production.json, and these checks follow it.
export const production = JSON.parse(
  readFileSync(new URL('./production.json', import.meta.url), 'utf8'),
)

const sameSet = (a, b) =>
  Array.isArray(a) &&
  a.length === b.length &&
  b.every((value) => a.includes(value))

/** The health body of the deployed build at `sha`, with its database up. */
export function checkHealth(body, sha) {
  if (
    body?.ok !== true ||
    body.service !== 'dossier' ||
    body.version !== sha ||
    body.protocol !== production.protocol ||
    body.deployment !== production.deployment ||
    body.db !== 'ok'
  ) {
    throw new Error(
      'Production health does not match the expected SHA, protocol and deployment',
    )
  }
}

/** A policy names `name` as one of its directives, not as a value. */
const hasDirective = (policy, name) =>
  policy
    .split(';')
    .some(
      (directive) => directive.trim().split(/\s+/)[0].toLowerCase() === name,
    )

/**
 * A content host asked for a path only the main host serves: a 404 with the
 * content headers and no cookie. It shows that the wildcard DNS record, the
 * content route and the Worker's host rules work together.
 */
export function checkContent(response) {
  const csp = response.headers.get('content-security-policy') ?? ''
  const cookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
  const problems = [
    response.status === 404 ? null : `HTTP ${response.status}, not 404`,
    response.headers.get('referrer-policy') ===
    'strict-origin-when-cross-origin'
      ? null
      : 'no strict-origin-when-cross-origin Referrer-Policy',
    hasDirective(csp, 'sandbox')
      ? null
      : 'no sandbox directive in its Content-Security-Policy',
    cookies.length === 0 ? null : 'it sets a cookie',
  ].filter(Boolean)
  if (problems.length > 0) {
    throw new Error(`The content host answered wrongly: ${problems.join('; ')}`)
  }
}

export async function smoke(
  sha,
  {
    fetcher = fetch,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts = 12,
  } = {},
) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a full build SHA')
  const ask = (url) =>
    fetcher(url, {
      headers: { 'cache-control': 'no-cache' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await ask(production.healthUrl)
      if (response.status !== 200)
        throw new Error(`Health HTTP ${response.status}`)
      checkHealth(await response.json(), sha)
      console.log(`Production verified at ${sha}`)
      break
    } catch (error) {
      console.log(`Health attempt ${attempt}/${attempts}: ${error.message}`)
      if (attempt === attempts)
        throw new Error(
          'Production smoke checks exhausted; publication is blocked',
          { cause: error },
        )
      await wait(5_000)
    }
  }
  try {
    checkContent(await ask(production.contentProbeUrl))
  } catch (error) {
    throw new Error(
      `Content host check failed; publication is blocked: ${error.message}`,
      { cause: error },
    )
  }
  console.log('Content host verified')
}

/**
 * Every name in production.secrets, at least one complete pair of
 * production.signInProviders, and no pair with only one of its names.
 */
export function checkSecrets(secrets) {
  const names = new Set(secrets.map((secret) => secret.name))
  const missing = production.secrets.filter((name) => !names.has(name))
  if (missing.length)
    throw new Error(`Missing production Worker secrets: ${missing.join(', ')}`)
  const halfSet = production.signInProviders.filter(
    (pair) => pair.filter((name) => names.has(name)).length === 1,
  )
  if (halfSet.length)
    throw new Error(
      halfSet
        .map(
          ([id, secret]) =>
            `${names.has(id) ? secret : id} is missing. Set both ${id} and ${secret}, or neither.`,
        )
        .join('\n'),
    )
  if (
    !production.signInProviders.some((pair) =>
      pair.every((name) => names.has(name)),
    )
  )
    throw new Error(
      `Set at least one sign-in provider: ${production.signInProviders
        .map(([id, secret]) => `${id} and ${secret}`)
        .join(', or ')}.`,
    )
  console.log('Required production secret names are present')
}

/**
 * The Worker configuration Vite built for production: every resource is
 * production's, and nothing else is there that should not be.
 */
export function checkConfig(config) {
  const vars = config.vars ?? {}
  const overwritten = [
    ...production.secrets,
    ...production.signInProviders.flat(),
  ].filter((name) => Object.hasOwn(vars, name))
  if (overwritten.length) {
    throw new Error(
      `Production vars must not overwrite Worker secrets: ${overwritten.join(', ')}`,
    )
  }
  const routes = config.routes ?? []
  const db = config.d1_databases?.find((entry) => entry.binding === 'DB')
  const bucket = config.r2_buckets?.find((entry) => entry.binding === 'BLOBS')
  const hub = config.durable_objects?.bindings?.find(
    (entry) => entry.name === production.hub.binding,
  )
  const producer = config.queues?.producers?.find(
    (entry) => entry.binding === 'WEBHOOKS',
  )
  const consumers = config.queues?.consumers ?? []
  const wrong = [
    config.name === production.worker ? null : 'Worker name',
    vars.PUBLIC_ORIGIN === production.origin ? null : 'PUBLIC_ORIGIN',
    vars.CONTENT_HOST === production.contentHost ? null : 'CONTENT_HOST',
    vars.DEPLOYMENT_NAME === production.deployment ? null : 'DEPLOYMENT_NAME',
    routes.some(
      (route) =>
        route.pattern === production.customDomain && route.custom_domain,
    )
      ? null
      : 'custom domain',
    routes.some(
      (route) =>
        route.pattern === production.contentRoute.pattern &&
        route.zone_name === production.contentRoute.zone_name,
    )
      ? null
      : 'content route',
    db?.database_name === production.d1.name &&
    db?.database_id === production.d1.id
      ? null
      : 'D1 database',
    bucket?.bucket_name === production.r2 ? null : 'R2 bucket',
    hub?.class_name === production.hub.class &&
    config.migrations?.some((m) =>
      m.new_sqlite_classes?.includes(production.hub.class),
    )
      ? null
      : 'tree hub',
    producer?.queue === production.queue ? null : 'Queue producer',
    consumers.length === 1 && consumers[0].queue === production.queue
      ? null
      : 'Queue consumer',
    sameSet(config.triggers?.crons, production.crons) ? null : 'crons',
    (config.ratelimits ?? []).length === 0 ? null : 'rate limiter bindings',
  ].filter(Boolean)
  if (wrong.length > 0) {
    throw new Error(
      `Refusing a non-production Worker configuration: ${wrong.join(', ')}`,
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, value] = process.argv.slice(2)
  if (command === 'smoke') await smoke(value)
  else if (command === 'secrets')
    checkSecrets(JSON.parse(readFileSync(value, 'utf8')))
  else if (command === 'config')
    checkConfig(JSON.parse(readFileSync(value, 'utf8')))
  else throw new Error('Unknown verification command')
}
