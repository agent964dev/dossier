import { createServer, type IncomingMessage, type Server } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const packageDirectory = new URL('..', import.meta.url).pathname
const artifact = join(packageDirectory, 'dist/index.js')
const bomFixture = join(packageDirectory, 'test/fixtures/bom.html')
let server: Server
let apiUrl: string
const homes: string[] = []
interface StoredDocument {
  html: Buffer
  version: number
  revision: number
  filename: string
  kind: string | null
  visibility: 'public' | 'team' | 'private' | null
  parentId: string | null
  authorAccountId: string
  authorName: string
  shares: string[]
  deletionBatchId: string | null
  deletionRootTitle: string | null
  deletedBy: string | null
}

const documents = new Map<string, StoredDocument>()
const idempotencyKeys: string[] = []
const listQueries: Array<{ scope: string | null; parent: string | null }> = []
let nextId = 1
let retryFailureSeen = false
let redirectWasFollowed = false

async function bodyJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >
}

function documentDto(id: string, stored: StoredDocument) {
  const now = '2026-09-12T00:00:00.000Z'
  const title = basename(stored.filename, '.html')
  return {
    id,
    title,
    description: null,
    kind: stored.kind,
    parentId: stored.parentId,
    effectiveVisibility: stored.visibility ?? 'team',
    workspaceSlug: 'test',
    authorAccountId: stored.authorAccountId,
    authorName: stored.authorName,
    latestVersionNumber: stored.version,
    disabled: false,
    url: `${apiUrl}/d/${id}`,
    rawUrl: `${apiUrl}/d/${id}/raw`,
    hubUrl: `${apiUrl}/d/${id}/tree`,
    createdAt: now,
    updatedAt: now,
    visibility: stored.visibility,
    accessSource: stored.visibility === null ? 'inherited' : 'own',
    versionCount: stored.version,
    revision: stored.revision,
    deletionBatchId: stored.deletionBatchId,
    deletionRootTitle: stored.deletionRootTitle,
    deletedAt: stored.deletionBatchId === null ? null : now,
    deletedBy: stored.deletedBy,
    disabledAt: null,
  }
}

function readerDto(id: string, stored: StoredDocument) {
  const document = documentDto(id, stored)
  return {
    id: document.id,
    title: document.title,
    description: document.description,
    kind: document.kind,
    parentId: document.parentId,
    effectiveVisibility: document.effectiveVisibility,
    workspaceSlug: document.workspaceSlug,
    authorAccountId: document.authorAccountId,
    authorName: document.authorName,
    latestVersionNumber: document.latestVersionNumber,
    disabled: document.disabled,
    url: document.url,
    rawUrl: document.rawUrl,
    hubUrl: document.hubUrl,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  }
}

function storedDocument(
  filename: string,
  overrides: Partial<StoredDocument> = {},
): StoredDocument {
  return {
    html: Buffer.from(`<!doctype html><title>${basename(filename, '.html')}</title>`),
    version: 1,
    revision: 1,
    filename,
    kind: null,
    visibility: 'team',
    parentId: null,
    authorAccountId: 'acct_test',
    authorName: 'Test User',
    shares: [],
    deletionBatchId: null,
    deletionRootTitle: null,
    deletedBy: null,
    ...overrides,
  }
}

function descendantIds(rootId: string): string[] {
  const descendants: string[] = []
  const pending = [rootId]
  while (pending.length > 0) {
    const parentId = pending.shift()!
    for (const [id, stored] of documents) {
      if (stored.parentId === parentId && stored.deletionBatchId === null) {
        descendants.push(id)
        pending.push(id)
      }
    }
  }
  return descendants
}

function authorSummaries(ids: readonly string[]) {
  const byAccount = new Map<
    string,
    { accountId: string; name: string; count: number }
  >()
  for (const id of ids) {
    const stored = documents.get(id)!
    const summary = byAccount.get(stored.authorAccountId) ?? {
      accountId: stored.authorAccountId,
      name: stored.authorName,
      count: 0,
    }
    summary.count += 1
    byAccount.set(stored.authorAccountId, summary)
  }
  return [...byAccount.values()]
}

function authenticated(request: IncomingMessage): boolean {
  return request.headers.authorization === 'Bearer ds_integration'
}

