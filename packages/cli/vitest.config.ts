import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      // Bun's bundler reads `with { type: 'text' }` imports; tests do the same.
      name: 'markdown-as-text',
      enforce: 'pre',
      load(id) {
        if (!id.endsWith('.md')) return null
        return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`
      },
    },
  ],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
})
