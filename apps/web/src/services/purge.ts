import type { PurgeBatchReport, PurgeReport } from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import { Db } from './db'
import { PersistenceError, StorageError } from './errors'
import { Ids } from './ids'
import { Objects } from './objects'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_MAX_BATCHES = 20
const DEFAULT_LEASE_MS = 10 * 60 * 1000
const D1_ID_CHUNK = 80
const R2_KEY_CHUNK = 1000

export interface PurgeProgress {
  readonly deletedObjects: number
  readonly deletedVersions: number
  readonly deletedDocuments: number
  readonly cursor: string | null
}

export interface RunPurgeOptions {
  readonly now: Date
  readonly retentionDays?: number
  readonly dryRun: boolean
  readonly maxBatches?: number
  readonly leaseMs?: number
}

export interface PurgeService {
  readonly runPurge: (
    options: RunPurgeOptions,
  ) => Effect.Effect<PurgeReport, PersistenceError | StorageError>
}

export class Purge extends Context.Tag('@dossier/web/Purge')<
  Purge,
  PurgeService
>() {}

type CandidateRow = {
  id: string
  root_title: string | null
  purge_progress: string | null
  purged_bytes: number | null
}

type BatchStatsRow = {
  documents: number
  versions: number
  bytes: number
}

type VersionObjectRow = {
  id: string
  object_key: string
  file_size: number
}

const emptyProgress = (): PurgeProgress => ({
  deletedObjects: 0,
  deletedVersions: 0,
  deletedDocuments: 0,
  cursor: null,
})

function persistence(operation: string, cause: unknown): PersistenceError {
  return new PersistenceError({ operation, cause })
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
  return value
}

