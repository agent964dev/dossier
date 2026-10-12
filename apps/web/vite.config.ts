import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * The commit the Worker is built from, reported by /_/api/health so operators
 * can compare the deployed Worker with the repository.
 */
function buildVersion(): string {
  if (process.env.DOSSIER_BUILD_VERSION) {
    return process.env.DOSSIER_BUILD_VERSION
  }
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

/** What each kind of base-layer file is served as. */
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const typeOf = (path: string): string =>
  TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream'

/** Every file under `dir`, as sorted paths relative to it. */
const filesUnder = (dir: string, at = ''): string[] =>
  readdirSync(join(dir, at), { withFileTypes: true })
    .flatMap((entry) => {
      const path = at === '' ? entry.name : `${at}/${entry.name}`
      return entry.isDirectory() ? filesUnder(dir, path) : [path]
    })
    .sort()

/**
 * The base layer: every file @dossier/browser builds into dist/base/ (the
 * shell, the page client, the base layout and the base components), built
 * with the Worker. Its version is the first 12 hex characters of the SHA-256
 * over every file's path and bytes in path order, so a new build never mixes
 * with the files of an open page. The manifest of versions and files goes to
 * dist/base-manifest.json for the deploy's copy into R2, and into the Worker
 * as __BASE_MANIFEST__.
 */
function baseLayer(): {
  version: string
  manifest: string
  plugin: Plugin
} {
  const browser = fileURLToPath(
    new URL('../../packages/browser', import.meta.url),
  )
  execFileSync('bun', ['run', 'build'], { cwd: browser, stdio: 'inherit' })
  const dir = join(browser, 'dist/base')
  const files = filesUnder(dir).map((path) => ({
    path,
    source: readFileSync(join(dir, path)),
  }))
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`${file.path}\0${file.source.byteLength}\0`)
    hash.update(file.source)
  }
  const version = hash.digest('hex').slice(0, 12)
  const manifest = JSON.stringify({
    version,
    files: Object.fromEntries(
      files.map((file) => [
        file.path,
        { type: typeOf(file.path), size: file.source.byteLength },
      ]),
    ),
  })
  return {
    version,
    manifest,
    plugin: {
      name: 'dossier-base-layer',
      generateBundle() {
        if (this.environment.name !== 'client') return
        for (const file of files) {
          this.emitFile({
            type: 'asset',
            fileName: `_/base/${version}/${file.path}`,
            source: file.source,
          })
        }
      },
      writeBundle(options) {
        if (this.environment.name !== 'client' || !options.dir) return
        // Beside the client build, so Static Assets never serve it.
        writeFileSync(
          join(options.dir, '..', 'base-manifest.json'),
          `${manifest}\n`,
        )
      },
    },
  }
}

const base = baseLayer()

export default defineConfig({
  define: {
    __DOSSIER_BUILD_VERSION__: JSON.stringify(buildVersion()),
    __BASE_VERSION__: JSON.stringify(base.version),
    __BASE_MANIFEST__: base.manifest,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Dossier's screens load their client build from /_/app/, beside the fonts.
  build: { assetsDir: '_/app' },
  server: { port: 8787, strictPort: true },
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tailwindcss(),
    tanstackStart(),
    react(),
    base.plugin,
  ],
})
