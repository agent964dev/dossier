// The purge: the one job that removes rows and bytes past the retention
// period. It reaches the tables only through TreeStore.system, which needs a
// SystemJob; the weekly trigger makes one, and so does "Purge now" once it
// has checked the super admin. Its own runs are kept in purge_runs: the lease
// that keeps two runs apart, where a run got to, and what it removed.
import {
  dossierError,
  type DossierError,
  type Sha256,
} from '@dossier/contracts'
import { MARKDOWN_VERSION } from '@dossier/html'
import { Cause, Clock, Context, Effect, Layer } from 'effect'

import { Bindings } from './bindings.ts'
import { CurrentCaller } from './caller.ts'
import { newId } from './ids.ts'
import { Settings } from './settings.ts'
import {
  NODE_BATCH,
  RECORD_BATCH,
  SYSTEM_STATEMENTS,
  SystemJob,
  type SystemStore,
} from './system-store.ts'
import { blobKey, TreeStore } from './tree-store.ts'

export interface PurgeOutcome {
  readonly runId: string
  readonly trigger: 'weekly' | 'manual'
  readonly expiredPushes: number
  readonly nodes: number
  readonly versions: number
  readonly trees: number
  readonly workspaces: number
  readonly blobs: number
  readonly records: number
  /** The run stopped at its budget: the next run goes on from here. */
  readonly remaining: boolean
}

export interface PurgeRun {
  readonly trigger: 'weekly' | 'manual'
  readonly state: 'running' | 'done' | 'partial' | 'failed'
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly outcome: PurgeOutcome | null
}

export interface PurgeService {
  readonly run: (
    trigger: 'weekly',
  ) => Effect.Effect<
    PurgeOutcome,
    DossierError<'conflict' | 'unavailable'>,
    SystemJob
  >
  /** A super admin's "Purge now"; anyone else gets not_found. */
  readonly runNow: () => Effect.Effect<
    PurgeOutcome,
    DossierError<'not_found' | 'sign_in_required' | 'conflict' | 'unavailable'>,
    CurrentCaller
  >
  /**
   * The bytes a committed withdrawal released, reclaimed at once when
   * nothing else references them. Provides its own SystemJob; failures are
   * logged and the weekly run repeats them.
   */
  readonly reclaim: (shas: readonly Sha256[]) => Effect.Effect<void>
  readonly lastRun: () => Effect.Effect<PurgeRun | null>
}

export class Purge extends Context.Tag('Purge')<Purge, PurgeService>() {}

/**
 * What one run may spend: D1 statements (R2 calls counted with them) and
 * time, whichever runs out first. What is left stays for the next run.
 */
export class PurgeBudget extends Context.Reference<PurgeBudget>()(
  'PurgeBudget',
  { defaultValue: () => ({ statements: 800, millis: 25_000 }) },
) {}

/** Another run waits while a run's lease is live. */
export const LEASE_MS = 10 * 60 * 1000

/** A claim older than this was left by a run or a reclaim that stopped. */
export const STALE_CLAIM_MS = 5 * 60 * 1000

/** Blobs claimed at once. */
const CLAIM_BATCH = 50

/** Expired pushes handled at once. */
const PUSH_BATCH = 100

const DAY = 24 * 60 * 60 * 1000

/** Where a run got to: the next step, and the blobs it claimed and has not finished. */
interface Checkpoint {
  readonly step: 'expire' | 'nodes' | 'records' | 'blobs' | 'done'
  readonly claimed: readonly Sha256[]
}

interface Tally {
  expiredPushes: number
  nodes: number
  versions: number
  trees: number
  workspaces: number
  keysRevoked: number
  blobs: number
  records: number
}

const emptyTally = (): Tally => ({
  expiredPushes: 0,
  nodes: 0,
  versions: 0,
  trees: 0,
  workspaces: 0,
  keysRevoked: 0,
  blobs: 0,
  records: 0,
})

/**
 * Every R2 object stored under a blob's hash: the bytes, and the generated
 * Markdown of every converter version. fonts/, looks/ and base/ are not
 * blobs and are never named here.
 */
