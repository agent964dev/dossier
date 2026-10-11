import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
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

const BASE_FILES = ['shell.js', 'client.js'] as const

/**
 * The base layer: @dossier/browser's shell and page client, built with the
 * Worker. Its version is the first 12 hex characters of the SHA-256 of both
 * files, so a new build never mixes with the files of an open page.
 */
function baseLayer(): { version: string; plugin: Plugin } {
  const browser = fileURLToPath(
    new URL('../../packages/browser', import.meta.url),
  )
  execFileSync('bun', ['run', 'build'], { cwd: browser, stdio: 'inherit' })
  const files = BASE_FILES.map((name) => ({
    name,
    source: readFileSync(`${browser}/dist/${name}`),
  }))
  const hash = createHash('sha256')
  for (const file of files) hash.update(file.source)
  const version = hash.digest('hex').slice(0, 12)
  return {
    version,
    plugin: {
      name: 'dossier-base-layer',
      generateBundle() {
        if (this.environment.name !== 'client') return
        for (const file of files) {
          this.emitFile({
            type: 'asset',
            fileName: `_/base/${version}/${file.name}`,
            source: file.source,
          })
        }
      },
    },
  }
}

const base = baseLayer()

export default defineConfig({
  define: {
    __DOSSIER_BUILD_VERSION__: JSON.stringify(buildVersion()),
    __BASE_VERSION__: JSON.stringify(base.version),
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
