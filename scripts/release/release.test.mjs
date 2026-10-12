import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  checkVersion,
  compareVersions,
  packageFingerprint,
} from './cli-version.mjs'
import { deploymentHistory, mayShip } from './freshness.mjs'
import { releaseDecision } from './registry.mjs'
import {
  checkConfig,
  checkContent,
  checkHealth,
  checkSecrets,
  production,
  smoke,
} from './verify.mjs'

const sha = 'a'.repeat(40)
const healthy = {
  ok: true,
  service: 'dossier',
  version: sha,
  protocol: 1,
  deployment: 'dossier.agent964.com',
  db: 'ok',
}
const reply = (status, body) => ({ status, json: async () => body })
const CONTENT_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'content-security-policy':
    'sandbox allow-scripts allow-same-origin allow-forms',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
}
const contentReply = (status = 404, headers = CONTENT_HEADERS) =>
  new Response('Not found.\n', { status, headers })
const registry = { name: '@agent964/dossier', versions: { '0.2.2': {} } }

test('version policy requires monotonic explicit stable bumps only for changed packages', () => {
  checkVersion('0.2.2', '0.2.2', false)
  checkVersion('0.2.2', '0.2.3', true)
  checkVersion('0.2.2', '0.3.0', false)
  assert.throws(() => checkVersion('0.2.2', '0.2.2', true), /explicitly bump/)
  assert.throws(() => checkVersion('0.2.2', '0.2.1', false), /decrease/)
  assert.throws(() => checkVersion('0.2.2', '0.2.3-beta.1', true), /stable/)
  assert.equal(compareVersions('0.10.0', '0.9.99'), 1)
})

test('registry publication is idempotent and fails closed for every ambiguous response', async () => {
  assert.equal(
    await releaseDecision('0.2.2', async () => reply(200, registry)),
    false,
  )
  assert.equal(
    await releaseDecision('0.2.3', async () => reply(200, registry)),
    true,
  )
  await assert.rejects(
    releaseDecision('0.2.1', async () => reply(200, registry)),
    /increase/,
  )
  for (const status of [401, 403, 404, 429, 500, 503]) {
    await assert.rejects(
      releaseDecision('0.2.3', async () => reply(status, {})),
      /refusing/,
    )
  }
  await assert.rejects(
    releaseDecision('0.2.3', async () => {
      throw new Error('network')
    }),
    /network/,
  )
  await assert.rejects(
    releaseDecision('0.2.3', async () => reply(200, {})),
    /metadata/,
  )
  await assert.rejects(
    releaseDecision('0.2.3', async () => ({
      status: 200,
      json: async () => {
        throw new Error('invalid JSON')
      },
    })),
    /invalid JSON/,
  )
})

test('health accepts the new body only at the expected SHA, protocol and deployment', () => {
  checkHealth(healthy, sha)
  for (const body of [
    { ...healthy, version: sha.slice(0, 7) },
    { ...healthy, version: 'b'.repeat(40) },
    { ...healthy, protocol: 2 },
    { ...healthy, protocol: '1' },
    { ...healthy, deployment: 'dossier-next-dev.tech964.workers.dev' },
    { ...healthy, db: 'unavailable' },
    { ...healthy, ok: false },
    { ...healthy, service: 'other' },
    // Today's health body, from before Dossier next.
    { ok: true, service: 'dossier', version: sha, features: ['state'] },
    null,
  ]) {
    assert.throws(() => checkHealth(body, sha), /expected SHA/)
  }
})