const objectsOf = (sha256: Sha256): string[] => [
  blobKey(sha256),
  ...Array.from(
    { length: MARKDOWN_VERSION },
    (_, at) => `derived/markdown/${at + 1}/${sha256}.md`,
  ),
]

const parseJson = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const claimedIn = (text: string | null): Sha256[] => {
  const value = parseJson(text) as { claimed?: unknown } | null
  return Array.isArray(value?.claimed)
    ? value.claimed.filter((s): s is Sha256 => typeof s === 'string')
    : []
}

const outcomeOf = (
  runId: string,
  trigger: 'weekly' | 'manual',
  counts: unknown,
): PurgeOutcome => {
  const c = (counts ?? {}) as Record<string, unknown>
  const n = (key: string) => (typeof c[key] === 'number' ? c[key] : 0)
  return {
    runId,
    trigger,
    expiredPushes: n('expiredPushes'),
    nodes: n('nodes'),
    versions: n('versions'),
    trees: n('trees'),
    workspaces: n('workspaces'),
    blobs: n('blobs'),
    records: n('records'),
    remaining: c.remaining === true,
  }
}

const running = () => dossierError('conflict', 'A purge is running.', null)

const notFound = () =>
  dossierError('not_found', 'Nothing is here, or you cannot open it.', null)

export const PurgeLive: Layer.Layer<
  Purge,
  never,
  TreeStore | Bindings | Settings
