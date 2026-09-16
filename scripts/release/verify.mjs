import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const production = JSON.parse(
  readFileSync(new URL('./production.json', import.meta.url), 'utf8'),
)

export function checkHealth(body, sha, features = production.features) {
  if (
    body.ok !== true ||
    body.service !== 'dossier' ||
    body.version !== sha ||
    !Array.isArray(body.features) ||
    features.some((feature) => !body.features.includes(feature))
  ) {
    throw new Error(
      'Production health does not match the expected SHA and capabilities',
    )
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
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetcher(production.healthUrl, {
        headers: { 'cache-control': 'no-cache' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      if (response.status !== 200)
        throw new Error(`Health HTTP ${response.status}`)
      checkHealth(await response.json(), sha)
      console.log(`Production verified at ${sha}`)
      return
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
}

export function checkSecrets(secrets) {
  const names = new Set(secrets.map((secret) => secret.name))
  const missing = production.secrets.filter((name) => !names.has(name))
  if (missing.length)
    throw new Error(`Missing production Worker secrets: ${missing.join(', ')}`)
  console.log('Required production secret names are present')
}

export function checkConfig(config) {
  const db = config.d1_databases?.find((entry) => entry.binding === 'DB')
  const bucket = config.r2_buckets?.find((entry) => entry.binding === 'OBJECTS')
  const limiter = config.ratelimits?.find(
    (entry) => entry.name === 'STATE_RATE_LIMITER',
  )
  if (
    config.name !== 'dossier' ||
    config.vars?.PUBLIC_BASE_URL !== 'https://dossier.agent964.com' ||
    db?.database_name !== 'dossier-production' ||
    db?.database_id !== '72766ce3-44da-4bdd-a025-90a6ebe1e3e0' ||
    bucket?.bucket_name !== 'dossier-production' ||
    limiter?.namespace_id !== '1003' ||
    limiter?.simple?.limit !== 60 ||
    limiter?.simple?.period !== 60
  ) {
    throw new Error('Refusing a non-production Worker configuration')
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
