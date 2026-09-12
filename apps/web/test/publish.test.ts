import { env as workerEnv } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  makeDb,
  PersistenceError,
  Principal,
  Publish,
  type PrincipalIdentity,
} from '../src/services'
import { makeCoreLayer, seedPrincipal, testEnv } from './core-helpers'

const env = testEnv(workerEnv)
const layer = makeCoreLayer(env)

function run<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>,
  )
}

async function setup(suffix: string): Promise<PrincipalIdentity> {
  const seeded = await seedPrincipal(env, { suffix })
  return run(
    Effect.gen(function* () {
      const service = yield* Principal
      return yield* service.resolve(
        new Request('https://dossier.test/api/uploads', {
          headers: { authorization: `Bearer ${seeded.token}` },
        }),
      )
    }),
  )
}

function publish(
  principal: PrincipalIdentity,
  payload: Parameters<import('../src/services').PublishService['publish']>[0],
) {
  return run(
    Effect.gen(function* () {
      const service = yield* Publish
      return yield* service.publish(payload, principal)
    }),
  )
}

function publishEither(
  principal: PrincipalIdentity,
  payload: Parameters<import('../src/services').PublishService['publish']>[0],
) {
  return run(
    Effect.gen(function* () {
      const service = yield* Publish
      return yield* service.publish(payload, principal).pipe(Effect.either)
    }),
  )
}

function html(title: string, body = title): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
}