beforeAll(async () => {
  await exec('bun', ['run', 'build'], { cwd: packageDirectory })

  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/healthz') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({ ok: true, service: 'dossier', version: '0.0.0' }),
      )
      return
    }

    if (url.pathname === '/redirect-target') {
      redirectWasFollowed = true
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true }))
      return
    }

    if (url.pathname === '/api/me') {
      response.setHeader('content-type', 'application/json')
      if (request.headers.authorization === 'Bearer ds_redirect') {
        response.statusCode = 302
        response.setHeader('location', '/redirect-target')
        response.end()
        return
      }
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      response.end(
        JSON.stringify({
          accountId: 'acct_test',
          accountName: 'Test User',
          apiKeyId: 'key_test',
          apiKeyName: 'integration',
          workspace: {
            id: 'ws_test',
            slug: 'test',
            kind: 'team',
            role: 'admin',
          },
          email: 'test@example.com',
        }),
      )
      return
    }

    if (url.pathname === '/api/uploads' && request.method === 'POST') {
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const payload = await bodyJson(request)
      const requestedId =
        typeof payload.documentId === 'string' ? payload.documentId : undefined
      if (typeof payload.idempotencyKey === 'string')
        idempotencyKeys.push(payload.idempotencyKey)
      if (payload.filename === 'retry.html' && !retryFailureSeen) {
        retryFailureSeen = true
        response.statusCode = 503
        response.end(
          JSON.stringify({ ok: false, code: 'temporarily_unavailable' }),
        )
        return
      }
      if (requestedId && !documents.has(requestedId)) {
        response.statusCode = 404
        response.end(JSON.stringify({ ok: false, code: 'not_found' }))
        return
      }
      const id = requestedId ?? `doc${String(nextId++).padStart(9, '0')}`
      const previous = documents.get(id)
      if (
        previous &&
        Object.hasOwn(payload, 'parentId') &&
        (payload.parentId ?? null) !== previous.parentId
      ) {
        response.statusCode = 409
        response.end(
          JSON.stringify({
            ok: false,
            code: 'conflict',
            message: 'Use the move operation to change a document parent.',
          }),
        )
        return
      }
      const stored: StoredDocument = {
        html: Buffer.from(String(payload.html), 'utf8'),
        version: (previous?.version ?? 0) + 1,
        revision: (previous?.revision ?? 0) + 1,
        filename:
          typeof payload.filename === 'string'
            ? payload.filename
            : 'document.html',
        kind:
          typeof payload.kind === 'string'
            ? payload.kind
            : (previous?.kind ?? null),
        visibility:
          payload.visibility === null || typeof payload.visibility === 'string'
            ? (payload.visibility as StoredDocument['visibility'])
            : (previous?.visibility ?? 'team'),
        parentId:
          payload.parentId === null || typeof payload.parentId === 'string'
            ? payload.parentId
            : (previous?.parentId ?? null),
        authorAccountId: previous?.authorAccountId ?? 'acct_test',
        authorName: previous?.authorName ?? 'Test User',
        shares:
          Array.isArray(payload.shares) && payload.shares.every((email) => typeof email === 'string')
            ? payload.shares
            : (previous?.shares ?? []),
        deletionBatchId: previous?.deletionBatchId ?? null,
        deletionRootTitle: previous?.deletionRootTitle ?? null,
        deletedBy: previous?.deletedBy ?? null,
      }
      documents.set(id, stored)
      const document = documentDto(id, stored)
      response.statusCode = previous ? 200 : 201
      response.end(
        JSON.stringify({
          ok: true,
          document,
          versionNumber: stored.version,
          versionUrl: `${apiUrl}/d/${id}/v/${stored.version}`,
          warnings: [],
          draftId: id,
          publicUrl: document.url,
          rawUrl: document.rawUrl,
        }),
      )
      return
    }

    const documentApi =
      /^\/api\/documents\/([a-z0-9]{12})(?:\/(restore|disable|enable|tree|shares))?$/.exec(
        url.pathname,
      )
    if (documentApi) {
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const id = documentApi[1]!
      const action = documentApi[2]
      const stored = documents.get(id)
      if (!stored) {
        response.statusCode = 404
        response.end(JSON.stringify({ ok: false, code: 'not_found' }))
        return
      }
      if (request.method === 'GET' && action === undefined) {
        response.end(
          JSON.stringify({
            ok: true,
            document: documentDto(id, stored),
            versions: [],
          }),
        )
        return
      }
      if (request.method === 'GET' && action === 'tree') {
        const breadcrumb = []
        let parentId = stored.parentId
        while (parentId !== null) {
          const parent = documents.get(parentId)
          if (!parent) break
          breadcrumb.unshift(readerDto(parentId, parent))
          parentId = parent.parentId
        }
        response.end(
          JSON.stringify({
            breadcrumb,
            document: readerDto(id, stored),
            siblings: [...documents]
              .filter(
                ([candidateId, candidate]) =>
                  candidateId !== id &&
                  candidate.parentId === stored.parentId &&
                  candidate.deletionBatchId === null,
              )
              .map(([candidateId, candidate]) =>
                readerDto(candidateId, candidate),
              ),
            children: [...documents]
              .filter(
                ([, candidate]) =>
                  candidate.parentId === id && candidate.deletionBatchId === null,
              )
              .map(([candidateId, candidate]) =>
                readerDto(candidateId, candidate),
              ),
          }),
        )
        return
      }
      if (request.method === 'PATCH' && action === undefined) {
        const payload = await bodyJson(request)
        if ('parentId' in payload) {
          stored.parentId =
            payload.parentId === null ? null : String(payload.parentId)
        }
        if ('visibility' in payload) {
          stored.visibility =
            payload.visibility === null
              ? null
              : (String(payload.visibility) as 'public' | 'team' | 'private')
        }
        stored.revision += 1
        response.end(
          JSON.stringify({ ok: true, document: documentDto(id, stored) }),
        )
        return
      }
      if (action === 'shares' && request.method === 'GET') {
        response.end(
          JSON.stringify({
            configured: stored.shares,
            effective: stored.shares,
            accessSource: 'own',
          }),
        )
        return
      }
      if (action === 'shares' && request.method === 'POST') {
        const payload = await bodyJson(request)
        const shares = new Set(stored.shares)
        if (Array.isArray(payload.add)) {
          for (const email of payload.add) shares.add(String(email))
        }
        if (Array.isArray(payload.remove)) {
          for (const email of payload.remove) shares.delete(String(email))
        }
        stored.shares = [...shares]
        stored.revision += 1
        response.end(
          JSON.stringify({
            configured: stored.shares,
            effective: stored.shares,
            accessSource: 'own',
          }),
        )
        return
      }
      if (request.method === 'DELETE' && action === undefined) {
        const descendants = descendantIds(id)
        const affected = [id, ...descendants]
        const authors = authorSummaries(affected)
        if (descendants.length > 0 && url.searchParams.get('force') !== '1') {
          response.statusCode = 409
          response.end(
            JSON.stringify({
              ok: false,
              code: 'has_children',
              message: 'Document has live descendants.',
              details: { count: descendants.length, authors },
            }),
          )
          return
        }
        const rootTitle = basename(stored.filename, '.html')
        for (const affectedId of affected) {
          const affectedDocument = documents.get(affectedId)!
          affectedDocument.deletionBatchId = 'batch_test'
          affectedDocument.deletionRootTitle = rootTitle
          affectedDocument.deletedBy = 'Test User'
        }
        response.end(
          JSON.stringify({
            ok: true,
            batchId: 'batch_test',
            deleted: affected.length,
            authors,
          }),
        )
        return
      }
      if (request.method === 'POST' && action === 'restore') {
        const payload = await bodyJson(request)
        for (const candidate of documents.values()) {
          if (candidate.deletionBatchId === payload.batchId) {
            candidate.deletionBatchId = null
            candidate.deletionRootTitle = null
            candidate.deletedBy = null
          }
        }
        response.end(
          JSON.stringify({ ok: true, document: documentDto(id, stored) }),
        )
        return
      }
      if (request.method === 'POST' && action === 'disable') {
        await bodyJson(request)
        response.end(
          JSON.stringify({ ok: true, document: documentDto(id, stored) }),
        )
        return
      }
      if (request.method === 'POST' && action === 'enable') {
        response.end(
          JSON.stringify({ ok: true, document: documentDto(id, stored) }),
        )
        return
      }
    }

    if (url.pathname === '/api/documents' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const scope = url.searchParams.get('scope') ?? 'mine'
      const parent = url.searchParams.get('parent')
      listQueries.push({ scope, parent })
      const filtered = [...documents].filter(([, stored]) => {
        if (scope === 'trash') return stored.deletionBatchId !== null
        if (stored.deletionBatchId !== null) return false
        if (parent === null) return true
        return parent === 'root'
          ? stored.parentId === null
          : stored.parentId === parent
      })
      const all = filtered.map(([id, stored]) => documentDto(id, stored))
      const offset = Number(url.searchParams.get('cursor') ?? '0')
      const pageSize = 1
      const page = all.slice(offset, offset + pageSize)
      const nextOffset = offset + page.length
      response.end(
        JSON.stringify({
          ok: true,
          documents: page,
          nextCursor: nextOffset < all.length ? String(nextOffset) : null,
        }),
      )
      return
    }

    const raw = /^\/d\/([a-z0-9]{12})(?:\/v\/(\d+))?\/raw$/.exec(url.pathname)
    if (raw) {
      if (!authenticated(request)) {
        response.statusCode = 401
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const stored = documents.get(raw[1]!)
      if (!stored || (raw[2] && Number(raw[2]) > stored.version)) {
        response.statusCode = 404
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ ok: false, code: 'not_found' }))
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(stored.html)
      return
    }

    response.statusCode = 404
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: false, code: 'not_found' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('server did not bind TCP')
  apiUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await Promise.all(
    homes.map((home) => rm(home, { recursive: true, force: true })),
  )
})

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dossier-cli-integration-'))
  homes.push(home)
  return home
}

