import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type SQLiteColumn,
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
      sql`${t.kind} in ('linked', 'takeover', 'email_kept', 'signed_out_everywhere', 'key_created', 'key_revoked', 'deleted', 'returned')`,
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
    /** The node the key is limited to; null reaches the whole account. */
    scopeNodeId: text('scope_node_id').references(() => nodes.id),
    readOnly: integer('read_only', { mode: 'boolean' })
      .notNull()
      .default(false),
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

// Workspaces and trees.

/** Lowercase letters, digits and hyphens, 1 to 63, not starting with '-'. */
const nameRule = (c: SQLiteColumn) =>
  sql`length(${c}) between 1 and 63 and ${c} not glob '*[^a-z0-9-]*' and ${c} not glob '-*'`

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    /** In links; never 'api' or 'cli'. */
    name: text('name').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: integer('created_at').notNull(),
    suspendedAt: integer('suspended_at'),
    /** The name stays taken. */
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    uniqueIndex('workspaces_name_unique').on(t.name),
    check(
      'workspaces_name_check',
      sql`${nameRule(t.name)} and ${t.name} not in ('api', 'cli')`,
    ),
  ],
)

export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: integer('created_at').notNull(),
    /** Set by a trigger from grant_clock when the row is written or its role changes. */
    grantOrder: integer('grant_order'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('workspace_members_user_idx').on(t.userId),
    check(
      'workspace_members_role_check',
      sql`${t.role} in ('admin', 'member')`,
    ),
  ],
)

/** A workspace's teams: shares to a team reach its members. */
export const teams = sqliteTable(
  'teams',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** Shown as typed, trimmed; unique in the workspace whatever its case. */
    name: text('name').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('teams_workspace_name_unique').on(
      t.workspaceId,
      sql`lower(${t.name})`,
    ),
    check(
      'teams_name_check',
      sql`length(${t.name}) between 1 and 60 and ${t.name} = trim(${t.name})`,
    ),
  ],
)

export const teamMembers = sqliteTable(
  'team_members',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    /** Set by a trigger from grant_clock when the row is written. */
    grantOrder: integer('grant_order'),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index('team_members_user_idx').on(t.userId),
  ],
)

/** An email an admin invited; it becomes a membership at sign-in. */
export const invitations = sqliteTable(
  'invitations',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    /** Lower-cased; matched against the person's current email. */
    email: text('email').notNull(),
    /** The teams the person joins with it. */
    teamIdsJson: text('team_ids_json').notNull().default('[]'),
    invitedBy: text('invited_by')
      .notNull()
      .references(() => user.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.email] }),
    index('invitations_email_idx').on(t.email),
  ],
)

/** What super admins saved; absent keys read as the defaults. */
export const deploymentSettings = sqliteTable(
  'deployment_settings',
  {
    key: text('key').primaryKey(),
    valueJson: text('value_json').notNull(),
    updatedBy: text('updated_by').references(() => user.id),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check(
      'deployment_settings_key_check',
      sql`${t.key} in ('workspace_creation', 'limits', 'retention_days')`,
    ),
  ],
)