describe('Publish', () => {
  it('starts at version 1 and allocates distinct concurrent version numbers', async () => {
    const principal = await setup('publish_versions')
    const first = await publish(principal, {
      html: html('Version one'),
      idempotencyKey: 'publish-versions-first',
    })
    expect(first.versionNumber).toBe(1)

    const next = await Promise.all([
      publish(principal, {
        html: html('Version two'),
        documentId: first.document.id,
        idempotencyKey: 'publish-versions-two',
      }),
      publish(principal, {
        html: html('Version three'),
        documentId: first.document.id,
        idempotencyKey: 'publish-versions-three',
      }),
    ])
    expect(next.map((result) => result.versionNumber).sort()).toEqual([2, 3])
    const document = await env.DB.prepare(
      `SELECT next_version_number FROM documents WHERE id = ?`,
    )
      .bind(first.document.id)
      .first<{ next_version_number: number }>()
    expect(document?.next_version_number).toBe(4)
  })

  it('rolls back counters, pointers, versions, and events when a SQL guard fails', async () => {
    const principal = await setup('publish_guard')
    const first = await publish(principal, {
      html: html('Guard baseline'),
      idempotencyKey: 'publish-guard-baseline',
    })
    const before = await env.DB.prepare(
      `SELECT next_version_number, current_version_id, revision,
              (SELECT COUNT(*) FROM document_versions WHERE document_id = d.id) AS versions,
              (SELECT COUNT(*) FROM upload_events WHERE document_id = d.id) AS events
         FROM documents d WHERE id = ?`,
    )
      .bind(first.document.id)
      .first()

    await env.DB.prepare(
      `CREATE TRIGGER test_publication_guard_failure
       BEFORE INSERT ON publication_guards
       BEGIN
         SELECT RAISE(ABORT, 'CHECK constraint failed: publication_guards_ok_check');
       END`,
    ).run()
    try {
      const result = await publishEither(principal, {
        html: html('Guard should fail'),
        documentId: first.document.id,
        idempotencyKey: 'publish-guard-failure',
      })
      expect(result).toMatchObject({ _tag: 'Left', left: { code: 'conflict' } })
    } finally {
      await env.DB.prepare(
        'DROP TRIGGER IF EXISTS test_publication_guard_failure',
      ).run()
    }

    const after = await env.DB.prepare(
      `SELECT next_version_number, current_version_id, revision,
              (SELECT COUNT(*) FROM document_versions WHERE document_id = d.id) AS versions,
              (SELECT COUNT(*) FROM upload_events WHERE document_id = d.id) AS events
         FROM documents d WHERE id = ?`,
    )
      .bind(first.document.id)
      .first()
    expect(after).toEqual(before)
  })

  it('deletes the attempted R2 object after a definite D1 failure', async () => {
    const principal = await setup('publish_compensation')
    const first = await publish(principal, {
      html: html('Compensation baseline'),
      idempotencyKey: 'publish-compensation-baseline',
    })
    const prefix = `docs/${first.document.id}/`
    const before = await env.OBJECTS.list({ prefix })

    await env.DB.prepare(
      `CREATE TRIGGER test_publication_d1_failure
       BEFORE INSERT ON upload_events
       BEGIN SELECT RAISE(ABORT, 'forced d1 failure'); END`,
    ).run()
    try {
      const result = await publishEither(principal, {
        html: html('Compensation should fail'),
        documentId: first.document.id,
        idempotencyKey: 'publish-compensation-failure',
      })
      expect(result).toMatchObject({
        _tag: 'Left',
        left: { _tag: 'PersistenceError' },
      })
    } finally {
      await env.DB.prepare(
        'DROP TRIGGER IF EXISTS test_publication_d1_failure',
      ).run()
    }

    const after = await env.OBJECTS.list({ prefix })
    expect(after.objects.map((object) => object.key).sort()).toEqual(
      before.objects.map((object) => object.key).sort(),
    )
  })

  it.each(['D1 internal error', 'unexpected proxy response'])(
    'retains the R2 object when a committed batch reports an ambiguous %s',
    async (message) => {
      const principal = await setup(
        `publish_ambiguous_${message.replaceAll(' ', '_')}`,
      )
      const actualDb = makeDb(env.DB)
      const ambiguousLayer = makeCoreLayer(env, {
        db: {
          ...actualDb,
          batch: (statements) =>
            actualDb.batch(statements).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new PersistenceError({
                    operation: 'D1 batch',
                    cause: new Error(message),
                  }),
                ),
              ),
            ),
        },
      })
      const idempotencyKey = `ambiguous-${message.replaceAll(' ', '-')}`
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* Publish
          return yield* service
            .publish(
              { html: html('Committed despite response'), idempotencyKey },
              principal,
            )
            .pipe(Effect.either)
        }).pipe(Effect.provide(ambiguousLayer)),
      )
      expect(result).toMatchObject({
        _tag: 'Left',
        left: { _tag: 'PersistenceError' },
      })

      const committed = await env.DB.prepare(
        `SELECT object_key FROM document_versions
          WHERE created_by_api_key_id = ? AND idempotency_key = ?`,
      )
        .bind(principal.apiKeyId, idempotencyKey)
        .first<{ object_key: string }>()
      expect(committed).not.toBeNull()
      expect(await env.OBJECTS.head(committed!.object_key)).not.toBeNull()
    },
  )

  it('returns the same receipt for the same key and request hash', async () => {
    const principal = await setup('publish_retry')
    const payload = {
      html: html('Idempotent retry'),
      idempotencyKey: 'publish-same-hash',
    }
    const first = await publish(principal, payload)
    const retry = await publish(principal, payload)
    expect(retry.document.id).toBe(first.document.id)
    expect(retry.versionNumber).toBe(first.versionNumber)
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM document_versions
        WHERE created_by_api_key_id = ? AND idempotency_key = ?`,
    )
      .bind(principal.apiKeyId, payload.idempotencyKey)
      .first<{ count: number }>()
    expect(count?.count).toBe(1)
  })

  it('rejects the same idempotency key with a different hash', async () => {
    const principal = await setup('publish_conflict')
    await publish(principal, {
      html: html('First idempotent body'),
      idempotencyKey: 'publish-different-hash',
    })
    const result = await publishEither(principal, {
      html: html('Different idempotent body'),
      idempotencyKey: 'publish-different-hash',
    })
    expect(result).toMatchObject({
      _tag: 'Left',
      left: { code: 'idempotency_conflict' },
    })
  })

  it('coalesces simultaneous same-key creates into one document', async () => {
    const principal = await setup('publish_same_key_create')
    const payload = {
      html: html('Concurrent idempotent create'),
      idempotencyKey: 'publish-concurrent-create',
    }
    const [left, right] = await Promise.all([
      publish(principal, payload),
      publish(principal, payload),
    ])
    expect(right.document.id).toBe(left.document.id)
    expect(right.versionNumber).toBe(1)
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ? AND created_by = ?`,
    )
      .bind(principal.workspaceId, principal.accountId)
      .first<{ count: number }>()
    expect(count?.count).toBe(1)
  })

  it('returns the original document snapshot after an intervening publication', async () => {
    const principal = await setup('publish_stable_receipt')
    const originalPayload = {
      html: html('Stable original'),
      kind: 'plan',
      description: 'The original description',
      visibility: 'private' as const,
      idempotencyKey: 'publish-stable-original',
    }
    const first = await publish(principal, originalPayload)
    const second = await publish(principal, {
      html: html('Changed later'),
      documentId: first.document.id,
      kind: 'report',
      description: 'A later description',
      visibility: 'team',
      idempotencyKey: 'publish-stable-second',
    })
    expect(second.document.latestVersionNumber).toBe(2)

    const retry = await publish(principal, originalPayload)
    expect(retry.versionNumber).toBe(1)
    expect(retry.document).toEqual(first.document)
  })

  it('rejects an empty idempotency key before writing', async () => {
    const principal = await setup('publish_empty_idempotency')
    const result = await publishEither(principal, {
      html: html('Empty idempotency'),
      idempotencyKey: '',
    })
    expect(result).toMatchObject({
      _tag: 'Left',
      left: { code: 'policy_rejected' },
    })
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM documents WHERE created_by = ?',
    )
      .bind(principal.accountId)
      .first<{ count: number }>()
    expect(count?.count).toBe(0)
  })

  it('rejects parent placement until tree support ships', async () => {
    const principal = await setup('publish_parent_unsupported')
    const result = await publishEither(principal, {
      html: html('Unsupported parent'),
      parentId: 'aaaaaaaaaaaa',
      idempotencyKey: 'publish-parent-unsupported',
    })
    expect(result).toMatchObject({
      _tag: 'Left',
      left: {
        code: 'policy_rejected',
        message: expect.stringContaining('phase 2'),
      },
    })
  })

  it('rejects conflicting documentId and legacy draftId', async () => {
    const principal = await setup('publish_legacy_conflict')
    const result = await publishEither(principal, {
      html: html('Legacy conflict'),
      documentId: 'aaaaaaaaaaaa',
      draftId: 'bbbbbbbbbbbb',
      idempotencyKey: 'publish-legacy-conflict',
    })
    expect(result).toMatchObject({
      _tag: 'Left',
      left: { code: 'policy_rejected' },
    })
  })
})
