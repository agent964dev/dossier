import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import type { BaseLibraries } from '@dossier/contracts'
import { defineConfig } from 'vitest/config'

const BASE_LAYOUT = path.join(
  import.meta.dirname,
  '../../packages/browser/src/base/_layout.html',
)

/** Stand-in scripts of the test build's base layer. */
const SCRIPTS = [
  'shell.js',
  'client.js',
  'lib/mermaid.js',
  'lib/shiki.js',
  'lib/katex.js',
]

const standIn = (name: string) => `// the test build's stand-in ${name}\n`

/**
 * Stand-ins of the files an export inlines: the single-file builds, a
 * grammar and KaTeX's stylesheet with its fonts inline. Export builds are
 * never components, so the kit map is as without them.
 */
const EXPORT_FILES: Record<string, { type: string; text: string }> = {
  ...Object.fromEntries(
    [
      'lib/mermaid.export.js',
      'lib/shiki.export.js',
      'lib/katex.export.js',
      '_components/dossier-diff.export.js',
      '_components/dossier-copy.export.js',
      '_components/dossier-comments.export.js',
    ].map((name) => [
      name,
      { type: 'text/javascript; charset=utf-8', text: standIn(name) },
    ]),
  ),
  'lib/shiki-grammars/typescript.json': {
    type: 'application/json',
    text: '[{"name":"typescript"}]\n',
  },
  'lib/katex.export.css': {
    type: 'text/css; charset=utf-8',
    text: '.katex { font: 1em KaTeX_Main } /* fonts inline */\n',
  },
}

/** The test build's libraries.json, over the stand-in scripts. */
const TEST_LIBRARIES = {
  libraries: {
    mermaid: { live: 'lib/mermaid.js', export: 'lib/mermaid.export.js' },
    shiki: {
      live: 'lib/shiki.js',
      export: 'lib/shiki.export.js',
      grammars: {
        ts: { file: 'lib/shiki-grammars/typescript.json', embedded: [] },
        typescript: {
          file: 'lib/shiki-grammars/typescript.json',
          embedded: [],
        },
      },
    },
    katex: {
      live: 'lib/katex.js',
      export: 'lib/katex.export.js',
      css: 'lib/katex/katex.css',
      exportCss: 'lib/katex.export.css',
    },
  },
  components: {
    'dossier-diff': {
      live: '_components/dossier-diff.js',
      export: '_components/dossier-diff.export.js',
      doc: '_components/dossier-diff.md',
    },
    'dossier-copy': {
      live: '_components/dossier-copy.js',
      export: '_components/dossier-copy.export.js',
      doc: '_components/dossier-copy.md',
    },
    'dossier-comments': {
      live: '_components/dossier-comments.js',
      export: '_components/dossier-comments.export.js',
      doc: '_components/dossier-comments.md',
    },
  },
} satisfies BaseLibraries

/** The test build's base layer: stand-in scripts and the real layout. */
const testManifest = () => ({
  version: 'test',
  files: {
    ...Object.fromEntries(
      SCRIPTS.map((name) => [
        name,
        { type: 'text/javascript; charset=utf-8', size: standIn(name).length },
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(EXPORT_FILES).map(([name, file]) => [
        name,
        { type: file.type, size: file.text.length },
      ]),
    ),
    '_layout.html': {
      type: 'text/html; charset=utf-8',
      size: statSync(BASE_LAYOUT).size,
    },
  },
  libraries: TEST_LIBRARIES,
})

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
  for (const name of SCRIPTS) {
    const file = path.join(directory, '_/base/test', name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, standIn(name))
  }
  for (const [name, { text }] of Object.entries(EXPORT_FILES)) {
    const file = path.join(directory, '_/base/test', name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  copyFileSync(BASE_LAYOUT, path.join(directory, '_/base/test/_layout.html'))
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
      __BASE_MANIFEST__: JSON.stringify(testManifest()),
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
      projects: [
        {
          extends: true as const,
          test: {
            name: 'web',
            include: ['test/**/*.test.ts'],
            exclude: ['test/hub/**'],
          },
        },
        // Real upgrades and the real tree hub, whose sockets live across
        // requests: its files share one Worker's storage.
        {
          extends: true as const,
          test: { name: 'hub', include: ['test/hub/**/*.test.ts'] },
        },
        // Screen components in a DOM, outside the Worker.
        {
          resolve: {
            alias: { '@': path.join(import.meta.dirname, 'src') },
          },
          test: {
            name: 'dom',
            include: ['test/dom/**/*.test.tsx'],
            environment: 'happy-dom',
          },
        },
      ],
    },
  }
})
