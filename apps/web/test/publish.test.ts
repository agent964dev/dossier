import { env as workerEnv } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import worker from '../src/worker'
import {
  makeDb,
  makeObjects,
  PersistenceError,
  Principal,
  Publish,
  State,
  compareManifests,
  type DbService,
  type PrincipalIdentity,
} from '../src/services'
import { makeCoreLayer, seedPrincipal, sha256, testEnv } from './core-helpers'

const env = testEnv(workerEnv)
const layer = makeCoreLayer(env)

function run<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>,
  )
}

async function setupWithToken(suffix: string): Promise<{
  readonly principal: PrincipalIdentity
  readonly token: string
}> {
  const seeded = await seedPrincipal(env, { suffix })
  const principal = await run(
    Effect.gen(function* () {
      const service = yield* Principal
      return yield* service.resolve(
        new Request('https://dossier.test/api/uploads', {
          headers: { authorization: `Bearer ${seeded.token}` },
        }),
      )
    }),
  )
  return { principal, token: seeded.token }
}

async function setup(suffix: string): Promise<PrincipalIdentity> {
  return (await setupWithToken(suffix)).principal
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

function statefulHtml(title: string, fields: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${fields}</body></html>`
}

function saveState(
  principal: PrincipalIdentity,
  documentId: string,
  changes: readonly {
    readonly name: string
    readonly value: unknown
    readonly base: number
  }[],
) {
  return run(
    Effect.gen(function* () {
      return yield* (yield* State).save(
        documentId,
        { kind: 'account', principal },
        { changes },
      )
    }),
  )
}

function readState(principal: PrincipalIdentity, documentId: string) {
  return run(
    Effect.gen(function* () {
      return yield* (yield* State).read(documentId, {
        kind: 'account',
        principal,
      })
    }),
  )
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

function failPublicationStateContextAt(call: number): DbService {
  const base = makeDb(env.DB)
  let contextReads = 0
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrap(target.bind(...values))
        }
        if (property === 'all') {
          return async () => {
            contextReads += 1
            if (contextReads === call) {
              throw new Error('simulated publication state context failure')
            }
            return target.all()
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
          return query.includes(
            'SELECT d.current_version_id, current.state_fields_json',
          )
            ? wrap(statement)
            : statement
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ...base, raw }
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

  it('cleans R2 when a retry context read fails after rollback', async () => {
    const principal = await setup('publish_retry_context_cleanup')
    const first = await publish(principal, {
      html: statefulHtml(
        'Retry context cleanup',
        '<textarea data-state="notes">Initial</textarea>',
      ),
      stateful: true,
      idempotencyKey: 'publish-retry-context-cleanup-baseline',
    })
    const prefix = `docs/${first.document.id}/`
    const before = await env.OBJECTS.list({ prefix })
    const failingLayer = makeCoreLayer(env, {
      db: failPublicationStateContextAt(2),
    })

    await env.DB.prepare(
      `CREATE TRIGGER test_publication_retry_context_failure
       BEFORE INSERT ON publication_guards
       BEGIN
         SELECT RAISE(ABORT, 'CHECK constraint failed: publication_guards_ok_check');
       END`,
    ).run()
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Publish)
            .publish(
              {
                html: statefulHtml(
                  'Retry context should fail',
                  '<textarea data-state="notes">Initial</textarea>',
                ),
                documentId: first.document.id,
              },
              principal,
            )
            .pipe(Effect.either)
        }).pipe(Effect.provide(failingLayer)),
      )
      expect(result).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'PersistenceError',
          operation: 'load publication state context',
        },
      })
    } finally {
      await env.DB.prepare(
        'DROP TRIGGER IF EXISTS test_publication_retry_context_failure',
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

  it.each([
    {
      name: 'duplicate saved-value names',
      html: `<!doctype html><html><head><title>Duplicate</title></head><body>
  <input data-state="notes">
  <textarea data-state="notes"></textarea>
</body></html>`,
      error:
        'data-state "notes" is declared twice: line 2 col 3 and line 3 col 3',
    },
    {
      name: 'a missing literal head',
      html: '<!doctype html><html><body><input data-state="notes"></body></html>',
      error: 'Stateful HTML must contain exactly one literal <head> start tag.',
    },
  ])('returns policy errors for $name', async ({ html: source, error }) => {
    const { token } = await setupWithToken(
      `publish_policy_${error.startsWith('data-state') ? 'duplicate' : 'head'}`,
    )
    const response = await worker.fetch(
      new Request('https://dossier.test/api/uploads', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          html: source,
          stateful: true,
          idempotencyKey: `policy-${error.length}`,
        }),
      }) as Parameters<typeof worker.fetch>[0],
      env,
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'policy_rejected',
      details: { errors: [error] },
    })
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

  it('returns not_found for an unreadable or missing parent', async () => {
    const principal = await setup('publish_parent_unsupported')
    const result = await publishEither(principal, {
      html: html('Unsupported parent'),
      parentId: 'aaaaaaaaaaaa',
      idempotencyKey: 'publish-parent-unsupported',
    })
    expect(result).toMatchObject({
      _tag: 'Left',
      left: { code: 'not_found' },
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

  it('persists stylesheet_refs on the document_versions row for a linked stylesheet', async () => {
    const principal = await setup('publish_stylesheet_refs')
    const linked =
      '<!doctype html><html><head><title>Themed</title>' +
      '<link rel="stylesheet" href="/a/theme.css"></head><body>Themed</body></html>'
    const receipt = await publish(principal, {
      html: linked,
      idempotencyKey: 'publish-stylesheet-refs',
    })
    const row = await env.DB.prepare(
      `SELECT stylesheet_refs FROM document_versions
        WHERE document_id = ? AND version_number = ?`,
    )
      .bind(receipt.document.id, receipt.versionNumber)
      .first<{ stylesheet_refs: string | null }>()
    expect(JSON.parse(row?.stylesheet_refs ?? 'null')).toEqual(['/a/theme.css'])
  })

  it('stores the state manifest and initializes document state', async () => {
    const principal = await setup('publish_state_manifest')
    const stateful = `<!doctype html><html><head><title>Saved values</title></head><body>
      <input data-state="objective" value="Ship it">
      <input data-state="approved" type="checkbox" checked>
    </body></html>`
    const receipt = await publish(principal, {
      html: stateful,
      stateful: true,
      idempotencyKey: 'publish-state-manifest',
    })

    expect(receipt.document).toMatchObject({
      stateful: true,
      stateRevision: 0,
      stateUpdatedAt: null,
    })
    const row = await env.DB.prepare(
      `SELECT d.stateful, v.state_fields_json, state.revision,
              state.updated_at
         FROM documents d
         JOIN document_versions v ON v.id = d.current_version_id
         JOIN document_state state ON state.document_id = d.id
        WHERE d.id = ?`,
    )
      .bind(receipt.document.id)
      .first<{
        stateful: number
        state_fields_json: string
        revision: number
        updated_at: string | null
      }>()
    expect(row).toMatchObject({
      stateful: 1,
      revision: 0,
      updated_at: null,
    })
    expect(JSON.parse(row!.state_fields_json)).toEqual([
      { name: 'objective', type: 'text', default: 'Ship it' },
      { name: 'approved', type: 'checkbox', default: true },
    ])
  })

  it('enables saved values idempotently and never disables them', async () => {
    const principal = await setup('publish_state_enable')
    const ordinary = await publish(principal, {
      html: html('Enable later'),
      idempotencyKey: 'publish-state-enable-create',
    })
    const enabling = {
      html: html('Enable now'),
      documentId: ordinary.document.id,
      stateful: true,
      idempotencyKey: 'publish-state-enable-update',
    }
    const enabled = await publish(principal, enabling)
    const retry = await publish(principal, enabling)
    expect(retry.versionNumber).toBe(enabled.versionNumber)

    const continued = await publish(principal, {
      html: html('Still enabled'),
      documentId: ordinary.document.id,
      idempotencyKey: 'publish-state-enable-continued',
    })
    expect(continued.document.stateful).toBe(true)
    const rows = await env.DB.prepare(
      `SELECT d.stateful,
              (SELECT COUNT(*) FROM document_state state
                WHERE state.document_id = d.id) AS state_rows,
              v.state_fields_json
         FROM documents d
         JOIN document_versions v ON v.id = d.current_version_id
        WHERE d.id = ?`,
    )
      .bind(ordinary.document.id)
      .first<{
        stateful: number
        state_rows: number
        state_fields_json: string | null
      }>()
    expect(rows).toEqual({
      stateful: 1,
      state_rows: 1,
      state_fields_json: '[]',
    })
  })

  it('includes stateful and the manifest in the request hash', async () => {
    const principal = await setup('publish_state_hash')
    const source = html('State hash')
    const ordinary = await publish(principal, {
      html: source,
      idempotencyKey: 'publish-state-hash-ordinary',
    })
    const stateful = await publish(principal, {
      html: source,
      stateful: true,
      idempotencyKey: 'publish-state-hash-stateful',
    })
    const hashes = await env.DB.prepare(
      `SELECT document_id, request_hash FROM document_versions
        WHERE document_id IN (?, ?)`,
    )
      .bind(ordinary.document.id, stateful.document.id)
      .all<{ document_id: string; request_hash: string }>()
    const byDocument = new Map(
      hashes.results.map((row) => [row.document_id, row.request_hash]),
    )
    const common = {
      htmlHash: await sha256(source),
      target: { create: true },
      parent: { present: false },
      kind: { present: false },
      description: { present: false },
      visibility: { present: false },
      shares: { present: false },
      metadata: { present: false },
      filename: { present: false },
    }
    expect(byDocument.get(ordinary.document.id)).toBe(
      await sha256(
        canonicalJson({
          ...common,
          stateful: false,
          manifest: null,
          acceptStateChanges: false,
        }),
      ),
    )
    expect(byDocument.get(stateful.document.id)).toBe(
      await sha256(
        canonicalJson({
          ...common,
          stateful: true,
          manifest: [],
          acceptStateChanges: false,
        }),
      ),
    )
  })

  it('replays an ordinary request after saved values are enabled', async () => {
    const principal = await setup('publish_state_stable_replay')
    const created = await publish(principal, {
      html: html('Stable state replay'),
      idempotencyKey: 'publish-state-stable-create',
    })
    const ordinaryPayload = {
      html: html('Ordinary version two'),
      documentId: created.document.id,
      idempotencyKey: 'publish-state-stable-ordinary',
    }
    const ordinary = await publish(principal, ordinaryPayload)
    await publish(principal, {
      html: html('Enable after ordinary'),
      documentId: created.document.id,
      stateful: true,
      idempotencyKey: 'publish-state-stable-enable',
    })

    const retry = await publish(principal, ordinaryPayload)
    expect(retry.versionNumber).toBe(ordinary.versionNumber)
    expect(retry.document).toEqual(ordinary.document)
  })

  it('coalesces concurrent same-key saved-value enables', async () => {
    const principal = await setup('publish_state_concurrent_enable')
    const ordinary = await publish(principal, {
      html: html('Concurrent enable baseline'),
      idempotencyKey: 'publish-state-concurrent-create',
    })
    const actualObjects = makeObjects(env.OBJECTS)
    let arrivals = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const synchronizedLayer = makeCoreLayer(env, {
      objects: {
        ...actualObjects,
        put: (key, value, options) =>
          Effect.gen(function* () {
            yield* Effect.promise(async () => {
              arrivals += 1
              if (arrivals === 2) release()
              await gate
            })
            return yield* actualObjects.put(key, value, options)
          }),
      },
    })
    const payload = {
      html: html('Concurrent enable'),
      documentId: ordinary.document.id,
      stateful: true,
      idempotencyKey: 'publish-state-concurrent-enable',
    }
    const execute = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Publish).publish(payload, principal)
        }).pipe(Effect.provide(synchronizedLayer)),
      )

    const [left, right] = await Promise.all([execute(), execute()])
    expect(right.document.id).toBe(left.document.id)
    expect(right.versionNumber).toBe(left.versionNumber)
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM document_versions
        WHERE created_by_api_key_id = ? AND idempotency_key = ?`,
    )
      .bind(principal.apiKeyId, payload.idempotencyKey)
      .first<{ count: number }>()
    expect(count?.count).toBe(1)
  })

  it('leaves ordinary uploads without state rows or manifests', async () => {
    const principal = await setup('publish_ordinary_unchanged')
    const receipt = await publish(principal, {
      html: html('Ordinary remains ordinary'),
      idempotencyKey: 'publish-ordinary-unchanged',
    })
    expect(receipt.document).toMatchObject({
      stateful: false,
      stateRevision: null,
      stateUpdatedAt: null,
    })
    const row = await env.DB.prepare(
      `SELECT d.stateful, v.state_fields_json,
              (SELECT COUNT(*) FROM document_state state
                WHERE state.document_id = d.id) AS state_rows
         FROM documents d
         JOIN document_versions v ON v.id = d.current_version_id
        WHERE d.id = ?`,
    )
      .bind(receipt.document.id)
      .first()
    expect(row).toEqual({
      stateful: 0,
      state_fields_json: null,
      state_rows: 0,
    })
  })

  it('compares manifests against saved row types without side effects', () => {
    const prior = {
      previousManifest: [
        { name: 'notes', type: 'textarea' as const, default: '' },
        { name: 'removed', type: 'text' as const, default: '' },
      ],
      savedRows: [
        { name: 'notes', type: 'text' as const, value_json: '"saved"' },
        { name: 'removed', type: 'text' as const, value_json: '"keep"' },
      ],
    }
    const next = [{ name: 'notes', type: 'checkbox' as const, default: false }]

    expect(compareManifests(prior, next)).toEqual({
      retyped: [
        { name: 'notes', from: 'text', to: 'checkbox', default: false },
      ],
      orphaned: ['removed'],
      bytesDelta: JSON.stringify(false).length - '"saved"'.length,
    })
    expect(prior.savedRows[0]?.value_json).toBe('"saved"')
  })

  it('keeps values, starts new fields at defaults, and restores re-added fields', async () => {
    const principal = await setup('publish_state_preserve')
    const first = await publish(principal, {
      html: statefulHtml(
        'Preserve values',
        '<textarea data-state="notes">Initial</textarea>',
      ),
      stateful: true,
      idempotencyKey: 'publish-state-preserve-first',
    })
    await saveState(principal, first.document.id, [
      { name: 'notes', value: 'Saved notes', base: 0 },
    ])

    await publish(principal, {
      html: statefulHtml(
        'Add a field',
        '<textarea data-state="notes">Changed default</textarea>' +
          '<input data-state="approved" type="checkbox" checked>',
      ),
      documentId: first.document.id,
      idempotencyKey: 'publish-state-preserve-add',
    })
    expect(
      (await readState(principal, first.document.id)).fields,
    ).toMatchObject({
      notes: { value: 'Saved notes', revision: 1, type: 'textarea' },
      approved: { value: true, revision: 0, type: 'checkbox' },
    })

    const refused = await publishEither(principal, {
      html: statefulHtml(
        'Remove a field',
        '<input data-state="approved" type="checkbox">',
      ),
      documentId: first.document.id,
      idempotencyKey: 'publish-state-preserve-remove-refused',
    })
    expect(refused).toMatchObject({
      _tag: 'Left',
      left: {
        code: 'state_schema_change',
        details: { retyped: [], orphaned: ['notes'] },
      },
    })

    await publish(principal, {
      html: statefulHtml(
        'Remove a field',
        '<input data-state="approved" type="checkbox">',
      ),
      documentId: first.document.id,
      acceptStateChanges: true,
      idempotencyKey: 'publish-state-preserve-remove',
    })
    await publish(principal, {
      html: statefulHtml(
        'Removal accepted already',
        '<input data-state="approved" type="checkbox">',
      ),
      documentId: first.document.id,
      idempotencyKey: 'publish-state-preserve-remove-again',
    })
    expect(
      (await readState(principal, first.document.id)).fields.notes,
    ).toEqual({ value: 'Saved notes', revision: 1, type: 'textarea' })

    await publish(principal, {
      html: statefulHtml(
        'Re-add a field',
        '<textarea data-state="notes">New default</textarea>',
      ),
      documentId: first.document.id,
      idempotencyKey: 'publish-state-preserve-readd',
    })
    expect(
      (await readState(principal, first.document.id)).fields.notes,
    ).toEqual({ value: 'Saved notes', revision: 1, type: 'textarea' })

    const fresh = await publish(principal, {
      html: statefulHtml(
        'Fresh document',
        '<textarea data-state="notes">Fresh default</textarea>',
      ),
      stateful: true,
      idempotencyKey: 'publish-state-preserve-new',
    })
    expect(
      (await readState(principal, fresh.document.id)).fields.notes,
    ).toEqual({ value: 'Fresh default', revision: 0, type: 'textarea' })
  })

  it('refuses a retype until accepted, then resets it at a new revision', async () => {
    const principal = await setup('publish_state_retype')
    const first = await publish(principal, {
      html: statefulHtml(
        'Retype',
        '<textarea data-state="notes">Initial</textarea>',
      ),
      stateful: true,
      idempotencyKey: 'publish-state-retype-first',
    })
    await saveState(principal, first.document.id, [
      { name: 'notes', value: 'Saved notes', base: 0 },
    ])
    const retypedHtml = statefulHtml(
      'Retyped',
      '<input data-state="notes" value="Reset default">',
    )

    const refused = await publishEither(principal, {
      html: retypedHtml,
      documentId: first.document.id,
      idempotencyKey: 'publish-state-retype-refused',
    })
    expect(refused).toMatchObject({
      _tag: 'Left',
      left: {
        code: 'state_schema_change',
        details: {
          retyped: [{ name: 'notes', from: 'textarea', to: 'text' }],
          orphaned: [],
        },
      },
    })

    const accepted = await publish(principal, {
      html: retypedHtml,
      documentId: first.document.id,
      acceptStateChanges: true,
      idempotencyKey: 'publish-state-retype-accepted',
    })
    expect(accepted.resetStateFields).toEqual(['notes'])
    const snapshot = await readState(principal, first.document.id)
    expect(snapshot).toMatchObject({ revision: 2 })
    expect(snapshot.fields.notes).toEqual({
      value: 'Reset default',
      revision: 2,
      type: 'text',
    })
    expect(
      await env.DB.prepare(
        `SELECT updated_by FROM document_state_fields
          WHERE document_id = ? AND name = 'notes'`,
      )
        .bind(first.document.id)
        .first(),
    ).toEqual({ updated_by: 'publish' })
  })

  it('rejects a reset default over 64 KiB before writing a version', async () => {
    const principal = await setup('publish_state_large_default')
    const first = await publish(principal, {
      html: statefulHtml(
        'Large default baseline',
        '<textarea data-state="notes">Initial</textarea>',
      ),
      stateful: true,
      idempotencyKey: 'publish-state-large-default-first',
    })
    await saveState(principal, first.document.id, [
      { name: 'notes', value: 'Saved', base: 0 },
    ])
    const oversizedHtml = statefulHtml(
      'Large reset default',
      `<input data-state="notes" value="${'x'.repeat(65_535)}">`,
    )
    const refused = await publishEither(principal, {
      html: oversizedHtml,
      documentId: first.document.id,
      idempotencyKey: 'publish-state-large-default-refused',
    })
    expect(refused).toMatchObject({
      _tag: 'Left',
      left: { code: 'state_schema_change' },
    })

    const result = await publishEither(principal, {
      html: oversizedHtml,
      documentId: first.document.id,
      acceptStateChanges: true,
      idempotencyKey: 'publish-state-large-default-reset',
    })

    expect(result).toMatchObject({
      _tag: 'Left',
      left: { code: 'policy_rejected' },
    })
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM document_versions WHERE document_id = ?',
      )
        .bind(first.document.id)
        .first(),
    ).toEqual({ count: 1 })
  })

  it('rejects a reset that would push saved values over 256 KiB', async () => {
    const principal = await setup('publish_state_large_total')
    const fields = [
      '<textarea data-state="target"></textarea>',
      ...Array.from(
        { length: 4 },
        (_, index) => `<textarea data-state="bulk${index}"></textarea>`,
      ),
    ].join('')
    const first = await publish(principal, {
      html: statefulHtml('Large total baseline', fields),
      stateful: true,
      idempotencyKey: 'publish-state-large-total-first',
    })
    await saveState(principal, first.document.id, [
      { name: 'target', value: 'x', base: 0 },
      ...Array.from({ length: 4 }, (_, index) => ({
        name: `bulk${index}`,
        value: 'b'.repeat(58 * 1024),
        base: 0,
      })),
    ])
    const nextFields = [
      `<input data-state="target" value="${'n'.repeat(30 * 1024)}">`,
      ...Array.from(
        { length: 4 },
        (_, index) => `<textarea data-state="bulk${index}"></textarea>`,
      ),
    ].join('')
    const result = await publishEither(principal, {
      html: statefulHtml('Large total reset', nextFields),
      documentId: first.document.id,
      acceptStateChanges: true,
      idempotencyKey: 'publish-state-large-total-reset',
    })

    expect(result).toMatchObject({
      _tag: 'Left',
      left: {
        code: 'state_too_large',
        details: { limit: 262_144 },
      },
    })
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM document_versions WHERE document_id = ?',
      )
        .bind(first.document.id)
        .first(),
    ).toEqual({ count: 1 })
  })

  it('retries when a save lands after comparison and preserves that save', async () => {
    const principal = await setup('publish_state_retry')
    const source = statefulHtml(
      'Retry state publication',
      '<textarea data-state="notes">Initial</textarea>',
    )
    const first = await publish(principal, {
      html: source,
      stateful: true,
      idempotencyKey: 'publish-state-retry-first',
    })
    await saveState(principal, first.document.id, [
      { name: 'notes', value: 'Before retry', base: 0 },
    ])

    const actualDb = makeDb(env.DB)
    let batchCalls = 0
    const retryLayer = makeCoreLayer(env, {
      db: {
        ...actualDb,
        batch: (statements) =>
          Effect.gen(function* () {
            batchCalls += 1
            if (batchCalls === 1) {
              const valueJson = JSON.stringify('Concurrent save')
              yield* Effect.promise(() =>
                env.DB.batch([
                  env.DB.prepare(
                    `UPDATE document_state
                        SET revision = revision + 1,
                            updated_at = '2026-09-14T12:00:00.000Z',
                            bytes = bytes
                              - length(CAST((
                                  SELECT value_json
                                    FROM document_state_fields
                                   WHERE document_id = ? AND name = 'notes'
                                ) AS BLOB))
                              + length(CAST(? AS BLOB))
                      WHERE document_id = ?`,
                  ).bind(first.document.id, valueJson, first.document.id),
                  env.DB.prepare(
                    `UPDATE document_state_fields
                        SET value_json = ?,
                            revision = (
                              SELECT revision FROM document_state
                               WHERE document_id = ?
                            ),
                            updated_at = '2026-09-14T12:00:00.000Z'
                      WHERE document_id = ? AND name = 'notes'`,
                  ).bind(valueJson, first.document.id, first.document.id),
                ]),
              )
            }
            return yield* actualDb.batch(statements)
          }),
      },
    })
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Publish).publish(
          {
            html: source,
            documentId: first.document.id,
            idempotencyKey: 'publish-state-retry-next',
          },
          principal,
        )
      }).pipe(Effect.provide(retryLayer)),
    )

    expect(receipt.versionNumber).toBe(2)
    expect(batchCalls).toBe(2)
    expect(
      (await readState(principal, first.document.id)).fields.notes,
    ).toEqual({ value: 'Concurrent save', revision: 2, type: 'textarea' })
  })

  it('includes acceptStateChanges in the request hash', async () => {
    const principal = await setup('publish_state_accept_hash')
    const source = statefulHtml('Accept hash', '')
    const withoutAccept = await publish(principal, {
      html: source,
      stateful: true,
      idempotencyKey: 'publish-state-accept-hash-false',
    })
    const withAccept = await publish(principal, {
      html: source,
      stateful: true,
      acceptStateChanges: true,
      idempotencyKey: 'publish-state-accept-hash-true',
    })
    const hashes = await env.DB.prepare(
      `SELECT document_id, request_hash FROM document_versions
        WHERE document_id IN (?, ?)`,
    )
      .bind(withoutAccept.document.id, withAccept.document.id)
      .all<{ document_id: string; request_hash: string }>()
    const byId = new Map(
      hashes.results.map((row) => [row.document_id, row.request_hash]),
    )

    expect(byId.get(withAccept.document.id)).not.toBe(
      byId.get(withoutAccept.document.id),
    )
  })
})
