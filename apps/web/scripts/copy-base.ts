// Copies this build's base layer into R2 under base/<version>/, so a page
// opened before a deploy keeps loading the version it started with after
// Static Assets move on. Run with bun after the build and before
// `wrangler deploy`; never part of the Worker's build.
//
//   bun scripts/copy-base.ts --bucket <name> --env <dev|production>
//     [--dist <the client build, default dist/client>]
//
// A version's files never change, so a version R2 already marks complete is
// left alone, and an interrupted copy just runs again. Exits non-zero when a
// file could not be copied.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

interface Manifest {
  readonly version: string
  readonly files: Readonly<Record<string, { readonly type: string }>>
}

const web = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    bucket: { type: 'string' },
    env: { type: 'string' },
    dist: { type: 'string', default: 'dist/client' },
  },
})
const bucket = values.bucket
if (
  bucket === undefined ||
  (values.env !== 'dev' && values.env !== 'production')
) {
  console.error(
    'Usage: bun scripts/copy-base.ts --bucket <name> --env <dev|production> [--dist <path>]',
  )
  process.exit(2)
}
const dist = resolve(web, values.dist)
const manifestPath = join(dist, '..', 'base-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
const { version } = manifest
if (!/^[0-9a-f]{12}$/.test(version)) {
  console.error(`The base-layer manifest names no build version: ${version}`)
  process.exit(1)
}

const envArgs = values.env === 'dev' ? ['--env', 'dev'] : []

/** Runs wrangler in apps/web; resolves with its exit code and its stderr. */
const wrangler = (args: readonly string[]) =>
  new Promise<{ readonly code: number; readonly stderr: string }>(
    (done, failed) => {
      const child = spawn(
        'bunx',
        ['--no-install', 'wrangler', ...args, ...envArgs, '--remote'],
        { cwd: web, stdio: ['ignore', 'ignore', 'pipe'] },
      )
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', failed)
      child.on('close', (code) => done({ code: code ?? 1, stderr }))
    },
  )

const key = (path: string) => `${bucket}/base/${version}/${path}`

const held = await wrangler(['r2', 'object', 'get', key('.complete'), '--pipe'])
if (held.code === 0) {
  console.log(`R2 already holds base layer ${version}; nothing to copy.`)
  process.exit(0)
}

const files = Object.entries(manifest.files)
const put = async ([path, file]: (typeof files)[number]) => {
  const result = await wrangler([
    'r2',
    'object',
    'put',
    key(path),
    '--file',
    join(dist, '_/base', version, path),
    '--content-type',
    file.type,
  ])
  if (result.code !== 0) {
    throw new Error(`Copying ${path} failed:\n${result.stderr.trim()}`)
  }
  console.log(`copied   base/${version}/${path}`)
}

try {
  // Eight at a time.
  for (let at = 0; at < files.length; at += 8) {
    await Promise.all(files.slice(at, at + 8).map(put))
  }
  // The marker goes last and holds the manifest it completes.
  const marker = await wrangler([
    'r2',
    'object',
    'put',
    key('.complete'),
    '--file',
    manifestPath,
    '--content-type',
    'application/json',
  ])
  if (marker.code !== 0) {
    throw new Error(
      `Marking the copy complete failed:\n${marker.stderr.trim()}`,
    )
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
console.log(`Copied base layer ${version} into R2 (${files.length} files).`)
