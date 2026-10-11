import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

/**
 * Static Assets for the test Worker: the real public/_headers and a
 * stand-in base layer at version 'test', so tests see the headers the
 * deployed assets get.
 */
const testAssets = (): string => {
  const directory = path.join(
    import.meta.dirname,
    'node_modules/.cache/dossier-test-assets',
  )
  mkdirSync(path.join(directory, '_/base/test'), { recursive: true })
  copyFileSync(
    path.join(import.meta.dirname, 'public/_headers'),
    path.join(directory, '_headers'),
  )
  for (const name of ['shell.js', 'client.js']) {
    writeFileSync(
      path.join(directory, '_/base/test', name),
      `// the test build's stand-in ${name}\n`,
    )
  }
  return directory
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, 'drizzle'),
  )

  return {
    define: {
      __DOSSIER_BUILD_VERSION__: JSON.stringify('test'),
      __BASE_VERSION__: JSON.stringify('test'),
    },
    resolve: {
      alias: {
        // TanStack Start's server entry needs Vite's virtual modules; tests
        // render screens through a stand-in that calls the real runScreen.
        '@tanstack/react-start/server-entry': path.join(
          import.meta.dirname,
          'test/support/screens.ts',
        ),
        '@tanstack/react-start/server': path.join(
          import.meta.dirname,
          'test/support/start-server.ts',
        ),
      },
    },
    plugins: [
      cloudflareTest({
        // The test entry serves through the real edge with the stand-in Google.
        main: './test/support/worker.ts',
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          assets: {
            directory: testAssets(),
            binding: 'ASSETS',
          },
          bindings: {
            TEST_MIGRATIONS: migrations,
            PUBLIC_ORIGIN: 'https://dossier.test',
            CONTENT_HOST: '{tree}.content.test',
            DEPLOYMENT_NAME: 'dossier.test',
            SUPER_ADMINS: 'root@example.com, Chief@Example.com',
            BETTER_AUTH_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
            HANDLE_SECRET: 'test-handle-secret-0123456789abcdef',
            GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
            GOOGLE_CLIENT_SECRET: 'test-client-secret',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/support/setup.ts'],
      // workerd plus D1 migrations per file is slow on shared CI runners.
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }
})
