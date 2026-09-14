import { DossierApi } from '@dossier/contracts'
import { FetchHttpClient, HttpApiClient } from '@effect/platform'
import { env as workerEnv } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import worker from '../src/worker'
import {
  Principal,
  Publish,
  State,
  apiError,
  errorResponse,
  makeDb,
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

  it('normalizes text input newlines the way the browser does', async () => {
    const { principal } = await setup('state_text_newlines')
    const published = await run(
      Effect.gen(function* () {
        return yield* (yield* Publish).publish(
          {
            html: `<!doctype html><html><head><title>Text newlines</title></head><body>
              <input data-state="title" value="first
second">
            </body></html>`,
            stateful: true,
            idempotencyKey: 'state-text-newlines',
          },
          principal,
        )
      }),
    )

    const initial = await run(
      Effect.gen(function* () {
        return yield* (yield* State).read(published.document.id, {
          kind: 'account',
          principal,
        })
      }),
    )
    expect(initial.fields.title?.value).toBe('firstsecond')

    const saved = await run(
      Effect.gen(function* () {
        return yield* (yield* State).save(
          published.document.id,
          { kind: 'account', principal },
          { changes: [{ name: 'title', value: 'saved\r\nvalue', base: 0 }] },
        )
      }),
    )
    expect(saved.fields.title?.value).toBe('savedvalue')
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

async function publishState(
  principal: PrincipalIdentity,
  suffix: string,
  html = statefulHtml(suffix),
  visibility?: 'public' | 'team' | 'private',
) {
  return run(
    Effect.gen(function* () {
      return yield* (yield* Publish).publish(
        {
          html,
          stateful: true,
          idempotencyKey: `state-save-${suffix}`,
          ...(visibility === undefined ? {} : { visibility }),
        },
        principal,
      )
    }),
  )
}

function saveState(
  documentId: string,
  principal: PrincipalIdentity,
  changes: readonly { name: string; value: unknown; base: number }[],
  version?: number,
) {
  return run(
    Effect.gen(function* () {
      return yield* (yield* State)
        .save(
          documentId,
          { kind: 'account', principal },
          { changes, ...(version === undefined ? {} : { version }) },
        )
        .pipe(Effect.either)
    }),
  )
}

async function stateRequest(
  path: string,
  token: string,
  environment: Cloudflare.Env,
  options: { readonly method?: string; readonly body?: unknown } = {},
): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${token}` })
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return worker.fetch(
    new Request(`https://dossier.test${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
    }) as Parameters<typeof worker.fetch>[0],
    environment,
  )
}