function parseProgress(value: string | null): PurgeProgress {
  if (value === null) return emptyProgress()
  const parsed = JSON.parse(value) as Partial<PurgeProgress>
  if (
    !Number.isSafeInteger(parsed.deletedObjects) ||
    parsed.deletedObjects! < 0 ||
    !Number.isSafeInteger(parsed.deletedVersions) ||
    parsed.deletedVersions! < 0 ||
    !Number.isSafeInteger(parsed.deletedDocuments) ||
    parsed.deletedDocuments! < 0 ||
    !(parsed.cursor === null || typeof parsed.cursor === 'string')
  ) {
    throw new TypeError('Invalid purge progress')
  }
  return {
    deletedObjects: parsed.deletedObjects!,
    deletedVersions: parsed.deletedVersions!,
    deletedDocuments: parsed.deletedDocuments!,
    cursor: parsed.cursor,
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function reportFor(
  candidate: CandidateRow,
  progress: PurgeProgress,
  stats: BatchStatsRow,
): PurgeBatchReport {
  return {
    id: candidate.id,
    rootTitle: candidate.root_title,
    documents: stats.documents + progress.deletedDocuments,
    versions: stats.versions + progress.deletedVersions,
    bytes: Math.max(stats.bytes, candidate.purged_bytes ?? 0),
  }
}

export const PurgeLive = Layer.effect(
  Purge,
  Effect.gen(function* () {
    const db = yield* Db
    const objects = yield* Objects
    const ids = yield* Ids

    const loadProgress = (value: string | null) =>
      Effect.try({
        try: () => parseProgress(value),
        catch: (cause) => persistence('parse purge progress', cause),
      })

    const loadStats = (batchId: string) =>
      Effect.tryPromise({
        try: () =>
          db.raw
            .prepare(
              `SELECT
                 (SELECT COUNT(*) FROM documents
                   WHERE deletion_batch_id = ?1) AS documents,
                 (SELECT COUNT(*)
                    FROM document_versions v
                    JOIN documents d ON d.id = v.document_id
                   WHERE d.deletion_batch_id = ?1) AS versions,
                 (SELECT COALESCE(SUM(v.file_size), 0)
                    FROM document_versions v
                    JOIN documents d ON d.id = v.document_id
                   WHERE d.deletion_batch_id = ?1) AS bytes`,
            )
            .bind(batchId)
            .first<BatchStatsRow>(),
        catch: (cause) => persistence('load purge batch totals', cause),
      }).pipe(
        Effect.map((row) => row ?? { documents: 0, versions: 0, bytes: 0 }),
      )

    const runPurge: PurgeService['runPurge'] = (options) =>
      Effect.gen(function* () {
        const retentionDays = positiveInteger(
          options.retentionDays ?? DEFAULT_RETENTION_DAYS,
          'retentionDays',
        )
        const maxBatches = positiveInteger(
          options.maxBatches ?? DEFAULT_MAX_BATCHES,
          'maxBatches',
        )
        const leaseMs = positiveInteger(
          options.leaseMs ?? DEFAULT_LEASE_MS,
          'leaseMs',
        )
        const nowMs = options.now.getTime()
        if (!Number.isFinite(nowMs)) throw new RangeError('now must be valid')
        const wallStartedAt = Date.now()
        const nextLease = () =>
          new Date(nowMs + (Date.now() - wallStartedAt) + leaseMs).toISOString()
        const now = options.now.toISOString()
        const cutoff = new Date(nowMs - retentionDays * DAY_MS).toISOString()
        const candidates = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT id, root_title, purge_progress, purged_bytes
                   FROM deletion_batches
                  WHERE restored_at IS NULL
                    AND created_at < ?1
                    AND (
                      purge_status = 'pending'
                      OR (
                        purge_status = 'claimed'
                        AND (purge_lease_until IS NULL OR purge_lease_until <= ?2)
                      )
                    )
                  ORDER BY created_at, id
                  LIMIT ?3`,
              )
              .bind(cutoff, now, maxBatches)
              .all<CandidateRow>(),
          catch: (cause) => persistence('select purge batches', cause),
        })

        const batches: PurgeBatchReport[] = []
        for (const selected of candidates.results) {
          let progress = yield* loadProgress(selected.purge_progress)
          const selectedStats = yield* loadStats(selected.id)
          const selectedReport = reportFor(selected, progress, selectedStats)
          if (options.dryRun) {
            batches.push(selectedReport)
            continue
          }

          let leaseUntil = nextLease()
          const claim = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `UPDATE deletion_batches
                      SET purge_status = 'claimed', purge_lease_until = ?1
                    WHERE id = ?2
                      AND restored_at IS NULL
                      AND created_at < ?3
                      AND (
                        purge_status = 'pending'
                        OR (
                          purge_status = 'claimed'
                          AND (purge_lease_until IS NULL OR purge_lease_until <= ?4)
                        )
                      )`,
                )
                .bind(leaseUntil, selected.id, cutoff, now)
                .run(),
            catch: (cause) => persistence('claim purge batch', cause),
          })
          if ((claim.meta.changes ?? 0) === 0) continue

          const claimed = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `SELECT id, root_title, purge_progress, purged_bytes
                     FROM deletion_batches
                    WHERE id = ?`,
                )
                .bind(selected.id)
                .first<CandidateRow>(),
            catch: (cause) => persistence('reload claimed purge batch', cause),
          })
          if (!claimed) {
            return yield* Effect.fail(
              persistence('reload claimed purge batch', 'Batch disappeared'),
            )
          }
          progress = yield* loadProgress(claimed.purge_progress)
          let purgedBytes = claimed.purged_bytes ?? 0
          const claimedStats = yield* loadStats(claimed.id)
          const batchReport = reportFor(claimed, progress, claimedStats)

          const checkpoint = (
            nextProgress: PurgeProgress,
            nextPurgedBytes: number,
          ) =>
            Effect.gen(function* () {
              const renewedLease = nextLease()
              const result = yield* Effect.tryPromise({
                try: () =>
                  db.raw
                    .prepare(
                      `UPDATE deletion_batches
                          SET purge_progress = ?1, purged_bytes = ?2,
                              purge_lease_until = ?3
                        WHERE id = ?4
                          AND purge_status = 'claimed'
                          AND restored_at IS NULL
                          AND purge_lease_until = ?5`,
                    )
                    .bind(
                      JSON.stringify(nextProgress),
                      nextPurgedBytes,
                      renewedLease,
                      claimed.id,
                      leaseUntil,
                    )
                    .run(),
                catch: (cause) =>
                  persistence('checkpoint purge progress', cause),
              })
              if ((result.meta.changes ?? 0) === 0) {
                return yield* Effect.fail(
                  persistence(
                    'checkpoint purge progress',
                    'Purge lease was lost',
                  ),
                )
              }
              leaseUntil = renewedLease
              progress = nextProgress
              purgedBytes = nextPurgedBytes
            })

          for (;;) {
            const page = yield* Effect.tryPromise({
              try: () =>
                db.raw
                  .prepare(
                    `SELECT v.id, v.object_key, v.file_size
                       FROM document_versions v
                       JOIN documents d ON d.id = v.document_id
                      WHERE d.deletion_batch_id = ?1
                        AND (?2 IS NULL OR v.id > ?2)
                      ORDER BY v.id
                      LIMIT ${R2_KEY_CHUNK}`,
                  )
                  .bind(claimed.id, progress.cursor)
                  .all<VersionObjectRow>(),
              catch: (cause) => persistence('list purge object keys', cause),
            })
            if (page.results.length === 0) break
            const keys = page.results.map((row) => row.object_key)
            yield* Effect.tryPromise({
              try: () => objects.bucket.delete(keys),
              catch: (cause) =>
                new StorageError({
                  operation: `R2 purge batch ${claimed.id}`,
                  cause,
                }),
            })
            const bytes = page.results.reduce(
              (total, row) => total + row.file_size,
              0,
            )
            yield* checkpoint(
              {
                ...progress,
                deletedObjects: progress.deletedObjects + page.results.length,
                cursor: page.results.at(-1)!.id,
              },
              purgedBytes + bytes,
            )
          }

          const guardedBatch = (
            statements: readonly D1PreparedStatement[],
            nextProgress: PurgeProgress,
            operation: string,
          ) =>
            Effect.gen(function* () {
              const guardId = ids.internalId()
              const renewedLease = nextLease()
              yield* db
                .batch([
                  db.raw
                    .prepare(
                      `INSERT INTO publication_guards (id, ok)
                       VALUES (?1, CASE WHEN EXISTS (
                         SELECT 1 FROM deletion_batches
                          WHERE id = ?2
                            AND purge_status = 'claimed'
                            AND restored_at IS NULL
                            AND purge_lease_until = ?3
                       ) THEN 1 ELSE 0 END)`,
                    )
                    .bind(guardId, claimed.id, leaseUntil),
                  ...statements,
                  db.raw
                    .prepare(
                      `UPDATE deletion_batches
                          SET purge_progress = ?1, purge_lease_until = ?2
                        WHERE id = ?3 AND purge_lease_until = ?4`,
                    )
                    .bind(
                      JSON.stringify(nextProgress),
                      renewedLease,
                      claimed.id,
                      leaseUntil,
                    ),
                  db.raw
                    .prepare('DELETE FROM publication_guards WHERE id = ?')
                    .bind(guardId),
                ])
                .pipe(
                  Effect.mapError((error) =>
                    persistence(operation, error.cause),
                  ),
                )
              leaseUntil = renewedLease
              progress = nextProgress
            })

          for (;;) {
            const versions = yield* Effect.tryPromise({
              try: () =>
                db.raw
                  .prepare(
                    `SELECT v.id
                       FROM document_versions v
                       JOIN documents d ON d.id = v.document_id
                      WHERE d.deletion_batch_id = ?
                      ORDER BY v.id
                      LIMIT ${D1_ID_CHUNK}`,
                  )
                  .bind(claimed.id)
                  .all<{ id: string }>(),
              catch: (cause) => persistence('list purge version rows', cause),
            })
            if (versions.results.length === 0) break
            const versionIds = versions.results.map((row) => row.id)
            const marks = placeholders(versionIds.length)
            yield* guardedBatch(
              [
                db.raw
                  .prepare(
                    `DELETE FROM upload_events
                      WHERE document_version_id IN (${marks})`,
                  )
                  .bind(...versionIds),
                db.raw
                  .prepare(
                    `DELETE FROM document_versions WHERE id IN (${marks})`,
                  )
                  .bind(...versionIds),
              ],
              {
                ...progress,
                deletedVersions: progress.deletedVersions + versionIds.length,
              },
              'delete purge version rows',
            )
          }

          for (;;) {
            const documents = yield* Effect.tryPromise({
              try: () =>
                db.raw
                  .prepare(
                    `SELECT id
                       FROM documents
                      WHERE deletion_batch_id = ?
                      ORDER BY depth DESC, id
                      LIMIT ${D1_ID_CHUNK}`,
                  )
                  .bind(claimed.id)
                  .all<{ id: string }>(),
              catch: (cause) => persistence('list purge document rows', cause),
            })
            if (documents.results.length === 0) break
            const documentIds = documents.results.map((row) => row.id)
            const marks = placeholders(documentIds.length)
            yield* guardedBatch(
              [
                db.raw
                  .prepare(
                    `DELETE FROM upload_events WHERE document_id IN (${marks})`,
                  )
                  .bind(...documentIds),
                db.raw
                  .prepare(
                    `DELETE FROM document_shares WHERE document_id IN (${marks})`,
                  )
                  .bind(...documentIds),
                db.raw
                  .prepare(
                    `DELETE FROM document_state_fields
                      WHERE document_id IN (${marks})`,
                  )
                  .bind(...documentIds),
                db.raw
                  .prepare(
                    `DELETE FROM document_state_grants
                      WHERE document_id IN (${marks})`,
                  )
                  .bind(...documentIds),
                db.raw
                  .prepare(
                    `DELETE FROM document_edit_links
                      WHERE document_id IN (${marks})`,
                  )
                  .bind(...documentIds),
                db.raw
                  .prepare(
                    `DELETE FROM document_state
                      WHERE document_id IN (${marks})`,
                  )
                  .bind(...documentIds),
                db.raw
                  .prepare(`DELETE FROM documents WHERE id IN (${marks})`)
                  .bind(...documentIds),
              ],
              {
                ...progress,
                deletedDocuments:
                  progress.deletedDocuments + documentIds.length,
              },
              'delete purge document rows',
            )
          }

          const finalProgress: PurgeProgress = {
            ...progress,
            deletedObjects: batchReport.versions,
            deletedVersions: batchReport.versions,
            deletedDocuments: batchReport.documents,
          }
          const completed = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `UPDATE deletion_batches
                      SET purge_status = 'purged', purge_lease_until = NULL,
                          purge_progress = ?1, purged_at = ?2, purged_bytes = ?3
                    WHERE id = ?4
                      AND purge_status = 'claimed'
                      AND restored_at IS NULL
                      AND purge_lease_until = ?5`,
                )
                .bind(
                  JSON.stringify(finalProgress),
                  now,
                  Math.max(purgedBytes, batchReport.bytes),
                  claimed.id,
                  leaseUntil,
                )
                .run(),
            catch: (cause) => persistence('complete purge batch', cause),
          })
          if ((completed.meta.changes ?? 0) === 0) {
            return yield* Effect.fail(
              persistence('complete purge batch', 'Purge lease was lost'),
            )
          }
          batches.push(batchReport)
        }

        const totals = batches.reduce(
          (total, batch) => ({
            batches: total.batches + 1,
            documents: total.documents + batch.documents,
            versions: total.versions + batch.versions,
            bytes: total.bytes + batch.bytes,
          }),
          { batches: 0, documents: 0, versions: 0, bytes: 0 },
        )
        return { cutoff, batches, totals, dryRun: options.dryRun }
      }).pipe(
        Effect.mapError((error) =>
          error instanceof PersistenceError || error instanceof StorageError
            ? error
            : persistence('run purge', error),
        ),
      )

    return { runPurge }
  }),
)
