// The one interface that removes rows and bytes. Only the purge (core/purge.ts)
// and the scheduled jobs (jobs/) import it, and every member needs a
// SystemJob in its context, which no request ever has. Review changes here by
// hand: everything below deletes.
import {
  dossierError,
  type DossierError,
  type Sha256,
} from '@dossier/contracts'
import { Clock, Context, Effect } from 'effect'

/** A job the Worker runs itself: a purge run, a webhook sweep, a delivery. */
export class SystemJob extends Context.Tag('SystemJob')<
  SystemJob,
  { readonly job: 'purge' | 'sweep' | 'deliver'; readonly runId: string }
>() {}

export interface PurgeCounts {
  readonly nodes: number
  readonly versions: number
  readonly trees: number
  readonly workspaces: number
  /** Keys scoped to a purged node, revoked with their scope cleared. */
  readonly keysRevoked: number
}

export interface SystemStore {
  /** Staged pushes past their expiry: expired, their files and holds gone. */
  readonly expireStagedPushes: (
    now: number,
    limit: number,
  ) => Effect.Effect<number, DossierError<'unavailable'>>
  /**
   * Nodes deleted before the cutoff, and the nodes of trees and workspaces
   * deleted before it, with everything that hangs off them, `limit` a run.
   */
  readonly purgeDeletedNodes: (
    cutoff: number,
    limit: number,
  ) => Effect.Effect<PurgeCounts, DossierError<'unavailable'>>
  /** Records past their life: operations, Seen by, views, handles, rates. */
  readonly purgeRecords: (
    cutoff: number,
    now: number,
  ) => Effect.Effect<
    Readonly<
      Record<
        'operations' | 'seenBy' | 'pageViews' | 'handles' | 'rates',
        number
      >
    >,
    DossierError<'unavailable'>
  >
  /**
   * Marks up to `limit` blobs nothing references and nothing holds as
   * reclaiming, `only` those hashes when given; the hashes it claimed.
   */
  readonly claimBlobs: (
    limit: number,
    only?: readonly Sha256[],
  ) => Effect.Effect<readonly Sha256[], DossierError<'unavailable'>>
  /** After the R2 delete: the blob's analyses and its row. */
  readonly finishBlob: (
    sha256: Sha256,
  ) => Effect.Effect<void, DossierError<'unavailable'>>
  /** Claims started before `olderThan`. */
  readonly staleClaims: (
    olderThan: number,
  ) => Effect.Effect<readonly Sha256[], DossierError<'unavailable'>>
  /** A claim whose bytes are still there goes back to live. */
  readonly releaseClaim: (
    sha256: Sha256,
  ) => Effect.Effect<void, DossierError<'unavailable'>>
}

/** Nodes one call removes at most: one batch. */
export const NODE_BATCH = 100

/** Rows of each kind of record one call removes at most. */
export const RECORD_BATCH = 2000

/**
 * The most D1 statements each member sends in one call, reads included, so a
 * caller can keep a run within its budget.
 */
export const SYSTEM_STATEMENTS = {
  expireStagedPushes: 6,
  purgeDeletedNodes: 13 + 18 + 11,
  purgeRecords: 7,
  claimBlobs: 1,
  finishBlob: 2,
  staleClaims: 1,
  releaseClaim: 1,
} as const

/** A day in milliseconds. */
const DAY = 24 * 60 * 60 * 1000

/**
 * The nodes of the batch `?1` (a JSON array of IDs) that go, as each
 * statement sees the database: still deleted before the cutoff `?2` (or in a
 * tree or workspace deleted before it), and with every child going in the
 * same batch. A node a restore made live again, or with a child that stays,
 * stays, and so does every node above it.
 */