/** The listed people who may create workspaces: emails and domains. */
export const workspaceCreators = sqliteTable(
  'workspace_creators',
  {
    /** 'sara@acme.com' or 'acme.com', lower-cased. */
    entry: text('entry').primaryKey(),
    kind: text('kind').notNull(),
    addedBy: text('added_by')
      .notNull()
      .references(() => user.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    check(
      'workspace_creators_kind_check',
      sql`${t.kind} in ('email', 'domain')`,
    ),
  ],
)

export const trees = sqliteTable(
  'trees',
  {
    /** Stable through moves; 20 of a-z 0-9, a DNS label of the content host. */
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    /** Written in the same batch as the root node. */
    rootNodeId: text('root_node_id').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    /** +1 per change to authored files; frame URLs pin it. */
    authoredSeq: integer('authored_seq').notNull().default(0),
    /** +1 per event. */
    eventSeq: integer('event_seq').notNull().default(0),
    /** Push numbers count per tree. */
    pushCount: integer('push_count').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    uniqueIndex('trees_workspace_name_unique')
      .on(t.workspaceId, t.name)
      .where(sql`${t.deletedAt} is null`),
    check('trees_name_check', nameRule(t.name)),
    check(
      'trees_id_check',
      sql`length(${t.id}) = 20 and ${t.id} not glob '*[^a-z0-9]*'`,
    ),
  ],
)

export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    treeId: text('tree_id')
      .notNull()
      .references(() => trees.id),
    /** Null only for the root. */
    parentId: text('parent_id'),
    /** '' for the root. */
    name: text('name').notNull(),
    /** '' for the root, 'a/b.html' below; written only by creation and move. */
    path: text('path').notNull(),
    /** 0 for the root, at most 32. */
    depth: integer('depth').notNull(),
    kind: text('kind').notNull(),
    origin: text('origin').notNull(),
    /** Data nodes written by one person. */
    ownerId: text('owner_id').references(() => user.id),
    /** Files only. */
    currentVersionId: text('current_version_id'),
    createdAt: integer('created_at').notNull(),
    deletedAt: integer('deleted_at'),
    /**
     * The folder where the path's `_` part starts: '' for '_x…', 'a/b' for
     * 'a/b/_x…', null when no segment starts with '_'. Read by Access, so
     * the `_` files a readable node reaches are readable in SQL too.
     */
    underscoreFrom: text('underscore_from').generatedAlwaysAs(
      sql`case
    when substr(path, 1, 1) = '_' then ''
    when instr(path, '/_') > 0 then substr(path, 1, instr(path, '/_') - 1)
    else null end`,
      { mode: 'virtual' },
    ),
  },
  (t) => [
    uniqueIndex('nodes_live_path_unique')
      .on(t.treeId, t.path)
      .where(sql`${t.deletedAt} is null`),
    index('nodes_tree_path_idx').on(t.treeId, t.path),
    index('nodes_parent_idx').on(t.parentId),
    check('nodes_kind_check', sql`${t.kind} in ('folder', 'file')`),
    check('nodes_origin_check', sql`${t.origin} in ('authored', 'data')`),
    check(
      'nodes_owner_check',
      sql`${t.origin} = 'data' or ${t.ownerId} is null`,
    ),
    check('nodes_depth_check', sql`${t.depth} between 0 and 32`),
  ],
)

export const nodeVersions = sqliteTable(
  'node_versions',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id),
    treeId: text('tree_id')
      .notNull()
      .references(() => trees.id),
    /** 1, 2, 3 … per node. */
    revision: integer('revision').notNull(),
    /** The tree's authored_seq this version took effect at; null for data. */
    authoredSeq: integer('authored_seq'),
    /** A deletion is a new version in state 'deleted' with no content. */
    state: text('state').notNull(),
    blobSha256: text('blob_sha256').references(() => blobs.sha256),
    /** JSON data files, at most 1 MiB. */
    jsonValue: text('json_value'),
    size: integer('size'),
    contentType: text('content_type'),
    authorId: text('author_id')
      .notNull()
      .references(() => user.id),
    keyId: text('key_id').references(() => agentKeys.id),
    pushId: text('push_id').references(() => pushes.id),
    /** Data versions: the push the writer saw. */
    seenPushNumber: integer('seen_push_number'),
    /** Data versions. */
    opId: text('op_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('node_versions_node_revision_unique').on(t.nodeId, t.revision),
    index('node_versions_node_seq_idx').on(t.nodeId, t.authoredSeq),
    index('node_versions_tree_seq_idx').on(t.treeId, t.authoredSeq),
    index('node_versions_blob_idx').on(t.blobSha256),
    index('node_versions_push_idx').on(t.pushId),
    check(
      'node_versions_state_check',
      sql`${t.state} in ('live', 'deleted', 'withdrawn')`,
    ),
    check(
      'node_versions_content_check',
      sql`case when ${t.state} = 'live'
    then (${t.blobSha256} is null) <> (${t.jsonValue} is null)
    else ${t.blobSha256} is null and ${t.jsonValue} is null end`,
    ),
  ],
)

