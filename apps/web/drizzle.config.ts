import { defineConfig } from 'drizzle-kit'

// Generates SQL migrations from src/db/schema.ts; Wrangler applies them.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
})