const DOOMED_NODES = `with recursive
  ids(id) as (select value from json_each(?1)),
  stays(id) as (
    select n.id from nodes n join ids on ids.id = n.id
    where not (
        (n.deleted_at is not null and n.deleted_at < ?2)
        or exists (select 1 from trees t join workspaces w on w.id = t.workspace_id
          where t.id = n.tree_id and (t.deleted_at < ?2 or w.deleted_at < ?2)))
      or exists (select 1 from nodes c where c.parent_id = n.id
        and c.id not in (select id from ids))
    union
    select n.parent_id from nodes n join stays on stays.id = n.id
    where n.parent_id is not null
  ),
  doomed(id) as (
    select id from ids where id not in (select id from stays)
      and id in (select id from nodes)
  )`

/** The trees of the batch `?1` deleted before `?2` that have no node left. */
const DOOMED_TREES = `with doomed(id) as (
    select t.id from trees t join workspaces w on w.id = t.workspace_id
      join json_each(?1) j on j.value = t.id
    where (t.deleted_at < ?2 or w.deleted_at < ?2)
      and not exists (select 1 from nodes n where n.tree_id = t.id)
  )`

/**
 * The workspaces of the batch `?1` deleted before `?2`, not yet purged, that
 * have no tree left.
 */
const DOOMED_WORKSPACES = `with doomed(id) as (
    select w.id from workspaces w join json_each(?1) j on j.value = w.id
    where w.deleted_at < ?2 and w.purged_at is null
      and not exists (select 1 from trees t where t.workspace_id = w.id)
  )`

/** The staged pushes of the batch `?1` whose expiry `?2` has passed. */
const EXPIRED_PUSHES = `with doomed(id) as (
    select p.id from pushes p join json_each(?1) j on j.value = p.id
    where p.state = 'staged' and p.expires_at <= ?2
  )`

const ZERO = { nodes: 0, versions: 0, trees: 0, workspaces: 0, keysRevoked: 0 }

