import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/** Better Auth's dates: epoch milliseconds, read back as `Date`. */
const ms = (name: string) => integer(name, { mode: 'timestamp_ms' })
const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`
/** Better Auth's creation time, defaulting to the moment of the insert. */
const createdAt = () => ms('created_at').default(nowMs).notNull()
/** Better Auth's update time, moved on every update. */
const updatedAt = () =>
  ms('updated_at')
    .default(nowMs)
    .$onUpdate(() => new Date())
    .notNull()

// Better Auth's tables, as its generator writes them for the options in
// ports/auth.ts, plus the unique index on an account's provider and subject.

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Lower-cased: the latest verified address Google returned. */
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' })
    .default(false)
    .notNull(),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: ms('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** The account that opened it, so a takeover revokes only its sessions. */
    googleAccountId: text('google_account_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('session_user_idx').on(t.userId)],
)

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Always 'google'. */
    providerId: text('provider_id').notNull(),
    /** Google's subject. */
    accountId: text('account_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: ms('access_token_expires_at'),
    refreshTokenExpiresAt: ms('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('account_provider_account_unique').on(
      t.providerId,
      t.accountId,
    ),
    index('account_user_idx').on(t.userId),
  ],
)

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: ms('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)

export const deviceCode = sqliteTable('device_code', {
  id: text('id').primaryKey(),
  deviceCode: text('device_code').notNull().unique(),
  userCode: text('user_code').notNull().unique(),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: ms('expires_at').notNull(),
  /** 'pending' | 'approved' | 'denied' */
  status: text('status').notNull(),
  lastPolledAt: ms('last_polled_at'),
  pollingInterval: integer('polling_interval'),
  clientId: text('client_id'),
  scope: text('scope'),
  /** "cli on m4", from Dossier's grant. */
  deviceName: text('device_name'),
  /** 'dossier-agent-key' */
  grantKind: text('grant_kind'),
  /**
   * The account whose session pressed Allow. A takeover denies the codes of
   * the accounts it detaches, and minting checks it again.
   */
  approvedByGoogleAccountId: text('approved_by_google_account_id'),
})

export const rateLimit = sqliteTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull(),
})

// Dossier's tables. Times are epoch milliseconds from Effect's Clock.

export const people = sqliteTable(
  'people',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Whether Google is the authority for the email, at the latest sign-in. */
    emailAuthority: text('email_authority').notNull(),
    firstSignInAt: integer('first_sign_in_at').notNull(),
    lastSignInAt: integer('last_sign_in_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    check(
      'people_email_authority_check',
      sql`${t.emailAuthority} in ('google', 'none')`,
    ),
  ],
)

export const googleAccounts = sqliteTable(
  'google_accounts',
  {
    accountId: text('account_id')
      .primaryKey()
      .references(() => account.id, { onDelete: 'cascade' }),
    /** As Google last returned it, lower-cased. */
    email: text('email').notNull(),
    emailAuthority: text('email_authority').notNull(),
    /** Google's hosted domain claim, kept on the server only. */
    hostedDomain: text('hosted_domain'),
    observedAt: integer('observed_at').notNull(),
  },
  (t) => [
    check(
      'google_accounts_email_authority_check',
      sql`${t.emailAuthority} in ('google', 'none')`,
    ),
  ],
)

export const personHistory = sqliteTable(
  'person_history',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** Account ids, emails, counts; never secrets. */
    detailJson: text('detail_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('person_history_user_idx').on(t.userId, t.createdAt),
    check(
      'person_history_kind_check',
      sql`${t.kind} in ('linked', 'takeover', 'email_kept', 'signed_out_everywhere', 'key_created', 'key_revoked')`,
    ),
  ],
)

export const superAdmins = sqliteTable('super_admins', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** Null when seeded from SUPER_ADMINS. */
  addedBy: text('added_by').references(() => user.id),
  createdAt: integer('created_at').notNull(),
})

export const agentKeys = sqliteTable(
  'agent_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Hex SHA-256 of the `dsk_` secret; the secret is never stored. */
    hashSha256: text('hash_sha256').notNull().unique(),
    createdVia: text('created_via').notNull(),
    /** The account whose session created or approved it. */
    googleAccountId: text('google_account_id'),
    /** Moved at most once a minute. */
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('agent_keys_user_idx').on(t.userId),
    check(
      'agent_keys_created_via_check',
      sql`${t.createdVia} in ('device', 'settings')`,
    ),
  ],
)