test('the content probe wants a 404 with the sandbox and referrer headers and no cookie', () => {
  checkContent(contentReply())
  // sandbox as a directive, alone, with tokens, or after another directive.
  for (const csp of [
    'sandbox',
    'sandbox allow-scripts',
    "default-src 'none'; sandbox allow-scripts",
    "default-src 'none';sandbox",
    'SANDBOX allow-forms',
  ]) {
    checkContent(
      contentReply(404, { ...CONTENT_HEADERS, 'content-security-policy': csp }),
    )
  }
  // sandbox only as a source or token of another directive is no sandbox.
  for (const csp of [
    'default-src sandbox',
    "script-src 'self' sandbox; frame-ancestors 'none'",
    'sandboxed',
    'default-src sandbox; img-src *',
  ]) {
    assert.throws(
      () =>
        checkContent(
          contentReply(404, {
            ...CONTENT_HEADERS,
            'content-security-policy': csp,
          }),
        ),
      /sandbox/,
      csp,
    )
  }
  const refused = [
    [contentReply(200), /not 404/],
    [contentReply(302), /not 404/],
    [
      contentReply(404, {
        ...CONTENT_HEADERS,
        'content-security-policy': "frame-ancestors 'none'",
      }),
      /sandbox/,
    ],
    [
      contentReply(404, {
        'referrer-policy': 'strict-origin-when-cross-origin',
      }),
      /sandbox/,
    ],
    [
      contentReply(404, {
        ...CONTENT_HEADERS,
        'referrer-policy': 'no-referrer-when-downgrade',
      }),
      /Referrer-Policy/,
    ],
    [
      contentReply(404, {
        ...CONTENT_HEADERS,
        'set-cookie': 'x=1; Path=/',
      }),
      /cookie/,
    ],
  ]
  for (const [response, message] of refused) {
    assert.throws(() => checkContent(response), message)
  }
})

test('smoke retries stale, HTTP, malformed and network responses, then checks the content host once', async () => {
  const responses = [
    new Error('network'),
    reply(503, {}),
    {
      status: 200,
      json: async () => {
        throw new Error('JSON')
      },
    },
    reply(200, { ...healthy, version: 'old' }),
    reply(200, healthy),
    contentReply(),
  ]
  const urls = []
  let waits = 0
  await smoke(sha, {
    attempts: 5,
    wait: async () => {
      waits++
    },
    fetcher: async (url, options) => {
      assert.equal(options.redirect, 'error')
      assert.ok(options.signal)
      urls.push(url)
      const response = responses[urls.length - 1]
      if (response instanceof Error) throw response
      return response
    },
  })
  assert.equal(urls.length, 6)
  assert.equal(waits, 4)
  assert.deepEqual(urls, [
    ...Array(5).fill(production.healthUrl),
    production.contentProbeUrl,
  ])
  assert.equal(
    production.contentProbeUrl,
    'https://releasecheck.dossier-content.com/_/api/health',
  )
})

test('smoke blocks publication when the content host answers wrongly', async () => {
  for (const content of [contentReply(200), new Error('DNS')]) {
    const answers = [reply(200, healthy), content]
    await assert.rejects(
      smoke(sha, {
        attempts: 1,
        wait: async () => {},
        fetcher: async () => {
          const next = answers.shift()
          if (next instanceof Error) throw next
          return next
        },
      }),
      /Content host check failed; publication is blocked/,
    )
  }
})

test('exhausted smoke fails with a bounded attempt count', async () => {
  let calls = 0
  await assert.rejects(
    smoke(sha, {
      attempts: 3,
      wait: async () => {},
      fetcher: async () => {
        calls++
        return reply(200, { ...healthy, db: 'unavailable' })
      },
    }),
    /publication is blocked/,
  )
  assert.equal(calls, 3)
})

