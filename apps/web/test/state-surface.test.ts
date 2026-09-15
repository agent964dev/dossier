import { env as workerEnv } from 'cloudflare:workers'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { renderWrapperPage } from '../src/api/wrapper'
import frameRuntime from '../src/runtime/frame-runtime.js?raw'
import { issueCsrfToken } from '../src/server/csrf'
import worker from '../src/worker'
import {
  Principal,
  Publish,
  Session,
  State,
  makeSession,
  type PrincipalIdentity,
} from '../src/services'
import bomFixture from './fixtures/bom.html?raw'
import {
  TEST_SECRET,
  makeCoreLayer,
  seedPrincipal,
  testEnv,
} from './core-helpers'

const env = testEnv(workerEnv)
const layer = makeCoreLayer(env)

function run<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>,
  )
}

interface Setup {
  readonly principal: PrincipalIdentity
  readonly token: string
  readonly cookie: string
  readonly accountId: string
  readonly workspaceId: string
}

interface SurfaceBody {
  readonly documentId: string
  readonly version: number
  readonly revision: number
  readonly viewer: string
  readonly canSave: boolean
  readonly frameTicket: string
  readonly frameVersion: number
  readonly frameHasRuntime: boolean
  readonly csrfToken?: string
}

async function setup(suffix: string): Promise<Setup> {
  const seeded = await seedPrincipal(env, { suffix })
  return run(
    Effect.gen(function* () {
      const principals = yield* Principal
      const principal = yield* principals.resolve(
        new Request('https://dossier.test/api/uploads', {
          headers: { authorization: `Bearer ${seeded.token}` },
        }),
      )
      const cookie = yield* makeSession(TEST_SECRET, true).createSessionCookie({
        accountId: seeded.accountId,
        workspaceId: seeded.workspaceId,
      })
      return {
        principal,
        token: seeded.token,
        cookie: cookie.split(';', 1)[0],
        accountId: seeded.accountId,
        workspaceId: seeded.workspaceId,
      }
    }),
  )
}

function statefulHtml(
  title: string,
  body = '<input data-state="name" value="Ada">',
) {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
}

async function publish(
  owner: Setup,
  input: {
    readonly html: string
    readonly stateful?: boolean
    readonly visibility?: 'public' | 'team' | 'private'
    readonly documentId?: string
    readonly key: string
  },
) {
  return run(
    Effect.gen(function* () {
      return yield* (yield* Publish).publish(
        {
          html: input.html,
          ...(input.stateful === undefined ? {} : { stateful: input.stateful }),
          ...(input.visibility === undefined
            ? {}
            : { visibility: input.visibility }),
          ...(input.documentId === undefined
            ? {}
            : { documentId: input.documentId }),
          idempotencyKey: input.key,
        },
        owner.principal,
      )
    }),
  )
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(`https://dossier.test${path}`, init) as Parameters<
      typeof worker.fetch
    >[0],
    env,
  )
}

async function surface(
  documentId: string,
  init?: RequestInit,
  query = '',
): Promise<{ response: Response; body: SurfaceBody }> {
  const response = await request(`/d/${documentId}/state${query}`, init)
  return { response, body: (await response.json()) as SurfaceBody }
}

