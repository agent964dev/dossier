import { env as workerEnv } from 'cloudflare:workers'
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import worker, { scheduled } from '../src/worker'
import {
  Assets,
  Documents,
  makeDb,
  makeObjects,
  PersistenceError,
  Principal,
  Publish,
  Purge,
  StorageError,
  type DbService,
  type PrincipalIdentity,
} from '../src/services'
import { makeCoreLayer, seedPrincipal, testEnv } from './core-helpers'

const env = testEnv(workerEnv)
const layer = makeCoreLayer(env)
const NOW = new Date('2026-12-31T12:00:00.000Z')
const OLD = new Date(NOW.getTime() - 31 * 86_400_000).toISOString()
const YOUNG = new Date(NOW.getTime() - 10 * 86_400_000).toISOString()

function run<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  provided = layer,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(provided)) as Effect.Effect<A, E, never>,
  )
}

async function principalFor(suffix: string): Promise<{
  principal: PrincipalIdentity
  token: string
}> {
  const seeded = await seedPrincipal(env, { suffix })
  const principal = await run(
    Effect.gen(function* () {
      return yield* (yield* Principal).resolve(
        new Request('https://dossier.test/api/uploads', {
          headers: { authorization: `Bearer ${seeded.token}` },
        }),
      )
    }),
  )
  return { principal, token: seeded.token }
}

function html(title: string, version: number): string {
  return `<!doctype html><title>${title}</title><p>${version}</p>`
}

async function archive(
  suffix: string,
  options: { readonly versions?: number; readonly createdAt?: string } = {},
) {
  const { principal, token } = await principalFor(suffix)
  const first = await run(
    Effect.gen(function* () {
      return yield* (yield* Publish).publish(
        {
          html: html(`Purge ${suffix}`, 1),
          idempotencyKey: `${suffix}-1`,
        },
        principal,
      )
    }),
  )
  const versions = options.versions ?? 1
  for (let start = 2; start <= versions; start += 20) {
    const end = Math.min(versions, start + 19)
    await Promise.all(
      Array.from({ length: end - start + 1 }, (_, offset) => {
        const version = start + offset
        return run(
          Effect.gen(function* () {
            return yield* (yield* Publish).publish(
              {
                html: html(`Purge ${suffix}`, version),
                documentId: first.document.id,
                idempotencyKey: `${suffix}-${version}`,
              },
              principal,
            )
          }),
        )
      }),
    )
  }
  const keys = await env.DB.prepare(
    `SELECT object_key FROM document_versions
      WHERE document_id = ? ORDER BY id`,
  )
    .bind(first.document.id)
    .all<{ object_key: string }>()
  const deleted = await run(
    Effect.gen(function* () {
      return yield* (yield* Documents).delete(first.document.id, principal)
    }),
  )
  await env.DB.prepare(
    'UPDATE deletion_batches SET created_at = ? WHERE id = ?',
  )
    .bind(options.createdAt ?? OLD, deleted.batchId)
    .run()
  return {
    principal,
    token,
    documentId: first.document.id,
    batchId: deleted.batchId,
    keys: keys.results.map((row) => row.object_key),
  }
}

function purge(dryRun: boolean, now = NOW, provided = layer) {
  return run(
    Effect.gen(function* () {
      return yield* (yield* Purge).runPurge({
        now,
        retentionDays: 30,
        dryRun,
      })
    }),
    provided,
  )
}