export const pushes = sqliteTable(
  'pushes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    treeName: text('tree_name').notNull(),
    /** Null while the push would create its tree. */
    treeId: text('tree_id').references(() => trees.id),
    /** The pushed folder inside the tree, '' for the root. */
    path: text('path').notNull(),
    /** Null with --force, or when the folder saw nothing there. */
    baseSeq: integer('base_seq'),
    /** Set at commit. */
    number: integer('number'),
    message: text('message'),
    force: integer('force', { mode: 'boolean' }).notNull().default(false),
    authorId: text('author_id')
      .notNull()
      .references(() => user.id),
    keyId: text('key_id').references(() => agentKeys.id),
    state: text('state').notNull(),
    fileCount: integer('file_count').notNull(),
    byteCount: integer('byte_count').notNull(),
    createdAt: integer('created_at').notNull(),
    /** A day after staging. */
    expiresAt: integer('expires_at').notNull(),
    committedAt: integer('committed_at'),
  },
  (t) => [
    uniqueIndex('pushes_tree_number_unique').on(t.treeId, t.number),
    index('pushes_state_expires_idx').on(t.state, t.expiresAt),
    check(
      'pushes_state_check',
      sql`${t.state} in ('staged', 'committed', 'expired')`,
    ),
  ],
)

/** The staged manifest; the commit reads it set-wise. */
export const pushFiles = sqliteTable(
  'push_files',
  {
    pushId: text('push_id')
      .notNull()
      .references(() => pushes.id, { onDelete: 'cascade' }),
    /** Inside the tree. */
    path: text('path').notNull(),
    parentPath: text('parent_path').notNull(),
    name: text('name').notNull(),
    depth: integer('depth').notNull(),
    sha256: text('sha256').notNull(),
    size: integer('size').notNull(),
    contentType: text('content_type').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pushId, t.path] })],
)

export const pushFolders = sqliteTable(
  'push_folders',
  {
    pushId: text('push_id')
      .notNull()
      .references(() => pushes.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    parentPath: text('parent_path').notNull(),
    name: text('name').notNull(),
    depth: integer('depth').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pushId, t.path] })],
)

/** Bytes in R2 at blobs/<sha256>; their life is owned by the tree store. */
export const blobs = sqliteTable(
  'blobs',
  {
    sha256: text('sha256').primaryKey(),
    size: integer('size').notNull(),
    /** Versions that point at it. */
    refCount: integer('ref_count').notNull().default(0),
    state: text('state').notNull().default('live'),
    firstSeenAt: integer('first_seen_at').notNull(),
    reclaimStartedAt: integer('reclaim_started_at'),
  },
  (t) => [
    check('blobs_state_check', sql`${t.state} in ('live', 'reclaiming')`),
  ],
)

/**
 * A change in progress holding a blob until it commits. A hold is taken
 * before the bytes are written, so a purge never removes a blob an upload
 * is filling, and counts for a commit only once the bytes are verified.
 */
export const blobHolds = sqliteTable(
  'blob_holds',
  {
    /** push, upload, restore or move. */
    holderKind: text('holder_kind').notNull(),
    holderId: text('holder_id').notNull(),
    sha256: text('sha256')
      .notNull()
      .references(() => blobs.sha256),
    /** False while an upload is writing the bytes; true once they match. */
    verified: integer('verified', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.holderKind, t.holderId, t.sha256] }),
    index('blob_holds_sha_idx').on(t.sha256),
    check(
      'blob_holds_kind_check',
      sql`${t.holderKind} in ('push', 'restore', 'upload', 'move')`,
    ),
  ],
)

