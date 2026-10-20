declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
    /** Empty until a migration test applies migrations to it. */
    MIGRATION_DB: D1Database
    /** The stand-in Microsoft's client. */
    MICROSOFT_CLIENT_ID?: string
    MICROSOFT_CLIENT_SECRET?: string
  }
}

// The Worker's own Env, which a test runtime's overrides are typed by.
interface Env {
  MICROSOFT_CLIENT_ID?: string
  MICROSOFT_CLIENT_SECRET?: string
}
