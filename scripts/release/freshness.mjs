import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function mayShip(sha, main, deployments, isAncestor) {
  if (!isAncestor(sha, main))
    throw new Error('Release SHA is no longer on main')
  // Keep all attempts, including failures: a failed run may have applied D1
  // migrations or activated its Worker before smoke checks failed.
  return deployments.every((deployment) => isAncestor(deployment.sha, sha))
}

export async function deploymentHistory(fetcher, repository) {
  const deployments = []
  for (let page = 1; page <= 100; page++) {
    const response = await fetcher(
      `https://api.github.com/repos/${repository}/deployments?environment=production&per_page=100&page=${page}`,
    )
    if (response.status !== 200)
      throw new Error(`Deployment history HTTP ${response.status}`)
    const batch = await response.json()
    if (
      !Array.isArray(batch) ||
      batch.some((entry) => !/^[a-f0-9]{40}$/.test(entry.sha))
    )
      throw new Error('Invalid deployment history')
    deployments.push(...batch)
    if (batch.length < 100) return deployments
  }
  throw new Error(
    'Deployment history pagination limit reached; refusing an incomplete stale-run check',
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sha = process.env.GITHUB_SHA
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error('Expected an exact release SHA')
  execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'inherit' })
  const main = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], {
    encoding: 'utf8',
  }).trim()
  const deployments = await deploymentHistory(
    (url) =>
      fetch(url, {
        headers: {
          authorization: `Bearer ${process.env.GH_TOKEN}`,
          accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      }),
    process.env.GITHUB_REPOSITORY,
  )
  const ship = mayShip(sha, main, deployments, (ancestor, descendant) => {
    const result = spawnSync('git', [
      'merge-base',
      '--is-ancestor',
      ancestor,
      descendant,
    ])
    if (result.status !== 0 && result.status !== 1)
      throw new Error('Cannot resolve deployment ancestry')
    return result.status === 0
  })
  if (!ship) {
    throw new Error(
      `Stale release ${sha}: a newer production revision has already been attempted`,
    )
  }
  console.log(`Eligible production SHA: ${sha}`)
  appendFileSync(process.env.GITHUB_OUTPUT, `ship=${ship}\n`)
}
