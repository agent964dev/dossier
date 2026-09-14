import { env as workerEnv } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import worker from '../src/worker'
import {
  Principal,
  Publish,
  State,
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

async function setup(suffix: string): Promise<{
  readonly principal: PrincipalIdentity
  readonly token: string
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

function statefulHtml(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>
    <input data-state="objective" value="Launch the new website">
    <input data-state="approved" type="checkbox">
    <textarea data-state="notes">Initial notes</textarea>
  </body></html>`
}

describe('State', () => {
  it('rejects reads for an ordinary document', async () => {
    const { principal, token } = await setup('state_not_enabled')
    const published = await run(
      Effect.gen(function* () {
        return yield* (yield* Publish).publish(
          {
            html: '<!doctype html><title>Ordinary</title><p>content</p>',
            idempotencyKey: 'state-not-enabled',
          },
          principal,
        )
      }),
    )

    const result = await run(
      Effect.gen(function* () {
        return yield* (yield* State)
          .read(published.document.id, { kind: 'account', principal })
          .pipe(Effect.either)
      }),
    )
    expect(result).toMatchObject({
      _tag: 'Left',
      left: { code: 'state_not_enabled', status: 409 },
    })

    const response = await worker.fetch(
      new Request(
        `https://dossier.test/api/documents/${published.document.id}/state`,
        { headers: { authorization: `Bearer ${token}` } },
      ) as Parameters<typeof worker.fetch>[0],
      env,
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'state_not_enabled',
    })
  })

  it('returns authored defaults at revision zero', async () => {
    const { principal } = await setup('state_defaults')
    const published = await run(
      Effect.gen(function* () {
        return yield* (yield* Publish).publish(
          {
            html: statefulHtml('State defaults'),
            stateful: true,
            idempotencyKey: 'state-defaults',
          },
          principal,
        )
      }),
    )

    const snapshot = await run(
      Effect.gen(function* () {
        return yield* (yield* State).read(published.document.id, {
          kind: 'account',
          principal,
        })
      }),
    )
    expect(snapshot).toEqual({
      documentId: published.document.id,
      version: 1,
      revision: 0,
      updatedAt: null,
      fields: {
        objective: {
          value: 'Launch the new website',
          revision: 0,
          type: 'text',
        },
        approved: { value: false, revision: 0, type: 'checkbox' },
        notes: { value: 'Initial notes', revision: 0, type: 'textarea' },
      },
      canSave: true,
      viewer: 'editor',
    })
  })

  it('includes saved fields absent from the current manifest', async () => {
    const { principal, token } = await setup('state_orphan')
    const published = await run(
      Effect.gen(function* () {
        return yield* (yield* Publish).publish(
          {
            html: statefulHtml('Orphaned state'),
            stateful: true,
            idempotencyKey: 'state-orphan',
          },
          principal,
        )
      }),
    )
    const updatedAt = '2026-09-14T09:15:00.000Z'
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE document_state
            SET revision = 4, updated_at = ?
          WHERE document_id = ?`,
      ).bind(updatedAt, published.document.id),
      env.DB.prepare(
        `INSERT INTO document_state_fields
           (document_id, name, type, value_json, revision, updated_by,
            updated_at)
         VALUES (?, 'removed', 'text', ?, 4, 'account:test', ?)`,
      ).bind(published.document.id, JSON.stringify('keep me'), updatedAt),
    ])

    const snapshot = await run(
      Effect.gen(function* () {
        return yield* (yield* State).read(published.document.id, {
          kind: 'account',
          principal,
        })
      }),
    )
    expect(snapshot.fields.removed).toEqual({
      value: 'keep me',
      revision: 4,
      type: 'text',
    })

    const response = await worker.fetch(
      new Request(
        `https://dossier.test/api/documents/${published.document.id}/state`,
        { headers: { authorization: `Bearer ${token}` } },
      ) as Parameters<typeof worker.fetch>[0],
      env,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      revision: 4,
      updatedAt,
      data: { removed: 'keep me' },
      fields: {
        removed: { value: 'keep me', revision: 4, type: 'text' },
      },
    })
  })

  it('preserves a __proto__ field through state reads and HTTP', async () => {
    const { principal, token } = await setup('state_proto')
    const published = await run(
      Effect.gen(function* () {
        return yield* (yield* Publish).publish(
          {
            html: `<!doctype html><html><head><title>Special name</title></head><body>
              <input data-state="__proto__" value="keep me">
            </body></html>`,
            stateful: true,
            idempotencyKey: 'state-proto',
          },
          principal,
        )
      }),
    )

    const snapshot = await run(
      Effect.gen(function* () {
        return yield* (yield* State).read(published.document.id, {
          kind: 'account',
          principal,
        })
      }),
    )
    expect(Object.hasOwn(snapshot.fields, '__proto__')).toBe(true)
    expect(snapshot.fields.__proto__).toEqual({
      value: 'keep me',
      revision: 0,
      type: 'text',
    })

    const response = await worker.fetch(
      new Request(
        `https://dossier.test/api/documents/${published.document.id}/state`,
        { headers: { authorization: `Bearer ${token}` } },
      ) as Parameters<typeof worker.fetch>[0],
      env,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: Record<string, unknown>
      fields: Record<string, unknown>
    }
    expect(Object.hasOwn(body.data, '__proto__')).toBe(true)
    expect(body.data.__proto__).toBe('keep me')
    expect(Object.hasOwn(body.fields, '__proto__')).toBe(true)
  })

  it('serves the StateResponse data and per-field revisions', async () => {
    const { principal, token } = await setup('state_api')
    const published = await run(
      Effect.gen(function* () {
        return yield* (yield* Publish).publish(
          {
            html: statefulHtml('State API'),
            stateful: true,
            visibility: 'public',
            idempotencyKey: 'state-api',
          },
          principal,
        )
      }),
    )

    const publicSnapshot = await run(
      Effect.gen(function* () {
        return yield* (yield* State).read(published.document.id, {
          kind: 'public',
        })
      }),
    )
    expect(publicSnapshot).toMatchObject({ canSave: false, viewer: 'reader' })

    const response = await worker.fetch(
      new Request(
        `https://dossier.test/api/documents/${published.document.id}/state`,
        { headers: { authorization: `Bearer ${token}` } },
      ) as Parameters<typeof worker.fetch>[0],
      env,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      documentId: published.document.id,
      version: 1,
      revision: 0,
      updatedAt: null,
      data: {
        objective: 'Launch the new website',
        approved: false,
        notes: 'Initial notes',
      },
      fields: {
        objective: {
          value: 'Launch the new website',
          revision: 0,
          type: 'text',
        },
        approved: { value: false, revision: 0, type: 'checkbox' },
        notes: { value: 'Initial notes', revision: 0, type: 'textarea' },
      },
    })
  })
})
