import { Context, Effect, Layer } from 'effect'

import { Db } from './db'
import { PersistenceError, SignInRefused } from './errors'
import { Ids } from './ids'
import { WorkerEnv } from './env'

export interface VerifiedSignInIdentity {
  readonly provider: string
  readonly subject: string
  readonly email: string
  readonly emailVerified: boolean
  readonly displayName?: string | null
  readonly pictureUrl?: string | null
  readonly piiSubject?: string | null
}

export interface SignInResolution {
  readonly accountId: string
  readonly workspaceId: string
  readonly workspaceSlug: string
  readonly role: 'admin' | 'member'
  readonly email: string
}

export interface SeedResult {
  readonly workspaceId: string
  readonly workspaceSlug: string
  readonly bootstrapAccountId: 'acct_bootstrap'
  readonly bootstrapApiKeyId: 'key_bootstrap' | null
}

export interface AllowlistService {
  readonly resolveSignIn: (
    identity: VerifiedSignInIdentity,
  ) => Effect.Effect<SignInResolution, SignInRefused | PersistenceError>
  readonly seed: () => Effect.Effect<SeedResult, PersistenceError>
}

export class Allowlist extends Context.Tag('@dossier/web/Allowlist')<
  Allowlist,
  AllowlistService
>() {}

type AllowlistRow = {
  id: string
  workspace_id: string
  workspace_slug: string
  role: 'admin' | 'member'
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function persistence(operation: string, cause: unknown): PersistenceError {
  return new PersistenceError({ operation, cause })
}

export const AllowlistLive = Layer.effect(
  Allowlist,
  Effect.gen(function* () {
    const db = yield* Db
    const ids = yield* Ids
    const env = yield* WorkerEnv

    const resolveSignIn: AllowlistService['resolveSignIn'] = (identity) =>
      Effect.gen(function* () {
        const email = normalizeEmail(identity.email)
        const at = email.lastIndexOf('@')
        if (!identity.emailVerified || at <= 0 || at === email.length - 1) {
          return yield* Effect.fail(
            new SignInRefused({ message: 'A verified email address is required.' }),
          )
        }
        const domain = email.slice(at + 1)
        const entry = yield* Effect.tryPromise({
          try: async () => {
            const exact = await db.raw
              .prepare(
                `SELECT al.id, al.workspace_id, w.slug AS workspace_slug, al.role
                   FROM allowlist al
                   JOIN workspaces w ON w.id = al.workspace_id
                  WHERE al.kind = 'email' AND al.value = ?
                  LIMIT 1`,
              )
              .bind(email)
              .first<AllowlistRow>()
            if (exact) return exact
            return db.raw
              .prepare(
                `SELECT al.id, al.workspace_id, w.slug AS workspace_slug, al.role
                   FROM allowlist al
                   JOIN workspaces w ON w.id = al.workspace_id
                  WHERE al.kind = 'domain' AND al.value = ?
                  LIMIT 1`,
              )
              .bind(domain)
              .first<AllowlistRow>()
          },
          catch: (cause) => persistence('resolve allowlist entry', cause),
        })
        if (!entry) {
          return yield* Effect.fail(
            new SignInRefused({
              message: 'This dossier is invite-only; ask an admin to allow your email.',
            }),
          )
        }

        const existing = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT i.id AS identity_id, i.account_id, a.disabled_at
                   FROM identities i
                   JOIN accounts a ON a.id = i.account_id
                  WHERE i.provider = ? AND i.subject = ?
                  LIMIT 1`,
              )
              .bind(identity.provider, identity.subject)
              .first<{ identity_id: string; account_id: string; disabled_at: string | null }>(),
          catch: (cause) => persistence('load sign-in identity', cause),
        })
        if (existing?.disabled_at) {
          return yield* Effect.fail(
            new SignInRefused({ message: 'This account is disabled.' }),
          )
        }

        const now = new Date().toISOString()
        const accountId = existing?.account_id ?? ids.internalId()
        const identityId = existing?.identity_id ?? ids.internalId()
        const accountName = identity.displayName?.trim() || email
        const statements: D1PreparedStatement[] = []
        if (!existing) {
          statements.push(
            db.raw
              .prepare(
                `INSERT INTO accounts
                   (id, name, kind, deployment_admin, disabled_at, created_at, updated_at)
                 VALUES (?, ?, 'user', 0, NULL, ?, ?)`,
              )
              .bind(accountId, accountName, now, now),
            db.raw
              .prepare(
                `INSERT INTO identities
                   (id, account_id, provider, subject, email, email_verified,
                    display_name, picture_url, pii_subject, created_at, last_login_at)
                 VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
              )
              .bind(
                identityId,
                accountId,
                identity.provider,
                identity.subject,
                email,
                identity.displayName ?? null,
                identity.pictureUrl ?? null,
                identity.piiSubject ?? null,
                now,
                now,
              ),
          )
        } else {
          statements.push(
            db.raw
              .prepare(
                `UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?`,
              )
              .bind(accountName, now, accountId),
            db.raw
              .prepare(
                `UPDATE identities
                    SET email = ?, email_verified = 1, display_name = ?,
                        picture_url = ?, pii_subject = ?, last_login_at = ?
                  WHERE id = ?`,
              )
              .bind(
                email,
                identity.displayName ?? null,
                identity.pictureUrl ?? null,
                identity.piiSubject ?? null,
                now,
                identityId,
              ),
          )
        }
        statements.push(
          db.raw
            .prepare(
              `INSERT INTO memberships (workspace_id, account_id, role, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(workspace_id, account_id)
               DO UPDATE SET role = excluded.role`,
            )
            .bind(entry.workspace_id, accountId, entry.role, now),
          db.raw
            .prepare(`UPDATE allowlist SET last_used_at = ? WHERE id = ?`)
            .bind(now, entry.id),
        )
        yield* db.batch(statements)

        return {
          accountId,
          workspaceId: entry.workspace_id,
          workspaceSlug: entry.workspace_slug,
          role: entry.role,
          email,
        }
      })

    const seed: AllowlistService['seed'] = () =>
      Effect.gen(function* () {
        const [slugRaw, domainRaw] = env.SEED_WORKSPACE.split(':', 2)
        const slug = slugRaw.trim().toLowerCase()
        const domain = domainRaw?.trim().toLowerCase() || null
        const adminEmail = normalizeEmail(env.SEED_ADMIN_EMAIL)
        const now = new Date().toISOString()
        const workspaceId = `workspace_${slug}`
        const bootstrapKeyHash = env.BOOTSTRAP_API_KEY
          ? yield* ids.sha256Hex(env.BOOTSTRAP_API_KEY)
          : null

        const statements = [
          db.raw
            .prepare(
              `INSERT INTO accounts
                 (id, name, kind, deployment_admin, disabled_at, created_at, updated_at)
               VALUES ('acct_bootstrap', 'Bootstrap service', 'service', 1, NULL, ?, ?)
               ON CONFLICT(id) DO NOTHING`,
            )
            .bind(now, now),
          db.raw
            .prepare(
              `INSERT INTO workspaces
                 (id, slug, kind, email_domain, name, created_at, updated_at)
               VALUES (?, ?, 'team', ?, ?, ?, ?)
               ON CONFLICT(id) DO NOTHING`,
            )
            .bind(workspaceId, slug, domain, slug, now, now),
          db.raw
            .prepare(
              `INSERT INTO allowlist
                 (id, kind, value, workspace_id, role, created_by, created_at, last_used_at)
               VALUES (?, 'email', ?, ?, 'admin', 'acct_bootstrap', ?, NULL)
               ON CONFLICT(value) DO NOTHING`,
            )
            .bind(`allow_${slug}_admin`, adminEmail, workspaceId, now),
        ]
        if (domain) {
          statements.push(
            db.raw
              .prepare(
                `INSERT INTO allowlist
                   (id, kind, value, workspace_id, role, created_by, created_at, last_used_at)
                 VALUES (?, 'domain', ?, ?, 'member', 'acct_bootstrap', ?, NULL)
                 ON CONFLICT(value) DO NOTHING`,
              )
              .bind(`allow_${slug}_domain`, domain, workspaceId, now),
          )
        }
        if (bootstrapKeyHash) {
          statements.push(
            db.raw
              .prepare(
                `INSERT INTO api_keys
                   (id, account_id, workspace_id, name, key_hash, created_at, last_used_at, revoked_at)
                 VALUES ('key_bootstrap', 'acct_bootstrap', ?, 'Bootstrap', ?, ?, NULL, NULL)
                 ON CONFLICT(id) DO NOTHING`,
              )
              .bind(workspaceId, bootstrapKeyHash, now),
          )
        }
        yield* db.batch(statements)
        return {
          workspaceId,
          workspaceSlug: slug,
          bootstrapAccountId: 'acct_bootstrap' as const,
          bootstrapApiKeyId: bootstrapKeyHash ? ('key_bootstrap' as const) : null,
        }
      })

    return { resolveSignIn, seed }
  }),
)
