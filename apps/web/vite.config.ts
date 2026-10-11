import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

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

export default defineConfig({
  define: {
    __DOSSIER_BUILD_VERSION__: JSON.stringify(buildVersion()),
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
  ],
})