/** An HTML file's analysis, stored by blob hash when it is uploaded. */
export const analyses = sqliteTable(
  'analyses',
  {
    sha256: text('sha256').notNull(),
    /** 'html'. */
    analyzer: text('analyzer').notNull(),
    version: integer('version').notNull(),
    json: text('json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sha256, t.analyzer, t.version] })],
)

export const shares = sqliteTable(
  'shares',
  {
    id: text('id').primaryKey(),
    treeId: text('tree_id')
      .notNull()
      .references(() => trees.id),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id),
    targetKind: text('target_kind').notNull(),
    /** Lower-cased email, team id, workspace id, or '*'. */
    target: text('target').notNull(),
    role: text('role').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: integer('created_at').notNull(),
    /** Set by a trigger from grant_clock when the row is written or its role changes. */
    grantOrder: integer('grant_order'),
  },
  (t) => [
    uniqueIndex('shares_node_target_unique').on(
      t.nodeId,
      t.targetKind,
      t.target,
    ),
    index('shares_tree_idx').on(t.treeId),
    index('shares_target_idx').on(t.targetKind, t.target),
    check(
      'shares_target_kind_check',
      sql`${t.targetKind} in ('email', 'team', 'workspace', 'anyone')`,
    ),
    check('shares_role_check', sql`${t.role} in ('read', 'respond', 'write')`),
  ],
)

/** The literals of EventTypeSchema; a test keeps them equal. */
export const EVENT_TYPES_SQL = sql`'push', 'delete', 'restore', 'move', 'submission', 'entry', 'withdrawal', 'data_write', 'comment', 'mention', 'share'`

export const events = sqliteTable(
  'events',
  {
    treeId: text('tree_id')
      .notNull()
      .references(() => trees.id),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    nodeId: text('node_id'),
    path: text('path').notNull(),
    /** Null where the event hides its actor. */
    actorId: text('actor_id').references(() => user.id),
    pushId: text('push_id').references(() => pushes.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.treeId, t.seq] }),
    check('events_type_check', sql`${t.type} in (${EVENT_TYPES_SQL})`),
  ],
)

/** Replay of data writes, by operation id. */
export const operations = sqliteTable(
  'operations',
  {
    /** A person's id, or 'anon:<session>'. */
    principal: text('principal').notNull(),
    /** '<tree id>:<target folder or file path>'. */
    scope: text('scope').notNull(),
    opId: text('op_id').notNull(),
    resultNodeId: text('result_node_id'),
    resultVersionId: text('result_version_id'),
    resultState: text('result_state').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.principal, t.scope, t.opId] }),
    check(
      'operations_result_state_check',
      sql`${t.resultState} in ('stored', 'withdrawn')`,
    ),
  ],
)

/** A failed guard row aborts the whole batch it is part of. */
export const changeGuards = sqliteTable(
  'change_guards',
  {
    id: text('id').notNull(),
    reason: text('reason').notNull(),
    ok: integer('ok'),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.reason] }),
    check('change_guard_head', sql`${t.reason} <> 'head' or ${t.ok} = 1`),
    check('change_guard_basis', sql`${t.reason} <> 'basis' or ${t.ok} = 1`),
    check('change_guard_blob', sql`${t.reason} <> 'blob' or ${t.ok} = 1`),
    check('change_guard_state', sql`${t.reason} <> 'state' or ${t.ok} = 1`),
    check(
      'change_guard_mergeable',
      sql`${t.reason} <> 'mergeable' or ${t.ok} = 1`,
    ),
    check('change_guard_size', sql`${t.reason} <> 'size' or ${t.ok} = 1`),
    check('change_guard_admins', sql`${t.reason} <> 'admins' or ${t.ok} = 1`),
    check('change_guard_storage', sql`${t.reason} <> 'storage' or ${t.ok} = 1`),
  ],
)

// Forms.

/**
 * A form's rules, stored by the version of the page or layout that holds
 * it, so a send is checked against the form as the person saw it.
 */
export const forms = sqliteTable(
  'forms',
  {
    /** The page or layout version. */
    hostVersionId: text('host_version_id')
      .notNull()
      .references(() => nodeVersions.id),
    hostNodeId: text('host_node_id')
      .notNull()
      .references(() => nodes.id),
    treeId: text('tree_id')
      .notNull()
      .references(() => trees.id),
    /** A tree path: 'answers/' for a folder, 'decisions.json' for a file. */
    targetPath: text('target_path').notNull(),
    /** The form's id, or '' when it has none. */
    formKey: text('form_key').notNull(),
    kind: text('kind').notNull(),
    /** From data-closes, epoch ms. */
    closesAt: integer('closes_at'),
    /** data-closed. */
    closed: integer('closed', { mode: 'boolean' }).notNull(),
    line: integer('line').notNull(),
    /** The legend of its first fieldset, or its aria-label. */
    title: text('title'),
    /** FormSchema as JSON. */
    schemaJson: text('schema_json').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.hostVersionId, t.targetPath, t.formKey] }),
    index('forms_tree_target_idx').on(t.treeId, t.targetPath),
    index('forms_host_node_idx').on(t.hostNodeId),
    check(
      'forms_kind_check',
      sql`${t.kind} in ('person', 'entries', 'shared')`,
    ),
  ],
)

