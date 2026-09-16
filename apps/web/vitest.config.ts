import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, 'drizzle'),
  )

  return {
    // The Cloudflare Vitest pool loads the custom Worker entry without the
    // TanStack Vite plugin that provides its virtual server-entry imports.
    // Alias only that dependency; the Worker router and Effect handler remain real.
    resolve: {
      alias: {
        '@tanstack/react-start/server-entry': path.join(
          import.meta.dirname,
          'test/tanstack-server-entry.stub.ts',
        ),
      },
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      // The Playwright suite lives under test/browser and runs in Chromium
      // through `bun run test:browser`, not in the workerd pool.
      exclude: [...configDefaults.exclude, 'test/browser/**'],
      setupFiles: ['./test/apply-migrations.ts'],
      // workerd plus D1 migrations per file is slow on shared CI runners.
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }
})
