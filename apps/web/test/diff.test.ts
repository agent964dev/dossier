import { env as workerEnv } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import worker from '../src/worker'
import { visibleText } from '../src/services/diff'
import { seedPrincipal, testEnv } from './core-helpers'

const env = testEnv(workerEnv)

type JsonObject = Record<string, any>

async function api(
  path: string,
  options: {
    readonly token: string
    readonly method?: string
    readonly body?: unknown
    readonly environment?: Cloudflare.Env
  },
): Promise<Response> {
  const headers = new Headers({
    authorization: `Bearer ${options.token}`,
  })
  let requestBody: string | undefined
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json')
    requestBody = JSON.stringify(options.body)
  }
  return worker.fetch(
    new Request(`https://dossier.test${path}`, {
      method: options.method ?? (requestBody === undefined ? 'GET' : 'POST'),
      headers,
      body: requestBody,
    }) as Parameters<typeof worker.fetch>[0],
    options.environment ?? env,
  )
}

async function body(response: Response): Promise<JsonObject> {
  return response.json() as Promise<JsonObject>
}

async function upload(
  token: string,
  html: string,
  options: { readonly documentId?: string; readonly visibility?: string } = {},
): Promise<JsonObject> {
  const response = await api('/api/uploads', {
    token,
    body: {
      html,
      idempotencyKey: crypto.randomUUID(),
      ...options,
    },
  })
  expect(response.status).toBe(options.documentId ? 200 : 201)
  return body(response)
}

function documentHtml(line: string, newline = '\n'): string {
  return ['<!doctype html>', '<title>Version diff</title>', line, ''].join(
    newline,
  )
}

