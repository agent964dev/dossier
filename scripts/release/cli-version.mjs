import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function versionParts(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`CLI releases require a stable X.Y.Z version: ${version}`)
  }
  return version.split('.').map(BigInt)
}

export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  }
  return 0
}

export function checkVersion(base, head, changed) {
  const comparison = compareVersions(head, base)
  if (comparison < 0) throw new Error('CLI version must never decrease')
  if (changed && comparison === 0) {
    throw new Error(
      'Releasable CLI contents changed; explicitly bump packages/cli/package.json and bun.lock',
    )
  }
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

// Compare the actual npm payload, including bundled workspaces, dependency
// resolutions, README, skill and LICENSE. Only the release number is erased.
// Separate archives keep the tested checkout and linked worktrees untouched.
export function packageFingerprint(ref) {
  const directory = mkdtempSync(join(tmpdir(), 'dossier-release-'))
  const run = (command, args) =>
    execFileSync(command, args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  try {
    const archive = execFileSync('git', ['archive', ref], {
      maxBuffer: 32 * 1024 * 1024,
    })
    execFileSync('tar', ['-x', '-C', directory], { input: archive })
    run('bun', ['install', '--frozen-lockfile'])
    const manifestPath = join(directory, 'packages/cli/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.version = '0.0.0'
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    run('bun', ['run', '--cwd', 'packages/cli', 'build'])
    const packed = JSON.parse(
      run('npm', ['pack', './packages/cli', '--ignore-scripts', '--json']),
    )
    return createHash('sha256')
      .update(readFileSync(join(directory, packed[0].filename)))
      .digest('hex')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function checkRefs(base, head) {
  for (const ref of [base, head]) {
    if (!/^[a-f0-9]{40}$/.test(ref))
      throw new Error('Expected full base and head commit SHAs')
  }
  const manifest = (ref) =>
    JSON.parse(git('show', `${ref}:packages/cli/package.json`))
  const before = manifest(base).version
  const after = manifest(head).version
  const compiler = (ref) =>
    JSON.parse(git('show', `${ref}:package.json`)).packageManager
  checkVersion(before, after, compiler(base) !== compiler(head))
  if (before === after) {
    checkVersion(
      before,
      after,
      packageFingerprint(base) !== packageFingerprint(head),
    )
  }
  console.log(`CLI version policy passed: ${before} -> ${after}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkRefs(process.env.RELEASE_BASE_SHA, process.env.RELEASE_HEAD_SHA)
}
