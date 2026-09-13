import { env as workerEnv } from 'cloudflare:workers'
import { isDocumentEditor } from '@dossier/contracts'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  Access,
  Documents,
  Principal,
  Publish,
  Serving,
  Shares,
  Tree,
  type PrincipalIdentity,
} from '../src/services'
import { handleServingRequest } from '../src/api/serving'
import { makeCoreLayer, seedPrincipal, testEnv } from './core-helpers'

const env = testEnv(workerEnv)
const layer = makeCoreLayer(env)
const now = '2026-09-12T00:00:00.000Z'

function run<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>,
  )
}

function html(title: string): string {
  return `<!doctype html><title>${title}</title><p>${title}</p>`
}

async function resolve(token: string): Promise<PrincipalIdentity> {
  return run(
    Effect.gen(function* () {
      const principals = yield* Principal
      return yield* principals.resolve(
        new Request('https://dossier.test/api/me', {
          headers: { authorization: `Bearer ${token}` },
        }),
      )
    }),
  )
}

async function actor(
  suffix: string,
  targetWorkspace?: string,
  role?: 'admin' | 'member',
  email?: { value: string; verified: boolean },
): Promise<{ principal: PrincipalIdentity; token: string; accountId: string }> {
  const seeded = await seedPrincipal(env, {
    suffix,
    email: email?.verified ? email.value : undefined,
  })
  if (email && !email.verified) {
    await env.DB.prepare(
      `INSERT INTO identities
         (id, account_id, provider, subject, email, email_verified,
          display_name, picture_url, pii_subject, created_at, last_login_at)
       VALUES (?, ?, 'shoo', ?, ?, 0, NULL, NULL, NULL, ?, ?)`,
    )
      .bind(
        `identity_unverified_${suffix}`,
        seeded.accountId,
        `unverified_${suffix}`,
        email.value,
        now,
        now,
      )
      .run()
  }
  if (targetWorkspace && role) {
    await env.DB.prepare(
      `INSERT INTO memberships (workspace_id, account_id, role, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(targetWorkspace, seeded.accountId, role, now)
      .run()
    await env.DB.prepare(`UPDATE api_keys SET workspace_id = ? WHERE id = ?`)
      .bind(targetWorkspace, seeded.keyId)
      .run()
  }
  return {
    principal: await resolve(seeded.token),
    token: seeded.token,
    accountId: seeded.accountId,
  }
}

function publish(
  principal: PrincipalIdentity,
  title: string,
  options: Partial<
    Parameters<import('../src/services').PublishService['publish']>[0]
  > = {},
) {
  return run(
    Effect.gen(function* () {
      const service = yield* Publish
      return yield* service.publish(
        {
          html: html(title),
          idempotencyKey: `${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${crypto.randomUUID()}`,
          ...options,
        },
        principal,
      )
    }),
  )
}

function access(documentId: string, principal: PrincipalIdentity | null) {
  return run(
    Effect.gen(function* () {
      const service = yield* Access
      return (yield* service.resolve([documentId], principal))[0]!
    }),
  )
}

function patchEither(
  documentId: string,
  body: Parameters<import('../src/services').TreeService['patch']>[1],
  principal: PrincipalIdentity,
) {
  return run(
    Effect.gen(function* () {
      const tree = yield* Tree
      return yield* tree.patch(documentId, body, principal).pipe(Effect.either)
    }),
  )
}

describe('phase two tree and access', () => {
  it('enforces public, team, private, invite, verification, and inherited boundaries', async () => {
    const ownerSeed = await seedPrincipal(env, {
      suffix: 'acl_owner',
      email: 'owner@acl.test',
    })
    const owner = await resolve(ownerSeed.token)
    const admin = await actor('acl_admin', owner.workspaceId, 'admin')
    const member = await actor('acl_member', owner.workspaceId, 'member')
    const invited = await actor('acl_invited', undefined, undefined, {
      value: 'guest@outside.test',
      verified: true,
    })
    const unverified = await actor('acl_unverified', undefined, undefined, {
      value: 'guest@outside.test',
      verified: false,
    })
    const outsider = await actor('acl_outsider')

    const roots = {
      public: await publish(owner, 'ACL public', {
        visibility: 'public',
        shares: ['guest@outside.test'],
      }),
      team: await publish(owner, 'ACL team', {
        visibility: 'team',
        shares: ['guest@outside.test'],
      }),
      private: await publish(owner, 'ACL private', {
        visibility: 'private',
        shares: ['guest@outside.test'],
      }),
    }
    const children = {
      public: await publish(owner, 'ACL public inherited', {
        parentId: roots.public.document.id,
      }),
      team: await publish(owner, 'ACL team inherited', {
        parentId: roots.team.document.id,
      }),
      private: await publish(owner, 'ACL private inherited', {
        parentId: roots.private.document.id,
      }),
    }

    for (const visibility of ['public', 'team', 'private'] as const) {
      for (const target of [roots[visibility], children[visibility]]) {
        expect((await access(target.document.id, owner)).canRead).toBe(true)
        expect(
          (await access(target.document.id, admin.principal)).canRead,
        ).toBe(true)
        expect(
          (await access(target.document.id, member.principal)).canRead,
        ).toBe(visibility !== 'private')
        expect(
          (await access(target.document.id, invited.principal)).canRead,
        ).toBe(true)
        expect(
          (await access(target.document.id, unverified.principal)).canRead,
        ).toBe(visibility === 'public')
        expect(
          (await access(target.document.id, outsider.principal)).canRead,
        ).toBe(visibility === 'public')
        expect((await access(target.document.id, null)).canRead).toBe(
          visibility === 'public',
        )
      }
      expect(
        (await access(children[visibility].document.id, owner)).accessSource,
      ).toBe('inherited')
    }
  })

  it('treats a public child under a hidden parent as a virtual root without leaking ancestors', async () => {
    const ownerSeed = await seedPrincipal(env, { suffix: 'hidden_owner' })
    const owner = await resolve(ownerSeed.token)
    const outsider = await actor('hidden_outsider')
    const hidden = await publish(owner, 'Never reveal this ancestor title', {
      visibility: 'private',
    })
    const sibling = await publish(owner, 'Never reveal this sibling title', {
      parentId: hidden.document.id,
      visibility: 'private',
    })
    const child = await publish(owner, 'Visible child', {
      parentId: hidden.document.id,
      visibility: 'public',
    })

    const tree = await run(
      Effect.gen(function* () {
        return yield* (yield* Tree).get(child.document.id, null)
      }),
    )
    expect(tree.document.parentId).toBeNull()
    expect(tree.breadcrumb).toEqual([])
    expect(tree.siblings).toEqual([])
    const serialised = JSON.stringify(tree)
    expect(serialised).not.toContain(hidden.document.id)
    expect(serialised).not.toContain(hidden.document.title)
    expect(serialised).not.toContain(sibling.document.id)
    expect(serialised).not.toContain('depth')
    expect(serialised).not.toContain('path')
    expect(serialised).not.toContain('accessSource')

    const hub = await handleServingRequest(
      new Request(`${child.document.hubUrl}`),
      env,
    )
    expect(hub.status).toBe(200)
    const hubHtml = await hub.text()
    expect(hubHtml).toContain('Visible child')
    expect(hubHtml).not.toContain(hidden.document.id)
    expect(hubHtml).not.toContain(hidden.document.title)
    expect(hubHtml).not.toContain(sibling.document.id)

    const detail = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).get(
          child.document.id,
          outsider.principal,
        )
      }),
    )
    const detailJson = JSON.stringify(detail)
    expect(detail.document.parentId).toBeNull()
    expect(detailJson).not.toContain(hidden.document.id)
    expect(detailJson).not.toContain(hidden.document.title)
    expect(detailJson).not.toContain('revision')

    const hiddenParentList = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents)
          .list(
            { scope: 'readable', parent: hidden.document.id },
            outsider.principal,
          )
          .pipe(Effect.either)
      }),
    )
    expect(hiddenParentList).toMatchObject({
      _tag: 'Left',
      left: { code: 'not_found' },
    })
  })

  it('filters and orders virtual roots without consulting hidden storage ancestry', async () => {
    const ownerSeed = await seedPrincipal(env, {
      suffix: 'virtual_order_owner',
    })
    const owner = await resolve(ownerSeed.token)
    const outsider = await actor('virtual_order_outsider')
    const firstHidden = await publish(owner, 'First hidden filing root', {
      visibility: 'private',
    })
    const secondHidden = await publish(owner, 'Second hidden filing root', {
      visibility: 'private',
    })
    const [lowerParent, higherParent] =
      firstHidden.document.id < secondHidden.document.id
        ? [firstHidden, secondHidden]
        : [secondHidden, firstHidden]
    const zulu = await publish(owner, 'Zulu public root', {
      parentId: lowerParent.document.id,
      visibility: 'public',
    })
    const alpha = await publish(owner, 'Alpha public root', {
      parentId: higherParent.document.id,
      visibility: 'public',
    })

    const tree = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).list(
          { scope: 'readable', tree: true },
          outsider.principal,
        )
      }),
    )
    expect(
      tree.documents
        .filter(
          (document) =>
            document.id === alpha.document.id ||
            document.id === zulu.document.id,
        )
        .map((document) => document.id),
    ).toEqual([alpha.document.id, zulu.document.id])
    expect(
      tree.documents
        .filter(
          (document) =>
            document.id === alpha.document.id ||
            document.id === zulu.document.id,
        )
        .every((document) => document.parentId === null),
    ).toBe(true)

    const roots = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).list(
          { scope: 'readable', parent: null },
          outsider.principal,
        )
      }),
    )
    expect(roots.documents.map((document) => document.id)).toEqual(
      expect.arrayContaining([alpha.document.id, zulu.document.id]),
    )
  })

  it('uses the current boundary for historical serving and node-only availability', async () => {
    const ownerSeed = await seedPrincipal(env, { suffix: 'history_owner' })
    const owner = await resolve(ownerSeed.token)
    const parent = await publish(owner, 'Disabled ancestor', {
      visibility: 'private',
    })
    const document = await publish(owner, 'Historical ACL', {
      parentId: parent.document.id,
      visibility: 'public',
    })
    const serving = () =>
      run(
        Effect.gen(function* () {
          return yield* (yield* Serving).serve(
            new Request(`${document.publicUrl}/v/1`),
          )
        }),
      )
    expect((await serving()).status).toBe(200)

    await run(
      Effect.gen(function* () {
        yield* (yield* Documents).disable(parent.document.id, owner)
      }),
    )
    expect((await serving()).status).toBe(200)

    await run(
      Effect.gen(function* () {
        yield* (yield* Tree).patch(
          document.document.id,
          { visibility: 'private' },
          owner,
        )
      }),
    )
    expect((await serving()).status).toBe(404)
    await run(
      Effect.gen(function* () {
        yield* (yield* Tree).patch(
          document.document.id,
          { visibility: 'public' },
          owner,
        )
        yield* (yield* Documents).disable(document.document.id, owner)
      }),
    )
    expect((await serving()).status).toBe(404)
    await run(
      Effect.gen(function* () {
        yield* (yield* Documents).enable(document.document.id, owner)
        yield* (yield* Documents).delete(document.document.id, owner)
      }),
    )
    expect((await serving()).status).toBe(404)
  })

  it('creates through depth 16 and rejects deeper creates, cycles, overflow, and cross-workspace parents', async () => {
    const ownerSeed = await seedPrincipal(env, { suffix: 'depth_owner' })
    const owner = await resolve(ownerSeed.token)
    const chain = [await publish(owner, 'Depth 0', { visibility: 'team' })]
    for (let depth = 1; depth <= 16; depth += 1) {
      chain.push(
        await publish(owner, `Depth ${depth}`, {
          parentId: chain.at(-1)!.document.id,
        }),
      )
    }
    const tooDeep = await run(
      Effect.gen(function* () {
        return yield* (yield* Publish)
          .publish(
            {
              html: html('Depth 17'),
              parentId: chain.at(-1)!.document.id,
              idempotencyKey: 'depth-17-rejected',
            },
            owner,
          )
          .pipe(Effect.either)
      }),
    )
    expect(tooDeep).toMatchObject({
      _tag: 'Left',
      left: { code: 'policy_rejected' },
    })

    expect(
      await patchEither(
        chain[0].document.id,
        { parentId: chain[1].document.id },
        owner,
      ),
    ).toMatchObject({ _tag: 'Left', left: { code: 'policy_rejected' } })
    const movable = await publish(owner, 'Movable root child', {
      parentId: chain[0].document.id,
    })
    expect(
      await patchEither(
        movable.document.id,
        { parentId: chain.at(-1)!.document.id },
        owner,
      ),
    ).toMatchObject({ _tag: 'Left', left: { code: 'policy_rejected' } })

    const otherSeed = await seedPrincipal(env, { suffix: 'depth_other' })
    const other = await resolve(otherSeed.token)
    const otherRoot = await publish(other, 'Other workspace public', {
      visibility: 'public',
    })
    expect(
      await patchEither(
        movable.document.id,
        { parentId: otherRoot.document.id },
        owner,
      ),
    ).toMatchObject({ _tag: 'Left', left: { code: 'not_found' } })

    const rooted = await run(
      Effect.gen(function* () {
        return yield* (yield* Tree).patch(
          movable.document.id,
          { parentId: null },
          owner,
        )
      }),
    )
    expect(rooted.parentId).toBeNull()
    const storage = await env.DB.prepare(
      `SELECT path, depth FROM documents WHERE id = ?`,
    )
      .bind(movable.document.id)
      .first<{ path: string; depth: number }>()
    expect(storage).toEqual({ path: '/', depth: 0 })
  })

  it('rewrites tombstone paths and enforces admin editor overrides', async () => {
    const ownerSeed = await seedPrincipal(env, { suffix: 'move_owner' })
    const owner = await resolve(ownerSeed.token)
    const admin = await actor('move_admin', owner.workspaceId, 'admin')
    const member = await actor('move_member', owner.workspaceId, 'member')
    const root = await publish(member.principal, 'Member document', {
      visibility: 'team',
    })
    const tombstone = await publish(member.principal, 'Moved tombstone', {
      parentId: root.document.id,
    })
    await run(
      Effect.gen(function* () {
        yield* (yield* Documents).delete(
          tombstone.document.id,
          member.principal,
        )
      }),
    )
    const destination = await publish(owner, 'Admin destination', {
      visibility: 'team',
    })
    const before = await env.DB.prepare(
      `SELECT path FROM documents WHERE id = ?`,
    )
      .bind(tombstone.document.id)
      .first<{ path: string }>()

    const memberDenied = await patchEither(
      destination.document.id,
      { description: 'member edit' },
      member.principal,
    )
    expect(memberDenied).toMatchObject({
      _tag: 'Left',
      left: { code: 'editor_required' },
    })
    const changed = await run(
      Effect.gen(function* () {
        return yield* (yield* Tree).patch(
          root.document.id,
          {
            parentId: destination.document.id,
            kind: '  ReSearch-Note  ',
          },
          admin.principal,
        )
      }),
    )
    expect(changed.kind).toBe('research-note')
    const after = await env.DB.prepare(
      `SELECT path FROM documents WHERE id = ?`,
    )
      .bind(tombstone.document.id)
      .first<{ path: string }>()
    expect(after?.path).not.toBe(before?.path)
    expect(after?.path).toContain(destination.document.id)

    const deleted = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).delete(
          root.document.id,
          admin.principal,
          true,
        )
      }),
    )
    expect(deleted.deleted).toBe(1)
  })

  it('archives the current parent graph when stored paths no longer match a preflight view', async () => {
    const ownerSeed = await seedPrincipal(env, {
      suffix: 'archive_current_tree_owner',
    })
    const owner = await resolve(ownerSeed.token)
    const root = await publish(owner, 'Archive current tree root', {
      visibility: 'team',
    })
    const child = await publish(owner, 'Archive current tree child', {
      parentId: root.document.id,
    })

    // This is the state the old preflight-path implementation could observe
    // across a concurrent move: the root lookup and descendant lookup no
    // longer describe the same storage prefix. Parent links remain current.
    await env.DB.prepare(
      `UPDATE documents SET path = '/stale/', depth = 1 WHERE id = ?`,
    )
      .bind(root.document.id)
      .run()

    const refused = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents)
          .delete(root.document.id, owner)
          .pipe(Effect.either)
      }),
    )
    expect(refused).toMatchObject({
      _tag: 'Left',
      left: { code: 'has_children', details: { count: 1 } },
    })
    const beforeForce = await env.DB.prepare(
      `SELECT id, deleted_at FROM documents WHERE id IN (?, ?) ORDER BY id`,
    )
      .bind(root.document.id, child.document.id)
      .all<{ id: string; deleted_at: string | null }>()
    expect(beforeForce.results.every((row) => row.deleted_at === null)).toBe(
      true,
    )

    const deletion = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).delete(root.document.id, owner, true)
      }),
    )
    expect(deletion.deleted).toBe(2)
    const tagged = await env.DB.prepare(
      `SELECT id FROM documents WHERE deletion_batch_id = ? ORDER BY id`,
    )
      .bind(deletion.batchId)
      .all<{ id: string }>()
    expect(tagged.results.map((row) => row.id)).toEqual(
      [root.document.id, child.document.id].sort(),
    )
  })

  it('materialises inherited shares, composes concurrent deltas, and rejects stale replacement', async () => {
    const ownerSeed = await seedPrincipal(env, { suffix: 'shares_owner' })
    const owner = await resolve(ownerSeed.token)
    const parent = await publish(owner, 'Shared parent', {
      visibility: 'private',
      shares: ['inherited@example.test'],
    })
    const child = await publish(owner, 'Inheriting child', {
      parentId: parent.document.id,
    })

    await Promise.all([
      run(
        Effect.gen(function* () {
          return yield* (yield* Shares).delta(
            child.document.id,
            { add: ['one@example.test'] },
            owner,
          )
        }),
      ),
      run(
        Effect.gen(function* () {
          return yield* (yield* Shares).delta(
            child.document.id,
            { add: ['two@example.test'] },
            owner,
          )
        }),
      ),
    ])
    const configured = await run(
      Effect.gen(function* () {
        return yield* (yield* Shares).get(child.document.id, owner)
      }),
    )
    expect(configured.accessSource).toBe('own')
    expect(configured.configured).toEqual([
      'inherited@example.test',
      'one@example.test',
      'two@example.test',
    ])

    const revision = (await env.DB.prepare(
      `SELECT revision FROM documents WHERE id = ?`,
    )
      .bind(child.document.id)
      .first<{ revision: number }>())!.revision
    await run(
      Effect.gen(function* () {
        yield* (yield* Shares).replace(
          child.document.id,
          {
            emails: ['replacement@example.test'],
            ifRevision: revision,
          },
          owner,
        )
      }),
    )
    const stale = await run(
      Effect.gen(function* () {
        return yield* (yield* Shares)
          .replace(
            child.document.id,
            {
              emails: ['stale@example.test'],
              ifRevision: revision,
            },
            owner,
          )
          .pipe(Effect.either)
      }),
    )
    expect(stale).toMatchObject({ _tag: 'Left', left: { code: 'conflict' } })
  })

  it('archives multi-author live subtrees and restores only the current batch', async () => {
    const ownerSeed = await seedPrincipal(env, { suffix: 'archive_owner' })
    const owner = await resolve(ownerSeed.token)
    const member = await actor('archive_member', owner.workspaceId, 'member')
    const parent = await publish(owner, 'Archive parent', {
      visibility: 'team',
    })
    const ticket = await publish(owner, 'Archive ticket', {
      parentId: parent.document.id,
    })
    const old = await publish(owner, 'Old tombstone', {
      parentId: ticket.document.id,
    })
    const oldDelete = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).delete(old.document.id, owner)
      }),
    )
    const research = await publish(member.principal, 'Intern research', {
      parentId: ticket.document.id,
    })

    const conflict = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents)
          .delete(ticket.document.id, owner)
          .pipe(Effect.either)
      }),
    )
    expect(conflict).toMatchObject({
      _tag: 'Left',
      left: { code: 'has_children', details: { count: 1 } },
    })
    const deletion = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).delete(ticket.document.id, owner, true)
      }),
    )
    expect(deletion.deleted).toBe(2)
    expect(deletion.authors).toEqual(
      expect.arrayContaining([
        { accountId: owner.accountId, name: owner.accountName, count: 1 },
        {
          accountId: member.accountId,
          name: member.principal.accountName,
          count: 1,
        },
      ]),
    )

    const ownerTrash = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).list({ scope: 'trash' }, owner)
      }),
    )
    const ticketRoot = ownerTrash.documents.find(
      (document) => document.id === ticket.document.id,
    )
    expect(
      ticketRoot && isDocumentEditor(ticketRoot)
        ? ticketRoot.deletionRootTitle
        : null,
    ).toBe('Archive ticket')
    expect(
      ticketRoot && isDocumentEditor(ticketRoot) ? ticketRoot.deletedBy : null,
    ).toBe(owner.accountName)
    expect(
      ticketRoot && isDocumentEditor(ticketRoot) ? ticketRoot.authors : null,
    ).toEqual(
      expect.arrayContaining([
        { accountId: owner.accountId, name: owner.accountName, count: 1 },
        {
          accountId: member.accountId,
          name: member.principal.accountName,
          count: 1,
        },
      ]),
    )
    const memberTrash = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).list(
          { scope: 'trash' },
          member.principal,
        )
      }),
    )
    expect(memberTrash.documents).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: research.document.id }),
      ]),
    )

    const oldState = await env.DB.prepare(
      `SELECT deletion_batch_id FROM documents WHERE id = ?`,
    )
      .bind(old.document.id)
      .first<{ deletion_batch_id: string }>()
    expect(oldState?.deletion_batch_id).toBe(oldDelete.batchId)

    const parentDelete = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents).delete(parent.document.id, owner)
      }),
    )
    const refused = await run(
      Effect.gen(function* () {
        return yield* (yield* Documents)
          .restore(ticket.document.id, deletion.batchId, owner)
          .pipe(Effect.either)
      }),
    )
    expect(refused).toMatchObject({ _tag: 'Left', left: { code: 'conflict' } })
    await run(
      Effect.gen(function* () {
        yield* (yield* Documents).restore(
          parent.document.id,
          parentDelete.batchId,
          owner,
        )
        yield* (yield* Documents).restore(
          ticket.document.id,
          deletion.batchId,
          owner,
        )
      }),
    )
    const states = await env.DB.prepare(
      `SELECT id, deleted_at, deletion_batch_id FROM documents
        WHERE id IN (?, ?, ?) ORDER BY id`,
    )
      .bind(ticket.document.id, research.document.id, old.document.id)
      .all<{
        id: string
        deleted_at: string | null
        deletion_batch_id: string | null
      }>()
    expect(
      states.results.find((row) => row.id === ticket.document.id)?.deleted_at,
    ).toBeNull()
    expect(
      states.results.find((row) => row.id === research.document.id)?.deleted_at,
    ).toBeNull()
    expect(
      states.results.find((row) => row.id === old.document.id)
        ?.deletion_batch_id,
    ).toBe(oldDelete.batchId)

    const repeated = await run(
      Effect.gen(function* () {
        const documents = yield* Documents
        const next = yield* documents.delete(ticket.document.id, owner, true)
        yield* documents.restore(ticket.document.id, next.batchId, owner)
        return next
      }),
    )
    expect(repeated.batchId).not.toBe(deletion.batchId)
  })
})
