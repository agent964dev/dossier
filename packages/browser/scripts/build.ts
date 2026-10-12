// Builds the base layer into dist/base/: the shell and the page client as
// separate static bundles, the base layer's _layout.html, and every file of
// src/base/_components/. Each bundle's metafile goes to dist/meta/, outside
// the base layer, so it is never served.
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const dist = join(root, 'dist')
const base = join(dist, 'base')
const meta = join(dist, 'meta')

const bundles = [
  // The shell document loads it with <script type="module">.
  { name: 'shell', entry: 'src/shell/main.ts', format: 'esm' },
  // A classic, blocking script, so it runs before any author script.
  { name: 'client', entry: 'src/page-client/install.ts', format: 'iife' },
] as const

await rm(dist, { recursive: true, force: true })
await mkdir(meta, { recursive: true })

for (const bundle of bundles) {
  const result = await Bun.build({
    entrypoints: [join(root, bundle.entry)],
    outdir: base,
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
  const info = result.metafile
  await Bun.write(
    join(meta, `${bundle.name}.meta.json`),
    typeof info === 'string' ? info : JSON.stringify(info, null, 2),
  )
}

await cp(join(root, 'src/base/_layout.html'), join(base, '_layout.html'))
const components = join(root, 'src/base/_components')
if (await stat(components).catch(() => null)) {
  await cp(components, join(base, '_components'), { recursive: true })
}
