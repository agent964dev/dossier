import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Short git commit of the build, reported by /api/healthz so operators can
 * compare the deployed Worker with the repository. Falls back to "unknown"
 * outside a git checkout (for example a source tarball).
 */
function buildVersion(): string {
  if (process.env.DOSSIER_BUILD_VERSION)
    return process.env.DOSSIER_BUILD_VERSION
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * The dev server's port and its local Miniflare state directory. The browser
 * suite sets both so it never shares a port or a D1 file with a dev server the
 * developer is already running.
 */
const devPort = Number(process.env.DOSSIER_DEV_PORT) || 8787
const persistPath = process.env.DOSSIER_PERSIST_PATH

export default defineConfig({
  define: {
    __DOSSIER_BUILD_VERSION__: JSON.stringify(buildVersion()),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: devPort,
    strictPort: true,
  },
  plugins: [
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      ...(persistPath === undefined
        ? {}
        : { persistState: { path: persistPath } }),
    }),
    tailwindcss(),
    tanstackStart(),
    react(),
  ],
})