> = Layer.effect(
  Purge,
  Effect.gen(function* () {
    const store = yield* TreeStore
    const settings = yield* Settings
    const { DB, BLOBS } = yield* Bindings

    const d1 = <A>(what: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (error) => {
          console.error(`The purge could not ${what}`, error)
          return dossierError('unavailable')
        },
      })

    const r2 = <A>(what: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (error) => {
          console.error(`The purge could not ${what} in file storage`, error)
          return dossierError(
            'unavailable',
            `File storage did not ${what} a file.`,
          )
        },
      })

    /**
     * Deletes a claimed blob's objects, then its rows. A run deletes only
     * while it still holds its lease: a run another took over stops here,
     * so two never finish one claim around a new upload of the same bytes.
     */
    const reclaimOne = (
      system: SystemStore,
      sha256: Sha256,
      runId: string | null = null,
    ) =>
      Effect.gen(function* () {
        if (runId !== null) {
          const now = yield* Clock.currentTimeMillis
          const ours = yield* d1('check its lease', () =>
            DB.prepare(
              `select 1 as one from purge_runs where id = ? and state = 'running'
                 and lease_until > ?`,
            )
              .bind(runId, now)
              .first(),
          )
          if (ours === null) {
            return yield* Effect.fail(
              dossierError('conflict', 'Another purge run took over this one.'),
            )
          }
        }
        yield* r2('delete', () => BLOBS.delete(objectsOf(sha256)))
        yield* system.finishBlob(sha256)
      })

    type Lease =
      | { readonly kind: 'leased'; readonly resume: readonly Sha256[] }
      | { readonly kind: 'busy' }
      | { readonly kind: 'refused' }

    /**
     * Takes the lease unless a live one exists; a run whose lease lapsed
     * while it still said running stopped, and is marked failed. A pressed
     * run is taken only while its super admin still is one, as the insert
     * commits. The new run carries the claims the last run left.
     */
    const lease = (
      runId: string,
      trigger: 'weekly' | 'manual',
      by: { readonly personId: string; readonly sessionId: string } | null,
      now: number,
    ) =>
      Effect.gen(function* () {
        const results = yield* d1('take its lease', () =>
          DB.batch([
            DB.prepare(
              `update purge_runs set state = 'failed',
                 error = coalesce(error, 'It stopped before it finished.'),
                 finished_at = ?1
               where state = 'running' and lease_until <= ?1`,
            ).bind(now),
            DB.prepare(
              `insert into purge_runs (id, trigger, started_by, state, lease_until,
                 checkpoint_json, counts_json, started_at)
               select ?2, ?3, ?4, 'running', ?5,
                 json_object('step', 'expire', 'claimed', json(coalesce(
                   (select json_extract(checkpoint_json, '$.claimed') from purge_runs
                     order by rowid desc limit 1), '[]'))),
                 '{}', ?1
               where not exists (select 1 from purge_runs
                   where state = 'running' and lease_until > ?1)
                 and (?6 is null or exists (select 1 from session s
                   join super_admins a on a.user_id = s.user_id
                   where s.id = ?6 and s.user_id = ?4 and s.expires_at > ?1))`,
            ).bind(
              now,
              runId,
              trigger,
              by?.personId ?? null,
              now + LEASE_MS,
              by?.sessionId ?? null,
            ),
            DB.prepare(
              `select (select checkpoint_json from purge_runs where id = ?1) as checkpoint,
                 exists (select 1 from purge_runs where id <> ?1
                   and state = 'running' and lease_until > ?2) as busy`,
            ).bind(runId, now),
          ]),
        )
        const row = results[2]?.results[0] as
          | { checkpoint: string | null; busy: number }
          | undefined
        if (row?.checkpoint != null) {
          return {
            kind: 'leased',
            resume: claimedIn(row.checkpoint),
          } satisfies Lease as Lease
        }
        return (
          row?.busy === 1 ? { kind: 'busy' } : { kind: 'refused' }
        ) as Lease
      })

    /** One run under a lease already taken, step after step. */
    const steps = (
      system: SystemStore,
      runId: string,
      started: number,
      resume: readonly Sha256[],
      tally: Tally,
    ) =>
      Effect.gen(function* () {
        const budget = yield* PurgeBudget
        // The lease batch.
        let used = 3
        const fits = (cost: number) =>
          Effect.map(
            Clock.currentTimeMillis,
            (now) =>
              used + cost <= budget.statements && now - started < budget.millis,
          )
        const spend = (cost: number) => {
          used += cost
        }
        let checkpoint: Checkpoint = { step: 'expire', claimed: resume }
        const save = (next: Checkpoint) =>
          Effect.gen(function* () {
            checkpoint = next
            spend(1)
            yield* d1('save where it got to', () =>
              DB.prepare(
                `update purge_runs set checkpoint_json = ?, counts_json = ?
                 where id = ?`,
              )
                .bind(JSON.stringify(next), JSON.stringify(tally), runId)
                .run(),
            )
          })

        const { retentionDays } = yield* settings.current()
        const cutoff = started - retentionDays * DAY

        // 1. Staged pushes past their expiry.
        const expire = Effect.gen(function* () {
          for (;;) {
            if (!(yield* fits(SYSTEM_STATEMENTS.expireStagedPushes + 1))) {
              return false
            }
            spend(SYSTEM_STATEMENTS.expireStagedPushes)
            const now = yield* Clock.currentTimeMillis
            const expired = yield* system.expireStagedPushes(now, PUSH_BATCH)
            tally.expiredPushes += expired
            if (expired < PUSH_BATCH) return true
          }
        })

        // 2 and 3. Deleted nodes, then emptied trees and workspaces.
        const nodes = Effect.gen(function* () {
          for (;;) {
            if (!(yield* fits(SYSTEM_STATEMENTS.purgeDeletedNodes + 1))) {
              return false
            }
            spend(SYSTEM_STATEMENTS.purgeDeletedNodes)
            const counts = yield* system.purgeDeletedNodes(cutoff, NODE_BATCH)
            tally.nodes += counts.nodes
            tally.versions += counts.versions
            tally.trees += counts.trees
            tally.workspaces += counts.workspaces
            tally.keysRevoked += counts.keysRevoked
            if (counts.nodes + counts.trees + counts.workspaces === 0) {
              return true
            }
          }
        })

        // 4. Records past their life.
        const records = Effect.gen(function* () {
          for (;;) {
            if (!(yield* fits(SYSTEM_STATEMENTS.purgeRecords + 1))) {
              return false
            }
            spend(SYSTEM_STATEMENTS.purgeRecords)
            const now = yield* Clock.currentTimeMillis
            const counts = yield* system.purgeRecords(cutoff, now)
            const all = Object.values(counts)
            tally.records += all.reduce((sum, n) => sum + n, 0)
            if (all.every((n) => n < RECORD_BATCH)) return true
          }
        })

        // 5. Blobs nothing references or holds.
        const perBlob = 1 + SYSTEM_STATEMENTS.finishBlob
        const blobs = Effect.gen(function* () {
          // The claims a stopped run left: nothing can take them back, so
          // their deletion goes on.
          if (checkpoint.claimed.length > 0) {
            spend(1)
            const still = yield* d1('read the claims left', () =>
              DB.prepare(
                `select sha256 from blobs where state = 'reclaiming'
                   and sha256 in (select value from json_each(?))`,
              )
                .bind(JSON.stringify(checkpoint.claimed))
                .all<{ sha256: Sha256 }>(),
            )
            for (const { sha256 } of still.results) {
              yield* reclaimOne(system, sha256, runId)
              spend(perBlob)
              tally.blobs += 1
            }
            yield* save({ step: 'blobs', claimed: [] })
          }
          // Claims a stopped run or reclaim left behind, whether or not a
          // checkpoint names them. A claimed blob is one nothing references
          // or holds, and no hold can be taken on it, so it is finished,
          // never handed back to live: a claim handed back while another
          // actor was about to delete its bytes would lose them.
          if (!(yield* fits(SYSTEM_STATEMENTS.staleClaims))) return false
          spend(SYSTEM_STATEMENTS.staleClaims)
          const now = yield* Clock.currentTimeMillis
          for (const sha256 of yield* system.staleClaims(
            now - STALE_CLAIM_MS,
          )) {
            if (!(yield* fits(perBlob))) return false
            yield* reclaimOne(system, sha256, runId)
            spend(perBlob)
            tally.blobs += 1
          }
          for (;;) {
            const cost =
              SYSTEM_STATEMENTS.claimBlobs + 2 + CLAIM_BATCH * perBlob
            if (!(yield* fits(cost))) return false
            spend(SYSTEM_STATEMENTS.claimBlobs)
            const claimed = yield* system.claimBlobs(CLAIM_BATCH)
            if (claimed.length === 0) return true
            yield* save({ step: 'blobs', claimed })
            for (const sha256 of claimed) {
              yield* reclaimOne(system, sha256, runId)
              spend(perBlob)
              tally.blobs += 1
            }
            yield* save({ step: 'blobs', claimed: [] })
          }
        })

        const order = [
          ['expire', expire],
          ['nodes', nodes],
          ['records', records],
          ['blobs', blobs],
        ] as const
        for (const [step, work] of order) {
          if (checkpoint.step !== step) {
            yield* save({ step, claimed: checkpoint.claimed })
          }
          if (!(yield* work)) return { remaining: true, checkpoint }
        }
        return { remaining: false, checkpoint: { step: 'done', claimed: [] } }
      })

    /** A whole run: lease, steps, and the row that says how it ended. */
    const execute = (
      runId: string,
      trigger: 'weekly' | 'manual',
      by: { readonly personId: string; readonly sessionId: string } | null,
    ) =>
      Effect.gen(function* () {
        const system = yield* store.system
        const started = yield* Clock.currentTimeMillis
        const leased = yield* lease(runId, trigger, by, started)
        if (leased.kind !== 'leased') return leased
        const tally = emptyTally()
        const ended = yield* Effect.either(
          steps(system, runId, started, leased.resume, tally).pipe(
            Effect.catchAllDefect((defect) =>
              Effect.fail(
                dossierError(
                  'unavailable',
                  Cause.pretty(Cause.die(defect)).split('\n')[0],
                ),
              ),
            ),
          ),
        )
        const finished = yield* Clock.currentTimeMillis
        if (ended._tag === 'Left') {
          const error = ended.left.message.slice(0, 500)
          console.error(
            JSON.stringify({
              message: 'purge',
              runId,
              trigger,
              state: 'failed',
              error,
              ...tally,
            }),
          )
          yield* d1('record its failure', () =>
            DB.prepare(
              `update purge_runs set state = 'failed', error = ?, counts_json = ?,
                 finished_at = ?, lease_until = ?
               where id = ? and state = 'running'`,
            )
              .bind(error, JSON.stringify(tally), finished, finished, runId)
              .run(),
          ).pipe(Effect.ignore)
          return yield* Effect.fail(dossierError('unavailable'))
        }
        const { remaining, checkpoint } = ended.right
        const state = remaining ? 'partial' : 'done'
        const counts = { ...tally, remaining }
        yield* d1('record its end', () =>
          DB.prepare(
            `update purge_runs set state = ?, counts_json = ?, checkpoint_json = ?,
               finished_at = ?, lease_until = ?
             where id = ?`,
          )
            .bind(
              state,
              JSON.stringify(counts),
              JSON.stringify(checkpoint),
              finished,
              finished,
              runId,
            )
            .run(),
        )
        console.log(
          JSON.stringify({
            message: 'purge',
            runId,
            trigger,
            state,
            ...counts,
          }),
        )
        return {
          kind: 'done',
          outcome: outcomeOf(runId, trigger, counts),
        } as const
      })

    const run: PurgeService['run'] = (trigger) =>
      Effect.gen(function* () {
        const job = yield* SystemJob
        const ended = yield* execute(job.runId, trigger, null)
        if (ended.kind === 'done') return ended.outcome
        return yield* Effect.fail(
          ended.kind === 'busy' ? running() : dossierError('unavailable'),
        )
      })

    const runNow: PurgeService['runNow'] = () =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        if (caller.person === null || caller.via.kind !== 'browser') {
          return yield* Effect.fail(notFound())
        }
        const by = {
          personId: caller.person.id,
          sessionId: caller.via.sessionId,
        }
        const now = yield* Clock.currentTimeMillis
        // Its own query: a live session of a super admin.
        const allowed = yield* d1('check the super admin', () =>
          DB.prepare(
            `select 1 as one from session s
               join super_admins a on a.user_id = s.user_id
             where s.id = ? and s.user_id = ? and s.expires_at > ?`,
          )
            .bind(by.sessionId, by.personId, now)
            .first<{ one: number }>(),
        )
        if (allowed === null) return yield* Effect.fail(notFound())
        const runId = newId()
        const ended = yield* execute(runId, 'manual', by).pipe(
          Effect.provideService(SystemJob, { job: 'purge', runId }),
        )
        if (ended.kind === 'done') return ended.outcome
        return yield* Effect.fail(
          ended.kind === 'busy' ? running() : notFound(),
        )
      })

    const reclaim: PurgeService['reclaim'] = (shas) => {
      const runId = `reclaim:${newId()}`
      return Effect.gen(function* () {
        const unique = [...new Set(shas)]
        if (unique.length === 0) return
        const system = yield* store.system
        for (let at = 0; at < unique.length; at += CLAIM_BATCH) {
          const claimed = yield* system.claimBlobs(
            CLAIM_BATCH,
            unique.slice(at, at + CLAIM_BATCH),
          )
          for (const sha256 of claimed) yield* reclaimOne(system, sha256)
        }
      }).pipe(
        Effect.provideService(SystemJob, { job: 'purge', runId }),
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            console.error(
              'Reclaiming released files failed; the weekly purge repeats it',
              Cause.pretty(cause),
            )
          }),
        ),
      )
    }

    const lastRun: PurgeService['lastRun'] = () =>
      d1('read the last run', () =>
        DB.prepare(
          `select id, trigger, state, started_at as startedAt,
             finished_at as finishedAt, counts_json as counts
           from purge_runs order by rowid desc limit 1`,
        ).first<{
          id: string
          trigger: 'weekly' | 'manual'
          state: PurgeRun['state']
          startedAt: number
          finishedAt: number | null
          counts: string
        }>(),
      ).pipe(
        Effect.map((row) =>
          row === null
            ? null
            : ({
                trigger: row.trigger,
                state: row.state,
                startedAt: row.startedAt,
                finishedAt: row.finishedAt,
                outcome:
                  row.state === 'running'
                    ? null
                    : outcomeOf(row.id, row.trigger, parseJson(row.counts)),
              } satisfies PurgeRun),
        ),
        Effect.orElseSucceed(() => null),
      )

    return { run, runNow, reclaim, lastRun } satisfies PurgeService
  }),
)