async function listKeys(prefix?: string): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.OBJECTS.list({ prefix, cursor })
    keys.push(...page.objects.map((object) => object.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return keys
}

function bucketWithDelete(
  remove: (keys: string | string[]) => Promise<void>,
): R2Bucket {
  return {
    head: env.OBJECTS.head.bind(env.OBJECTS),
    get: env.OBJECTS.get.bind(env.OBJECTS),
    put: env.OBJECTS.put.bind(env.OBJECTS),
    createMultipartUpload: env.OBJECTS.createMultipartUpload.bind(env.OBJECTS),
    resumeMultipartUpload: env.OBJECTS.resumeMultipartUpload.bind(env.OBJECTS),
    delete: remove,
    list: env.OBJECTS.list.bind(env.OBJECTS),
  }
}

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function pausePreparedRun(
  matches: (query: string) => boolean,
  reached: ReturnType<typeof deferred>,
  release: ReturnType<typeof deferred>,
): DbService {
  const base = makeDb(env.DB)
  let paused = false
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrap(target.bind(...values))
        }
        if (property === 'run') {
          return async () => {
            if (!paused) {
              paused = true
              reached.resolve()
              await release.promise
            }
            return target.run()
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  const raw = new Proxy(base.raw, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => {
          const statement = target.prepare(query)
          return matches(query) ? wrap(statement) : statement
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ...base, raw }
}

function failDbBatchAt(call: number): DbService {
  const base = makeDb(env.DB)
  let batchCalls = 0
  return {
    ...base,
    batch: (statements) => {
      batchCalls += 1
      return batchCalls === call
        ? Effect.fail(
            new PersistenceError({
              operation: 'simulated D1 cleanup interruption',
              cause: new Error('simulated D1 cleanup interruption'),
            }),
          )
        : base.batch(statements)
    },
  }
}

async function snapshotD1(): Promise<string> {
  const tables = await env.DB.prepare(
    `SELECT name
       FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_cf_%'
      ORDER BY name`,
  ).all<{ name: string }>()
  const snapshot: Record<string, unknown> = {}
  for (const table of tables.results) {
    const name = table.name.replaceAll('"', '""')
    snapshot[table.name] = (
      await env.DB.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()
    ).results
  }
  return JSON.stringify(snapshot)
}

describe('Purge', () => {
  it('leaves batches younger than retention untouched', async () => {
    const archived = await archive('purge_young', { createdAt: YOUNG })
    const report = await purge(false)

    expect(report.batches).toEqual([])
    expect(await env.OBJECTS.head(archived.keys[0]!)).not.toBeNull()
    expect(
      await env.DB.prepare(
        'SELECT purge_status FROM deletion_batches WHERE id = ?',
      )
        .bind(archived.batchId)
        .first(),
    ).toEqual({ purge_status: 'pending' })
    const trash = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).list(
          { scope: 'trash' },
          archived.principal,
        )
      }),
    )
    expect(trash.documents[0]).toMatchObject({
      purgeStatus: 'pending',
      purgesAt: new Date(Date.parse(YOUNG) + 30 * 86_400_000).toISOString(),
    })
  })

  it('purges old R2 objects and document rows while retaining audit counts', async () => {
    const archived = await archive('purge_old', { versions: 2 })
    const before = await env.DB.prepare(
      `SELECT COUNT(*) AS versions, COALESCE(SUM(file_size), 0) AS bytes
         FROM document_versions WHERE document_id = ?`,
    )
      .bind(archived.documentId)
      .first<{ versions: number; bytes: number }>()
    const report = await purge(false)

    expect(report).toMatchObject({
      dryRun: false,
      totals: {
        batches: 1,
        documents: 1,
        versions: 2,
        bytes: before!.bytes,
      },
    })
    for (const key of archived.keys) {
      expect(await env.OBJECTS.head(key)).toBeNull()
    }
    const rows = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM documents WHERE id = ?1) AS documents,
         (SELECT COUNT(*) FROM document_versions WHERE document_id = ?1) AS versions,
         (SELECT COUNT(*) FROM upload_events WHERE document_id = ?1) AS events`,
    )
      .bind(archived.documentId)
      .first()
    expect(rows).toEqual({ documents: 0, versions: 0, events: 0 })
    expect(
      await env.DB.prepare(
        `SELECT purge_status, purged_bytes, deleted_count, purged_at
           FROM deletion_batches WHERE id = ?`,
      )
        .bind(archived.batchId)
        .first(),
    ).toEqual({
      purge_status: 'purged',
      purged_bytes: before!.bytes,
      deleted_count: 1,
      purged_at: NOW.toISOString(),
    })
  })

  it('leaves restored batches untouched', async () => {
    const archived = await archive('purge_restored')
    await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).restore(
          archived.documentId,
          archived.batchId,
          archived.principal,
        )
      }),
    )

    expect((await purge(false)).batches).toEqual([])
    expect(await env.OBJECTS.head(archived.keys[0]!)).not.toBeNull()
    expect(
      await env.DB.prepare('SELECT id FROM documents WHERE id = ?')
        .bind(archived.documentId)
        .first(),
    ).toEqual({ id: archived.documentId })
  })

  it('lets restore win when it commits before the purge claim', async () => {
    const archived = await archive('purge_restore_wins')
    const claimReached = deferred()
    const releaseClaim = deferred()
    const pausingLayer = makeCoreLayer(env, {
      db: pausePreparedRun(
        (query) => query.includes("SET purge_status = 'claimed'"),
        claimReached,
        releaseClaim,
      ),
    })

    const purgeResult = purge(false, NOW, pausingLayer)
    await claimReached.promise
    try {
      await run(
        Effect.gen(function* () {
          return yield* (yield* Documents).restore(
            archived.documentId,
            archived.batchId,
            archived.principal,
          )
        }),
      )
    } finally {
      releaseClaim.resolve()
    }

    expect((await purgeResult).batches).toEqual([])
    expect(await env.OBJECTS.head(archived.keys[0]!)).not.toBeNull()
    expect(
      await env.DB.prepare(
        `SELECT restored_at, purge_status
           FROM deletion_batches WHERE id = ?`,
      )
        .bind(archived.batchId)
        .first(),
    ).toMatchObject({
      restored_at: expect.any(String),
      purge_status: 'pending',
    })
  })

  it('rejects restore when the purge claim commits first', async () => {
    const archived = await archive('purge_claim_wins')
    const deleteReached = deferred()
    const releaseDelete = deferred()
    let paused = false
    const pausingBucket = bucketWithDelete(async (keys) => {
      if (!paused) {
        paused = true
        deleteReached.resolve()
        await releaseDelete.promise
      }
      await env.OBJECTS.delete(keys)
    })
    const pausingLayer = makeCoreLayer(env, {
      objects: makeObjects(pausingBucket),
    })

    const purgeResult = purge(false, NOW, pausingLayer)
    await deleteReached.promise
    let response: Response
    try {
      response = await worker.fetch(
        new Request(
          `https://dossier.test/api/documents/${archived.documentId}/restore`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${archived.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ batchId: archived.batchId }),
          },
        ) as Parameters<typeof worker.fetch>[0],
        env,
      )
    } finally {
      releaseDelete.resolve()
    }

    expect(response!.status).toBe(409)
    expect(await response!.json()).toMatchObject({
      ok: false,
      code: 'batch_purged',
    })
    expect((await purgeResult).batches).toEqual([
      expect.objectContaining({ id: archived.batchId }),
    ])
    expect(await env.OBJECTS.head(archived.keys[0]!)).toBeNull()
  })

  it('keeps the restored audit batch and purges a later re-archive', async () => {
    const archived = await archive('purge_rearchive')
    await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).restore(
          archived.documentId,
          archived.batchId,
          archived.principal,
        )
      }),
    )
    const rearchived = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).delete(
          archived.documentId,
          archived.principal,
        )
      }),
    )
    expect(rearchived.batchId).not.toBe(archived.batchId)
    await env.DB.prepare(
      'UPDATE deletion_batches SET created_at = ? WHERE id = ?',
    )
      .bind(OLD, rearchived.batchId)
      .run()

    const report = await purge(false)

    expect(report.batches).toEqual([
      expect.objectContaining({ id: rearchived.batchId }),
    ])
    expect(
      await env.DB.prepare(
        `SELECT restored_at, purge_status
           FROM deletion_batches WHERE id = ?`,
      )
        .bind(archived.batchId)
        .first(),
    ).toMatchObject({
      restored_at: expect.any(String),
      purge_status: 'pending',
    })
    expect(
      await env.DB.prepare(
        'SELECT purge_status FROM deletion_batches WHERE id = ?',
      )
        .bind(rearchived.batchId)
        .first(),
    ).toEqual({ purge_status: 'purged' })
    expect(await env.OBJECTS.head(archived.keys[0]!)).toBeNull()
  })

  it('defaults the admin endpoint to dry-run for deployment admins', async () => {
    const archived = await archive('purge_admin', {
      createdAt: '2020-01-01T00:00:00.000Z',
    })
    const denied = await worker.fetch(
      new Request('https://dossier.test/api/admin/purge', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${archived.token}`,
          'content-type': 'application/json',
        },
        body: '{}',
      }) as Parameters<typeof worker.fetch>[0],
      env,
    )
    expect(denied.status).toBe(401)

    await env.DB.prepare(
      'UPDATE accounts SET deployment_admin = 1 WHERE id = ?',
    )
      .bind(archived.principal.accountId)
      .run()
    await env.DB.prepare('UPDATE api_keys SET last_used_at = NULL WHERE id = ?')
      .bind(archived.principal.apiKeyId)
      .run()
    const beforeD1 = await snapshotD1()
    const beforeR2 = await listKeys()

    const response = await worker.fetch(
      new Request('https://dossier.test/api/admin/purge', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${archived.token}`,
          'content-type': 'application/json',
        },
        body: '{}',
      }) as Parameters<typeof worker.fetch>[0],
      env,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      dryRun: true,
      batches: [{ id: archived.batchId }],
    })
    expect(await snapshotD1()).toBe(beforeD1)
    expect(await listKeys()).toEqual(beforeR2)
    expect(
      await env.DB.prepare('SELECT last_used_at FROM api_keys WHERE id = ?')
        .bind(archived.principal.apiKeyId)
        .first(),
    ).toEqual({ last_used_at: null })
    await env.DB.prepare(
      'UPDATE deletion_batches SET created_at = ? WHERE id = ?',
    )
      .bind(YOUNG, archived.batchId)
      .run()
  })

  it('never touches asset versions or asset R2 keys', async () => {
    const archived = await archive('purge_asset')
    const asset = await run(
      Effect.gen(function* () {
        return yield* (yield* Assets).push(
          {
            slug: 'purge-asset',
            ext: 'css',
            contentBase64: btoa('body { color: #123456; }'),
          },
          archived.principal,
        )
      }),
    )
    const assetRow = await env.DB.prepare(
      `SELECT v.object_key
         FROM asset_versions v
         JOIN assets a ON a.id = v.asset_id
        WHERE a.slug = ? AND v.version_number = ?`,
    )
      .bind(asset.slug, asset.versionNumber)
      .first<{ object_key: string }>()

    await purge(false)

    expect(await env.OBJECTS.head(assetRow!.object_key)).not.toBeNull()
    expect(
      await env.DB.prepare('SELECT id FROM asset_versions WHERE object_key = ?')
        .bind(assetRow!.object_key)
        .first(),
    ).not.toBeNull()
  })

  it('dry-run performs no D1 or R2 writes', async () => {
    const archived = await archive('purge_dry', { versions: 2 })
    const beforeRows = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM documents WHERE id = ?1) AS documents,
         (SELECT COUNT(*) FROM document_versions WHERE document_id = ?1) AS versions,
         (SELECT purge_status FROM deletion_batches WHERE id = ?2) AS status`,
    )
      .bind(archived.documentId, archived.batchId)
      .first()
    const beforeKeys = await listKeys(`docs/${archived.documentId}/`)

    const report = await purge(true)

    expect(report).toMatchObject({
      dryRun: true,
      batches: [{ id: archived.batchId, documents: 1, versions: 2 }],
    })
    expect(
      await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM documents WHERE id = ?1) AS documents,
           (SELECT COUNT(*) FROM document_versions WHERE document_id = ?1) AS versions,
           (SELECT purge_status FROM deletion_batches WHERE id = ?2) AS status`,
      )
        .bind(archived.documentId, archived.batchId)
        .first(),
    ).toEqual(beforeRows)
    expect(await listKeys(`docs/${archived.documentId}/`)).toEqual(beforeKeys)
    await env.DB.prepare(
      'UPDATE deletion_batches SET created_at = ? WHERE id = ?',
    )
      .bind(YOUNG, archived.batchId)
      .run()
  })

  it('resumes after an R2 failure following the first chunk', async () => {
    const archived = await archive('purge_crash', { versions: 1001 })
    let calls = 0
    const failingBucket = bucketWithDelete(async (keys) => {
      calls += 1
      if (calls === 2) throw new Error('simulated R2 crash')
      await env.OBJECTS.delete(keys)
    })
    const failingLayer = makeCoreLayer(env, {
      objects: makeObjects(failingBucket),
    })
    const failed = await run(
      Effect.gen(function* () {
        return yield* (yield* Purge)
          .runPurge({ now: NOW, retentionDays: 30, dryRun: false })
          .pipe(Effect.either)
      }),
      failingLayer,
    )
    expect(failed).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'StorageError' },
    })
    expect((failed as { _tag: 'Left'; left: unknown }).left).toBeInstanceOf(
      StorageError,
    )
    const checkpoint = await env.DB.prepare(
      `SELECT purge_status, purge_progress, purged_bytes
           FROM deletion_batches WHERE id = ?`,
    )
      .bind(archived.batchId)
      .first<{
        purge_status: string
        purge_progress: string
        purged_bytes: number
      }>()
    expect(checkpoint).toMatchObject({
      purge_status: 'claimed',
      purged_bytes: expect.any(Number),
    })
    expect(JSON.parse(checkpoint!.purge_progress)).toEqual({
      deletedObjects: 1000,
      deletedVersions: 0,
      deletedDocuments: 0,
      cursor: expect.any(String),
    })
    expect(await listKeys(`docs/${archived.documentId}/`)).toHaveLength(1)

    const resumed = await purge(false, new Date(NOW.getTime() + 11 * 60_000))
    expect(resumed.batches[0]).toMatchObject({
      id: archived.batchId,
      versions: 1001,
    })
    expect(await listKeys(`docs/${archived.documentId}/`)).toEqual([])
  }, 120_000)

  it('resumes after an interruption during D1 cleanup', async () => {
    const archived = await archive('purge_d1_crash', { versions: 81 })
    const failingLayer = makeCoreLayer(env, { db: failDbBatchAt(2) })
    const failed = await run(
      Effect.gen(function* () {
        return yield* (yield* Purge)
          .runPurge({ now: NOW, retentionDays: 30, dryRun: false })
          .pipe(Effect.either)
      }),
      failingLayer,
    )

    expect(failed).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'PersistenceError' },
    })
    expect((failed as { _tag: 'Left'; left: unknown }).left).toBeInstanceOf(
      PersistenceError,
    )
    expect(await listKeys(`docs/${archived.documentId}/`)).toEqual([])
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM document_versions WHERE document_id = ?',
      )
        .bind(archived.documentId)
        .first(),
    ).toEqual({ count: 1 })
    const checkpoint = await env.DB.prepare(
      `SELECT purge_status, purge_progress
         FROM deletion_batches WHERE id = ?`,
    )
      .bind(archived.batchId)
      .first<{ purge_status: string; purge_progress: string }>()
    expect(checkpoint).toMatchObject({ purge_status: 'claimed' })
    expect(JSON.parse(checkpoint!.purge_progress)).toMatchObject({
      deletedObjects: 81,
      deletedVersions: 80,
      deletedDocuments: 0,
    })

    const resumed = await purge(false, new Date(NOW.getTime() + 11 * 60_000))

    expect(resumed.batches).toEqual([
      expect.objectContaining({
        id: archived.batchId,
        documents: 1,
        versions: 81,
      }),
    ])
    expect(
      await env.DB.prepare(
        `SELECT purge_status,
                (SELECT COUNT(*) FROM documents WHERE id = ?1) AS documents,
                (SELECT COUNT(*) FROM document_versions WHERE document_id = ?1) AS versions
           FROM deletion_batches WHERE id = ?2`,
      )
        .bind(archived.documentId, archived.batchId)
        .first(),
    ).toEqual({ purge_status: 'purged', documents: 0, versions: 0 })
  }, 120_000)

  it('deletes more than 1000 object keys in bounded R2 chunks', async () => {
    const archived = await archive('purge_chunks', { versions: 1001 })
    const chunks: number[] = []
    const countingBucket = bucketWithDelete(async (keys) => {
      chunks.push(typeof keys === 'string' ? 1 : keys.length)
      await env.OBJECTS.delete(keys)
    })
    const countingLayer = makeCoreLayer(env, {
      objects: makeObjects(countingBucket),
    })

    await purge(false, NOW, countingLayer)

    expect(chunks).toEqual([1000, 1])
    expect(await listKeys(`docs/${archived.documentId}/`)).toEqual([])
  }, 120_000)

  it('runs from the scheduled handler and logs structured JSON', async () => {
    const archived = await archive('purge_scheduled', {
      createdAt: '2020-01-01T00:00:00.000Z',
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const controller = createScheduledController({
        cron: '17 3 * * SUN',
        scheduledTime: new Date(),
      })
      const context = createExecutionContext()
      scheduled(controller, env, context)
      await waitOnExecutionContext(context)

      expect(
        await env.DB.prepare(
          'SELECT purge_status FROM deletion_batches WHERE id = ?',
        )
          .bind(archived.batchId)
          .first(),
      ).toEqual({ purge_status: 'purged' })
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        dryRun: false,
        batches: [{ id: archived.batchId }],
      })
    } finally {
      log.mockRestore()
    }
  })
})
