import { env as workerEnv } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  Principal,
  Publish,
  Serving,
  type PrincipalIdentity,
} from '../src/services'
import bomFixture from './fixtures/bom.html?raw'
import { makeCoreLayer, seedPrincipal, testEnv } from './core-helpers'

const env = testEnv(workerEnv)
const layer = makeCoreLayer(env)

function run<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>,
  )
}

async function setup(): Promise<{
  principal: PrincipalIdentity
  token: string
}> {
  const seeded = await seedPrincipal(env, { suffix: 'serving_bytes' })
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

describe('Serving', () => {
  it('streams HTML byte-for-byte, preserves a BOM, and supports HEAD', async () => {
    const { principal, token } = await setup()
    expect(bomFixture.charCodeAt(0)).toBe(0xfeff)
    const published = await run(
      Effect.gen(function* () {
        const service = yield* Publish
        return yield* service.publish(
          {
            html: bomFixture,
            filename: 'bom.html',
            idempotencyKey: 'serving-bom',
          },
          principal,
        )
      }),
    )
    const get = await run(
      Effect.gen(function* () {
        const service = yield* Serving
        return yield* service.serve(
          new Request(published.publicUrl, {
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      }),
    )
    expect(get.status).toBe(200)
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(
      new TextEncoder().encode(bomFixture),
    )
    expect(get.headers.get('x-dossier-document-id')).toBe(published.document.id)
    expect(get.headers.get('x-dossier-version')).toBe('1')
    expect(get.headers.get('cache-control')).toBe('no-store')
    expect(get.headers.get('content-security-policy')).toContain(
      'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
    )

    const head = await run(
      Effect.gen(function* () {
        const service = yield* Serving
        return yield* service.serve(
          new Request(`${published.publicUrl}/v/1/raw`, {
            method: 'HEAD',
            headers: { authorization: `Bearer ${token}` },
          }),
        )
      }),
    )
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(
      String(new TextEncoder().encode(bomFixture).byteLength),
    )
    expect(head.headers.get('content-type')).toContain('text/plain')
    expect((await head.arrayBuffer()).byteLength).toBe(0)
  })
})
