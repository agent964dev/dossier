declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
    /** Empty until a migration test applies migrations to it. */
    MIGRATION_DB: D1Database
  }
}
