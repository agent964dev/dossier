// Writes dist/server/wrangler.local.json: the built dev configuration without
// its routes. Wrangler rewrites every local request to the first route's host,
// which would hide the main and content hosts the Worker tells apart.
import { readFileSync, writeFileSync } from 'node:fs'

const built = new URL('../dist/server/wrangler.json', import.meta.url)
const config = JSON.parse(readFileSync(built, 'utf8')) as Record<
  string,
  unknown
>
delete config.routes
writeFileSync(
  new URL('../dist/server/wrangler.local.json', import.meta.url),
  `${JSON.stringify(config, null, 2)}\n`,
)