async function cli(
  runtime: 'node' | 'bun',
  args: readonly string[],
  options: { input?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const home = options.home ?? (await temporaryHome())
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, [artifact, ...args], {
      env: { ...process.env, DOSSIER_HOME: home, ...options.env },
      stdio: 'pipe',
    })
    let stdout = ''
    let stderr = ''
    child.stdout
      .setEncoding('utf8')
      .on('data', (chunk: string) => (stdout += chunk))
    child.stderr
      .setEncoding('utf8')
      .on('data', (chunk: string) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 1 }),
    )
    child.stdin.end(options.input)
  })
}

async function authenticate(home: string, runtime: 'node' | 'bun' = 'node') {
  const result = await cli(
    runtime,
    ['auth', 'set', '--api-url', apiUrl, '--json'],
    {
      home,
      input: 'ds_integration\n',
    },
  )
  expect(result).toMatchObject({ stderr: '', exitCode: 0 })
}

describe('built CLI', () => {
  it('runs under Node and Bun', async () => {
    const node = await cli('node', ['health', '--api-url', apiUrl, '--json'])
    expect(node).toEqual({
      stdout: `${JSON.stringify({ ok: true, service: 'dossier', version: '0.0.0' })}\n`,
      stderr: '',
      exitCode: 0,
    })
    const bun = await cli('bun', ['health', '--api-url', apiUrl, '--json'])
    expect(bun.exitCode).toBe(0)
    expect(JSON.parse(bun.stdout)).toEqual({
      ok: true,
      service: 'dossier',
      version: '0.0.0',
    })
  })

  it('keeps health hidden from root help', async () => {
    const help = await cli('node', ['--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).not.toMatch(/- health/)
  })

  it('runs static upload validation before requiring credentials', async () => {
    const home = await temporaryHome()
    const file = join(home, 'invalid.html')
    await writeFile(file, '<!doctype html><form></form>', 'utf8')
    const result = await cli('node', ['upload', file, '--api-url', apiUrl], {
      home,
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Blocked <form> tag found.')
    expect(result.stderr).not.toContain('not authenticated')
  })

  it('stores credentials and prints workspace role through the typed client', async () => {
    const home = await temporaryHome()
    await authenticate(home, 'bun')
    const me = await cli('bun', ['whoami', '--json'], { home })
    expect(me.exitCode).toBe(0)
    expect(me.stderr).toBe('')
    expect(JSON.parse(me.stdout)).toEqual({
      accountId: 'acct_test',
      accountName: 'Test User',
      apiKeyId: 'key_test',
      apiKeyName: 'integration',
      workspace: { id: 'ws_test', slug: 'test', kind: 'team', role: 'admin' },
      email: 'test@example.com',
    })
  })

  it('creates then updates through the origin-account-path mapping', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const file = join(home, 'plan.html')
    await writeFile(
      file,
      '<!doctype html><title>Plan</title><p>one</p>',
      'utf8',
    )

    const created = await cli(
      'node',
      ['upload', file, '--kind', 'plan', '--visibility', 'public', '--json'],
      { home },
    )
    expect(created.exitCode).toBe(0)
    expect(created.stderr).toBe('')
    const first = JSON.parse(created.stdout)
    expect(first).toMatchObject({
      created: true,
      versionNumber: 1,
      kind: 'plan',
    })

    await writeFile(
      file,
      '<!doctype html><title>Plan</title><p>two</p>',
      'utf8',
    )
    const updated = await cli('node', ['upload', file, '--json'], { home })
    expect(updated.exitCode).toBe(0)
    const second = JSON.parse(updated.stdout)
    expect(second).toMatchObject({
      id: first.id,
      created: false,
      versionNumber: 2,
      kind: 'plan',
    })
    expect(idempotencyKeys.at(-2)).toMatch(/^[0-9a-f-]{36}$/)
    expect(idempotencyKeys.at(-1)).toMatch(/^[0-9a-f-]{36}$/)
    expect(idempotencyKeys.at(-1)).not.toBe(idempotencyKeys.at(-2))

    const mappings = JSON.parse(
      await readFile(join(home, 'documents.json'), 'utf8'),
    )
    expect(mappings[apiUrl].acct_test[file]).toMatchObject({
      documentId: first.id,
    })

    const listed = await cli('node', ['list', '--json'], { home })
    expect(listed.exitCode).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: first.id })]),
    )

    const deleted = await cli(
      'node',
      ['delete', first.id, '--force', '--json'],
      { home },
    )
    expect(deleted.exitCode).toBe(0)
    expect(JSON.parse(deleted.stdout)).toMatchObject({
      batchId: 'batch_test',
      deleted: 1,
    })
    const restored = await cli(
      'node',
      ['restore', first.id, '--batch', 'batch_test', '--json'],
      { home },
    )
    expect(restored.exitCode).toBe(0)
    expect(JSON.parse(restored.stdout)).toMatchObject({ id: first.id })
    expect(
      (await cli('node', ['disable', first.id, '--json'], { home })).exitCode,
    ).toBe(0)
    expect(
      (await cli('node', ['enable', first.id, '--json'], { home })).exitCode,
    ).toBe(0)

    const quiet = await cli('node', ['upload', file, '--new', '-q'], { home })
    expect(quiet).toEqual({
      stdout: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:\d+\/d\/[a-z0-9]{12}\n$/,
      ),
      stderr: '',
      exitCode: 0,
    })
  })

  it('reuses one idempotency key when a transient upload is retried', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const file = join(home, 'retry.html')
    await writeFile(file, '<!doctype html><title>Retry</title>', 'utf8')
    const before = idempotencyKeys.length
    const result = await cli('node', ['upload', file, '--json'], { home })
    expect(result.exitCode).toBe(0)
    const retryKeys = idempotencyKeys.slice(before)
    expect(retryKeys).toHaveLength(2)
    expect(retryKeys[0]).toBe(retryKeys[1])
  })

  it('fetches a BOM fixture with exact byte equality', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const upload = await cli('bun', ['upload', bomFixture, '--new', '--json'], {
      home,
    })
    expect(upload.exitCode).toBe(0)
    const document = JSON.parse(upload.stdout)
    const output = join(home, 'fetched.html')
    const fetched = await cli('node', ['fetch', document.id, '-o', output], {
      home,
    })
    expect(fetched.exitCode).toBe(0)
    expect(await readFile(output)).toEqual(await readFile(bomFixture))
  })

  it('follows document-list cursors until every page is loaded', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const listed = await cli('node', ['list', '--json'], { home })
    expect(listed.exitCode).toBe(0)
    expect(listed.stderr).toBe('')
    expect(
      JSON.parse(listed.stdout).map((document: { id: string }) => document.id),
    ).toEqual([...documents.keys()])
    expect(documents.size).toBeGreaterThan(1)
  })

  it('keeps the same parent on re-upload and points moves to the move command', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const firstParentFile = join(home, 'first-parent.html')
    const secondParentFile = join(home, 'second-parent.html')
    const childFile = join(home, 'parented-child.html')
    await writeFile(firstParentFile, '<!doctype html><title>First</title>', 'utf8')
    await writeFile(secondParentFile, '<!doctype html><title>Second</title>', 'utf8')
    await writeFile(childFile, '<!doctype html><title>Child</title>', 'utf8')
    const firstParent = JSON.parse(
      (await cli('node', ['upload', firstParentFile, '--new', '--json'], { home }))
        .stdout,
    )
    const secondParent = JSON.parse(
      (await cli('node', ['upload', secondParentFile, '--new', '--json'], { home }))
        .stdout,
    )
    const created = await cli(
      'node',
      ['upload', childFile, '--new', '--parent', firstParent.id, '--json'],
      { home },
    )
    expect(created.exitCode).toBe(0)
    expect(JSON.parse(created.stdout).parentId).toBe(firstParent.id)

    await writeFile(childFile, '<!doctype html><title>Child v2</title>', 'utf8')
    const sameParent = await cli(
      'node',
      ['upload', childFile, '--parent', firstParent.id, '--json'],
      { home },
    )
    expect(sameParent.exitCode).toBe(0)
    expect(JSON.parse(sameParent.stdout)).toMatchObject({
      versionNumber: 2,
      parentId: firstParent.id,
    })

    const changedParent = await cli(
      'node',
      ['upload', childFile, '--parent', secondParent.id],
      { home },
    )
    expect(changedParent.exitCode).toBe(1)
    expect(changedParent.stderr).toContain('use dossier move')
    expect(changedParent.stderr).toContain(secondParent.id)
  })

  it('lists a readable branch as a client-side nested tree', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set('navr00000001', storedDocument('Navigation Root.html'))
    documents.set(
      'navc00000001',
      storedDocument('Navigation Child.html', { parentId: 'navr00000001' }),
    )
    documents.set(
      'navg00000001',
      storedDocument('Navigation Grandchild.html', {
        parentId: 'navc00000001',
      }),
    )
    const before = listQueries.length
    const result = await cli(
      'node',
      ['list', '--tree', '--all', '--parent', 'navr00000001', '--json'],
      { home },
    )
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({
        id: 'navc00000001',
        children: [
          expect.objectContaining({ id: 'navg00000001', children: [] }),
        ],
      }),
    ])
    expect(listQueries.slice(before)).toEqual(
      expect.arrayContaining([
        { scope: 'readable', parent: 'navr00000001' },
        { scope: 'readable', parent: null },
      ]),
    )
  })

  it('shows breadcrumb, siblings, and children with tree', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set('treeroot0001', storedDocument('Tree Root.html'))
    documents.set(
      'treenode0001',
      storedDocument('Tree Node.html', { parentId: 'treeroot0001' }),
    )
    documents.set(
      'treesibl0001',
      storedDocument('Tree Sibling.html', { parentId: 'treeroot0001' }),
    )
    documents.set(
      'treechld0001',
      storedDocument('Tree Child.html', { parentId: 'treenode0001' }),
    )
    const result = await cli('node', ['tree', 'treenode0001', '--json'], {
      home,
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      breadcrumb: [{ id: 'treeroot0001' }],
      document: { id: 'treenode0001' },
      siblings: [{ id: 'treesibl0001' }],
      children: [{ id: 'treechld0001' }],
    })
  })

  it('moves a document to a parent or root', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set('movepar00001', storedDocument('Move Parent.html'))
    documents.set('movedoc00001', storedDocument('Move Document.html'))
    const moved = await cli(
      'node',
      ['move', 'movedoc00001', '--parent', 'movepar00001', '--json'],
      { home },
    )
    expect(moved.exitCode).toBe(0)
    expect(JSON.parse(moved.stdout).parentId).toBe('movepar00001')
    const rooted = await cli(
      'node',
      ['move', 'movedoc00001', '--parent', 'root', '--json'],
      { home },
    )
    expect(rooted.exitCode).toBe(0)
    expect(JSON.parse(rooted.stdout).parentId).toBeNull()
  })

  it('sets visibility and clears it to inherit', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set(
      'visidoc00001',
      storedDocument('Visibility Document.html', { visibility: 'public' }),
    )
    const result = await cli(
      'node',
      ['visibility', 'visidoc00001', 'inherit', '--json'],
      { home },
    )
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 'visidoc00001',
      visibility: null,
      effectiveVisibility: 'team',
      accessSource: 'inherited',
    })
  })

  it('adds and removes shares through the delta endpoint', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set(
      'sharedoc0001',
      storedDocument('Shared Document.html', { shares: ['old@example.com'] }),
    )
    const result = await cli(
      'node',
      [
        'share',
        'sharedoc0001',
        '--add',
        'one@example.com,two@example.com',
        '--remove',
        'old@example.com',
        '--json',
      ],
      { home },
    )
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      configured: ['one@example.com', 'two@example.com'],
      effective: ['one@example.com', 'two@example.com'],
      accessSource: 'own',
    })
  })

  it('shows trash batch roots with root titles and authors', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set(
      'trashrot0001',
      storedDocument('Archived Ticket.html', {
        deletionBatchId: 'batch_trash',
        deletionRootTitle: 'Archived Ticket',
        deletedBy: 'Test User',
      }),
    )
    documents.set(
      'trashchd0001',
      storedDocument('Archived Research.html', {
        parentId: 'trashrot0001',
        authorAccountId: 'acct_intern',
        authorName: 'Intern User',
        deletionBatchId: 'batch_trash',
        deletionRootTitle: 'Archived Ticket',
        deletedBy: 'Test User',
      }),
    )
    const result = await cli('node', ['trash'], { home })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Archived Ticket')
    expect(result.stdout).toContain('batch_trash')
    expect(result.stdout).toContain('Authors: Test User, Intern User')
  })

  it('prints has_children impact and exits one without force', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set('deleter00001', storedDocument('Delete Root.html'))
    documents.set(
      'deletea00001',
      storedDocument('Delete A.html', {
        parentId: 'deleter00001',
        authorAccountId: 'acct_other_a',
        authorName: 'Other A',
      }),
    )
    documents.set(
      'deleteb00001',
      storedDocument('Delete B.html', {
        parentId: 'deleter00001',
        authorAccountId: 'acct_other_b',
        authorName: 'Other B',
      }),
    )
    documents.set(
      'deletec00001',
      storedDocument('Delete C.html', { parentId: 'deletea00001' }),
    )
    const result = await cli('node', ['delete', 'deleter00001'], { home })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      'this also archives 3 documents by 2 other people',
    )
    expect(result.stderr).toContain('--force')
  })

  it('restores the batch discovered from document detail', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set(
      'restored0001',
      storedDocument('Restore Document.html', {
        deletionBatchId: 'batch_restore',
        deletionRootTitle: 'Restore Document',
        deletedBy: 'Test User',
      }),
    )
    const result = await cli('node', ['restore', 'restored0001', '--json'], {
      home,
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 'restored0001',
      deletionBatchId: null,
    })
  })

  it('uses the reader-safe message for missing fetches', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const result = await cli('node', ['fetch', 'none00000000'], { home })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      'not found or not readable with the current key',
    )
  })

  it('maps a 401 response to exit code 4', async () => {
    const result = await cli(
      'node',
      ['whoami', '--api-url', apiUrl, '--json'],
      {
        env: { DOSSIER_API_KEY: 'bad-key' },
      },
    )
    expect(result.exitCode).toBe(4)
    expect(result.stderr).toContain('dossier:')
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exitCode: 4 })
  })

  it('rejects typed API redirects without forwarding credentials', async () => {
    redirectWasFollowed = false
    const result = await cli('node', ['whoami', '--api-url', apiUrl], {
      env: { DOSSIER_API_KEY: 'ds_redirect' },
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('redirects are not allowed')
    expect(redirectWasFollowed).toBe(false)
  })

  it('rejects a foreign-origin document reference with exit code 2', async () => {
    const result = await cli('node', [
      'fetch',
      'https://foreign.example/d/doc000000001',
      '--api-url',
      apiUrl,
    ])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('does not match configured dossier origin')
  })

  it('explains how to recover from a stale automatic mapping', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const file = join(home, 'stale.html')
    await writeFile(file, '<!doctype html><title>Stale</title>', 'utf8')
    await writeFile(
      join(home, 'documents.json'),
      `${JSON.stringify({
        [apiUrl]: {
          acct_test: {
            [file]: {
              documentId: 'miss00000000',
              url: `${apiUrl}/d/miss00000000`,
              rawUrl: `${apiUrl}/d/miss00000000/raw`,
              updatedAt: '2026-09-12T00:00:00.000Z',
            },
          },
        },
      })}\n`,
      'utf8',
    )
    const result = await cli('node', ['upload', file], { home })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('mapping')
    expect(result.stderr).toContain('--new')
  })
})
