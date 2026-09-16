import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The integration suite spawns the built CLI once per case. Under the
    // root `bun run test`, four packages run at once and a case can wait
    // longer than the 5-second default on a shared runner.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