describe('State saves', () => {
  it('allows disjoint saves and reports the moved field for a stale base', async () => {
    const { principal } = await setup('state_conflicts')
    const published = await publishState(principal, 'state-conflicts')

    const objective = await saveState(published.document.id, principal, [
      { name: 'objective', value: 'Ship it', base: 0 },
    ])
    expect(objective).toMatchObject({
      _tag: 'Right',
      right: {
        revision: 1,
        fields: { objective: { value: 'Ship it', revision: 1 } },
      },
    })

    const approved = await saveState(published.document.id, principal, [
      { name: 'approved', value: true, base: 0 },
    ])
    expect(approved).toMatchObject({
      _tag: 'Right',
      right: {
        revision: 2,
        fields: {
          objective: { value: 'Ship it', revision: 1 },
          approved: { value: true, revision: 2 },
        },
      },
    })

    const stale = await saveState(published.document.id, principal, [
      { name: 'objective', value: 'Overwrite it', base: 0 },
    ])
    expect(stale).toMatchObject({
      _tag: 'Left',
      left: {
        code: 'state_conflict',
        status: 409,
        details: {
          fields: [{ name: 'objective', revision: 1, value: 'Ship it' }],
        },
      },
    })
  })

  it('reports a stale browser version before validating values', async () => {
    const { principal } = await setup('state_version_changed')
    const published = await publishState(principal, 'state-version-changed')

    const result = await saveState(
      published.document.id,
      principal,
      [{ name: 'objective', value: false, base: 0 }],
      0,
    )
    expect(result).toMatchObject({
      _tag: 'Left',
      left: {
        code: 'state_version_changed',
        status: 409,
        details: { currentVersion: 1 },
      },
    })
  })

  it('reports a version change when a publish races a CLI save', async () => {
    const { principal } = await setup('state_publish_race')
    const published = await publishState(principal, 'state-publish-race')
    const actualDb = makeDb(env.DB)
    let publishRaced = false
    const racingLayer = makeCoreLayer(env, {
      db: {
        ...actualDb,
        batch: (statements) =>
          Effect.gen(function* () {
            if (!publishRaced) {
              publishRaced = true
              yield* Effect.promise(() =>
                run(
                  Effect.gen(function* () {
                    return yield* (yield* Publish).publish(
                      {
                        html: statefulHtml('Published during state save'),
                        stateful: true,
                        documentId: published.document.id,
                        idempotencyKey: 'state-publish-race-version-two',
                      },
                      principal,
                    )
                  }),
                ),
              )
            }
            return yield* actualDb.batch(statements)
          }),
      },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* State)
          .save(
            published.document.id,
            { kind: 'account', principal },
            {
              changes: [{ name: 'objective', value: 'CLI draft', base: 0 }],
            },
          )
          .pipe(Effect.either)
      }).pipe(Effect.provide(racingLayer)),
    )

    expect(publishRaced).toBe(true)
    expect(result).toMatchObject({
      _tag: 'Left',
      left: {
        code: 'state_version_changed',
        status: 409,
        details: { currentVersion: 2 },
      },
    })
    const stateRow = await env.DB.prepare(
      'SELECT revision FROM document_state WHERE document_id = ?',
    )
      .bind(published.document.id)
      .first<{ revision: number }>()
    expect(stateRow?.revision).toBe(0)
  })

  it('validates field names, types, and the serialized 64 KiB cap', async () => {
    const { principal } = await setup('state_type_limits')
    const published = await publishState(principal, 'state-type-limits')

    const wrongType = await saveState(published.document.id, principal, [
      { name: 'approved', value: 'yes', base: 0 },
      { name: 'missing', value: true, base: 0 },
    ])
    expect(wrongType).toMatchObject({
      _tag: 'Left',
      left: {
        code: 'state_type_mismatch',
        status: 422,
        details: { fields: ['approved', 'missing'] },
      },
    })

    const tooLarge = await saveState(published.document.id, principal, [
      { name: 'notes', value: 'x'.repeat(64 * 1024), base: 0 },
    ])
    expect(tooLarge).toMatchObject({
      _tag: 'Left',
      left: {
        code: 'state_type_mismatch',
        status: 422,
        details: { fields: ['notes'] },
      },
    })
  })

  it('saves 200 fields through one JSON parameter', async () => {
    const { principal } = await setup('state_200_fields')
    const controls = Array.from(
      { length: 200 },
      (_, index) => `<input data-state="field_${index}" value="">`,
    ).join('')
    const published = await publishState(
      principal,
      'state-200-fields',
      `<!doctype html><html><head><title>Many fields</title></head><body>${controls}</body></html>`,
    )
    const result = await saveState(
      published.document.id,
      principal,
      Array.from({ length: 200 }, (_, index) => ({
        name: `field_${index}`,
        value: `value ${index}`,
        base: 0,
      })),
    )

    expect(result._tag).toBe('Right')
    if (result._tag === 'Right') {
      expect(Object.keys(result.right.fields)).toHaveLength(200)
      expect(result.right.fields.field_199).toEqual({
        value: 'value 199',
        revision: 1,
        type: 'text',
      })
    }
  })

  it('rejects a save that would exceed the 256 KiB document total', async () => {
    const { principal } = await setup('state_total_limit')
    const controls = Array.from(
      { length: 5 },
      (_, index) => `<textarea data-state="field_${index}"></textarea>`,
    ).join('')
    const published = await publishState(
      principal,
      'state-total-limit',
      `<!doctype html><html><head><title>Total cap</title></head><body>${controls}</body></html>`,
    )
    const result = await saveState(
      published.document.id,
      principal,
      Array.from({ length: 5 }, (_, index) => ({
        name: `field_${index}`,
        value: 'x'.repeat(60_000),
        base: 0,
      })),
    )

    expect(result).toMatchObject({
      _tag: 'Left',
      left: {
        code: 'state_too_large',
        status: 413,
        details: { limit: 256 * 1024 },
      },
    })
    if (result._tag === 'Left' && 'details' in result.left) {
      expect((result.left.details as { bytes: number }).bytes).toBeGreaterThan(
        256 * 1024,
      )
    }
  })

  it('re-checks account, document, and editor authority at save time', async () => {
    const owner = await setup('state_authority_owner')
    const published = await publishState(
      owner.principal,
      'state-authority',
      statefulHtml('State authority'),
      'public',
    )

    await env.DB.prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?')
      .bind('2026-09-14T12:00:00.000Z', owner.principal.accountId)
      .run()
    const disabledAccount = await saveState(
      published.document.id,
      owner.principal,
      [{ name: 'approved', value: true, base: 0 }],
    )
    expect(disabledAccount).toMatchObject({
      _tag: 'Left',
      left: { code: 'state_edit_required', status: 403 },
    })

    const outsider = await setup('state_authority_outsider')
    const nonEditor = await saveState(
      published.document.id,
      outsider.principal,
      [{ name: 'approved', value: true, base: 0 }],
    )
    expect(nonEditor).toMatchObject({
      _tag: 'Left',
      left: { code: 'state_edit_required', status: 403 },
    })

    const publicActor = await run(
      Effect.gen(function* () {
        return yield* (yield* State)
          .save(
            published.document.id,
            { kind: 'public' },
            { changes: [{ name: 'approved', value: true, base: 0 }] },
          )
          .pipe(Effect.either)
      }),
    )
    expect(publicActor).toMatchObject({
      _tag: 'Left',
      left: { code: 'state_edit_required', status: 403 },
    })

    const stateRow = await env.DB.prepare(
      'SELECT revision FROM document_state WHERE document_id = ?',
    )
      .bind(published.document.id)
      .first<{ revision: number }>()
    expect(stateRow?.revision).toBe(0)
  })

  it.each([
    ['archived', 'deleted_at'],
    ['disabled', 'disabled_at'],
  ] as const)('refuses an %s document', async (suffix, column) => {
    const { principal } = await setup(`state_${suffix}_document`)
    const published = await publishState(principal, `state-${suffix}-document`)
    await env.DB.prepare(`UPDATE documents SET ${column} = ? WHERE id = ?`)
      .bind('2026-09-14T12:00:00.000Z', published.document.id)
      .run()

    const result = await saveState(published.document.id, principal, [
      { name: 'approved', value: true, base: 0 },
    ])
    expect(result).toMatchObject({
      _tag: 'Left',
      left: { code: 'not_found', status: 404 },
    })
  })

  it('writes the state_saved event and returns the full snapshot', async () => {
    const { principal, token } = await setup('state_event')
    const published = await publishState(principal, 'state-event')
    const response = await stateRequest(
      `/api/documents/${published.document.id}/state`,
      token,
      env,
      {
        method: 'PUT',
        body: {
          changes: [{ name: 'notes', value: 'Ready', base: 0 }],
        },
      },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      documentId: published.document.id,
      version: 1,
      revision: 1,
      data: {
        objective: 'Launch the new website',
        approved: false,
        notes: 'Ready',
      },
      fields: {
        objective: { revision: 0, type: 'text' },
        approved: { revision: 0, type: 'checkbox' },
        notes: { value: 'Ready', revision: 1, type: 'textarea' },
      },
    })

    const event = await env.DB.prepare(
      `SELECT document_version_id, account_id, api_key_id, metadata_json
         FROM upload_events
        WHERE document_id = ? AND event_type = 'state_saved'`,
    )
      .bind(published.document.id)
      .first<{
        document_version_id: string
        account_id: string
        api_key_id: string
        metadata_json: string
      }>()
    expect(event).toMatchObject({
      account_id: principal.accountId,
      api_key_id: principal.apiKeyId,
    })
    expect(JSON.parse(event?.metadata_json ?? 'null')).toEqual({
      names: ['notes'],
      actorKind: 'account',
    })
  })

  it('shares one 60-request limiter key between reads and writes', async () => {
    const { principal, token } = await setup('state_rate_limit')
    const published = await publishState(principal, 'state-rate-limit')
    let calls = 0
    const keys = new Set<string>()
    const limitedEnv = {
      ...env,
      STATE_RATE_LIMITER: {
        limit: async ({ key }: RateLimitOptions) => {
          calls += 1
          keys.add(key)
          return { success: calls <= 60 }
        },
      },
    } as Cloudflare.Env
    const path = `/api/documents/${published.document.id}/state`

    for (let index = 0; index < 59; index += 1) {
      const response = await stateRequest(path, token, limitedEnv)
      expect(response.status).toBe(200)
    }
    const write = await stateRequest(path, token, limitedEnv, {
      method: 'PUT',
      body: { changes: [{ name: 'approved', value: true, base: 0 }] },
    })
    expect(write.status).toBe(200)

    const limited = await stateRequest(path, token, limitedEnv)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(await limited.json()).toMatchObject({
      ok: false,
      code: 'rate_limited',
    })
    expect(calls).toBe(61)
    expect([...keys]).toEqual([
      `document:${published.document.id}:account:${principal.accountId}`,
    ])
  })

  it('gates alternate state routes after framework matching', async () => {
    const { principal, token } = await setup('state_route_gate')
    const published = await publishState(principal, 'state-route-gate')
    const id = published.document.id
    const path = `/api/documents/${id}/state`
    const encodedId = `%${id.charCodeAt(0).toString(16)}${id.slice(1)}`
    const requests: readonly {
      readonly path: string
      readonly options?: {
        readonly method?: string
        readonly body?: unknown
      }
    }[] = [
      { path },
      {
        path: `/api/documents/${encodedId}/state`,
        options: {
          method: 'PUT',
          body: { changes: [{ name: 'approved', value: true, base: 0 }] },
        },
      },
      { path: `${path}/` },
      { path: `/api/documents//${id}//state` },
      { path, options: { method: 'HEAD' } },
    ]
    const keys: string[] = []
    const rejecting = {
      ...env,
      STATE_RATE_LIMITER: {
        limit: async ({ key }: RateLimitOptions) => {
          keys.push(key)
          return { success: false }
        },
      },
    } as Cloudflare.Env

    for (const request of requests) {
      const response = await stateRequest(
        request.path,
        token,
        rejecting,
        request.options,
      )
      expect(response.status, request.path).toBe(429)
    }
    expect(keys).toEqual(
      requests.map(() => `document:${id}:account:${principal.accountId}`),
    )

    const production = {
      ...env,
      PUBLIC_BASE_URL: 'https://dossier.agent964.com',
    } as Partial<Cloudflare.Env>
    delete production.STATE_RATE_LIMITER
    for (const request of requests) {
      const response = await stateRequest(
        request.path,
        token,
        production as Cloudflare.Env,
        request.options,
      )
      expect(response.status, request.path).toBe(503)
    }

    const stateRow = await env.DB.prepare(
      'SELECT revision FROM document_state WHERE document_id = ?',
    )
      .bind(id)
      .first<{ revision: number }>()
    expect(stateRow?.revision).toBe(0)
  })

  it('fails closed without the production state limiter and hides health', async () => {
    const { principal, token } = await setup('state_missing_limiter')
    const published = await publishState(principal, 'state-missing-limiter')
    const production = {
      ...env,
      PUBLIC_BASE_URL: 'https://dossier.agent964.com',
    } as Partial<Cloudflare.Env>
    delete production.STATE_RATE_LIMITER

    const response = await stateRequest(
      `/api/documents/${published.document.id}/state`,
      token,
      production as Cloudflare.Env,
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'state_unavailable',
    })

    const health = await worker.fetch(
      new Request('https://dossier.test/api/healthz') as Parameters<
        typeof worker.fetch
      >[0],
      production as Cloudflare.Env,
    )
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ features: [] })
  })

  it('decodes real state error envelopes through the derived client', async () => {
    const responses = [
      errorResponse(
        apiError('state_conflict', 'A saved value moved.', {
          fields: [{ name: 'approved', revision: 3, value: true }],
        }),
      ),
      errorResponse(
        apiError('state_unavailable', 'Saved values are unavailable.'),
      ),
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift()!.clone()),
    )

    try {
      const client = await Effect.runPromise(
        HttpApiClient.make(DossierApi, {
          baseUrl: 'https://dossier.test',
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      )
      const conflict = await Effect.runPromise(
        Effect.flip(
          client.state.set({
            path: { id: 'abcdefghijkl' },
            payload: { changes: [] },
          }),
        ),
      )
      expect(conflict).toEqual({
        ok: false,
        code: 'state_conflict',
        message: 'A saved value moved.',
        details: {
          fields: [{ name: 'approved', revision: 3, value: true }],
        },
      })

      const unavailable = await Effect.runPromise(
        Effect.flip(client.state.get({ path: { id: 'abcdefghijkl' } })),
      )
      expect(unavailable).toEqual({
        ok: false,
        code: 'state_unavailable',
        message: 'Saved values are unavailable.',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
