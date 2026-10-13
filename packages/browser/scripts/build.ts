// Builds the base layer into dist/base/: the shell and the page client as
// separate static bundles, the base layer's _layout.html, the libraries and
// base components pages load by markup (with shared chunks), a single-file
// build of each with no imports for pages exported as one file, Shiki's
// grammars, KaTeX's stylesheet and fonts, and libraries.json naming them.
// Each bundle's metafile goes to dist/meta/, outside the base layer, so it is
// never served.
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { BunPlugin } from 'bun'
import { bundledLanguagesInfo } from 'shiki/langs'

import type {
  BaseComponentTag,
  BaseGrammar,
  BaseLibraries,
} from '@dossier/contracts/base'
import type { LibraryName } from '@dossier/html/libraries'

const root = join(import.meta.dir, '..')
const dist = join(root, 'dist')
const base = join(dist, 'base')
const meta = join(dist, 'meta')
const staging = join(dist, 'staging')

const bundles = [
  // The shell document loads it with <script type="module">.
  { name: 'shell', entry: 'src/shell/main.ts', format: 'esm' },
  // A classic, blocking script, so it runs before any author script.
  { name: 'client', entry: 'src/page-client/install.ts', format: 'iife' },
] as const

const LIBRARIES: readonly LibraryName[] = ['mermaid', 'shiki', 'katex']
const COMPONENTS: readonly BaseComponentTag[] = [
  'dossier-diff',
  'dossier-copy',
  'dossier-comments',
  'dossier-notifications',
]

const fail = (logs: readonly unknown[]): never => {
  for (const log of logs) console.error(log)
  process.exit(1)
}

const writeMeta = async (name: string, info: unknown) => {
  await Bun.write(
    join(meta, `${name}.meta.json`),
    typeof info === 'string' ? info : JSON.stringify(info, null, 2),
  )
}

/** Shiki's grammars: one file per language with the grammars it embeds. */
const writeGrammars = async (): Promise<Record<string, BaseGrammar>> => {
  const grammars: Record<string, BaseGrammar> = {}
  const folder = join(base, 'lib/shiki-grammars')
  await mkdir(folder, { recursive: true })
  for (const info of bundledLanguagesInfo) {
    const langs = (await info.import()).default
    const own = langs.find((lang) => lang.name === info.id)
    if (own === undefined) {
      throw new Error(`Shiki's ${info.id} grammar does not name itself`)
    }
    const file = `lib/shiki-grammars/${info.id}.json`
    await Bun.write(join(base, file), JSON.stringify(langs))
    const grammar: BaseGrammar = {
      file,
      embedded: langs
        .map((lang) => lang.name)
        .filter((name) => name !== info.id)
        .sort(),
    }
    for (const name of [info.id, ...(info.aliases ?? [])]) {
      grammars[name.toLowerCase()] ??= grammar
    }
  }
  return grammars
}

/**
 * Inside @pierre/diffs, 'shiki' is the base layer's shared Shiki, and the
 * bundled themes and the WebAssembly engine it could load are stand-ins that
 * are never called: the diff uses the base layer's grammars, its one theme
 * and the JavaScript engine.
 */
const sharedShiki: BunPlugin = {
  name: 'dossier-shared-shiki',
  setup(build) {
    const shim = join(root, 'src/base/lib/shiki-for-diffs.ts')
    const fromDiffs = (importer: string) =>
      /[\\/]@pierre[\\/+]/.test(importer) || importer.includes('@pierre+')
    build.onResolve({ filter: /^shiki$/ }, (args) =>
      fromDiffs(args.importer) ? { path: shim } : undefined,
    )
    build.onResolve({ filter: /^(shiki\/wasm|@shikijs\/themes\/.*)$/ }, () => ({
      path: 'unused',
      namespace: 'dossier-unused',
    }))
    build.onLoad({ filter: /.*/, namespace: 'dossier-unused' }, () => ({
      contents:
        'export default undefined\nexport const wasmBinary = undefined\n',
      loader: 'js',
    }))
  },
}

const libraryEntries = [
  ...LIBRARIES.map((name) => join(root, `src/base/lib/${name}.ts`)),
  ...COMPONENTS.map((tag) => join(root, `src/base/components/${tag}.ts`)),
]

