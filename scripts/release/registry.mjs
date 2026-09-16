import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compareVersions, versionParts } from './cli-version.mjs'

export async function releaseDecision(version, fetcher = fetch) {
  versionParts(version)
  // A successful package document proves absence of a VERSION. An HTTP 404
  // alone cannot distinguish an absent package from auth/proxy/registry errors.
  const response = await fetcher(
    'https://registry.npmjs.org/@agent964%2Fdossier',
    {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (response.status !== 200)
    throw new Error(
      `npm registry HTTP ${response.status}; refusing to infer an unpublished version`,
    )
  const data = await response.json()
  if (
    data.name !== '@agent964/dossier' ||
    !data.versions ||
    typeof data.versions !== 'object' ||
    !Object.keys(data.versions).length
  )
    throw new Error('Invalid npm package metadata')
  if (Object.hasOwn(data.versions, version)) return false
  const stableVersions = Object.keys(data.versions).filter((entry) =>
    /^\d+\.\d+\.\d+$/.test(entry),
  )
  if (
    !stableVersions.length ||
    stableVersions.some((entry) => compareVersions(version, entry) <= 0)
  ) {
    throw new Error(
      'Unpublished CLI version must be an explicit increase over published versions',
    )
  }
  return true
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(
    readFileSync('packages/cli/package.json', 'utf8'),
  )
  const publish = await releaseDecision(version)
  console.log(
    `${version}: ${publish ? 'unpublished release' : 'already published; skipping'}`,
  )
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`)
}
