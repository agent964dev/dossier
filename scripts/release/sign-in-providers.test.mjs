import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkConfig, checkSecrets, production } from './verify.mjs'

const CORE = ['BETTER_AUTH_SECRET', 'HANDLE_SECRET', 'SUPER_ADMINS']
const GOOGLE = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
const MICROSOFT = ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET']

/** The Worker's secret names, as `wrangler secret list` gives them. */
const secrets = (...names) => names.map((name) => ({ name }))

/** Asserts that the check throws exactly `message`. */
const refuses = (names, message) =>
  assert.throws(() => checkSecrets(secrets(...names)), { message })

const NO_PAIR =
  'Set at least one sign-in provider: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.'

test('the production file lists the core secrets and the sign-in provider pairs, Google first', () => {
  assert.deepEqual(production.secrets, CORE)
  assert.deepEqual(production.signInProviders, [GOOGLE, MICROSOFT])
})

test('secret names: the core secrets and one complete provider pair pass, whichever it is', () => {
  checkSecrets(secrets(...CORE, ...GOOGLE))
  checkSecrets(secrets(...CORE, ...MICROSOFT))
  checkSecrets(secrets(...CORE, ...GOOGLE, ...MICROSOFT))
  checkSecrets(secrets(...MICROSOFT, ...CORE, 'SESSION_SECRET'))
})

test('secret names: a half-set provider pair is refused, naming the missing one first', () => {
  refuses(
    [...CORE, 'MICROSOFT_CLIENT_ID'],
    'MICROSOFT_CLIENT_SECRET is missing. Set both MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET, or neither.',
  )
  refuses(
    [...CORE, 'MICROSOFT_CLIENT_SECRET'],
    'MICROSOFT_CLIENT_ID is missing. Set both MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET, or neither.',
  )
  refuses(
    [...CORE, 'GOOGLE_CLIENT_ID'],
    'GOOGLE_CLIENT_SECRET is missing. Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither.',
  )
  refuses(
    [...CORE, 'GOOGLE_CLIENT_SECRET'],
    'GOOGLE_CLIENT_ID is missing. Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither.',
  )
  // A complete pair beside it does not make a half-set one acceptable.
  refuses(
    [...CORE, ...GOOGLE, 'MICROSOFT_CLIENT_ID'],
    'MICROSOFT_CLIENT_SECRET is missing. Set both MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET, or neither.',
  )
})

test('secret names: no provider pair at all is refused', () => {
  refuses(CORE, NO_PAIR)
  refuses([...CORE, 'SESSION_SECRET'], NO_PAIR)
})

test('secret names: a missing core secret is refused by name, as before', () => {
  refuses(
    [...GOOGLE, 'BETTER_AUTH_SECRET', 'SUPER_ADMINS'],
    'Missing production Worker secrets: HANDLE_SECRET',
  )
  refuses(
    MICROSOFT,
    'Missing production Worker secrets: BETTER_AUTH_SECRET, HANDLE_SECRET, SUPER_ADMINS',
  )
  // The core names come first, before the provider rule.
  refuses(
    [],
    'Missing production Worker secrets: BETTER_AUTH_SECRET, HANDLE_SECRET, SUPER_ADMINS',
  )
})

/** The production config Vite builds from apps/web/wrangler.jsonc. */
const productionConfig = (vars = {}) => ({
  name: 'dossier',
  routes: [
    { pattern: 'dossier.agent964.com', custom_domain: true },
    { pattern: '*.dossier-content.com/*', zone_name: 'dossier-content.com' },
  ],
  vars: {
    PUBLIC_ORIGIN: 'https://dossier.agent964.com',
    DEPLOYMENT_NAME: 'dossier.agent964.com',
    CONTENT_HOST: '{tree}.dossier-content.com',
    ...vars,
  },
  d1_databases: [
    {
      binding: 'DB',
      database_name: 'dossier-next-production',
      database_id: production.d1.id,
    },
  ],
  r2_buckets: [{ binding: 'BLOBS', bucket_name: 'dossier-next-production' }],
  durable_objects: { bindings: [{ name: 'TREE_HUB', class_name: 'TreeHub' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['TreeHub'] }],
  queues: {
    producers: [{ binding: 'WEBHOOKS', queue: 'dossier-next-production' }],
    consumers: [{ queue: 'dossier-next-production', max_retries: 10 }],
  },
  triggers: { crons: ['*/5 * * * *', '17 3 * * SUN'] },
  ratelimits: [],
})

test('config: a sign-in provider name among the variables is refused', () => {
  checkConfig(productionConfig())
  // Every name of a provider pair is a Worker secret.
  for (const name of [
    'MICROSOFT_CLIENT_SECRET',
    'MICROSOFT_CLIENT_ID',
    ...GOOGLE,
  ]) {
    assert.throws(
      () => checkConfig(productionConfig({ [name]: 'set as a variable' })),
      Error,
      name,
    )
  }
})
