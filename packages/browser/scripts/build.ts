// Builds the shell and the page client as separate static bundles in dist/,
// each with the bundler's metafile beside it.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const dist = join(root, 'dist')

const bundles = [
  // The shell document loads it with <script type="module">.
  { name: 'shell', entry: 'src/shell/main.ts', format: 'esm' },
  // A classic, blocking script, so it runs before any author script.
  { name: 'client', entry: 'src/page-client/install.ts', format: 'iife' },
] as const

await rm(dist, { recursive: true, force: true })

for (const bundle of bundles) {
  const result = await Bun.build({
    entrypoints: [join(root, bundle.entry)],
    outdir: dist,
    naming: `${bundle.name}.js`,
    target: 'browser',
    format: bundle.format,
    minify: true,
    metafile: true,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  const meta = result.metafile
  await Bun.write(
    join(dist, `${bundle.name}.meta.json`),
    typeof meta === 'string' ? meta : JSON.stringify(meta, null, 2),
  )
}
