import { env as workerEnv } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  Documents,
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

async function setup(): Promise<PrincipalIdentity> {
  const seeded = await seedPrincipal(env, { suffix: 'documents_archive' })
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

describe('Documents', () => {
  it('soft deletes to trash and restores by batch id', async () => {
    const principal = await setup()
    const published = await run(
      Effect.gen(function* () {
        const service = yield* Publish
        return yield* service.publish(
          {
            html: '<!doctype html><title>Archive me</title><p>content</p>',
            idempotencyKey: 'documents-archive-create',
          },
          principal,
        )
      }),
    )
    const disabled = await run(
      Effect.gen(function* () {
        const service = yield* Documents
        return yield* service.disable(published.document.id, principal, 'review')
      }),
    )
    expect(disabled.disabledAt).not.toBeNull()
    const inspected = await run(
      Effect.gen(function* () {
        const service = yield* Documents
        return yield* service.get(published.document.id, principal)
      }),
    )
    expect(inspected.document.disabled).toBe(true)
    const enabled = await run(
      Effect.gen(function* () {
        const service = yield* Documents
        return yield* service.enable(published.document.id, principal)
      }),
    )
    expect(enabled.disabledAt).toBeNull()

    const deleted = await run(
      Effect.gen(function* () {
        const service = yield* Documents
        return yield* service.delete(published.document.id, principal)
      }),
    )
    expect(deleted).toMatchObject({ ok: true, deleted: 1 })

    const trash = await run(
      Effect.gen(function* () {
        const service = yield* Documents
        return yield* service.list({ scope: 'trash' }, principal)
      }),
    )
    expect(trash.documents.map((document) => document.id)).toContain(
      published.document.id,
    )
    expect(
      trash.documents.find((document) => document.id === published.document.id)?.deletedAt,
    ).not.toBeNull()

    const restored = await run(
      Effect.gen(function* () {
        const service = yield* Documents
        return yield* service.restore(
          published.document.id,
          deleted.batchId,
          principal,
        )
      }),
    )
    expect(restored.deletedAt).toBeNull()
    expect(restored.deletionBatchId).toBeNull()

    const after = await run(
      Effect.gen(function* () {
        const service = yield* Documents
        return yield* service.list({ scope: 'trash' }, principal)
      }),
    )
    expect(after.documents.map((document) => document.id)).not.toContain(
      published.document.id,
    )
  })
})