/** A push's forms, staged before the commit writes them set-wise. */
export const pushForms = sqliteTable(
  'push_forms',
  {
    pushId: text('push_id')
      .notNull()
      .references(() => pushes.id, { onDelete: 'cascade' }),
    /** The page or layout inside the tree. */
    path: text('path').notNull(),
    targetPath: text('target_path').notNull(),
    formKey: text('form_key').notNull(),
    kind: text('kind').notNull(),
    closesAt: integer('closes_at'),
    closed: integer('closed', { mode: 'boolean' }).notNull(),
    line: integer('line').notNull(),
    title: text('title'),
    schemaJson: text('schema_json').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pushId, t.path, t.targetPath, t.formKey] })],
)

// Viewing pages.

/**
 * A view handle: what a tree's frames carry in their path, since a content
 * host reads no cookie. The handle itself is never stored.
 */
export const viewHandles = sqliteTable(
  'view_handles',
  {
    /** Hex SHA-256 of the handle. */
    hashSha256: text('hash_sha256').primaryKey(),
    /** Bumped when an expired handle is replaced. */
    generation: integer('generation').notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => session.id, {
      onDelete: 'cascade',
    }),
    /** Visitors' handles. */
    anonSessionId: text('anon_session_id'),
    treeId: text('tree_id')
      .notNull()
      .references(() => trees.id),
    /** 24 hours after the last renewal. */
    expiresAt: integer('expires_at').notNull(),
    renewedAt: integer('renewed_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('view_handles_session_tree_unique').on(t.sessionId, t.treeId),
    index('view_handles_expires_idx').on(t.expiresAt),
    check(
      'view_handles_owner_check',
      sql`(${t.sessionId} is null) <> (${t.anonSessionId} is null)`,
    ),
  ],
)

/**
 * The nodes a view issued to a handle at a sequence: the page or file it
 * opened and the files the page loads. At an older sequence, a frame without
 * write opens only these, or files unchanged since.
 */
export const viewHandleNodes = sqliteTable(
  'view_handle_nodes',
  {
    handleHash: text('handle_hash')
      .notNull()
      .references(() => viewHandles.hashSha256, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.handleHash, t.seq, t.nodeId] })],
)

/**
 * When a sequence was first issued to a handle, in grant order: grants with
 * an order at or below it existed then. Written once, never moved.
 */
export const viewHandleFirsts = sqliteTable(
  'view_handle_firsts',
  {
    handleHash: text('handle_hash')
      .notNull()
      .references(() => viewHandles.hashSha256, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    grantOrder: integer('grant_order').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.handleHash, t.seq] })],
)

/**
 * One row counting grant writes in commit order. Triggers on shares and
 * workspace members move it in the transaction that writes the grant.
 */
export const grantClock = sqliteTable(
  'grant_clock',
  {
    id: integer('id').primaryKey(),
    value: integer('value').notNull(),
  },
  (t) => [check('grant_clock_one_row', sql`${t.id} = 1`)],
)

/** Who opened a page, and about when they last did. */
export const seenBy = sqliteTable(
  'seen_by',
  {
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Trails the last open by up to an hour. */
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.userId] })],
)

/** One row per counted key, over a fixed one-minute window. */
export const rateCounters = sqliteTable('rate_counters', {
  /** 'push:<agent key id>', 'send:<person id or anon:<session>>'. */
  key: text('key').primaryKey(),
  /** The minute, epoch ms. */
  windowStart: integer('window_start').notNull(),
  count: integer('count').notNull(),
})
