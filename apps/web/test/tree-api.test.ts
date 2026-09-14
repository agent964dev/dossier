import { env as workerEnv } from 'cloudflare:workers'
import { makeSession } from '../src/services'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { handleApiRequest } from '../src/api'
import { handleServingRequest } from '../src/api/serving'
import { seedPrincipal, TEST_SECRET, testEnv } from './core-helpers'

const env = testEnv(workerEnv)
const now = '2026-09-12T00:00:00.000Z'

type Seeded = Awaited<ReturnType<typeof seedPrincipal>>

type JsonObject = Record<string, any>

function html(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${title}</body></html>`
}

async function api(
  path: string,
  options: {
    readonly token?: string
    readonly method?: string
    readonly body?: unknown
  } = {},
): Promise<Response> {
  const headers = new Headers()
  if (options.token) headers.set('authorization', `Bearer ${options.token}`)
  let requestBody: string | undefined
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json')
    requestBody = JSON.stringify(options.body)
  }
  return handleApiRequest(
    new Request(`https://dossier.test${path}`, {
      method: options.method ?? (requestBody === undefined ? 'GET' : 'POST'),
      headers,
      body: requestBody,
    }),
    env,
  )
}

async function serving(
  path: string,
  options: {
    readonly token?: string
    readonly cookie?: string
    readonly method?: string
    readonly authorization?: string
  } = {},
): Promise<Response> {
  const headers = new Headers()
  if (options.token) headers.set('authorization', `Bearer ${options.token}`)
  if (options.authorization) headers.set('authorization', options.authorization)
  if (options.cookie) headers.set('cookie', options.cookie)
  return handleServingRequest(
    new Request(`https://dossier.test${path}`, {
      method: options.method ?? 'GET',
      headers,
    }),
    env,
  )
}

async function body(response: Response): Promise<JsonObject> {
  return response.json() as Promise<JsonObject>
}

async function upload(
  token: string,
  title: string,
  options: Record<string, unknown> = {},
): Promise<JsonObject> {
  const response = await api('/api/uploads', {
    token,
    body: {
      html: html(title),
      idempotencyKey: `${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${crypto.randomUUID()}`,
      ...options,
    },
  })
  expect(response.status).toBe(options.documentId ? 200 : 201)
  return body(response)
}

async function actor(
  suffix: string,
  options: {
    readonly workspaceId?: string
    readonly role?: 'admin' | 'member'
    readonly email?: string
    readonly verified?: boolean
  } = {},
): Promise<Seeded> {
  const seeded = await seedPrincipal(env, {
    suffix,
    email:
      options.email && options.verified !== false ? options.email : undefined,
  })
  if (options.email && options.verified === false) {
    await env.DB.prepare(
      `INSERT INTO identities
         (id, account_id, provider, subject, email, email_verified,
          display_name, picture_url, pii_subject, created_at, last_login_at)
       VALUES (?, ?, 'shoo', ?, ?, 0, NULL, NULL, NULL, ?, ?)`,
    )
      .bind(
        `identity_unverified_${suffix}`,
        seeded.accountId,
        `subject_unverified_${suffix}`,
        options.email,
        now,
        now,
      )
      .run()
  }
  if (options.workspaceId && options.role) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memberships (workspace_id, account_id, role, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(options.workspaceId, seeded.accountId, options.role, now),
      env.DB.prepare('UPDATE api_keys SET workspace_id = ? WHERE id = ?').bind(
        options.workspaceId,
        seeded.keyId,
      ),
    ])
  }
  return seeded
}

async function expectApiStatus(
  documentId: string,
  token: string,
  expected: number,
): Promise<void> {
  const response = await api(`/api/documents/${documentId}`, { token })
  expect(response.status).toBe(expected)
  if (expected === 404) {
    expect(await body(response)).toMatchObject({ ok: false, code: 'not_found' })
  }
}

async function expectServingStatus(
  documentId: string,
  expected: number,
  token?: string,
): Promise<void> {
  expect((await serving(`/d/${documentId}`, { token })).status).toBe(expected)
}

