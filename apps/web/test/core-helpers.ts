import { Layer as Layers } from 'effect'

import {
  AccessLive,
  AllowlistLive,
  AssetsLive,
  Db,
  type DbService,
  DocumentsLive,
  IdsLive,
  makeDb,
  makeObjects,
  Objects,
  type ObjectsService,
  PrincipalLive,
  PublishLive,
  PurgeLive,
  ServingLive,
  SharesLive,
  StateLive,
  TreeLive,
  SessionLayer,
  WorkerEnv,
} from '../src/services'

export const TEST_SECRET = 'test-session-secret-at-least-32-bytes'

export function testEnv(base: Cloudflare.Env): Cloudflare.Env {
  return {
    ...base,
    PUBLIC_BASE_URL: 'https://dossier.test',
    STYLE_HOST_ALLOWLIST: 'fonts.googleapis.com,fonts.gstatic.com',
    EMBED_HOST_ALLOWLIST: '',
    SCRIPT_HOST_ALLOWLIST: '',
    SHOO_BASE_URL: 'https://shoo.test',
    MAX_REQUEST_BYTES: '8388608',
    MAX_HTML_BYTES: '1048576',
    MAX_ASSET_BYTES: '5242880',
    PURGE_RETENTION_DAYS: '30',
    SEED_WORKSPACE: 'test:test.example',
    SEED_ADMIN_EMAIL: 'admin@test.example',
    SESSION_SECRET: TEST_SECRET,
    BOOTSTRAP_API_KEY: undefined,
    UPLOAD_RATE_LIMITER: { limit: async () => ({ success: true }) },
    STATE_RATE_LIMITER: { limit: async () => ({ success: true }) },
  } as unknown as Cloudflare.Env
}

export function makeCoreLayer(
  env: Cloudflare.Env,
  overrides: {
    readonly db?: DbService
    readonly objects?: ObjectsService
  } = {},
) {
  const environment = Layers.succeed(WorkerEnv, env)
  const foundation = Layers.mergeAll(
    environment,
    Layers.succeed(Db, overrides.db ?? makeDb(env.DB)),
    Layers.succeed(Objects, overrides.objects ?? makeObjects(env.OBJECTS)),
    IdsLive,
    SessionLayer(TEST_SECRET),
  )
  const principal = PrincipalLive.pipe(Layers.provide(foundation))
  const access = AccessLive.pipe(Layers.provide(foundation))
  const auth = Layers.mergeAll(foundation, principal, access)
  const assets = AssetsLive.pipe(Layers.provide(auth))
  const publish = PublishLive.pipe(Layers.provide(auth))
  const purge = PurgeLive.pipe(Layers.provide(auth))
  const documents = DocumentsLive.pipe(Layers.provide(auth))
  const serving = ServingLive.pipe(Layers.provide(auth))
  const shares = SharesLive.pipe(Layers.provide(auth))
  const state = StateLive.pipe(Layers.provide(auth))
  const tree = TreeLive.pipe(Layers.provide(auth))
  const allowlist = AllowlistLive.pipe(Layers.provide(foundation))
  return Layers.mergeAll(
    auth,
    assets,
    publish,
    purge,
    documents,
    serving,
    shares,
    state,
    tree,
    allowlist,
  )
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export interface SeedPrincipalOptions {
  readonly suffix: string
  readonly token?: string
  readonly role?: 'admin' | 'member' | null
  readonly accountKind?: 'user' | 'service'
  readonly revoked?: boolean
  readonly disabled?: boolean
  readonly email?: string
}

export async function seedPrincipal(
  env: Cloudflare.Env,
  options: SeedPrincipalOptions,
): Promise<{
  accountId: string
  workspaceId: string
  keyId: string
  token: string
}> {
  const suffix = options.suffix
  const accountId = `account_${suffix}`
  const workspaceId = `workspace_${suffix}`
  const keyId = `key_${suffix}`
  const token = options.token ?? `ds_test_${suffix}`
  const now = '2026-09-12T00:00:00.000Z'
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspaces
         (id, slug, kind, email_domain, name, created_at, updated_at)
       VALUES (?, ?, 'team', NULL, ?, ?, ?)`,
    ).bind(workspaceId, `ws-${suffix}`, `Workspace ${suffix}`, now, now),
    env.DB.prepare(
      `INSERT INTO accounts
         (id, name, kind, deployment_admin, disabled_at, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    ).bind(
      accountId,
      `Account ${suffix}`,
      options.accountKind ?? 'user',
      options.disabled ? now : null,
      now,
      now,
    ),
  ])
  if (options.role !== null) {
    await env.DB.prepare(
      `INSERT INTO memberships (workspace_id, account_id, role, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(workspaceId, accountId, options.role ?? 'member', now)
      .run()
  }
  if (options.email) {
    await env.DB.prepare(
      `INSERT INTO identities
         (id, account_id, provider, subject, email, email_verified,
          display_name, picture_url, pii_subject, created_at, last_login_at)
       VALUES (?, ?, 'shoo', ?, ?, 1, NULL, NULL, NULL, ?, ?)`,
    )
      .bind(
        `identity_${suffix}`,
        accountId,
        `subject_${suffix}`,
        options.email,
        now,
        now,
      )
      .run()
  }
  await env.DB.prepare(
    `INSERT INTO api_keys
       (id, account_id, workspace_id, name, key_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, 'Test key', ?, ?, NULL, ?)`,
  )
    .bind(
      keyId,
      accountId,
      workspaceId,
      await sha256(token),
      now,
      options.revoked ? now : null,
    )
    .run()
  return { accountId, workspaceId, keyId, token }
}
