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
  features: ['state'],
}
const reply = (status, body) => ({ status, json: async () => body })
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

test('health validates full SHA and revision capabilities', () => {
  checkHealth(healthy, sha)
  for (const body of [
    { ...healthy, version: sha.slice(0, 7) },
    { ...healthy, features: [] },
    { ...healthy, ok: false },
    { ...healthy, service: 'other' },
  ]) {
    assert.throws(() => checkHealth(body, sha), /expected SHA/)
  }
  checkHealth({ ...healthy, features: [] }, sha, [])
})

test('smoke retries stale, HTTP, malformed and network responses then succeeds', async () => {
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
  ]
  let calls = 0
  let waits = 0
  await smoke(sha, {
    attempts: 5,
    wait: async () => {
      waits++
    },
    fetcher: async (_url, options) => {
      assert.equal(options.redirect, 'error')
      assert.ok(options.signal)
      const response = responses[calls++]
      if (response instanceof Error) throw response
      return response
    },
  })
  assert.equal(calls, 5)
  assert.equal(waits, 4)
})

test('exhausted smoke fails with a bounded attempt count', async () => {
  let calls = 0
  await assert.rejects(
    smoke(sha, {
      attempts: 3,
      wait: async () => {},
      fetcher: async () => {
        calls++
        return reply(200, { ...healthy, features: [] })
      },
    }),
    /publication is blocked/,
  )
  assert.equal(calls, 3)
})

test('production prerequisites reject missing secrets and development resources', () => {
  checkSecrets(production.secrets.map((name) => ({ name })))
  assert.throws(() => checkSecrets([{ name: 'SESSION_SECRET' }]), /LINK_SECRET/)
  const config = {
    name: 'dossier',
    vars: { PUBLIC_BASE_URL: 'https://dossier.agent964.com' },
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'dossier-production',
        database_id: '72766ce3-44da-4bdd-a025-90a6ebe1e3e0',
      },
    ],
    r2_buckets: [{ binding: 'OBJECTS', bucket_name: 'dossier-production' }],
    ratelimits: [
      {
        name: 'STATE_RATE_LIMITER',
        namespace_id: '1003',
        simple: { limit: 60, period: 60 },
      },
    ],
  }
  checkConfig(config)
  assert.throws(
    () =>
      checkConfig({
        ...config,
        vars: { ...config.vars, SEED_ADMIN_EMAIL: 'placeholder@example.com' },
      }),
    /overwrite Worker secrets/,
  )
  for (const change of [
    { name: 'dossier-dev' },
    {
      d1_databases: [{ ...config.d1_databases[0], database_id: 'development' }],
    },
    {
      r2_buckets: [{ binding: 'OBJECTS', bucket_name: 'dossier-development' }],
    },
    { ratelimits: [] },
  ]) {
    assert.throws(() => checkConfig({ ...config, ...change }), /non-production/)
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
    const run = (migrationExit, deployExit) => {
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
      /dossier-production --remote --config wrangler.jsonc/,
    )
    const failedDeploy = run(0, 23)
    assert.equal(failedDeploy.status, 23)
    assert.equal(failedDeploy.calls.length, 2)
    for (const call of failedDeploy.calls)
      assert.match(call, /--no-x-provision/)
    assert.match(
      failedDeploy.calls[1],
      /deploy --config dist\/server\/wrangler.json/,
    )
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
