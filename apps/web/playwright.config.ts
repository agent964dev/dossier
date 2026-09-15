import { defineConfig, devices } from '@playwright/test'

/**
 * The browser suite runs against the same Vite dev server `bun run dev` starts,
 * because only that server applies the Cloudflare plugin, the `?raw` runtime
 * imports, and the TanStack transforms.
 *
 * It never shares anything with a dev server the developer already has running:
 * its own port, and its own Miniflare state directory, so its D1 and R2 are
 * separate files.
 */
const port = Number(process.env.PLAYWRIGHT_PORT) || 8790
const persistPath =
  process.env.DOSSIER_PERSIST_PATH ?? '.wrangler/state-browser'
const baseURL = `http://localhost:${port}`

export default defineConfig({
  testDir: './test/browser',
  globalSetup: './test/browser/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // The load overlay gives the frame five seconds, so a spec that waits for it
  // needs headroom above that.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    storageState: './test/browser/.auth/session.json',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun run dev',
    cwd: import.meta.dirname,
    port,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DOSSIER_DEV_PORT: String(port),
      DOSSIER_PERSIST_PATH: persistPath,
      PUBLIC_BASE_URL: baseURL,
    },
  },
})
