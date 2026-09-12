import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const wranglerConfig = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))
const embedHostAllowlist = process.env.DOSSIER_BROWSER_EMBED_HOST_ALLOWLIST

export default defineConfig({
  root: appRoot,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../src', import.meta.url)),
    },
  },
  plugins: [
    cloudflare({
      configPath: wranglerConfig,
      config(config) {
        return {
          vars: {
            ...config.vars,
            PUBLIC_BASE_URL: 'http://localhost:8787',
            ...(embedHostAllowlist === undefined
              ? {}
              : { EMBED_HOST_ALLOWLIST: embedHostAllowlist }),
          },
        }
      },
      viteEnvironment: { name: 'ssr' },
    }),
    tailwindcss(),
    tanstackStart(),
    react(),
  ],
})
