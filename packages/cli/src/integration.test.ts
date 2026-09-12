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
const documents = new Map<
  string,
  {
    html: Buffer
    version: number
    filename: string
    kind: string | null
    visibility: string
  }
>()
const idempotencyKeys: string[] = []
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

function documentDto(
  id: string,
  stored: {
    version: number
    filename: string
    kind: string | null
    visibility: string
  },
) {
  const now = '2026-09-12T00:00:00.000Z'
  const title = basename(stored.filename, '.html')
  return {
    id,
    title,
    description: null,
    kind: stored.kind,
    parentId: null,
    effectiveVisibility: stored.visibility,
    workspaceSlug: 'test',
    authorAccountId: 'acct_test',
    authorName: 'Test User',
    latestVersionNumber: stored.version,
    disabled: false,
    url: `${apiUrl}/d/${id}`,
    rawUrl: `${apiUrl}/d/${id}/raw`,
    hubUrl: `${apiUrl}/d/${id}/tree`,
    createdAt: now,
    updatedAt: now,
    visibility: stored.visibility,
    accessSource: 'own',
    versionCount: stored.version,
    revision: stored.version,
    deletionBatchId: null,
    deletedAt: null,
    deletedBy: null,
    disabledAt: null,
  }
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
      const stored = {
        html: Buffer.from(String(payload.html), 'utf8'),
        version: (previous?.version ?? 0) + 1,
        filename:
          typeof payload.filename === 'string'
            ? payload.filename
            : 'document.html',
        kind:
          typeof payload.kind === 'string'
            ? payload.kind
            : (previous?.kind ?? null),
        visibility:
          typeof payload.visibility === 'string'
            ? payload.visibility
            : (previous?.visibility ?? 'team'),
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
      /^\/api\/documents\/([a-z0-9]{12})(?:\/(restore|disable|enable))?$/.exec(
        url.pathname,
      )
    if (documentApi) {
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const stored = documents.get(documentApi[1]!)
      if (!stored) {
        response.statusCode = 404
        response.end(JSON.stringify({ ok: false, code: 'not_found' }))
        return
      }
      if (request.method === 'GET' && !documentApi[2]) {
        response.end(
          JSON.stringify({
            ok: true,
            document: documentDto(documentApi[1]!, stored),
            versions: [],
          }),
        )
        return
      }
      if (request.method === 'DELETE' && !documentApi[2]) {
        response.end(
          JSON.stringify({
            ok: true,
            batchId: 'batch_test',
            deleted: 1,
            authors: ['acct_test'],
          }),
        )
        return
      }
      if (request.method === 'POST' && documentApi[2]) {
        if (documentApi[2] !== 'enable') await bodyJson(request)
        response.end(
          JSON.stringify({
            ok: true,
            document: documentDto(documentApi[1]!, stored),
          }),
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
      const all = [...documents].map(([id, stored]) => documentDto(id, stored))
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