describe('saved-values browser surface', () => {
  it('escapes bootstrap JSON and wrapper text without changing values', async () => {
    const hostile = '</ScRiPt><script>window.bad = true</script>\u2028\u2029'
    const response = renderWrapperPage({
      mode: 'public',
      snapshot: {
        documentId: 'abc123def456',
        version: 1,
        revision: 0,
        updatedAt: null,
        fields: {
          note: { value: hostile, revision: 0, type: 'text' },
        },
        canSave: false,
        viewer: 'reader',
      },
      ticket: 'ticket',
      version: 1,
      hasRuntime: true,
      title: '<Unsafe title>',
      nonce: 'fixed-nonce',
    })
    const html = await response.text()
    const match =
      /<script type="application\/json" id="dossier-bootstrap">([\s\S]*?)<\/script>/.exec(
        html,
      )

    expect(match).not.toBeNull()
    expect(match![1]).not.toMatch(/<\/script/i)
    expect(match![1]).toContain('\\u2028')
    expect(match![1]).toContain('\\u2029')
    const bootstrap = JSON.parse(match![1]!) as {
      snapshot: { fields: { note: { value: string } } }
    }
    expect(bootstrap.snapshot.fields.note.value).toBe(hostile)
    expect(html).toContain('&lt;Unsafe title&gt;')
    expect(response.headers.get('content-security-policy')).toContain(
      "script-src 'nonce-fixed-nonce'",
    )
  })

  it('serves a wrapper for stateful documents and exact bytes for ordinary ones', async () => {
    const owner = await setup('surface_wrapper')
    const stateful = await publish(owner, {
      html: statefulHtml('Stateful wrapper'),
      stateful: true,
      visibility: 'public',
      key: 'surface-wrapper-stateful',
    })
    const ordinarySource =
      '<!doctype html><html><head><title>Ordinary bytes</title></head><body>untouched</body></html>'
    const ordinary = await publish(owner, {
      html: ordinarySource,
      visibility: 'public',
      key: 'surface-wrapper-ordinary',
    })

    const wrapped = await request(`/d/${stateful.document.id}`, {
      headers: { cookie: owner.cookie },
    })
    const wrapperHtml = await wrapped.text()
    expect(wrapped.status).toBe(200)
    expect(wrapped.headers.get('content-security-policy')).toContain(
      "script-src 'nonce-",
    )
    expect(wrapped.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    )
    expect(wrapperHtml).toContain('id="dossier-bootstrap"')
    expect(wrapperHtml).toContain('id="dossier-frame"')
    expect(wrapperHtml).toContain('sandbox="allow-scripts allow-popups"')
    expect(wrapperHtml).toContain('>Save</p>')
    expect(wrapperHtml).toContain('id="dossier-save" type="button">Save')
    expect(wrapperHtml).toContain('id="dossier-save-retry"')
    expect(wrapperHtml).toContain('id="dossier-copy-draft"')
    expect(wrapperHtml).toContain('This plan changed while you were editing')
    expect(wrapperHtml).toContain('Keep editing this draft')
    expect(wrapperHtml).toContain('Review latest saved version')

    const pinnedCurrent = await request(`/d/${stateful.document.id}/v/1`)
    const pinnedCurrentHtml = await pinnedCurrent.text()
    expect(pinnedCurrentHtml).toContain('Older version, read only')
    expect(pinnedCurrentHtml).toContain(
      `/d/${stateful.document.id}/v/1/frame?t=`,
    )

    const plain = await request(`/d/${ordinary.document.id}`)
    expect(plain.status).toBe(200)
    expect(await plain.text()).toBe(ordinarySource)
    expect(plain.headers.get('content-security-policy')).toContain(
      'sandbox allow-scripts',
    )
  })

  it('returns the current snapshot and a pinned-version ticket', async () => {
    const owner = await setup('surface_pinned')
    const first = await publish(owner, {
      html: statefulHtml('Pinned one'),
      stateful: true,
      visibility: 'public',
      key: 'surface-pinned-one',
    })
    await publish(owner, {
      html: statefulHtml('Pinned two'),
      stateful: true,
      documentId: first.document.id,
      key: 'surface-pinned-two',
    })

    const { response, body } = await surface(
      first.document.id,
      undefined,
      '?version=1',
    )
    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      documentId: first.document.id,
      version: 2,
      frameVersion: 1,
      frameHasRuntime: true,
      viewer: 'reader',
      canSave: false,
    })
    const claims = await run(
      Effect.gen(function* () {
        return yield* (yield* State).verifyFrameTicket(body.frameTicket)
      }),
    )
    expect(claims).toMatchObject({
      documentId: first.document.id,
      workspaceId: owner.workspaceId,
      version: 1,
      viewer: 'public',
    })

    const wrapper = await request(`/d/${first.document.id}/v/1`)
    const html = await wrapper.text()
    expect(html).toContain('Older version, read only')
    expect(html).toContain(`/d/${first.document.id}/v/1/frame?t=`)

    const queryWrapper = await request(`/d/${first.document.id}?version=1`)
    const queryHtml = await queryWrapper.text()
    expect(queryHtml).toContain('Read only')
    expect(queryHtml).toContain(`/d/${first.document.id}/frame?t=`)
    expect(queryHtml).not.toContain(`/d/${first.document.id}/v/1/frame?t=`)
    const ticket = /id="dossier-frame"[^>]+src="[^"]+\?t=([^"]+)/.exec(
      queryHtml,
    )?.[1]
    expect(ticket).toBeDefined()
    const frame = await request(
      `/d/${first.document.id}/frame?t=${encodeURIComponent(ticket!)}`,
    )
    expect(frame.status).toBe(200)
    expect(frame.headers.get('x-dossier-version')).toBe('2')
  })

  it('allows anonymous GET only for a public stateful document', async () => {
    const owner = await setup('surface_public')
    const published = await publish(owner, {
      html: statefulHtml('Anonymous state'),
      stateful: true,
      visibility: 'public',
      key: 'surface-public',
    })

    const { response, body } = await surface(published.document.id)
    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      documentId: published.document.id,
      viewer: 'reader',
      canSave: false,
      frameVersion: 1,
      frameHasRuntime: true,
    })

    const post = await request(`/d/${published.document.id}/state`, {
      method: 'POST',
      headers: {
        origin: 'https://dossier.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        version: 1,
        changes: [{ name: 'name', value: 'Grace', base: 0 }],
      }),
    })
    expect(post.status).toBe(403)
    expect(await post.json()).toMatchObject({
      ok: false,
      code: 'state_edit_required',
    })
  })

  it('reads and saves a private document through the edit-token header', async () => {
    const owner = await setup('surface_link')
    const published = await publish(owner, {
      html: statefulHtml('Private link surface'),
      stateful: true,
      visibility: 'private',
      key: 'surface-link',
    })
    const editLink = await run(
      Effect.gen(function* () {
        return yield* (yield* State).links.create(
          published.document.id,
          owner.principal,
        )
      }),
    )
    const token = new URL(editLink.editUrl!).hash.slice(1)
    const keys: string[] = []
    const original = env.STATE_RATE_LIMITER
    env.STATE_RATE_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key)
        return { success: true }
      },
    }

    try {
      const editPage = await request(`/d/${published.document.id}/edit`)
      const editHtml = await editPage.text()
      expect(editPage.status).toBe(200)
      expect(editHtml).toContain('<body data-mode="link">')
      expect(editHtml).toContain(
        `<script type="application/json" id="dossier-bootstrap">{"documentId":"${published.document.id}"}</script>`,
      )
      expect(editHtml).not.toContain('"snapshot"')
      // The link page carries no session of its own and no chrome that would
      // name the tree, the author, or the workspace around the document.
      expect(editPage.headers.get('set-cookie')).toBeNull()
      expect(editHtml).not.toContain('Private link surface')
      expect(editHtml).toContain('<h1 id="dossier-title">Edit document</h1>')

      const { response: get, body } = await surface(published.document.id, {
        headers: { 'x-dossier-edit-token': token },
      })
      expect(get.status).toBe(200)
      expect(body).toMatchObject({
        documentId: published.document.id,
        viewer: 'link',
        canSave: true,
        frameVersion: 1,
      })
      expect(body.csrfToken).toBeUndefined()

      const frame = await request(
        `/d/${published.document.id}/frame?t=${encodeURIComponent(body.frameTicket)}`,
      )
      expect(frame.status).toBe(200)

      const save = await request(`/d/${published.document.id}/state`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dossier-edit-token': token,
        },
        body: JSON.stringify({
          version: body.version,
          changes: [{ name: 'name', value: 'Grace', base: 0 }],
        }),
      })
      expect(save.status, await save.clone().text()).toBe(200)
      expect(await save.json()).toMatchObject({
        viewer: 'link',
        fields: { name: { value: 'Grace', revision: 1 } },
      })
      expect(keys).toEqual([
        `document:${published.document.id}:link:1`,
        `document:${published.document.id}:link:1`,
      ])

      await run(
        Effect.gen(function* () {
          yield* (yield* State).links.revoke(
            published.document.id,
            owner.principal,
          )
        }),
      )
      const revokedGet = await request(`/d/${published.document.id}/state`, {
        headers: { 'x-dossier-edit-token': token },
      })
      expect(revokedGet.status).toBe(410)
      expect(await revokedGet.json()).toMatchObject({ code: 'link_revoked' })

      const revokedFrame = await request(
        `/d/${published.document.id}/frame?t=${encodeURIComponent(body.frameTicket)}`,
      )
      expect(revokedFrame.status).toBe(410)
      expect(await revokedFrame.json()).toMatchObject({ code: 'link_revoked' })

      const revokedSave = await request(`/d/${published.document.id}/state`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dossier-edit-token': token,
        },
        body: JSON.stringify({
          version: body.version,
          changes: [{ name: 'name', value: 'Katherine', base: 1 }],
        }),
      })
      expect(revokedSave.status).toBe(410)
      expect(await revokedSave.json()).toMatchObject({ code: 'link_revoked' })

      const replacement = await run(
        Effect.gen(function* () {
          return yield* (yield* State).links.create(
            published.document.id,
            owner.principal,
          )
        }),
      )
      const replacementToken = new URL(replacement.editUrl!).hash.slice(1)
      const replacementGet = await request(
        `/d/${published.document.id}/state`,
        {
          headers: { 'x-dossier-edit-token': replacementToken },
        },
      )
      expect(replacementGet.status).toBe(200)
      expect(keys.at(-1)).toBe(`document:${published.document.id}:link:2`)
    } finally {
      env.STATE_RATE_LIMITER = original
    }
  })

  it('ignores edit tokens on document, tree, raw, and protected API routes', async () => {
    const owner = await setup('surface_link_scope')
    const published = await publish(owner, {
      html: statefulHtml('Scoped private link'),
      stateful: true,
      visibility: 'private',
      key: 'surface-link-scope',
    })
    const editLink = await run(
      Effect.gen(function* () {
        return yield* (yield* State).links.create(
          published.document.id,
          owner.principal,
        )
      }),
    )
    const token = new URL(editLink.editUrl!).hash.slice(1)
    const headers = { 'x-dossier-edit-token': token }

    for (const path of [
      `/d/${published.document.id}`,
      `/d/${published.document.id}/tree`,
      `/d/${published.document.id}/raw`,
    ]) {
      const response = await request(path, { headers })
      expect(response.status, path).toBe(404)
    }

    const unauthenticatedApi = await request(
      `/api/documents/${published.document.id}/state`,
      { headers },
    )
    expect(unauthenticatedApi.status).toBe(401)

    const authenticatedApi = await request(
      `/api/documents/${published.document.id}/state`,
      {
        headers: {
          authorization: `Bearer ${owner.token}`,
          'x-dossier-edit-token': 'not-a-link-token',
        },
      },
    )
    expect(authenticatedApi.status).toBe(200)
  })

  it('saves with a cookie and account-bound CSRF token', async () => {
    const owner = await setup('surface_save')
    const published = await publish(owner, {
      html: statefulHtml('Browser save'),
      stateful: true,
      visibility: 'public',
      key: 'surface-save',
    })
    const { body: initial } = await surface(published.document.id, {
      headers: { cookie: owner.cookie },
    })
    expect(initial.csrfToken).toBeTypeOf('string')

    const wrapper = await request(`/d/${published.document.id}`, {
      headers: { cookie: owner.cookie },
    })
    const wrapperHtml = await wrapper.text()
    const bootstrapText =
      /<script type="application\/json" id="dossier-bootstrap">([\s\S]*?)<\/script>/.exec(
        wrapperHtml,
      )?.[1]
    expect(bootstrapText).toBeDefined()
    const bootstrap = JSON.parse(bootstrapText!) as {
      csrfToken: string
      snapshot: { canSave: boolean }
    }
    expect(bootstrap.csrfToken).toBeTypeOf('string')
    expect(bootstrap.snapshot.canSave).toBe(true)

    const response = await request(`/d/${published.document.id}/state`, {
      method: 'POST',
      headers: {
        cookie: owner.cookie,
        origin: 'https://dossier.test',
        'content-type': 'application/json',
        'x-dossier-csrf': bootstrap.csrfToken,
      },
      body: JSON.stringify({
        version: initial.version,
        changes: [{ name: 'name', value: 'Grace', base: 0 }],
      }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({
      documentId: published.document.id,
      version: initial.version,
      revision: 1,
      fields: {
        name: { value: 'Grace', revision: 1, type: 'text' },
      },
      canSave: true,
    })
  })

  it('rejects missing, foreign-origin, and foreign-account CSRF proofs', async () => {
    const owner = await setup('surface_csrf_owner')
    const other = await setup('surface_csrf_other')
    const published = await publish(owner, {
      html: statefulHtml('CSRF save'),
      stateful: true,
      visibility: 'public',
      key: 'surface-csrf',
    })
    const ownerToken = await run(
      issueCsrfToken(owner.accountId).pipe(Effect.provide(layer)),
    )
    const otherToken = await run(
      issueCsrfToken(other.accountId).pipe(Effect.provide(layer)),
    )
    const payload = JSON.stringify({
      version: 1,
      changes: [{ name: 'name', value: 'Mallory', base: 0 }],
    })
    const attempts = [
      {
        origin: 'https://dossier.test',
        token: undefined,
      },
      {
        origin: 'https://attacker.example',
        token: ownerToken,
      },
      {
        origin: 'https://dossier.test',
        token: otherToken,
      },
    ] as const

    for (const attempt of attempts) {
      const response = await request(`/d/${published.document.id}/state`, {
        method: 'POST',
        headers: {
          cookie: owner.cookie,
          origin: attempt.origin,
          'content-type': 'application/json',
          ...(attempt.token === undefined
            ? {}
            : { 'x-dossier-csrf': attempt.token }),
        },
        body: payload,
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({
        ok: false,
        code: 'state_edit_required',
      })
    }
  })

  it('passes a state conflict through the API error envelope', async () => {
    const owner = await setup('surface_conflict')
    const published = await publish(owner, {
      html: statefulHtml('Conflict save'),
      stateful: true,
      visibility: 'public',
      key: 'surface-conflict',
    })
    const token = await run(
      issueCsrfToken(owner.accountId).pipe(Effect.provide(layer)),
    )
    const save = (value: string) =>
      request(`/d/${published.document.id}/state`, {
        method: 'POST',
        headers: {
          cookie: owner.cookie,
          origin: 'https://dossier.test',
          'content-type': 'application/json',
          'x-dossier-csrf': token,
        },
        body: JSON.stringify({
          version: 1,
          changes: [{ name: 'name', value, base: 0 }],
        }),
      })

    const first = await save('Grace')
    expect(first.status, await first.clone().text()).toBe(200)
    const conflict = await save('Katherine')
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      ok: false,
      code: 'state_conflict',
      details: {
        fields: [{ name: 'name', revision: 1, value: 'Grace' }],
      },
    })
  })

  it('rate limits browser saves by document and account', async () => {
    const owner = await setup('surface_rate_limit')
    const published = await publish(owner, {
      html: statefulHtml('Rate limited save'),
      stateful: true,
      visibility: 'public',
      key: 'surface-rate-limit',
    })
    const token = await run(
      issueCsrfToken(owner.accountId).pipe(Effect.provide(layer)),
    )
    const original = env.STATE_RATE_LIMITER
    const keys: string[] = []
    env.STATE_RATE_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key)
        return { success: false }
      },
    }

    try {
      const response = await request(`/d/${published.document.id}/state`, {
        method: 'POST',
        headers: {
          cookie: owner.cookie,
          origin: 'https://dossier.test',
          'content-type': 'application/json',
          'x-dossier-csrf': token,
        },
        body: JSON.stringify({
          version: 1,
          changes: [{ name: 'name', value: 'Grace', base: 0 }],
        }),
      })
      expect(response.status).toBe(429)
      expect(response.headers.get('retry-after')).toBe('60')
      expect(await response.json()).toMatchObject({
        ok: false,
        code: 'rate_limited',
      })
      expect(keys).toEqual([
        `document:${published.document.id}:account:${owner.accountId}`,
      ])
    } finally {
      env.STATE_RATE_LIMITER = original
    }
  })

  it('answers 404 for expired, wrong-document, and wrong-version tickets', async () => {
    const owner = await setup('surface_ticket')
    const first = await publish(owner, {
      html: statefulHtml('Ticket one'),
      stateful: true,
      visibility: 'public',
      key: 'surface-ticket-one',
    })
    const second = await publish(owner, {
      html: statefulHtml('Ticket two'),
      stateful: true,
      visibility: 'public',
      key: 'surface-ticket-two',
    })
    const { body } = await surface(first.document.id)
    const expired = await run(
      Effect.gen(function* () {
        const sessions = yield* Session
        return yield* sessions.signToken(
          {
            purpose: 'frame',
            documentId: first.document.id,
            workspaceId: owner.workspaceId,
            version: 1,
            viewer: 'public',
          },
          60,
          Math.floor(Date.now() / 1000) - 61,
        )
      }),
    )

    expect(
      (
        await request(
          `/d/${first.document.id}/frame?t=${encodeURIComponent(expired)}`,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await request(
          `/d/${second.document.id}/frame?t=${encodeURIComponent(body.frameTicket)}`,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await request(
          `/d/${first.document.id}/v/2/frame?t=${encodeURIComponent(body.frameTicket)}`,
        )
      ).status,
    ).toBe(404)
  })

  it('rehydrates account tickets from live rows and rejects a disabled account', async () => {
    const owner = await setup('surface_disabled')
    const published = await publish(owner, {
      html: statefulHtml('Private frame'),
      stateful: true,
      visibility: 'private',
      key: 'surface-disabled',
    })
    const { response, body } = await surface(published.document.id, {
      headers: { cookie: owner.cookie },
    })
    expect(response.status).toBe(200)
    await env.DB.prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), owner.accountId)
      .run()

    const frame = await request(
      `/d/${published.document.id}/frame?t=${encodeURIComponent(body.frameTicket)}`,
    )
    expect(frame.status).toBe(404)
  })

  it('prepends the frame runtime exactly once', async () => {
    const owner = await setup('surface_prepend')
    const published = await publish(owner, {
      html: statefulHtml(
        'Prepend once',
        '<script>window.authorRan = true</script><input data-state="name">',
      ),
      stateful: true,
      visibility: 'public',
      key: 'surface-prepend',
    })
    const { body } = await surface(published.document.id)
    const frame = await request(
      `/d/${published.document.id}/frame?t=${encodeURIComponent(body.frameTicket)}`,
    )
    const html = await frame.text()
    const injected = `<script>${frameRuntime}</script>`

    expect(frame.status).toBe(200)
    expect(html.split(injected)).toHaveLength(2)
    expect(html.indexOf(injected)).toBeLessThan(
      html.indexOf('<script>window.authorRan = true</script>'),
    )
    expect(frame.headers.get('content-security-policy')).toContain(
      'frame-ancestors https://dossier.test',
    )
    expect(frame.headers.get('x-dossier-version')).toBe('1')
    expect(frame.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects a second literal head tag at upload', async () => {
    const owner = await setup('surface_two_heads')
    const response = await request('/api/uploads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        html: '<!doctype html><html><head></head><body><head></head></body></html>',
        stateful: true,
        idempotencyKey: 'surface-two-heads',
      }),
    })

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'policy_rejected',
      details: {
        errors: [
          'Stateful HTML must contain exactly one literal <head> start tag.',
        ],
      },
    })
  })

  it('preserves a BOM before the first tag while rewriting the frame', async () => {
    const owner = await setup('surface_bom')
    expect(bomFixture.charCodeAt(0)).toBe(0xfeff)
    const published = await publish(owner, {
      html: bomFixture,
      stateful: true,
      visibility: 'public',
      key: 'surface-bom',
    })
    const { body } = await surface(published.document.id)
    const frame = await request(
      `/d/${published.document.id}/frame?t=${encodeURIComponent(body.frameTicket)}`,
    )
    const bytes = new Uint8Array(await frame.arrayBuffer())
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)

    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text.indexOf('<')).toBe(1)
  })

  it('serves a pre-stateful version untouched and does not wait for a runtime', async () => {
    const owner = await setup('surface_pre_stateful')
    const firstSource =
      '<!doctype html><html><head><title>Before state</title></head><body>original bytes</body></html>'
    const first = await publish(owner, {
      html: firstSource,
      visibility: 'public',
      key: 'surface-pre-stateful-one',
    })
    await publish(owner, {
      html: statefulHtml('After state'),
      stateful: true,
      documentId: first.document.id,
      key: 'surface-pre-stateful-two',
    })
    const { body } = await surface(first.document.id, undefined, '?version=1')
    expect(body).toMatchObject({
      version: 2,
      frameVersion: 1,
      frameHasRuntime: false,
    })

    const frame = await request(
      `/d/${first.document.id}/v/1/frame?t=${encodeURIComponent(body.frameTicket)}`,
    )
    expect(await frame.text()).toBe(firstSource)
    expect(frame.headers.get('content-length')).toBe(
      String(new TextEncoder().encode(firstSource).byteLength),
    )

    const wrapper = await request(`/d/${first.document.id}/v/1`)
    const html = await wrapper.text()
    expect(html).toContain('Published before saved values')
    expect(html).toContain('id="dossier-overlay" hidden')
  })

  it('keeps current and pinned raw fetches byte-exact for stateful documents', async () => {
    const owner = await setup('surface_raw')
    const published = await publish(owner, {
      html: bomFixture,
      stateful: true,
      visibility: 'public',
      key: 'surface-raw',
    })
    const expected = new TextEncoder().encode(bomFixture)

    for (const path of [
      `/d/${published.document.id}/raw`,
      `/d/${published.document.id}/v/1/raw`,
    ]) {
      const response = await request(path)
      expect(response.status).toBe(200)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected)
      expect(response.headers.get('content-type')).toContain('text/plain')
    }
  })
})
