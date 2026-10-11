import { EventTypeSchema } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { SignIn } from '../src/core/index.ts'
import { ORIGIN } from './support/harness.ts'
import { everything } from './support/keys.ts'
import { runAs, sessionFor } from './support/people.ts'
import { join, person, sha256Of, workspace } from './support/trees.ts'

/** A member of a fresh workspace and a real agent key of theirs. */
const member = async () => {
  const admin = await person('admin')
  const ws = await workspace(admin)
  const who = await person('agent-owner')
  await join(ws, who)
  const { secret } = await runAs(
    await sessionFor(who),
    Effect.flatMap(SignIn, (signIn) =>
      signIn.createKey({ name: 'edge', ...everything }),
    ),
  )
  return { ws, secret }
}

const api = (
  secret: string | null,
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = new Headers(init.headers)
  if (secret !== null) headers.set('authorization', `Bearer ${secret}`)
  return SELF.fetch(`${ORIGIN}/_/api${path}`, { ...init, headers })
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const INDEX = '<!doctype html><title>Acme</title><p>Hello</p>'

describe('the pushes and files endpoints', () => {
  it('stage, blob, commit, ls and file answer as declared', async () => {
    const { ws, secret } = await member()
    const sha = await sha256Of(INDEX)
    const size = new TextEncoder().encode(INDEX).length
    const staged = await api(
      secret,
      '/pushes',
      json({
        target: `${ws.name}/acme`,
        baseSeq: null,
        baseTree: null,
        force: false,
        dryRun: false,
        message: 'first',
        files: [{ path: 'index.html', sha256: sha, size }],
      }),
    )
    expect(staged.status).toBe(200)
    const stage = (await staged.json()) as { pushId: string; missing: string[] }
    expect(stage.missing).toEqual([sha])

    const put = (body: string) =>
      api(secret, `/pushes/${stage.pushId}/blobs/${sha}`, {
        method: 'PUT',
        headers: { 'content-length': String(size) },
        body,
      })
    const first = await put(INDEX)
    expect(first.status).toBe(201)
    expect(await first.text()).toBe('')
    // The same answer when the bytes are already stored.
    const again = await put(INDEX)
    expect(again.status).toBe(201)
    // Bytes that do not match their hash are refused.
    const wrong = await put(INDEX.replace('Hello', 'Hellp'))
    expect(wrong.status).toBe(400)
    expect(
      ((await wrong.json()) as { error: { code: string } }).error.code,
    ).toBe('invalid')

    const committed = await api(secret, `/pushes/${stage.pushId}/commit`, {
      method: 'POST',
    })
    expect(committed.status).toBe(200)
    expect(await committed.json()).toMatchObject({
      number: 1,
      link: `${ORIGIN}/${ws.name}/acme/`,
      seq: 1,
    })

    const listed = await api(
      secret,
      `/ls?path=${encodeURIComponent(`${ws.name}/acme`)}&depth=one`,
    )
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({
      tree: { workspace: ws.name, name: 'acme' },
      path: '',
      seq: 1,
      entries: [
        {
          name: 'index.html',
          kind: 'page',
          size,
          sha256: sha,
          title: 'Acme',
          push: { number: 1, at: expect.any(String) },
        },
      ],
    })

    const file = await api(
      secret,
      `/file?path=${encodeURIComponent(`${ws.name}/acme/index.html`)}`,
    )
    expect(file.status).toBe(200)
    expect(file.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''index.html",
    )
    expect(file.headers.get('x-content-type-options')).toBe('nosniff')
    expect(file.headers.get('content-security-policy')).toBe('sandbox')
    expect(file.headers.get('etag')).toBe(`"${sha}"`)
    expect(file.headers.get('content-type')).toBe('application/octet-stream')
    expect(await file.text()).toBe(INDEX)
  })

  it('answers the same 201 for bytes another tree already stored', async () => {
    const { ws, secret } = await member()
    const text = `shared ${crypto.randomUUID()}`
    const sha = await sha256Of(text)
    const size = text.length
    for (const tree of ['one', 'two']) {
      const staged = (await (
        await api(
          secret,
          '/pushes',
          json({
            target: `${ws.name}/${tree}`,
            baseSeq: null,
            baseTree: null,
            force: false,
            dryRun: false,
            message: null,
            files: [{ path: 'a.txt', sha256: sha, size }],
          }),
        )
      ).json()) as { pushId: string; missing: string[] }
      expect(staged.missing).toEqual([sha])
      const put = await api(secret, `/pushes/${staged.pushId}/blobs/${sha}`, {
        method: 'PUT',
        headers: { 'content-length': String(size) },
        body: text,
      })
      expect(put.status).toBe(201)
      expect(await put.text()).toBe('')
    }
  })

  it('asks a visitor to sign in, and answers not found for what is not there', async () => {
    const { ws, secret } = await member()
    const visitor = await api(
      null,
      `/ls?path=${encodeURIComponent(`${ws.name}/acme`)}&depth=one`,
    )
    expect(visitor.status).toBe(401)
    const missing = await api(
      secret,
      `/file?path=${encodeURIComponent(`${ws.name}/nope/a.txt`)}`,
    )
    expect(missing.status).toBe(404)
    expect(
      ((await missing.json()) as { error: { code: string } }).error.code,
    ).toBe('not_found')
    const bad = await api(
      secret,
      `/ls?path=${encodeURIComponent('_/x')}&depth=one`,
    )
    expect(bad.status).toBe(400)
  })
})

describe('the event types', () => {
  it('are the same in the contract and the events table', async () => {
    const table = await env.DB.prepare(
      `select sql from sqlite_master where type = 'table' and name = 'events'`,
    ).first<{ sql: string }>()
    const listed = /"type" in \(([^)]*)\)/.exec(table?.sql ?? '')?.[1] ?? ''
    const inTable = [...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(inTable).toEqual([...EventTypeSchema.literals])
  })
})
