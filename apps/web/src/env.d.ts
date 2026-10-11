// Secrets, which `wrangler types` cannot see because they live outside
// wrangler.jsonc. Set them with `wrangler secret put` in every environment.
interface Env {
  /** Comma-separated emails, seeded as super admins at their first sign-in. */
  SUPER_ADMINS: string
  BETTER_AUTH_SECRET: string
  HANDLE_SECRET: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
}

declare namespace Cloudflare {
  interface Env {
    SUPER_ADMINS: string
    BETTER_AUTH_SECRET: string
    HANDLE_SECRET: string
    GOOGLE_CLIENT_ID?: string
    GOOGLE_CLIENT_SECRET?: string
  }
}