/** The store over the Worker's D1 and R2; reached through TreeStore.system. */
export const makeSystemStore = (bindings: Env): SystemStore => {
  const { DB } = bindings

  const query = <A>(what: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (error) => {
        console.error(`The purge could not ${what}`, error)
        return dossierError('unavailable')
      },
    })

  /** Each statement in one batch, bound to as many values as it names. */
  const batch = (
    what: string,
    statements: readonly { readonly sql: string; readonly binds: unknown[] }[],
  ) =>
    query(what, () =>
      DB.batch(
        statements.map((s) => {
          const highest = Math.max(
            0,
            ...[...s.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])),
          )
          return DB.prepare(s.sql).bind(...s.binds.slice(0, highest))
        }),
      ),
    ).pipe(Effect.map((results) => results.map((r) => r.meta.changes ?? 0)))

  const ids = (what: string, sql: string, ...binds: unknown[]) =>
    query(what, () =>
      DB.prepare(sql)
        .bind(...binds)
        .all<{ id: string }>(),
    ).pipe(Effect.map((rows) => rows.results.map((r) => r.id)))

  const expireStagedPushes: SystemStore['expireStagedPushes'] = (now, limit) =>
    Effect.gen(function* () {
      const found = yield* ids(
        'read expired pushes',
        `select id from pushes where state = 'staged' and expires_at <= ?
         order by expires_at limit ?`,
        now,
        limit,
      )
      if (found.length === 0) return 0
      const binds = [JSON.stringify(found), now]
      const changes = yield* batch('expire pushes', [
        {
          sql: `${EXPIRED_PUSHES} delete from blob_holds
                where holder_kind = 'push' and holder_id in (select id from doomed)`,
          binds,
        },
        ...['push_files', 'push_folders', 'push_forms'].map((table) => ({
          sql: `${EXPIRED_PUSHES} delete from ${table}
                where push_id in (select id from doomed)`,
          binds,
        })),
        {
          sql: `${EXPIRED_PUSHES} update pushes set state = 'expired'
                where id in (select id from doomed)`,
          binds,
        },
      ])
      return changes[4] ?? 0
    })

  /** One batch of deleted nodes, deepest first, with what hangs off them. */
  const nodeBatch = (cutoff: number, limit: number, now: number) =>
    Effect.gen(function* () {
      const found = yield* ids(
        'read deleted nodes',
        `select id from (
           select n.id, n.depth from nodes n where n.deleted_at < ?1
           union
           select n.id, n.depth from trees t join nodes n on n.tree_id = t.id
             where t.deleted_at < ?1
           union
           select n.id, n.depth from workspaces w
             join trees t on t.workspace_id = w.id
             join nodes n on n.tree_id = t.id
             where w.deleted_at < ?1
         ) order by depth desc, id limit ?2`,
        cutoff,
        Math.min(limit, NODE_BATCH),
      )
      if (found.length === 0) return ZERO
      const binds = [JSON.stringify(found), cutoff, now]
      const inDoomed = (column: string) =>
        `${column} in (select id from doomed)`
      const changes = yield* batch('remove deleted nodes', [
        {
          sql: `${DOOMED_NODES} delete from forms where ${inDoomed('host_node_id')}
                or host_version_id in (select id from node_versions
                  where ${inDoomed('node_id')})`,
          binds,
        },
        ...[
          'shares',
          'seen_by',
          'page_views',
          'path_aliases',
          'view_handle_nodes',
        ].map((table) => ({
          sql: `${DOOMED_NODES} delete from ${table} where ${inDoomed('node_id')}`,
          binds,
        })),
        {
          sql: `${DOOMED_NODES} delete from mentions
                where ${inDoomed('comment_node_id')} or ${inDoomed('page_node_id')}`,
          binds,
        },
        {
          sql: `${DOOMED_NODES} delete from operations
                where ${inDoomed('result_node_id')}`,
          binds,
        },
        {
          // One update, so no live key ever has its scope cleared, which
          // would widen it to the whole account.
          sql: `${DOOMED_NODES} update agent_keys
                set revoked_at = coalesce(revoked_at, ?3), scope_node_id = null
                where ${inDoomed('scope_node_id')}`,
          binds,
        },
        {
          sql: `${DOOMED_NODES} update blobs set ref_count = ref_count -
                  (select count(*) from node_versions v
                    where v.blob_sha256 = blobs.sha256 and ${inDoomed('v.node_id')})
                where sha256 in (select blob_sha256 from node_versions
                  where blob_sha256 is not null and ${inDoomed('node_id')})`,
          binds,
        },
        {
          sql: `${DOOMED_NODES} delete from node_versions where ${inDoomed('node_id')}`,
          binds,
        },
        {
          sql: `${DOOMED_NODES} delete from nodes where ${inDoomed('id')}`,
          binds,
        },
      ])
      return {
        ...ZERO,
        keysRevoked: changes[8] ?? 0,
        versions: changes[10] ?? 0,
        nodes: changes[11] ?? 0,
      }
    })

  /** Deleted trees with no node left: their rows of every kind, then them. */
  const treeBatch = (cutoff: number) =>
    Effect.gen(function* () {
      const found = yield* ids(
        'read deleted trees',
        `select t.id from trees t join workspaces w on w.id = t.workspace_id
         where (t.deleted_at < ?1 or w.deleted_at < ?1)
           and not exists (select 1 from nodes n where n.tree_id = t.id)
         order by t.id limit 20`,
        cutoff,
      )
      if (found.length === 0) return ZERO
      const binds = [JSON.stringify(found), cutoff]
      const byTree = (table: string) => ({
        sql: `${DOOMED_TREES} delete from ${table}
              where tree_id in (select id from doomed)`,
        binds,
      })
      const handles = `(select hash_sha256 from view_handles
        where tree_id in (select id from doomed))`
      const pushes = `(select id from pushes where tree_id in (select id from doomed))`
      const changes = yield* batch('remove deleted trees', [
        byTree('events'),
        byTree('mentions'),
        byTree('path_aliases'),
        byTree('tree_aliases'),
        byTree('page_needs'),
        byTree('forms'),
        byTree('shares'),
        {
          sql: `${DOOMED_TREES} delete from view_handle_nodes
                where handle_hash in ${handles}`,
          binds,
        },
        {
          sql: `${DOOMED_TREES} delete from view_handle_firsts
                where handle_hash in ${handles}`,
          binds,
        },
        byTree('view_handles'),
        {
          // Operation scopes are '<tree id>:<path>'.
          sql: `${DOOMED_TREES} delete from operations
                where substr(scope, 1, instr(scope, ':') - 1) in (select id from doomed)`,
          binds,
        },
        {
          sql: `${DOOMED_TREES} delete from blob_holds
                where holder_kind = 'push' and holder_id in ${pushes}`,
          binds,
        },
        ...['push_files', 'push_folders', 'push_forms'].map((table) => ({
          sql: `${DOOMED_TREES} delete from ${table} where push_id in ${pushes}`,
          binds,
        })),
        byTree('pushes'),
        {
          sql: `${DOOMED_TREES} delete from trees where id in (select id from doomed)`,
          binds,
        },
      ])
      return { ...ZERO, trees: changes[changes.length - 1] ?? 0 }
    })

  /**
   * Deleted workspaces with no tree left: memberships, teams, invitations
   * and pushes go; the row stays, marked purged, so the name stays taken.
   */
  const workspaceBatch = (cutoff: number, now: number) =>
    Effect.gen(function* () {
      const found = yield* ids(
        'read deleted workspaces',
        `select w.id from workspaces w
         where w.deleted_at < ?1 and w.purged_at is null
           and not exists (select 1 from trees t where t.workspace_id = w.id)
         order by w.id limit 20`,
        cutoff,
      )
      if (found.length === 0) return ZERO
      const binds = [JSON.stringify(found), cutoff, now]
      // A push of a tree that moved to another workspace stays with it.
      const pushes = `(select id from pushes
        where workspace_id in (select id from doomed)
          and (tree_id is null or tree_id not in (select id from trees)))`
      const changes = yield* batch('remove deleted workspaces', [
        {
          sql: `${DOOMED_WORKSPACES} delete from blob_holds
                where holder_kind = 'push' and holder_id in ${pushes}`,
          binds,
        },
        ...['push_files', 'push_folders', 'push_forms'].map((table) => ({
          sql: `${DOOMED_WORKSPACES} delete from ${table} where push_id in ${pushes}`,
          binds,
        })),
        {
          sql: `${DOOMED_WORKSPACES} delete from pushes where id in ${pushes}`,
          binds,
        },
        {
          sql: `${DOOMED_WORKSPACES} delete from team_members where team_id in
                  (select id from teams where workspace_id in (select id from doomed))`,
          binds,
        },
        ...['teams', 'invitations', 'workspace_members'].map((table) => ({
          sql: `${DOOMED_WORKSPACES} delete from ${table}
                where workspace_id in (select id from doomed)`,
          binds,
        })),
        {
          sql: `${DOOMED_WORKSPACES} update workspaces set purged_at = ?3
                where id in (select id from doomed)`,
          binds,
        },
      ])
      return { ...ZERO, workspaces: changes[changes.length - 1] ?? 0 }
    })

  const purgeDeletedNodes: SystemStore['purgeDeletedNodes'] = (cutoff, limit) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      // Nodes first; trees once their nodes are gone; workspaces last.
      const nodes = yield* nodeBatch(cutoff, limit, now)
      if (nodes.nodes > 0) return nodes
      const trees = yield* treeBatch(cutoff)
      if (trees.trees > 0) return { ...trees, keysRevoked: nodes.keysRevoked }
      const workspaces = yield* workspaceBatch(cutoff, now)
      return { ...workspaces, keysRevoked: nodes.keysRevoked }
    })

  const purgeRecords: SystemStore['purgeRecords'] = (cutoff, now) =>
    Effect.gen(function* () {
      const day = new Date(cutoff).toISOString().slice(0, 10)
      const older = (table: string, column: string) =>
        `delete from ${table} where rowid in
           (select rowid from ${table} where ${column} < ?1 limit ?2)`
      const expired = `with gone(hash) as (select hash_sha256 from view_handles
          where expires_at < ?1 order by hash_sha256 limit ?2)`
      const changes = yield* batch('remove old records', [
        {
          sql: older('operations', 'created_at'),
          binds: [cutoff, RECORD_BATCH],
        },
        {
          sql: older('seen_by', 'last_seen_at'),
          binds: [cutoff, RECORD_BATCH],
        },
        { sql: older('page_views', 'day'), binds: [day, RECORD_BATCH] },
        {
          sql: `${expired} delete from view_handle_nodes
                where handle_hash in (select hash from gone)`,
          binds: [now, RECORD_BATCH],
        },
        {
          sql: `${expired} delete from view_handle_firsts
                where handle_hash in (select hash from gone)`,
          binds: [now, RECORD_BATCH],
        },
        {
          sql: `${expired} delete from view_handles
                where hash_sha256 in (select hash from gone)`,
          binds: [now, RECORD_BATCH],
        },
        {
          sql: older('rate_counters', 'window_start'),
          binds: [now - DAY, RECORD_BATCH],
        },
      ])
      return {
        operations: changes[0] ?? 0,
        seenBy: changes[1] ?? 0,
        pageViews: changes[2] ?? 0,
        handles: changes[5] ?? 0,
        rates: changes[6] ?? 0,
      }
    })

  const claimBlobs: SystemStore['claimBlobs'] = (limit, only) =>
    Effect.gen(function* () {
      if (only !== undefined && only.length === 0) return []
      const now = yield* Clock.currentTimeMillis
      // Every hold is a guarded insert that needs a live row, and so is
      // every new reference: once claimed, nothing takes the blob back.
      const rows = yield* query('claim blobs', () =>
        DB.prepare(
          `update blobs set state = 'reclaiming', reclaim_started_at = ?1
           where sha256 in (
             select b.sha256 from blobs b
             where b.state = 'live' and b.ref_count <= 0
               and not exists (select 1 from blob_holds h where h.sha256 = b.sha256)
               and not exists (select 1 from node_versions v
                 where v.blob_sha256 = b.sha256)
               and (?3 is null or b.sha256 in (select value from json_each(?3)))
             limit ?2)
           returning sha256`,
        )
          .bind(now, limit, only === undefined ? null : JSON.stringify(only))
          .all<{ sha256: Sha256 }>(),
      )
      return rows.results.map((r) => r.sha256)
    })

  const finishBlob: SystemStore['finishBlob'] = (sha256) =>
    batch('finish a blob', [
      {
        sql: `delete from analyses where sha256 = ?1 and exists
                (select 1 from blobs where sha256 = ?1 and state = 'reclaiming')`,
        binds: [sha256],
      },
      {
        sql: `delete from blobs where sha256 = ?1 and state = 'reclaiming'`,
        binds: [sha256],
      },
    ]).pipe(Effect.asVoid)

  const staleClaims: SystemStore['staleClaims'] = (olderThan) =>
    query('read old claims', () =>
      DB.prepare(
        `select sha256 from blobs where state = 'reclaiming'
           and reclaim_started_at < ? order by reclaim_started_at limit 100`,
      )
        .bind(olderThan)
        .all<{ sha256: Sha256 }>(),
    ).pipe(Effect.map((rows) => rows.results.map((r) => r.sha256)))

  const releaseClaim: SystemStore['releaseClaim'] = (sha256) =>
    query('release a claim', () =>
      DB.prepare(
        `update blobs set state = 'live', reclaim_started_at = null
         where sha256 = ? and state = 'reclaiming'`,
      )
        .bind(sha256)
        .run(),
    ).pipe(Effect.asVoid)

  return {
    expireStagedPushes,
    purgeDeletedNodes,
    purgeRecords,
    claimBlobs,
    finishBlob,
    staleClaims,
    releaseClaim,
  }
}
