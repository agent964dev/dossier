import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core'

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    kind: text('kind').notNull(),
    emailDomain: text('email_domain'),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('workspaces_slug_unique').on(table.slug),
    uniqueIndex('workspaces_email_domain_unique').on(table.emailDomain),
    check('workspaces_kind_check', sql`${table.kind} IN ('team', 'personal')`),
  ],
)

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    deploymentAdmin: integer('deployment_admin').notNull().default(0),
    disabledAt: text('disabled_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('accounts_kind_check', sql`${table.kind} IN ('user', 'service')`),
    check(
      'accounts_deployment_admin_check',
      sql`${table.deploymentAdmin} IN (0, 1)`,
    ),
  ],
)

export const memberships = sqliteTable(
  'memberships',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    role: text('role').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.accountId] }),
    index('memberships_account_id_idx').on(table.accountId),
    check('memberships_role_check', sql`${table.role} IN ('admin', 'member')`),
  ],
)

export const allowlist = sqliteTable(
  'allowlist',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    value: text('value').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    role: text('role').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => accounts.id),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (table) => [
    uniqueIndex('allowlist_value_unique').on(table.value),
    index('allowlist_value_idx').on(table.value),
    check('allowlist_kind_check', sql`${table.kind} IN ('email', 'domain')`),
    check('allowlist_role_check', sql`${table.role} IN ('admin', 'member')`),
  ],
)

export const identities = sqliteTable(
  'identities',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    email: text('email').notNull(),
    emailVerified: integer('email_verified').notNull(),
    displayName: text('display_name'),
    pictureUrl: text('picture_url'),
    piiSubject: text('pii_subject'),
    createdAt: text('created_at').notNull(),
    lastLoginAt: text('last_login_at'),
  },
  (table) => [
    unique('identities_provider_subject_unique').on(
      table.provider,
      table.subject,
    ),
    index('identities_account_id_idx').on(table.accountId),
    check(
      'identities_email_verified_check',
      sql`${table.emailVerified} IN (0, 1)`,
    ),
  ],
)

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
  },
  (table) => [
    uniqueIndex('api_keys_key_hash_unique').on(table.keyHash),
    index('api_keys_account_id_idx').on(table.accountId),
  ],
)

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    createdBy: text('created_by')
      .notNull()
      .references(() => accounts.id),
    parentId: text('parent_id').references(
      (): AnySQLiteColumn => documents.id,
    ),
    path: text('path').notNull(),
    depth: integer('depth').notNull(),
    kind: text('kind'),
    title: text('title').notNull(),
    description: text('description'),
    visibility: text('visibility'),
    currentVersionId: text('current_version_id'),
    nextVersionNumber: integer('next_version_number').notNull().default(1),
    revision: integer('revision').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
    deletionBatchId: text('deletion_batch_id').references(
      (): AnySQLiteColumn => deletionBatches.id,
    ),
    disabledAt: text('disabled_at'),
    disabledReason: text('disabled_reason'),
  },
  (table) => [
    check(
      'documents_id_check',
      sql`length(${table.id}) = 12 AND ${table.id} NOT GLOB '*[^a-z0-9]*'`,
    ),
    check(
      'documents_depth_check',
      sql`${table.depth} BETWEEN 0 AND 16`,
    ),
    check(
      'documents_kind_check',
      sql`${table.kind} IS NULL OR (length(${table.kind}) BETWEEN 1 AND 32 AND ${table.kind} NOT GLOB '*[^a-z0-9-]*')`,
    ),
    check(
      'documents_visibility_check',
      sql`${table.visibility} IS NULL OR ${table.visibility} IN ('public', 'team', 'private')`,
    ),
    index('documents_path_binary_idx').on(sql`${table.path} COLLATE BINARY`),
    index('documents_parent_deleted_idx').on(table.parentId, table.deletedAt),
    index('documents_workspace_deleted_updated_idx').on(
      table.workspaceId,
      table.deletedAt,
      table.updatedAt,
    ),
    index('documents_created_by_deleted_updated_idx').on(
      table.createdBy,
      table.deletedAt,
      table.updatedAt,
    ),
  ],
)