describe('phase two HTTP tree and access', () => {
  it('enforces explicit and inherited access for Bearer and anonymous readers', async () => {
    const owner = await seedPrincipal(env, {
      suffix: 'http_acl_owner',
      email: 'owner@http-acl.test',
    })
    const member = await actor('http_acl_member', {
      workspaceId: owner.workspaceId,
      role: 'member',
    })
    const invited = await actor('http_acl_invited', {
      email: 'guest@http-acl.test',
      verified: true,
    })
    const unverified = await actor('http_acl_unverified', {
      email: 'guest@http-acl.test',
      verified: false,
    })
    const stranger = await actor('http_acl_stranger')

    const roots = {
      public: await upload(owner.token, 'HTTP ACL public', {
        visibility: 'public',
        shares: ['guest@http-acl.test'],
      }),
      team: await upload(owner.token, 'HTTP ACL team', {
        visibility: 'team',
        shares: ['guest@http-acl.test'],
      }),
      private: await upload(owner.token, 'HTTP ACL private', {
        visibility: 'private',
        shares: ['guest@http-acl.test'],
      }),
    }
    const inherited = {
      public: await upload(owner.token, 'HTTP ACL public inherited', {
        parentId: roots.public.document.id,
      }),
      team: await upload(owner.token, 'HTTP ACL team inherited', {
        parentId: roots.team.document.id,
      }),
      private: await upload(owner.token, 'HTTP ACL private inherited', {
        parentId: roots.private.document.id,
      }),
    }

    for (const visibility of ['public', 'team', 'private'] as const) {
      for (const target of [roots[visibility], inherited[visibility]]) {
        const id = target.document.id as string
        await expectApiStatus(id, owner.token, 200)
        await expectApiStatus(
          id,
          member.token,
          visibility === 'private' ? 404 : 200,
        )
        await expectApiStatus(id, invited.token, 200)
        await expectApiStatus(
          id,
          unverified.token,
          visibility === 'public' ? 200 : 404,
        )
        await expectApiStatus(
          id,
          stranger.token,
          visibility === 'public' ? 200 : 404,
        )
        await expectServingStatus(id, 200, owner.token)
        await expectServingStatus(
          id,
          visibility === 'private' ? 404 : 200,
          member.token,
        )
        await expectServingStatus(id, 200, invited.token)
        await expectServingStatus(
          id,
          visibility === 'public' ? 200 : 404,
          unverified.token,
        )
        await expectServingStatus(
          id,
          visibility === 'public' ? 200 : 404,
          stranger.token,
        )
        await expectServingStatus(id, visibility === 'public' ? 200 : 404)
      }
    }

    const anonymousApi = await api(`/api/documents/${roots.public.document.id}`)
    expect(anonymousApi.status).toBe(401)
    expect(anonymousApi.headers.get('www-authenticate')).toBe('Bearer')
    expect(await body(anonymousApi)).toMatchObject({ code: 'unauthenticated' })

    const privateParent = await upload(owner.token, 'HTTP hidden boundary', {
      visibility: 'private',
    })
    const publicChild = await upload(
      owner.token,
      'HTTP visible boundary child',
      {
        parentId: privateParent.document.id,
        visibility: 'public',
      },
    )
    await expectApiStatus(publicChild.document.id, stranger.token, 200)
    const childDetail = await body(
      await api(`/api/documents/${publicChild.document.id}`, {
        token: stranger.token,
      }),
    )
    expect(childDetail.document.parentId).toBeNull()

    expect(
      (
        await api(`/api/documents/${privateParent.document.id}/disable`, {
          token: owner.token,
          body: { reason: 'ancestor only' },
        })
      ).status,
    ).toBe(200)
    await expectApiStatus(publicChild.document.id, stranger.token, 200)
    await expectServingStatus(publicChild.document.id, 200)
  })

  it('renders a calm leaf hub with a manual copy fallback', async () => {
    const owner = await seedPrincipal(env, { suffix: 'http_leaf_hub_owner' })
    const leaf = await upload(owner.token, 'HTTP calm leaf hub', {
      visibility: 'public',
    })

    const response = await serving(`/d/${leaf.document.id}/tree`)
    expect(response.status).toBe(200)
    const renderedHtml = await response.text()
    expect(renderedHtml).not.toContain('Nested under this')
    expect(renderedHtml).not.toContain('Alongside this')
    expect(renderedHtml).not.toContain('Nothing nested')
    expect(renderedHtml).not.toContain('<dt class="micro">Workspace</dt>')
    expect(renderedHtml).toContain('document.execCommand("copy")')
    expect(renderedHtml).toContain('data-copy-source')
    expect(renderedHtml).toContain(
      'grid-template-columns: repeat(2, minmax(0, 1fr))',
    )
  })

  it('returns unpaginated public-field-ordered visible forests and never leaks hidden ancestry', async () => {
    const owner = await seedPrincipal(env, { suffix: 'http_forest_owner' })
    const stranger = await actor('http_forest_stranger')
    const hidden = await upload(owner.token, 'HTTP never reveal ancestor', {
      visibility: 'private',
    })
    const hiddenSibling = await upload(
      owner.token,
      'HTTP never reveal sibling',
      {
        parentId: hidden.document.id,
        visibility: 'private',
      },
    )
    const child = await upload(owner.token, 'HTTP visible virtual root', {
      parentId: hidden.document.id,
      visibility: 'public',
    })
    const grandchild = await upload(owner.token, 'HTTP visible grandchild', {
      parentId: child.document.id,
    })
    const otherRoot = await upload(owner.token, 'HTTP visible other root', {
      visibility: 'public',
    })

    const mineResponse = await api('/api/documents?scope=mine&tree=1&limit=1', {
      token: owner.token,
    })
    expect(mineResponse.status).toBe(200)
    const mine = await body(mineResponse)
    expect(mine.nextCursor).toBeNull()
    expect(mine.documents.map((document: JsonObject) => document.id)).toEqual(
      expect.arrayContaining([
        hidden.document.id,
        hiddenSibling.document.id,
        child.document.id,
        grandchild.document.id,
        otherRoot.document.id,
      ]),
    )
    expect(
      mine.documents.find(
        (document: JsonObject) => document.id === child.document.id,
      ).parentId,
    ).toBe(hidden.document.id)

    const listResponse = await api(
      '/api/documents?scope=readable&tree=1&limit=1',
      { token: stranger.token },
    )
    expect(listResponse.status).toBe(200)
    const list = await body(listResponse)
    expect(list.nextCursor).toBeNull()
    expect(list.documents.map((document: JsonObject) => document.id)).toEqual(
      expect.arrayContaining([
        child.document.id,
        grandchild.document.id,
        otherRoot.document.id,
      ]),
    )
    expect(list.documents.length).toBeGreaterThan(1)
    const childIndex = list.documents.findIndex(
      (document: JsonObject) => document.id === child.document.id,
    )
    const grandchildIndex = list.documents.findIndex(
      (document: JsonObject) => document.id === grandchild.document.id,
    )
    expect(childIndex).toBeLessThan(grandchildIndex)
    expect(list.documents[childIndex].parentId).toBeNull()
    expect(list.documents[grandchildIndex].parentId).toBe(child.document.id)

    const treeResponse = await api(`/api/documents/${child.document.id}/tree`, {
      token: stranger.token,
    })
    expect(treeResponse.status).toBe(200)
    const tree = await body(treeResponse)
    expect(tree.document.parentId).toBeNull()
    expect(tree.breadcrumb).toEqual([])
    expect(tree.siblings).toEqual([])

    const detailResponse = await api(`/api/documents/${child.document.id}`, {
      token: stranger.token,
    })
    const detailText = JSON.stringify(await body(detailResponse))
    const treeText = JSON.stringify(tree)
    const listText = JSON.stringify(list)
    for (const serialised of [detailText, treeText, listText]) {
      expect(serialised).not.toContain(hidden.document.id)
      expect(serialised).not.toContain(hidden.document.title)
      expect(serialised).not.toContain(hiddenSibling.document.id)
      expect(serialised).not.toContain(hiddenSibling.document.title)
      expect(serialised).not.toContain('"depth"')
      expect(serialised).not.toContain('"path"')
      expect(serialised).not.toContain('"accessSource"')
      expect(serialised).not.toContain('"revision"')
    }

    const hub = await serving(`/d/${child.document.id}/tree`)
    expect(hub.status).toBe(200)
    const hubHtml = await hub.text()
    expect(hubHtml).toContain('HTTP visible virtual root')
    expect(hubHtml).not.toContain(hidden.document.id)
    expect(hubHtml).not.toContain(hidden.document.title)
    expect(hubHtml).not.toContain(hiddenSibling.document.id)
    expect(hubHtml).not.toContain(hiddenSibling.document.title)

    const hiddenParent = await api(
      `/api/documents?scope=readable&parent=${hidden.document.id}`,
      { token: stranger.token },
    )
    expect(hiddenParent.status).toBe(404)
    expect(await body(hiddenParent)).toMatchObject({ code: 'not_found' })

    const invalidTree = await api('/api/documents?tree=0', {
      token: owner.token,
    })
    expect(invalidTree.status).toBe(422)
    expect(await body(invalidTree)).toMatchObject({ code: 'policy_rejected' })
  })

  it('applies the current boundary and availability to current and pinned serving routes', async () => {
    const owner = await seedPrincipal(env, { suffix: 'http_history_owner' })
    const stranger = await actor('http_history_stranger')
    const created = await upload(owner.token, 'HTTP historical version one', {
      visibility: 'public',
    })
    const id = created.document.id as string
    await upload(owner.token, 'HTTP historical version two', {
      documentId: id,
    })

    for (const path of [
      `/d/${id}`,
      `/d/${id}/raw`,
      `/d/${id}/v/1`,
      `/d/${id}/v/1/raw`,
    ]) {
      expect((await serving(path)).status).toBe(200)
      expect((await serving(path, { token: stranger.token })).status).toBe(200)
    }

    const privatePatch = await api(`/api/documents/${id}`, {
      token: owner.token,
      method: 'PATCH',
      body: { visibility: 'private' },
    })
    expect(privatePatch.status).toBe(200)
    for (const path of [
      `/d/${id}`,
      `/d/${id}/raw`,
      `/d/${id}/v/1`,
      `/d/${id}/v/1/raw`,
    ]) {
      expect((await serving(path)).status).toBe(404)
      expect((await serving(path, { token: stranger.token })).status).toBe(404)
      expect((await serving(path, { token: owner.token })).status).toBe(200)
    }

    expect(
      (
        await api(`/api/documents/${id}`, {
          token: owner.token,
          method: 'PATCH',
          body: { visibility: 'public' },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await api(`/api/documents/${id}/disable`, {
          token: owner.token,
          body: { reason: 'hide all versions' },
        })
      ).status,
    ).toBe(200)
    expect((await serving(`/d/${id}/v/1`, { token: owner.token })).status).toBe(
      404,
    )

    expect(
      (
        await api(`/api/documents/${id}/enable`, {
          token: owner.token,
          method: 'POST',
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await api(`/api/documents/${id}`, {
          token: owner.token,
          method: 'DELETE',
        })
      ).status,
    ).toBe(200)
    expect((await serving(`/d/${id}/v/1`, { token: owner.token })).status).toBe(
      404,
    )
  })

  it('enforces depth, cycle, root, cross-owner, and admin move/delete rules over HTTP', async () => {
    const owner = await seedPrincipal(env, { suffix: 'http_moves_owner' })
    const admin = await actor('http_moves_admin', {
      workspaceId: owner.workspaceId,
      role: 'admin',
    })
    const member = await actor('http_moves_member', {
      workspaceId: owner.workspaceId,
      role: 'member',
    })
    const peer = await actor('http_moves_peer', {
      workspaceId: owner.workspaceId,
      role: 'member',
    })

    const chain = [
      await upload(owner.token, 'HTTP depth zero', { visibility: 'team' }),
    ]
    for (let depth = 1; depth <= 16; depth += 1) {
      chain.push(
        await upload(owner.token, `HTTP depth ${depth}`, {
          parentId: chain.at(-1)!.document.id,
        }),
      )
    }
    const tooDeep = await api('/api/uploads', {
      token: owner.token,
      body: {
        html: html('HTTP depth seventeen'),
        parentId: chain.at(-1)!.document.id,
        idempotencyKey: 'http-depth-seventeen',
      },
    })
    expect(tooDeep.status).toBe(422)
    expect(await body(tooDeep)).toMatchObject({ code: 'policy_rejected' })

    const cycle = await api(`/api/documents/${chain[0].document.id}`, {
      token: owner.token,
      method: 'PATCH',
      body: { parentId: chain[1].document.id },
    })
    expect(cycle.status).toBe(422)
    expect(await body(cycle)).toMatchObject({ code: 'policy_rejected' })

    const movable = await upload(member.token, 'HTTP member movable', {
      visibility: 'team',
    })
    const overflow = await api(`/api/documents/${movable.document.id}`, {
      token: member.token,
      method: 'PATCH',
      body: { parentId: chain.at(-1)!.document.id },
    })
    expect(overflow.status).toBe(422)
    expect(await body(overflow)).toMatchObject({ code: 'policy_rejected' })

    const crossOwner = await api(`/api/documents/${movable.document.id}`, {
      token: member.token,
      method: 'PATCH',
      body: { parentId: chain[0].document.id },
    })
    expect(crossOwner.status).toBe(200)
    expect((await body(crossOwner)).document.parentId).toBe(
      chain[0].document.id,
    )
    const rooted = await api(`/api/documents/${movable.document.id}`, {
      token: member.token,
      method: 'PATCH',
      body: { parentId: null },
    })
    expect(rooted.status).toBe(200)
    expect((await body(rooted)).document.parentId).toBeNull()

    const foreignOwner = await seedPrincipal(env, {
      suffix: 'http_moves_foreign',
    })
    const foreignRoot = await upload(
      foreignOwner.token,
      'HTTP foreign public root',
      {
        visibility: 'public',
      },
    )
    const crossWorkspace = await api(`/api/documents/${movable.document.id}`, {
      token: member.token,
      method: 'PATCH',
      body: { parentId: foreignRoot.document.id },
    })
    expect(crossWorkspace.status).toBe(404)
    expect(await body(crossWorkspace)).toMatchObject({ code: 'not_found' })

    const memberDocument = await upload(member.token, 'HTTP admin target', {
      visibility: 'team',
    })
    const destination = await upload(admin.token, 'HTTP admin destination', {
      visibility: 'team',
    })
    for (const operation of [
      () =>
        api(`/api/documents/${memberDocument.document.id}`, {
          token: peer.token,
          method: 'PATCH',
          body: { description: 'forbidden edit' },
        }),
      () =>
        api(`/api/documents/${memberDocument.document.id}`, {
          token: peer.token,
          method: 'PATCH',
          body: { parentId: destination.document.id },
        }),
      () =>
        api(`/api/documents/${memberDocument.document.id}`, {
          token: peer.token,
          method: 'DELETE',
        }),
    ]) {
      const denied = await operation()
      expect(denied.status).toBe(403)
      expect(await body(denied)).toMatchObject({ code: 'editor_required' })
    }

    const edited = await api(`/api/documents/${memberDocument.document.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { description: 'admin edit' },
    })
    expect(edited.status).toBe(200)
    const moved = await api(`/api/documents/${memberDocument.document.id}`, {
      token: admin.token,
      method: 'PATCH',
      body: { parentId: destination.document.id },
    })
    expect(moved.status).toBe(200)
    expect((await body(moved)).document.parentId).toBe(destination.document.id)
    expect(
      (
        await api(`/api/documents/${memberDocument.document.id}`, {
          token: admin.token,
          method: 'DELETE',
        })
      ).status,
    ).toBe(200)
  })

  it('lists and restores only restorable multi-author batch roots', async () => {
    const owner = await seedPrincipal(env, { suffix: 'http_archive_owner' })
    const member = await actor('http_archive_member', {
      workspaceId: owner.workspaceId,
      role: 'member',
    })
    const parent = await upload(owner.token, 'HTTP archive parent', {
      visibility: 'team',
    })
    const ticket = await upload(owner.token, 'HTTP archive ticket', {
      parentId: parent.document.id,
    })
    const old = await upload(owner.token, 'HTTP old tombstone', {
      parentId: ticket.document.id,
    })
    const oldDeleteResponse = await api(`/api/documents/${old.document.id}`, {
      token: owner.token,
      method: 'DELETE',
    })
    const oldDelete = await body(oldDeleteResponse)
    const research = await upload(member.token, 'HTTP intern research', {
      parentId: ticket.document.id,
    })

    const conflict = await api(`/api/documents/${ticket.document.id}`, {
      token: owner.token,
      method: 'DELETE',
    })
    expect(conflict.status).toBe(409)
    expect(await body(conflict)).toMatchObject({
      code: 'has_children',
      details: { count: 1 },
    })
    const forced = await api(`/api/documents/${ticket.document.id}?force=1`, {
      token: owner.token,
      method: 'DELETE',
    })
    expect(forced.status).toBe(200)
    const deletion = await body(forced)
    expect(deletion.deleted).toBe(2)
    expect(deletion.authors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: owner.accountId, count: 1 }),
        expect.objectContaining({ accountId: member.accountId, count: 1 }),
      ]),
    )

    const ownerTrash = await body(
      await api('/api/documents?scope=trash', { token: owner.token }),
    )
    const batchRoot = ownerTrash.documents.find(
      (document: JsonObject) => document.id === ticket.document.id,
    )
    expect(batchRoot).toMatchObject({
      id: ticket.document.id,
      deletionBatchId: deletion.batchId,
      deletionRootTitle: 'HTTP archive ticket',
    })
    expect(batchRoot.authors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: owner.accountId, count: 1 }),
        expect.objectContaining({ accountId: member.accountId, count: 1 }),
      ]),
    )
    expect(
      ownerTrash.documents.some(
        (document: JsonObject) => document.id === research.document.id,
      ),
    ).toBe(false)

    const memberTrash = await body(
      await api('/api/documents?scope=trash', { token: member.token }),
    )
    expect(
      memberTrash.documents.some(
        (document: JsonObject) => document.id === research.document.id,
      ),
    ).toBe(false)

    const parentDelete = await body(
      await api(`/api/documents/${parent.document.id}`, {
        token: owner.token,
        method: 'DELETE',
      }),
    )
    const refused = await api(`/api/documents/${ticket.document.id}/restore`, {
      token: owner.token,
      body: { batchId: deletion.batchId },
    })
    expect(refused.status).toBe(409)
    expect(await body(refused)).toMatchObject({ code: 'conflict' })

    expect(
      (
        await api(`/api/documents/${parent.document.id}/restore`, {
          token: owner.token,
          body: { batchId: parentDelete.batchId },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await api(`/api/documents/${ticket.document.id}/restore`, {
          token: owner.token,
          body: { batchId: deletion.batchId },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await api(`/api/documents/${research.document.id}`, {
          token: member.token,
        })
      ).status,
    ).toBe(200)

    const oldDetail = await body(
      await api(`/api/documents/${old.document.id}`, { token: owner.token }),
    )
    expect(oldDetail.document).toMatchObject({
      deletionBatchId: oldDelete.batchId,
      deletedAt: expect.any(String),
    })

    const secondDelete = await body(
      await api(`/api/documents/${ticket.document.id}?force=1`, {
        token: owner.token,
        method: 'DELETE',
      }),
    )
    expect(secondDelete.batchId).not.toBe(deletion.batchId)
    expect(
      (
        await api(`/api/documents/${ticket.document.id}/restore`, {
          token: owner.token,
          body: { batchId: secondDelete.batchId },
        })
      ).status,
    ).toBe(200)
    const oldAfter = await body(
      await api(`/api/documents/${old.document.id}`, { token: owner.token }),
    )
    expect(oldAfter.document.deletionBatchId).toBe(oldDelete.batchId)
  })

  it('composes concurrent share deltas and maps tree/share/patch failures to the HTTP contract', async () => {
    const owner = await seedPrincipal(env, { suffix: 'http_shares_owner' })
    const member = await actor('http_shares_member', {
      workspaceId: owner.workspaceId,
      role: 'member',
    })
    const external = await actor('http_shares_external')
    const parent = await upload(owner.token, 'HTTP shared parent', {
      visibility: 'private',
      shares: ['inherited@http-shares.test'],
    })
    const child = await upload(owner.token, 'HTTP shared child', {
      parentId: parent.document.id,
    })

    const deltas = await Promise.all([
      api(`/api/documents/${child.document.id}/shares`, {
        token: owner.token,
        body: { add: ['one@http-shares.test'] },
      }),
      api(`/api/documents/${child.document.id}/shares`, {
        token: owner.token,
        body: { add: ['two@http-shares.test'] },
      }),
    ])
    expect(deltas.map((response) => response.status)).toEqual([200, 200])
    const shares = await body(
      await api(`/api/documents/${child.document.id}/shares`, {
        token: owner.token,
      }),
    )
    expect(shares).toMatchObject({ accessSource: 'own' })
    expect(shares.configured).toEqual([
      'inherited@http-shares.test',
      'one@http-shares.test',
      'two@http-shares.test',
    ])

    const readable = await upload(owner.token, 'HTTP readable non-editor', {
      visibility: 'public',
    })
    for (const request of [
      () =>
        api(`/api/documents/${readable.document.id}`, {
          token: member.token,
          method: 'PATCH',
          body: { description: 'no' },
        }),
      () =>
        api(`/api/documents/${readable.document.id}/shares`, {
          token: member.token,
        }),
      () =>
        api(`/api/documents/${readable.document.id}/shares`, {
          token: member.token,
          body: { add: ['no@http-shares.test'] },
        }),
      () =>
        api(`/api/documents/${readable.document.id}/shares`, {
          token: member.token,
          method: 'PUT',
          body: { emails: [], ifRevision: readable.document.revision },
        }),
    ]) {
      const denied = await request()
      expect(denied.status).toBe(403)
      expect(await body(denied)).toMatchObject({ code: 'editor_required' })
    }
    expect(
      (
        await api(`/api/documents/${readable.document.id}/tree`, {
          token: member.token,
        })
      ).status,
    ).toBe(200)

    for (const request of [
      () =>
        api(`/api/documents/${readable.document.id}`, {
          token: external.token,
          method: 'PATCH',
          body: { description: 'external write' },
        }),
      () =>
        api(`/api/documents/${readable.document.id}/shares`, {
          token: external.token,
          body: { add: ['external@http-shares.test'] },
        }),
    ]) {
      const nonPublisher = await request()
      expect(nonPublisher.status).toBe(403)
      expect(await body(nonPublisher)).toMatchObject({
        code: 'publisher_required',
      })
    }

    const staleShares = await api(
      `/api/documents/${child.document.id}/shares`,
      {
        token: owner.token,
        method: 'PUT',
        body: { emails: [], ifRevision: child.document.revision },
      },
    )
    expect(staleShares.status).toBe(409)
    expect(await body(staleShares)).toMatchObject({ code: 'conflict' })

    const invalidShare = await api(
      `/api/documents/${child.document.id}/shares`,
      {
        token: owner.token,
        body: { add: ['not-an-email'] },
      },
    )
    expect(invalidShare.status).toBe(422)
    expect(await body(invalidShare)).toMatchObject({ code: 'policy_rejected' })

    const stalePatch = await api(`/api/documents/${readable.document.id}`, {
      token: owner.token,
      method: 'PATCH',
      body: {
        description: 'stale',
        ifRevision: readable.document.revision + 1,
      },
    })
    expect(stalePatch.status).toBe(409)
    expect(await body(stalePatch)).toMatchObject({ code: 'conflict' })

    const missingId = 'zzzzzzzzzzzz'
    for (const request of [
      () => api(`/api/documents/${missingId}/tree`, { token: owner.token }),
      () =>
        api(`/api/documents/${missingId}`, {
          token: owner.token,
          method: 'PATCH',
          body: { description: 'missing' },
        }),
      () => api(`/api/documents/${missingId}/shares`, { token: owner.token }),
      () =>
        api(`/api/documents/${missingId}/shares`, {
          token: owner.token,
          body: { add: ['missing@http-shares.test'] },
        }),
      () =>
        api(`/api/documents/${missingId}/shares`, {
          token: owner.token,
          method: 'PUT',
          body: { emails: [], ifRevision: 0 },
        }),
    ]) {
      const missing = await request()
      expect(missing.status).toBe(404)
      expect(await body(missing)).toMatchObject({ code: 'not_found' })
    }

    for (const request of [
      () => api(`/api/documents/${readable.document.id}/tree`),
      () =>
        api(`/api/documents/${readable.document.id}`, {
          method: 'PATCH',
          body: { description: 'anonymous' },
        }),
      () => api(`/api/documents/${readable.document.id}/shares`),
    ]) {
      const unauthenticated = await request()
      expect(unauthenticated.status).toBe(401)
      expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer')
      expect(await body(unauthenticated)).toMatchObject({
        code: 'unauthenticated',
      })
    }

    const malformed = await api(`/api/documents/${readable.document.id}`, {
      token: owner.token,
      method: 'PATCH',
      body: { kind: 'not valid!' },
    })
    expect(malformed.status).toBe(422)
    expect(await body(malformed)).toMatchObject({ code: 'policy_rejected' })
  })

  it('uses Access for valid cookies, Bearer keys, and invalid-Bearer precedence on /d', async () => {
    const owner = await seedPrincipal(env, { suffix: 'http_cookie_owner' })
    const stranger = await actor('http_cookie_stranger')
    const document = await upload(owner.token, 'HTTP cookie private', {
      visibility: 'private',
    })
    const sessions = makeSession(TEST_SECRET, true)
    const ownerCookie = await Effect.runPromise(
      sessions.createSessionCookie({
        accountId: owner.accountId,
        workspaceId: owner.workspaceId,
      }),
    )
    const strangerCookie = await Effect.runPromise(
      sessions.createSessionCookie({
        accountId: stranger.accountId,
        workspaceId: stranger.workspaceId,
      }),
    )
    const ownerPair = ownerCookie.split(';', 1)[0]
    const strangerPair = strangerCookie.split(';', 1)[0]

    for (const path of [
      `/d/${document.document.id}`,
      `/d/${document.document.id}/raw`,
      `/d/${document.document.id}/v/1`,
      `/d/${document.document.id}/v/1/raw`,
      `/d/${document.document.id}/tree`,
    ]) {
      expect((await serving(path, { token: owner.token })).status).toBe(200)
      expect((await serving(path, { cookie: ownerPair })).status).toBe(200)
      expect((await serving(path, { token: stranger.token })).status).toBe(404)
      expect((await serving(path, { cookie: strangerPair })).status).toBe(404)
      const invalidBearer = await serving(path, {
        cookie: ownerPair,
        authorization: 'Bearer invalid',
      })
      expect(invalidBearer.status).toBe(401)
      expect(invalidBearer.headers.get('www-authenticate')).toBe('Bearer')
    }
  })
})
