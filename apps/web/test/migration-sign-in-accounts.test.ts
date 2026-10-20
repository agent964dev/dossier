// The migration that gives sign-in accounts provider-neutral names, run on a
// database seeded in the shape every earlier migration left. DB already has
// every migration, so this file seeds MIGRATION_DB, an empty database.
import type { PersonId, SessionId } from '@dossier/contracts'
import { applyD1Migrations, type D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { beforeAll, describe, expect, it } from 'vitest'

import { SignIn, type Caller } from '../src/core/index.ts'
import { testRuntime, withRuntime } from './support/harness.ts'
import { runAs } from './support/people.ts'

const RENAME = '0029_sign_in_accounts.sql'
const db = env.MIGRATION_DB

const numberOf = (migration: D1Migration) =>
  Number.parseInt(migration.name.split('_')[0] ?? '', 10)

const earlier = env.TEST_MIGRATIONS.filter((m) => numberOf(m) < 29)

const renameMigration = (): D1Migration => {
  const found = env.TEST_MIGRATIONS.find((m) => m.name === RENAME)
  if (found === undefined) {
    throw new Error(
      `The migration ${RENAME} is missing from apps/web/drizzle, so the old shape cannot be migrated`,
    )
  }
  return found
}

const all = async <T = Record<string, unknown>>(
  query: string,
  ...binds: unknown[]
): Promise<T[]> =>
  (
    await db
      .prepare(query)
      .bind(...binds)
      .all<T>()
  ).results

const run = (query: string, ...binds: unknown[]) =>
  db
    .prepare(query)
    .bind(...binds)
    .run()

const columnsOf = async (table: string) =>
  (await all<{ name: string }>(`select name from pragma_table_info(?)`, table))
    .map((c) => c.name)
    .sort()

const exists = async (type: 'table' | 'index' | 'trigger', name: string) =>
  (
    await all(
      'select 1 from sqlite_master where type = ? and name = ?',
      type,
      name,
    )
  ).length === 1

/** Renames one key of every row, as the migration renames a column. */
const renamed = (
  rows: readonly Record<string, unknown>[],
  from: string,
  to: string,
) => rows.map(({ [from]: value, ...rest }) => ({ ...rest, [to]: value }))

// Every kind person history could hold before the migration.
const OLD_KINDS = [
  'linked',
  'takeover',
  'email_kept',
  'signed_out_everywhere',
  'key_created',
  'key_revoked',
  'deleted',
  'returned',
]

/** One person with two Google accounts, and one more person, in the old shape. */
const seedOldShape = async () => {
  const at = 1_760_000_000_000
  await db.batch([
    db
      .prepare(
        'insert into "user" (id, name, email, email_verified, image, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'u-lina',
        'Lina',
        'lina@acme.test',
        1,
        'https://img.test/lina',
        at,
        at,
      ),
    db
      .prepare(
        'insert into "user" (id, name, email, email_verified, image, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind('u-omar', 'Omar', 'omar@gmail.com', 1, null, at, at),
    db
      .prepare(
        'insert into account (id, user_id, provider_id, account_id, id_token, scope, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'a-lina-work',
        'u-lina',
        'google',
        'sub-1',
        'tok-1',
        'openid email',
        at,
        at,
      ),
    db
      .prepare(
        'insert into account (id, user_id, provider_id, account_id, id_token, scope, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'a-lina-old',
        'u-lina',
        'google',
        'sub-2',
        null,
        'openid email',
        at + 1,
        at + 1,
      ),
    db
      .prepare(
        'insert into account (id, user_id, provider_id, account_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
      )
      .bind('a-omar', 'u-omar', 'google', 'sub-3', at, at),
    db
      .prepare(
        'insert into people (user_id, email_authority, first_sign_in_at, last_sign_in_at, deleted_at) values (?, ?, ?, ?, ?)',
      )
      .bind('u-lina', 'google', at, at + 5, null),
    db
      .prepare(
        'insert into people (user_id, email_authority, first_sign_in_at, last_sign_in_at, deleted_at) values (?, ?, ?, ?, ?)',
      )
      .bind('u-omar', 'none', at, at, at + 9),
    db
      .prepare(
        'insert into google_accounts (account_id, email, email_authority, hosted_domain, observed_at) values (?, ?, ?, ?, ?)',
      )
      .bind('a-lina-work', 'lina@acme.test', 'google', 'acme.test', at + 2),
    db
      .prepare(
        'insert into google_accounts (account_id, email, email_authority, hosted_domain, observed_at) values (?, ?, ?, ?, ?)',
      )
      .bind('a-lina-old', 'lina@acme.test', 'none', null, at + 3),
    db
      .prepare(
        'insert into google_accounts (account_id, email, email_authority, hosted_domain, observed_at) values (?, ?, ?, ?, ?)',
      )
      .bind('a-omar', 'omar@gmail.com', 'google', null, at + 4),
    ...OLD_KINDS.map((kind, index) =>
      db
        .prepare(
          'insert into person_history (id, user_id, kind, detail_json, created_at) values (?, ?, ?, ?, ?)',
        )
        .bind(
          `h-${kind}`,
          'u-lina',
          kind,
          JSON.stringify({ kind, index }),
          at + index,
        ),
    ),
    db
      .prepare(
        'insert into session (id, user_id, token, expires_at, ip_address, user_agent, google_account_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        's-work',
        'u-lina',
        'token-work',
        at + 1e9,
        '198.51.100.1',
        'browser',
        'a-lina-work',
        at,
        at,
      ),
    db
      .prepare(
        'insert into session (id, user_id, token, expires_at, ip_address, user_agent, google_account_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        's-old',
        'u-lina',
        'token-old',
        at + 1e9,
        null,
        null,
        'a-lina-old',
        at,
        at,
      ),
    db
      .prepare(
        'insert into session (id, user_id, token, expires_at, ip_address, user_agent, google_account_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        's-omar',
        'u-omar',
        'token-omar',
        at + 1e9,
        null,
        null,
        'a-omar',
        at,
        at,
      ),
    db
      .prepare(
        'insert into agent_keys (id, user_id, name, hash_sha256, created_via, google_account_id, last_used_at, revoked_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'k-work',
        'u-lina',
        'laptop',
        'hash-work',
        'settings',
        'a-lina-work',
        at + 6,
        null,
        at,
      ),
    db
      .prepare(
        'insert into agent_keys (id, user_id, name, hash_sha256, created_via, google_account_id, last_used_at, revoked_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'k-old',
        'u-lina',
        'cli on m4',
        'hash-old',
        'device',
        'a-lina-old',
        null,
        at + 7,
        at,
      ),
    db
      .prepare(
        'insert into device_code (id, device_code, user_code, user_id, expires_at, status, client_id, scope, device_name, grant_kind, approved_by_google_account_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'd-approved',
        'device-1',
        'ABCD-EFGH',
        'u-lina',
        at + 600_000,
        'approved',
        'dossier-cli',
        'agent',
        'cli on m4',
        'dossier-agent-key',
        'a-lina-old',
      ),
    db
      .prepare(
        'insert into device_code (id, device_code, user_code, user_id, expires_at, status, client_id, scope, device_name, grant_kind, approved_by_google_account_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'd-pending',
        'device-2',
        'IJKL-MNOP',
        null,
        at + 600_000,
        'pending',
        'dossier-cli',
        'agent',
        'cli on m5',
        'dossier-agent-key',
        null,
      ),
  ])
}

const snapshot = async () => ({
  user: await all('select * from "user" order by id'),
  account: await all('select * from account order by id'),
  people: await all('select * from people order by user_id'),
  history: await all('select * from person_history order by id'),
  google: await all('select * from google_accounts order by account_id'),
  session: await all('select * from session order by id'),
  keys: await all('select * from agent_keys order by id'),
  devices: await all('select * from device_code order by id'),
})

let before: Awaited<ReturnType<typeof snapshot>>

beforeAll(async () => {
  await applyD1Migrations(db, earlier)
  await seedOldShape()
  before = await snapshot()
  await applyD1Migrations(db, [renameMigration()])
})

describe('the migration to provider-neutral sign-in account names', () => {
  it('keeps every person, account and history row as it was', async () => {
    expect(before.history.map((h) => h.kind).sort()).toEqual(
      [...OLD_KINDS].sort(),
    )
    expect(await all('select * from "user" order by id')).toEqual(before.user)
    expect(await all('select * from account order by id')).toEqual(
      before.account,
    )
    expect(await all('select * from people order by user_id')).toEqual(
      before.people,
    )
    expect(await all('select * from person_history order by id')).toEqual(
      before.history,
    )
    expect(await exists('index', 'person_history_user_idx')).toBe(true)
  })

  it('moves every Google account row to account_emails, its hosted domain now the organisation', async () => {
    expect(await exists('table', 'google_accounts')).toBe(false)
    expect(await columnsOf('account_emails')).toEqual([
      'account_id',
      'email',
      'email_authority',
      'observed_at',
      'organisation',
    ])
    expect(before.google).toHaveLength(3)
    expect(
      await all('select * from account_emails order by account_id'),
    ).toEqual(renamed(before.google, 'hosted_domain', 'organisation'))
    expect(
      await all(
        'select organisation from account_emails where account_id = ?',
        'a-lina-work',
      ),
    ).toEqual([{ organisation: 'acme.test' }])
  })

  it('keeps every session, agent key and device code, each naming its sign-in account', async () => {
    expect(await columnsOf('session')).toContain('sign_in_account_id')
    expect(await columnsOf('session')).not.toContain('google_account_id')
    expect(await all('select * from session order by id')).toEqual(
      renamed(before.session, 'google_account_id', 'sign_in_account_id'),
    )

    expect(await columnsOf('agent_keys')).toContain('created_by_account_id')
    expect(await columnsOf('agent_keys')).not.toContain('google_account_id')
    expect(await all('select * from agent_keys order by id')).toEqual(
      renamed(before.keys, 'google_account_id', 'created_by_account_id'),
    )

    expect(await columnsOf('device_code')).toContain('approved_by_account_id')
    expect(await columnsOf('device_code')).not.toContain(
      'approved_by_google_account_id',
    )
    expect(await all('select * from device_code order by id')).toEqual(
      renamed(
        before.devices,
        'approved_by_google_account_id',
        'approved_by_account_id',
      ),
    )
  })

  it('still refuses a session whose account is not attached to its person', async () => {
    const insert = (id: string, accountId: string | null) =>
      run(
        'insert into session (id, user_id, token, expires_at, sign_in_account_id) values (?, ?, ?, ?, ?)',
        id,
        'u-lina',
        `token-${id}`,
        Date.now() + 60_000,
        accountId,
      )
    // Omar's account does not belong to Lina; a missing one belongs to nobody.
    await expect(insert('s-foreign', 'a-omar')).rejects.toThrow(
      /session_account_detached/,
    )
    await expect(insert('s-none', null)).rejects.toThrow(
      /session_account_detached/,
    )
    await expect(insert('s-gone', 'a-nowhere')).rejects.toThrow(
      /session_account_detached/,
    )
    await insert('s-attached', 'a-lina-work')
    expect(
      await all(
        'select sign_in_account_id from session where id = ?',
        's-attached',
      ),
    ).toEqual([{ sign_in_account_id: 'a-lina-work' }])
  })

  it('takes the sessions of a deleted account with it, and only those', async () => {
    await run('delete from account where id = ?', 'a-lina-old')
    expect(
      await all(
        'select id from session where user_id = ? order by id',
        'u-lina',
      ),
    ).not.toContainEqual({ id: 's-old' })
    expect(
      await all(
        'select id from session where id in (?, ?) order by id',
        's-old',
        's-work',
      ),
    ).toEqual([{ id: 's-work' }])
    expect(
      await all(
        'select account_id from account_emails where account_id = ?',
        'a-lina-old',
      ),
    ).toEqual([])
  })

  it('accepts Microsoft as the email authority of a person and of an account', async () => {
    await run(
      'update people set email_authority = ? where user_id = ?',
      'microsoft',
      'u-omar',
    )
    expect(
      await all(
        'select email_authority from people where user_id = ?',
        'u-omar',
      ),
    ).toEqual([{ email_authority: 'microsoft' }])

    await run(
      'insert into account (id, user_id, provider_id, account_id) values (?, ?, ?, ?)',
      'a-omar-ms',
      'u-omar',
      'microsoft',
      'oid-1',
    )
    await run(
      'insert into account_emails (account_id, email, email_authority, organisation, observed_at) values (?, ?, ?, ?, ?)',
      'a-omar-ms',
      'omar@outlook.com',
      'microsoft',
      null,
      Date.now(),
    )
    expect(
      await all(
        'select email_authority from account_emails where account_id = ?',
        'a-omar-ms',
      ),
    ).toEqual([{ email_authority: 'microsoft' }])

    // The check is widened, not dropped.
    await expect(
      run(
        'update people set email_authority = ? where user_id = ?',
        'yahoo',
        'u-omar',
      ),
    ).rejects.toThrow(/CHECK constraint failed/)
    await expect(
      run(
        'update account_emails set email_authority = ? where account_id = ?',
        'yahoo',
        'a-omar-ms',
      ),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('lets person history record a disconnect, and still refuses an unknown kind', async () => {
    const insert = (id: string, kind: string) =>
      run(
        'insert into person_history (id, user_id, kind, detail_json, created_at) values (?, ?, ?, ?, ?)',
        id,
        'u-lina',
        kind,
        '{}',
        Date.now(),
      )
    await insert('h-disconnected', 'disconnected')
    expect(
      await all(
        'select kind from person_history where id = ?',
        'h-disconnected',
      ),
    ).toEqual([{ kind: 'disconnected' }])
    await expect(insert('h-unknown', 'renamed')).rejects.toThrow(
      /CHECK constraint failed/,
    )
  })

  it('disconnects a sign-in account whose rows came through the migration', async () => {
    const now = Date.now()
    // Lina signs in with Microsoft too, and opens Settings in that session.
    await db.batch([
      db
        .prepare(
          'insert into account (id, user_id, provider_id, account_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?)',
        )
        .bind('a-lina-ms', 'u-lina', 'microsoft', 'oid-lina', now, now),
      db
        .prepare(
          'insert into account_emails (account_id, email, email_authority, organisation, observed_at) values (?, ?, ?, ?, ?)',
        )
        .bind('a-lina-ms', 'lina@acme.test', 'microsoft', null, now),
      db
        .prepare(
          'insert into session (id, user_id, token, expires_at, sign_in_account_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          's-ms',
          'u-lina',
          'token-ms',
          now + 86_400_000,
          'a-lina-ms',
          now,
          now,
        ),
      // A CLI login the migrated work account approved, not yet redeemed.
      db.prepare(
        `update device_code set status = 'approved', user_id = 'u-lina', approved_by_account_id = 'a-lina-work' where id = 'd-pending'`,
      ),
    ])
    const caller: Caller = {
      person: {
        id: 'u-lina' as PersonId,
        email: 'lina@acme.test',
        name: 'Lina',
        image: 'https://img.test/lina',
      },
      via: { kind: 'browser', sessionId: 's-ms' as SessionId },
      requestId: 'test',
    }

    await withRuntime(testRuntime({ env: { DB: db } }), () =>
      runAs(
        caller,
        Effect.flatMap(SignIn, (signIn) =>
          signIn.disconnectSignInAccount('a-lina-work'),
        ),
      ),
    )

    expect(
      await all('select id from account where id = ?', 'a-lina-work'),
    ).toEqual([])
    expect(
      await all(
        'select account_id from account_emails where account_id = ?',
        'a-lina-work',
      ),
    ).toEqual([])
    expect(
      await all(
        'select id from session where sign_in_account_id = ?',
        'a-lina-work',
      ),
    ).toEqual([])
    expect(await all('select id from session where id = ?', 's-ms')).toEqual([
      { id: 's-ms' },
    ])
    const keys = await all<{ id: string; revoked_at: number | null }>(
      'select id, revoked_at from agent_keys where id in (?, ?) order by id',
      'k-old',
      'k-work',
    )
    expect(keys[0]).toEqual({ id: 'k-old', revoked_at: 1_760_000_000_007 })
    expect(keys[1]?.revoked_at).toEqual(expect.any(Number))
    expect(await all('select id, status from device_code order by id')).toEqual(
      [
        { id: 'd-approved', status: 'approved' },
        { id: 'd-pending', status: 'denied' },
      ],
    )
    const disconnected = await all<{ detail_json: string }>(
      `select detail_json from person_history where user_id = ? and kind = 'disconnected' and detail_json <> '{}'`,
      'u-lina',
    )
    expect(
      disconnected.map((row) => JSON.parse(row.detail_json) as unknown),
    ).toEqual([{ accountId: 'a-lina-work', provider: 'google' }])
    expect(
      await all('select user_id from people where user_id = ?', 'u-lina'),
    ).toEqual([{ user_id: 'u-lina' }])
  })
})