export const documentVersions = sqliteTable(
  'document_versions',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    versionNumber: integer('version_number').notNull(),
    objectKey: text('object_key').notNull(),
    contentHash: text('content_hash').notNull(),
    fileSize: integer('file_size').notNull(),
    createdAt: text('created_at').notNull(),
    createdByAccountId: text('created_by_account_id')
      .notNull()
      .references(() => accounts.id),
    createdByApiKeyId: text('created_by_api_key_id').references(() => apiKeys.id),
    userAgent: text('user_agent'),
    cliVersion: text('cli_version'),
    gitBranch: text('git_branch'),
    gitCommitSha: text('git_commit_sha'),
    gitCommitSubject: text('git_commit_subject'),
    gitDirty: integer('git_dirty'),
    originalFilename: text('original_filename'),
    hasInlineScript: integer('has_inline_script').notNull(),
    externalImageHosts: text('external_image_hosts'),
    stylesheetRefs: text('stylesheet_refs'),
    ciRunUrl: text('ci_run_url'),
    ciActor: text('ci_actor'),
    idempotencyKey: text('idempotency_key'),
    requestHash: text('request_hash'),
  },
  (table) => [
    uniqueIndex('document_versions_object_key_unique').on(table.objectKey),
    unique('document_versions_document_number_unique').on(
      table.documentId,
      table.versionNumber,
    ),
    unique('document_versions_api_key_idempotency_unique').on(
      table.createdByApiKeyId,
      table.idempotencyKey,
    ),
    check(
      'document_versions_git_dirty_check',
      sql`${table.gitDirty} IS NULL OR ${table.gitDirty} IN (0, 1)`,
    ),
    check(
      'document_versions_has_inline_script_check',
      sql`${table.hasInlineScript} IN (0, 1)`,
    ),
  ],
)

export const documentShares = sqliteTable(
  'document_shares',
  {
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    email: text('email').notNull(),
    createdByAccountId: text('created_by_account_id')
      .notNull()
      .references(() => accounts.id),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.email] }),
    index('document_shares_email_idx').on(table.email),
  ],
)

export const deletionBatches = sqliteTable('deletion_batches', {
  id: text('id').primaryKey(),
  rootDocumentId: text('root_document_id')
    .notNull()
    .references((): AnySQLiteColumn => documents.id),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id),
  createdAt: text('created_at').notNull(),
  restoredAt: text('restored_at'),
  deletedCount: integer('deleted_count').notNull(),
})

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    createdBy: text('created_by')
      .notNull()
      .references(() => accounts.id),
    slug: text('slug').notNull(),
    ext: text('ext').notNull(),
    currentVersionId: text('current_version_id'),
    nextVersionNumber: integer('next_version_number').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    uniqueIndex('assets_slug_unique').on(table.slug),
    check(
      'assets_slug_check',
      sql`length(${table.slug}) BETWEEN 1 AND 64 AND ${table.slug} GLOB '[a-z0-9]*' AND ${table.slug} NOT GLOB '*[^a-z0-9-]*'`,
    ),
    check('assets_ext_check', sql`${table.ext} IN ('css', 'woff2')`),
  ],
)

export const assetVersions = sqliteTable(
  'asset_versions',
  {
    id: text('id').primaryKey(),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id),
    versionNumber: integer('version_number').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    contentHash: text('content_hash').notNull(),
    fileSize: integer('file_size').notNull(),
    createdAt: text('created_at').notNull(),
    createdByApiKeyId: text('created_by_api_key_id').references(() => apiKeys.id),
  },
  (table) => [
    uniqueIndex('asset_versions_object_key_unique').on(table.objectKey),
    unique('asset_versions_asset_number_unique').on(
      table.assetId,
      table.versionNumber,
    ),
  ],
)

export const uploadEvents = sqliteTable(
  'upload_events',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').references(() => documents.id),
    documentVersionId: text('document_version_id').references(
      () => documentVersions.id,
    ),
    accountId: text('account_id').references(() => accounts.id),
    apiKeyId: text('api_key_id').references(() => apiKeys.id),
    eventType: text('event_type').notNull(),
    metadataJson: text('metadata_json'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('upload_events_document_created_idx').on(
      table.documentId,
      table.createdAt,
    ),
  ],
)

/**
 * Ephemeral rows used inside D1 batches. Inserting ok=0 raises a CHECK
 * constraint so a failed publication or document guard rolls back the batch.
 */
export const publicationGuards = sqliteTable(
  'publication_guards',
  {
    id: text('id').primaryKey(),
    ok: integer('ok').notNull(),
  },
  (table) => [
    check('publication_guards_ok_check', sql`${table.ok} = 1`),
  ],
)