describe('version diff API', () => {
  it('extracts visible text from deeply nested markup without recursion', () => {
    const depth = 20_000
    const html = `${'<div>'.repeat(depth)}Deep visible text${'</div>'.repeat(depth)}`
    expect(visibleText(html)).toBe('Deep visible text\n')
  })

  it('returns unified JSON hunks and line statistics', async () => {
    const owner = await seedPrincipal(env, { suffix: 'diff_hunks' })
    const first = await upload(owner.token, documentHtml('<p>old line</p>'))
    await upload(owner.token, documentHtml('<p>new line</p>'), {
      documentId: first.document.id,
    })

    const response = await api(
      `/api/documents/${first.document.id}/diff?from=1&to=2`,
      { token: owner.token },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const result = await body(response)
    expect(result).toMatchObject({
      ok: true,
      documentId: first.document.id,
      from: { versionNumber: 1 },
      to: { versionNumber: 2 },
      mode: 'html',
      stats: { added: 1, removed: 1 },
    })
    expect(result.from.createdAt).toEqual(expect.any(String))
    expect(result.from.fileSize).toBeGreaterThan(0)
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0].lines).toEqual(
      expect.arrayContaining([
        { op: '-', text: '<p>old line</p>' },
        { op: '+', text: '<p>new line</p>' },
      ]),
    )
  })

  it('allows the same version on both sides', async () => {
    const owner = await seedPrincipal(env, { suffix: 'diff_identical' })
    const first = await upload(owner.token, documentHtml('<p>same</p>'))

    const response = await api(
      `/api/documents/${first.document.id}/diff?from=1&to=1`,
      { token: owner.token },
    )
    expect(response.status).toBe(200)
    expect(await body(response)).toMatchObject({
      from: { versionNumber: 1 },
      to: { versionNumber: 1 },
      hunks: [],
      stats: { added: 0, removed: 0 },
    })
  })

  it('defaults to the previous and latest versions', async () => {
    const owner = await seedPrincipal(env, { suffix: 'diff_defaults' })
    const first = await upload(owner.token, documentHtml('<p>first</p>'))
    await upload(owner.token, documentHtml('<p>latest</p>'), {
      documentId: first.document.id,
    })

    const response = await api(`/api/documents/${first.document.id}/diff`, {
      token: owner.token,
    })
    expect(response.status).toBe(200)
    expect(await body(response)).toMatchObject({
      from: { versionNumber: 1 },
      to: { versionNumber: 2 },
    })
  })

  it('rejects malformed parameters and returns 404 for unknown versions', async () => {
    const owner = await seedPrincipal(env, { suffix: 'diff_parameters' })
    const first = await upload(owner.token, documentHtml('<p>parameters</p>'))

    for (const query of ['from=0', 'from=abc', 'to=1.5', 'mode=raw']) {
      const response = await api(
        `/api/documents/${first.document.id}/diff?${query}`,
        { token: owner.token },
      )
      expect(response.status, query).toBe(422)
      expect(await body(response), query).toMatchObject({
        ok: false,
        code: 'policy_rejected',
      })
    }

    const missing = await api(
      `/api/documents/${first.document.id}/diff?from=1&to=99`,
      { token: owner.token },
    )
    expect(missing.status).toBe(404)
    expect(await body(missing)).toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })

  it('returns editor_required only when the document is readable', async () => {
    const owner = await seedPrincipal(env, { suffix: 'diff_owner' })
    const outsider = await seedPrincipal(env, { suffix: 'diff_outsider' })
    const readable = await upload(owner.token, documentHtml('<p>public</p>'), {
      visibility: 'public',
    })
    const hidden = await upload(owner.token, documentHtml('<p>private</p>'), {
      visibility: 'private',
    })

    const forbidden = await api(
      `/api/documents/${readable.document.id}/diff?from=1&to=1`,
      { token: outsider.token },
    )
    expect(forbidden.status).toBe(403)
    expect(await body(forbidden)).toMatchObject({
      ok: false,
      code: 'editor_required',
    })

    const notFound = await api(
      `/api/documents/${hidden.document.id}/diff?from=1&to=1`,
      { token: outsider.token },
    )
    expect(notFound.status).toBe(404)
    expect(await body(notFound)).toMatchObject({
      ok: false,
      code: 'not_found',
    })
  })

  it('hides disabled and archived version content from its author until enabled or restored', async () => {
    const owner = await seedPrincipal(env, { suffix: 'diff_availability' })
    const first = await upload(owner.token, documentHtml('<p>before</p>'))
    await upload(owner.token, documentHtml('<p>after</p>'), {
      documentId: first.document.id,
    })
    const documentPath = `/api/documents/${first.document.id}`
    const diffPath = `${documentPath}/diff?from=1&to=2`

    const disabled = await api(`${documentPath}/disable`, {
      token: owner.token,
      body: { reason: 'Review version content' },
    })
    expect(disabled.status).toBe(200)
    const disabledDiff = await api(diffPath, { token: owner.token })
    expect(disabledDiff.status).toBe(404)
    expect(await body(disabledDiff)).toMatchObject({
      ok: false,
      code: 'not_found',
    })

    const enabled = await api(`${documentPath}/enable`, {
      token: owner.token,
      method: 'POST',
    })
    expect(enabled.status).toBe(200)
    const enabledDiff = await api(diffPath, { token: owner.token })
    expect(enabledDiff.status).toBe(200)
    expect(await body(enabledDiff)).toMatchObject({
      ok: true,
      from: { versionNumber: 1 },
      to: { versionNumber: 2 },
      stats: { added: 1, removed: 1 },
    })

    const archived = await api(documentPath, {
      token: owner.token,
      method: 'DELETE',
    })
    expect(archived.status).toBe(200)
    const deletion = await body(archived)
    expect(deletion).toMatchObject({ ok: true, deleted: 1 })
    const archivedDiff = await api(diffPath, { token: owner.token })
    expect(archivedDiff.status).toBe(404)
    expect(await body(archivedDiff)).toMatchObject({
      ok: false,
      code: 'not_found',
    })

    const restored = await api(`${documentPath}/restore`, {
      token: owner.token,
      body: { batchId: deletion.batchId },
    })
    expect(restored.status).toBe(200)
    const restoredDiff = await api(diffPath, { token: owner.token })
    expect(restoredDiff.status).toBe(200)
    expect(await body(restoredDiff)).toMatchObject({
      ok: true,
      from: { versionNumber: 1 },
      to: { versionNumber: 2 },
      stats: { added: 1, removed: 1 },
    })
  })

  it('normalises a leading BOM and CRLF line endings', async () => {
    const owner = await seedPrincipal(env, { suffix: 'diff_normalise' })
    const first = await upload(
      owner.token,
      `\uFEFF${documentHtml('<p>normalised</p>', '\r\n')}`,
    )
    await upload(owner.token, documentHtml('<p>normalised</p>'), {
      documentId: first.document.id,
    })

    const response = await api(
      `/api/documents/${first.document.id}/diff?from=1&to=2`,
      { token: owner.token },
    )
    expect(response.status).toBe(200)
    expect(await body(response)).toMatchObject({
      hunks: [],
      stats: { added: 0, removed: 0 },
    })
  })

  it('compares visible block text and omits script, style, and template content', async () => {
    const owner = await seedPrincipal(env, { suffix: 'diff_text_mode' })
    const first = await upload(
      owner.token,
      '<!doctype html><title>Text</title><style>.old { color: red }</style><main><h1>Hello   world</h1><p>Before <strong>text</strong></p><script>oldScript()</script><template>old template</template></main>',
    )
    await upload(
      owner.token,
      '<!doctype html><title>Text</title><style>.new { color: blue }</style><main><h1>Hello world</h1><p>After text</p><script>newScript()</script><template>new template</template></main>',
      { documentId: first.document.id },
    )

    const response = await api(
      `/api/documents/${first.document.id}/diff?from=1&to=2&mode=text`,
      { token: owner.token },
    )
    expect(response.status).toBe(200)
    const result = await body(response)
    expect(result).toMatchObject({
      mode: 'text',
      stats: { added: 1, removed: 1 },
    })
    const lines = result.hunks.flatMap((hunk: JsonObject) => hunk.lines)
    expect(lines).toEqual(
      expect.arrayContaining([
        { op: ' ', text: 'Hello world' },
        { op: '-', text: 'Before text' },
        { op: '+', text: 'After text' },
      ]),
    )
    expect(JSON.stringify(lines)).not.toMatch(
      /oldScript|newScript|template|color/,
    )
  })

  it('preserves missing EOF-newline metadata on changed lines', async () => {
    const owner = await seedPrincipal(env, { suffix: 'diff_eof' })
    const first = await upload(
      owner.token,
      '<!doctype html>\n<title>EOF</title>\n<p>before</p>\n',
    )
    await upload(
      owner.token,
      '<!doctype html>\n<title>EOF</title>\n<p>after</p>',
      { documentId: first.document.id },
    )

    const response = await api(
      `/api/documents/${first.document.id}/diff?from=1&to=2`,
      { token: owner.token },
    )
    expect(response.status).toBe(200)
    const result = await body(response)
    expect(result.hunks[0].lines).toEqual(
      expect.arrayContaining([
        { op: '+', text: '<p>after</p>', noNewline: true },
      ]),
    )
  })

  it('lets workspace admins load and compare another author’s versions', async () => {
    const owner = await seedPrincipal(env, { suffix: 'diff_admin_owner' })
    const admin = await seedPrincipal(env, {
      suffix: 'diff_admin',
      role: null,
    })
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memberships (workspace_id, account_id, role, created_at)
         VALUES (?, ?, 'admin', ?)`,
      ).bind(owner.workspaceId, admin.accountId, '2026-09-12T00:00:00.000Z'),
      env.DB.prepare('UPDATE api_keys SET workspace_id = ? WHERE id = ?').bind(
        owner.workspaceId,
        admin.keyId,
      ),
    ])
    const first = await upload(owner.token, documentHtml('<p>admin old</p>'))
    await upload(owner.token, documentHtml('<p>admin new</p>'), {
      documentId: first.document.id,
    })

    const detail = await api(`/api/documents/${first.document.id}`, {
      token: admin.token,
    })
    expect(detail.status).toBe(200)
    expect((await body(detail)).versions).toHaveLength(2)

    const comparison = await api(
      `/api/documents/${first.document.id}/diff?from=1&to=2`,
      { token: admin.token },
    )
    expect(comparison.status).toBe(200)
    expect(await body(comparison)).toMatchObject({
      stats: { added: 1, removed: 1 },
    })
  })

  it('aborts highly divergent inputs before diff computation becomes unbounded', async () => {
    const owner = await seedPrincipal(env, { suffix: 'diff_edit_cap' })
    const oldLines = Array.from(
      { length: 551 },
      (_, index) => `<p>old ${index}</p>`,
    ).join('\n')
    const newLines = Array.from(
      { length: 551 },
      (_, index) => `<p>new ${index}</p>`,
    ).join('\n')
    const first = await upload(
      owner.token,
      `<!doctype html>\n<title>Edit cap</title>\n${oldLines}`,
    )
    await upload(
      owner.token,
      `<!doctype html>\n<title>Edit cap</title>\n${newLines}`,
      { documentId: first.document.id },
    )

    const response = await api(
      `/api/documents/${first.document.id}/diff?from=1&to=2`,
      { token: owner.token },
    )
    expect(response.status).toBe(413)
    expect(await body(response)).toMatchObject({
      ok: false,
      code: 'diff_too_large',
    })
  })

  it('returns diff_too_large for byte and total-line caps', async () => {
    const owner = await seedPrincipal(env, { suffix: 'diff_caps' })
    const ordinary = await upload(owner.token, documentHtml('<p>byte cap</p>'))
    const byteLimitedEnv = {
      ...env,
      MAX_HTML_BYTES: '32',
    } as unknown as Cloudflare.Env
    const byteLimited = await api(
      `/api/documents/${ordinary.document.id}/diff?from=1&to=1`,
      { token: owner.token, environment: byteLimitedEnv },
    )
    expect(byteLimited.status).toBe(413)
    expect(await body(byteLimited)).toMatchObject({
      ok: false,
      code: 'diff_too_large',
    })

    const manyLines =
      '<!doctype html>\n<title>Many lines</title>\n' +
      '<p>line</p>\n'.repeat(9_999)
    const large = await upload(owner.token, manyLines)
    const lineLimited = await api(
      `/api/documents/${large.document.id}/diff?from=1&to=1`,
      { token: owner.token },
    )
    expect(lineLimited.status).toBe(413)
    expect(await body(lineLimited)).toMatchObject({
      ok: false,
      code: 'diff_too_large',
    })
  })
})