/** The live builds, sharing chunks, laid out under lib/ and _components/. */
const buildLive = async (define: Record<string, string>) => {
  await rm(staging, { recursive: true, force: true })
  const result = await Bun.build({
    entrypoints: libraryEntries,
    root: join(root, 'src/base'),
    outdir: staging,
    naming: {
      entry: '[dir]/[name].[ext]',
      chunk: 'lib/chunks/[name]-[hash].[ext]',
      asset: 'lib/assets/[name]-[hash].[ext]',
    },
    splitting: true,
    target: 'browser',
    format: 'esm',
    minify: true,
    metafile: true,
    define,
    plugins: [sharedShiki],
  })
  if (!result.success) fail(result.logs)
  await writeMeta('libraries', result.metafile)
  // components/ and _components/ sit at the same depth, so the chunks'
  // relative imports still hold after the move.
  await rename(join(staging, 'components'), join(staging, '_components'))
  await cp(staging, base, { recursive: true })
  await rm(staging, { recursive: true, force: true })
}

/** One file per library and component with every import inlined. */
const buildExports = async (define: Record<string, string>) => {
  for (const entry of libraryEntries) {
    const name = basename(entry, '.ts')
    const folder = entry.includes('/components/') ? '_components' : 'lib'
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: join(base, folder),
      naming: `${name}.export.js`,
      splitting: false,
      target: 'browser',
      format: 'esm',
      minify: true,
      define,
      plugins: [sharedShiki],
    })
    if (!result.success) fail(result.logs)
    if (result.outputs.length !== 1) {
      throw new Error(`The export build of ${name} is not one file`)
    }
  }
}

/** KaTeX's stylesheet with only its woff2 fonts, and one with them inline. */
const writeKatex = async () => {
  const katex = join(root, 'node_modules/katex/dist')
  const fonts = join(base, 'lib/katex/fonts')
  await mkdir(fonts, { recursive: true })
  const css = (await Bun.file(join(katex, 'katex.min.css')).text()).replace(
    /,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g,
    '',
  )
  if (/\.(?:woff|ttf)\)/.test(css)) {
    throw new Error('KaTeX names a font other than woff2')
  }
  await Bun.write(join(base, 'lib/katex/katex.css'), css)
  const inline: Record<string, string> = {}
  for (const name of await readdir(join(katex, 'fonts'))) {
    if (!name.endsWith('.woff2')) continue
    await cp(join(katex, 'fonts', name), join(fonts, name))
    const bytes = await Bun.file(join(katex, 'fonts', name)).bytes()
    inline[name] =
      `data:font/woff2;base64,${Buffer.from(bytes).toString('base64')}`
  }
  await Bun.write(
    join(base, 'lib/katex.export.css'),
    css.replace(/url\(fonts\/([^)]+\.woff2)\)/g, (whole, name: string) =>
      inline[name] === undefined ? whole : `url(${inline[name]})`,
    ),
  )
}

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
  if (!result.success) fail(result.logs)
  await writeMeta(bundle.name, result.metafile)
}

await cp(join(root, 'src/base/_layout.html'), join(base, '_layout.html'))
const authored = join(root, 'src/base/_components')
if (await stat(authored).catch(() => null)) {
  await cp(authored, join(base, '_components'), { recursive: true })
}

const grammars = await writeGrammars()
const define = { __SHIKI_GRAMMARS__: JSON.stringify(grammars) }
await buildLive(define)
await buildExports(define)
await writeKatex()
for (const tag of COMPONENTS) {
  await cp(
    join(root, `src/base/components/${tag}.md`),
    join(base, `_components/${tag}.md`),
  )
}

const builds = (folder: string, name: string) => ({
  live: `${folder}/${name}.js`,
  export: `${folder}/${name}.export.js`,
})
const libraries: BaseLibraries = {
  libraries: {
    mermaid: builds('lib', 'mermaid'),
    shiki: { ...builds('lib', 'shiki'), grammars },
    katex: {
      ...builds('lib', 'katex'),
      css: 'lib/katex/katex.css',
      exportCss: 'lib/katex.export.css',
    },
  },
  components: Object.fromEntries(
    COMPONENTS.map((tag) => [
      tag,
      { ...builds('_components', tag), doc: `_components/${tag}.md` },
    ]),
  ) as BaseLibraries['components'],
}
await Bun.write(join(base, 'libraries.json'), `${JSON.stringify(libraries)}\n`)