/** The production config Vite builds from apps/web/wrangler.jsonc. */
const productionConfig = () => ({
  name: 'dossier',
  routes: [
    { pattern: 'dossier.agent964.com', custom_domain: true },
    { pattern: '*.dossier-content.com/*', zone_name: 'dossier-content.com' },
  ],
  vars: {
    PUBLIC_ORIGIN: 'https://dossier.agent964.com',
    DEPLOYMENT_NAME: 'dossier.agent964.com',
    CONTENT_HOST: '{tree}.dossier-content.com',
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

test('secret names: every production secret must be present, and a missing one is named', () => {
  checkSecrets(production.secrets.map((name) => ({ name })))
  checkSecrets([
    ...production.secrets.map((name) => ({ name })),
    { name: 'SESSION_SECRET' },
  ])
  assert.deepEqual(production.secrets, [
    'BETTER_AUTH_SECRET',
    'HANDLE_SECRET',
    'SUPER_ADMINS',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ])
  assert.throws(
    () =>
      checkSecrets(
        production.secrets
          .filter((name) => !name.startsWith('GOOGLE_'))
          .map((name) => ({ name })),
      ),
    /Missing production Worker secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET$/,
  )
  // Today's secrets alone are not enough.
  assert.throws(
    () =>
      checkSecrets(
        ['SESSION_SECRET', 'LINK_SECRET', 'SEED_ADMIN_EMAIL'].map((name) => ({
          name,
        })),
      ),
    /BETTER_AUTH_SECRET, HANDLE_SECRET, SUPER_ADMINS/,
  )
})

test('config: production resources pass, and each wrong one is refused by name', () => {
  checkConfig(productionConfig())
  assert.throws(
    () =>
      checkConfig({
        ...productionConfig(),
        vars: { ...productionConfig().vars, SUPER_ADMINS: 'a@example.com' },
      }),
    /overwrite Worker secrets/,
  )
  const base = productionConfig()
  const without = (key, value) => ({ ...base, [key]: value })
  for (const [config, named] of [
    [without('name', 'dossier-next-dev'), /Worker name/],
    [
      without('vars', { ...base.vars, PUBLIC_ORIGIN: 'https://x.example' }),
      /PUBLIC_ORIGIN/,
    ],
    [
      without('vars', { ...base.vars, CONTENT_HOST: undefined }),
      /CONTENT_HOST/,
    ],
    [
      without('vars', {
        ...base.vars,
        CONTENT_HOST: '{tree}-dev.dossier-content.com',
      }),
      /CONTENT_HOST/,
    ],
    [
      without('vars', { ...base.vars, DEPLOYMENT_NAME: 'dev' }),
      /DEPLOYMENT_NAME/,
    ],
    [without('routes', [base.routes[1]]), /custom domain/],
    [without('routes', [base.routes[0]]), /content route/],
    [
      without('routes', [
        base.routes[0],
        {
          pattern: '*-dev.dossier-content.com/*',
          zone_name: 'dossier-content.com',
        },
      ]),
      /content route/,
    ],
    [
      without('routes', [
        base.routes[0],
        { pattern: '*.dossier-content.com/*' },
      ]),
      /content route/,
    ],
    [
      without('d1_databases', [
        { ...base.d1_databases[0], database_name: 'dossier-production' },
      ]),
      /D1 database/,
    ],
    [
      without('d1_databases', [
        {
          ...base.d1_databases[0],
          database_id: '70b42e29-2b9a-434d-b2a5-920137c7fea9',
        },
      ]),
      /D1 database/,
    ],
    [
      without('d1_databases', [
        { binding: 'DB', database_name: 'dossier-next-production' },
      ]),
      /D1 database/,
    ],
    [
      without('r2_buckets', [
        { binding: 'BLOBS', bucket_name: 'dossier-next-dev' },
      ]),
      /R2 bucket/,
    ],
    [without('durable_objects', undefined), /tree hub/],
    [without('migrations', []), /tree hub/],
    [without('queues', { ...base.queues, producers: [] }), /Queue producer/],
    [
      without('queues', {
        ...base.queues,
        consumers: [{ queue: 'dossier-next-dev' }],
      }),
      /Queue consumer/,
    ],
    [without('queues', undefined), /Queue producer, Queue consumer/],
    [without('triggers', { crons: ['17 3 * * SUN'] }), /crons/],
    [without('triggers', undefined), /crons/],
    [
      without('ratelimits', [
        { name: 'PUSH_LIMITER', namespace_id: '1001', simple: {} },
      ]),
      /rate limiter bindings/,
    ],
  ]) {
    assert.throws(
      () => checkConfig(config),
      /non-production Worker configuration/,
    )
    assert.throws(() => checkConfig(config), named)
  }
})

test('serialized release fence permits queued forward progress and same-SHA retries only', () => {
  const history = ['a', 'b', 'c']
  const ancestor = (a, b) =>
    history.includes(a) && history.indexOf(a) <= history.indexOf(b)
  assert.equal(mayShip('b', 'c', [{ sha: 'a' }], ancestor), true) // newer merge waiting
  assert.equal(mayShip('b', 'c', [{ sha: 'b' }], ancestor), true) // retry
  assert.equal(mayShip('a', 'c', [{ sha: 'c' }, { sha: 'a' }], ancestor), false) // out of order / stale rerun
  assert.equal(
    mayShip('b', 'c', [{ sha: 'c', state: 'failure' }], ancestor),
    false,
  ) // newer migration may have succeeded
  assert.throws(() => mayShip('c', 'b', [], ancestor), /no longer on main/) // force push
})

test('deployment fence reads all pages and rejects history failures', async () => {
  const urls = []
  const deployments = await deploymentHistory(async (url) => {
    urls.push(url)
    return reply(
      200,
      urls.length === 1
        ? Array.from({ length: 100 }, () => ({ sha }))
        : [{ sha: 'b'.repeat(40) }],
    )
  }, 'agent964dev/dossier')
  assert.equal(deployments.length, 101)
  assert.match(urls[1], /page=2$/)
  await assert.rejects(
    deploymentHistory(async () => reply(403, []), 'repo'),
    /HTTP 403/,
  )
  await assert.rejects(
    deploymentHistory(async () => reply(200, [{ sha: 'bad' }]), 'repo'),
    /Invalid/,
  )
})

test('migration failure stops deployment; deploy failure never reverses migrations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dossier-deploy-test-'))
  try {
    mkdirSync(join(directory, 'apps/web'), { recursive: true })
    mkdirSync(join(directory, 'bin'))
    writeFileSync(
      join(directory, 'bin/bunx'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\ncase "$*" in\n  *"migrations apply"*) exit "$MIGRATION_EXIT";;\n  *"wrangler deploy"*) exit "$DEPLOY_EXIT";;\nesac\n',
      { mode: 0o755 },
    )
    writeFileSync(
      join(directory, 'bin/bun'),
      '#!/bin/sh\nprintf "bun %s\\n" "$*" >> "$CALLS"\nexit "$COPY_EXIT"\n',
      { mode: 0o755 },
    )
    const run = (migrationExit, deployExit, copyExit = 0) => {
      const calls = join(directory, 'calls')
      writeFileSync(calls, '')
      const result = spawnSync('bash', [resolve('scripts/release/deploy.sh')], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}/bin:${process.env.PATH}`,
          CALLS: calls,
          MIGRATION_EXIT: String(migrationExit),
          DEPLOY_EXIT: String(deployExit),
          COPY_EXIT: String(copyExit),
        },
      })
      return {
        status: result.status,
        calls: readFileSync(calls, 'utf8').trim().split('\n'),
      }
    }
    const failedMigration = run(17, 0)
    assert.equal(failedMigration.status, 17)
    assert.equal(failedMigration.calls.length, 1)
    assert.match(
      failedMigration.calls[0],
      /migrations apply dossier-next-production --remote --config wrangler.jsonc/,
    )
    const failedDeploy = run(0, 23)
    assert.equal(failedDeploy.status, 23)
    assert.equal(failedDeploy.calls.length, 3)
    for (const call of [failedDeploy.calls[0], failedDeploy.calls[2]])
      assert.match(call, /--no-x-provision/)
    // The base layer is copied into R2 after migrations and before deploy.
    assert.match(
      failedDeploy.calls[1],
      /^bun scripts\/copy-base.ts --bucket dossier-next-production --env production$/,
    )
    assert.match(
      failedDeploy.calls[2],
      /deploy --config dist\/server\/wrangler.json/,
    )
    const failedCopy = run(0, 0, 9)
    assert.equal(failedCopy.status, 9)
    assert.equal(failedCopy.calls.length, 2)
    assert.equal(run(0, 0).status, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('packed comparison includes bundled workspace code and assets; ignores web-only and version-only changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dossier-package-test-'))
  const original = process.cwd()
  try {
    process.chdir(directory)
    const run = (...args) =>
      execFileSync('git', args, { encoding: 'utf8' }).trim()
    run('init', '--quiet')
    run('config', 'user.name', 'Release test')
    run('config', 'user.email', 'release-test@example.invalid')
    mkdirSync('packages/cli/skills', { recursive: true })
    mkdirSync('packages/shared', { recursive: true })
    mkdirSync('apps/web', { recursive: true })
    writeFileSync('package.json', '{"name":"fixture","private":true}')
    execFileSync('bun', ['install'], { stdio: 'pipe' })
    writeFileSync(
      'packages/cli/package.json',
      JSON.stringify({
        name: '@agent964/dossier',
        version: '1.0.0',
        files: ['dist', 'skills'],
        scripts: {
          build: 'mkdir -p dist && cat ../shared/code.js > dist/index.js',
        },
      }),
    )
    writeFileSync('packages/shared/code.js', 'export const value = 1\n')
    writeFileSync('packages/cli/skills/SKILL.md', 'Original packaged asset\n')
    const commit = () => {
      run('add', '.')
      run('commit', '--quiet', '-m', 'fixture')
      return run('rev-parse', 'HEAD')
    }
    const baseline = packageFingerprint(commit())
    writeFileSync('apps/web/page.ts', 'web only\n')
    assert.equal(packageFingerprint(commit()), baseline)
    const manifest = JSON.parse(readFileSync('packages/cli/package.json'))
    writeFileSync(
      'packages/cli/package.json',
      JSON.stringify({ ...manifest, version: '1.0.1' }),
    )
    assert.equal(packageFingerprint(commit()), baseline)
    writeFileSync('packages/shared/code.js', 'export const value = 2\n')
    assert.notEqual(packageFingerprint(commit()), baseline)
    writeFileSync('packages/shared/code.js', 'export const value = 1\n')
    writeFileSync('packages/cli/skills/SKILL.md', 'Changed packaged asset\n')
    assert.notEqual(packageFingerprint(commit()), baseline)
  } finally {
    process.chdir(original)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('workflow graph isolates PR credentials and blocks publish behind production verification', () => {
  const parse = (file) =>
    JSON.parse(
      execFileSync(
        'bun',
        [
          '-e',
          'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))',
          file,
        ],
        { encoding: 'utf8' },
      ),
    )
  const ci = parse('.github/workflows/ci.yml')
  const release = parse('.github/workflows/release-cli.yml')
  assert.deepEqual(Object.keys(ci.on).sort(), ['pull_request', 'workflow_call'])
  assert.deepEqual(ci.permissions, { contents: 'read' })
  const versionGate = ci.jobs.checks.steps.find(
    (step) => step.run === 'node scripts/release/cli-version.mjs',
  )
  assert.equal(versionGate.env.RELEASE_HEAD_SHA, '${{ github.sha }}')
  for (const job of Object.values(ci.jobs)) {
    assert.equal(job.environment, undefined)
    assert.equal(job.permissions, undefined)
    assert.doesNotMatch(JSON.stringify(job), /\$\{\{\s*secrets\./)
  }
  assert.deepEqual(release.on, { push: { branches: ['main'] } })
  assert.deepEqual(release.concurrency, {
    group: 'dossier-production',
    'cancel-in-progress': false,
    queue: 'max',
  })
  assert.equal(release.jobs.ci.uses, './.github/workflows/ci.yml')
  assert.equal(release.jobs.ci.secrets, undefined)
  assert.equal(release.jobs.deploy.needs, 'ci')
  assert.equal(release.jobs.publish.needs, 'deploy')
  assert.equal(release.jobs.deploy.environment.name, 'production')
  assert.equal(release.jobs.publish.environment, 'production')
  assert.equal(release.jobs.deploy.permissions['id-token'], undefined)
  assert.equal(release.jobs.publish.permissions['id-token'], 'write')
  const deploymentSteps = release.jobs.deploy.steps
  assert.match(deploymentSteps.at(-1).run, /verify.mjs smoke/)
  const publishStep = release.jobs.publish.steps.at(-1).run
  assert.ok(
    publishStep.indexOf('verify.mjs smoke') <
      publishStep.indexOf('npm publish'),
  )
  assert.doesNotMatch(
    JSON.stringify(release),
    /NPM_TOKEN|NODE_AUTH_TOKEN|continue-on-error|always\(\)/,
  )
})
