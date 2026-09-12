import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('D1 migrations', () => {
  it('applies the schema and persists a workspace row', async () => {
    const now = '2026-09-12T00:00:00.000Z'

    await env.DB.prepare(
      `INSERT INTO workspaces
        (id, slug, kind, email_domain, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind('workspace-test', 'test', 'team', 'test.example', 'Test', now, now)
      .run()

    const workspace = await env.DB.prepare(
      'SELECT id, slug, kind, email_domain, name FROM workspaces WHERE id = ?',
    )
      .bind('workspace-test')
      .first()

    expect(workspace).toEqual({
      id: 'workspace-test',
      slug: 'test',
      kind: 'team',
      email_domain: 'test.example',
      name: 'Test',
    })
  })
})
