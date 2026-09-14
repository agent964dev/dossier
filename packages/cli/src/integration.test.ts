import { createServer, type IncomingMessage, type Server } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanStateFields, type FieldType } from '@dossier/policy'
import packageJson from '../package.json' with { type: 'json' }

const exec = promisify(execFile)
const currentVersion = packageJson.version
const nextVersion = `${Number(currentVersion.split('.')[0]) + 1}.0.0`
const packageDirectory = new URL('..', import.meta.url).pathname
const artifact = join(packageDirectory, 'dist/index.js')
const bomFixture = join(packageDirectory, 'test/fixtures/bom.html')
const cssFixture = join(packageDirectory, 'test/fixtures/shared-theme.css')
const woff2Fixture = join(packageDirectory, 'test/fixtures/test-font.woff2')
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
  stateful: boolean
  stateRevision: number | null
  stateUpdatedAt: string | null
  stateData: Record<string, unknown>
  stateFields: Record<
    string,
    { value: unknown; revision: number; type: FieldType }
  >
  shares: string[]
  deletionBatchId: string | null
  deletionRootTitle: string | null
  deletedBy: string | null
}

interface StoredAsset {
  ext: 'css' | 'woff2'
  bytes: Buffer
  version: number
  updatedAt: string
  deleted: boolean
}

const documents = new Map<string, StoredDocument>()
const assets = new Map<string, StoredAsset>()
const idempotencyKeys: string[] = []
const listQueries: Array<{ scope: string | null; parent: string | null }> = []
let nextId = 1
let retryFailureSeen = false
let redirectWasFollowed = false
let uploadRequests = 0
let healthRequests = 0
let assetRequests = 0
let lastDiffQuery = ''
const workspaceMembers = [
  {
    accountId: 'acct_test',
    name: 'Test User',
    email: 'test@example.com',
    role: 'admin' as const,
    kind: 'user',
    disabled: false,
  },
  {
    accountId: 'acct_member',
    name: 'Member User',
    email: 'member@example.com',
    role: 'member' as const,
    kind: 'user',
    disabled: false,
  },
]
const workspaceAllowlist: Array<{
  id: string
  kind: 'email' | 'domain'
  value: string
  role: 'admin' | 'member'
}> = [
  {
    id: 'allow_domain',
    kind: 'domain',
    value: 'example.com',
    role: 'member',
  },
]

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
    stateful: stored.stateful,
    stateRevision: stored.stateRevision,
    stateUpdatedAt: stored.stateUpdatedAt,
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
    stateful: document.stateful,
    stateRevision: document.stateRevision,
    stateUpdatedAt: document.stateUpdatedAt,
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
    html: Buffer.from(
      `<!doctype html><title>${basename(filename, '.html')}</title>`,
    ),
    version: 1,
    revision: 1,
    filename,
    kind: null,
    visibility: 'team',
    parentId: null,
    authorAccountId: 'acct_test',
    authorName: 'Test User',
    stateful: false,
    stateRevision: null,
    stateUpdatedAt: null,
    stateData: {},
    stateFields: {},
    shares: [],
    deletionBatchId: null,
    deletionRootTitle: null,
    deletedBy: null,
    ...overrides,
  }
}

function statefulHtml(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><label>Objective <input data-state="objective" value="Launch"></label><label><input type="checkbox" data-state="approved"> Approved</label><textarea data-state="notes"></textarea></body></html>`
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

function assetUrls(slug: string, ext: 'css' | 'woff2', version: number) {
  return {
    url: `${apiUrl}/a/${slug}.${ext}`,
    pinnedUrl: `${apiUrl}/a/${slug}@${version}.${ext}`,
  }
}

beforeAll(async () => {
  await exec('bun', ['run', 'build'], { cwd: packageDirectory })

  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/@agent964%2Fdossier/latest') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ version: nextVersion }))
      return
    }

    if (url.pathname === '/api/healthz') {
      healthRequests += 1
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          ok: true,
          service: 'dossier',
          version: '0.0.0',
          ...(request.headers.authorization === 'Bearer ds_legacy'
            ? {}
            : { features: ['state'] }),
        }),
      )
      return
    }

    if (url.pathname === '/redirect-target') {
      redirectWasFollowed = true
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true }))
      return
    }

    if (url.pathname === '/api/setup' && request.method === 'POST') {
      response.setHeader('content-type', 'application/json')
      if (request.headers.authorization !== 'Bearer ds_bootstrap') {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      response.end(
        JSON.stringify({
          ok: true,
          workspaceId: 'workspace_test',
          workspaceSlug: 'test',
          bootstrapAccountId: 'acct_bootstrap',
          bootstrapApiKeyId: 'key_bootstrap',
        }),
      )
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

    if (url.pathname === '/api/assets') {
      assetRequests += 1
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }

      if (request.method === 'POST') {
        const payload = await bodyJson(request)
        const slug = String(payload.slug ?? '')
        const ext = payload.ext
        if (slug === 'taken-theme') {
          response.statusCode = 409
          response.end(
            JSON.stringify({
              ok: false,
              code: 'slug_taken',
              message:
                'slug_taken: asset slug is reserved by another workspace',
            }),
          )
          return
        }
        if (ext !== 'css' && ext !== 'woff2') {
          response.statusCode = 422
          response.end(JSON.stringify({ ok: false, code: 'invalid_asset' }))
          return
        }
        const bytes = Buffer.from(String(payload.contentBase64 ?? ''), 'base64')
        if (
          ext === 'woff2' &&
          bytes.subarray(0, 4).toString('ascii') !== 'wOF2'
        ) {
          response.statusCode = 422
          response.end(
            JSON.stringify({
              ok: false,
              code: 'invalid_asset',
              message: 'WOFF2 magic bytes are missing',
            }),
          )
          return
        }
        const previous = assets.get(slug)
        if (previous && previous.ext !== ext) {
          response.statusCode = 409
          response.end(
            JSON.stringify({
              ok: false,
              code: 'slug_taken',
              message: 'slug_taken: asset extension cannot change',
            }),
          )
          return
        }
        const version = (previous?.version ?? 0) + 1
        const updatedAt = '2026-09-12T00:00:00.000Z'
        assets.set(slug, { ext, bytes, version, updatedAt, deleted: false })
        response.end(
          JSON.stringify({
            slug,
            ext,
            versionNumber: version,
            ...assetUrls(slug, ext, version),
          }),
        )
        return
      }

      if (request.method === 'GET') {
        response.end(
          JSON.stringify({
            ok: true,
            assets: [...assets]
              .filter(([, asset]) => !asset.deleted)
              .map(([slug, asset]) => ({
                slug,
                ext: asset.ext,
                latestVersionNumber: asset.version,
                ...assetUrls(slug, asset.ext, asset.version),
                updatedAt: asset.updatedAt,
              })),
          }),
        )
        return
      }
    }

    const assetDelete = /^\/api\/assets\/([a-z0-9][a-z0-9-]{0,63})$/.exec(
      url.pathname,
    )
    if (assetDelete && request.method === 'DELETE') {
      assetRequests += 1
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const stored = assets.get(assetDelete[1]!)
      if (!stored || stored.deleted) {
        response.statusCode = 404
        response.end(JSON.stringify({ ok: false, code: 'not_found' }))
        return
      }
      stored.deleted = true
      response.end(JSON.stringify({ ok: true }))
      return
    }

    if (url.pathname === '/api/uploads' && request.method === 'POST') {
      uploadRequests += 1
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const payload = await bodyJson(request)
      if (payload.filename === 'server-policy.html') {
        response.statusCode = 422
        response.end(
          JSON.stringify({
            ok: false,
            code: 'policy_rejected',
            message: 'HTML failed the saved-values field policy.',
            details: {
              errors: [
                'data-state "notes" is declared twice: line 3 col 3 and line 4 col 3',
              ],
            },
          }),
        )
        return
      }
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
      const stateful = payload.stateful === true || previous?.stateful === true
      const stateScan =
        payload.stateful === true
          ? scanStateFields(String(payload.html))
          : undefined
      const authoredFields = Object.fromEntries(
        (stateScan?.fields ?? []).map((field) => [
          field.name,
          { value: field.default, revision: 0, type: field.type },
        ]),
      )
      const authoredData = Object.fromEntries(
        (stateScan?.fields ?? []).map((field) => [field.name, field.default]),
      )
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
        stateful,
        stateRevision: stateful ? (previous?.stateRevision ?? 0) : null,
        stateUpdatedAt: stateful ? (previous?.stateUpdatedAt ?? null) : null,
        stateData:
          previous?.stateful === true ? previous.stateData : authoredData,
        stateFields:
          previous?.stateful === true ? previous.stateFields : authoredFields,
        shares:
          Array.isArray(payload.shares) &&
          payload.shares.every((email) => typeof email === 'string')
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

    const stateApi = /^\/api\/documents\/([a-z0-9]{12})\/state$/.exec(
      url.pathname,
    )
    if (stateApi && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const id = stateApi[1]!
      const stored = documents.get(id)
      if (!stored) {
        response.statusCode = 404
        response.end(JSON.stringify({ ok: false, code: 'not_found' }))
        return
      }
      if (!stored.stateful) {
        response.statusCode = 409
        response.end(
          JSON.stringify({
            ok: false,
            code: 'state_not_enabled',
            message: 'Saved values are not enabled for this document',
          }),
        )
        return
      }
      response.end(
        JSON.stringify({
          documentId: id,
          version: stored.version,
          revision: stored.stateRevision,
          updatedAt: stored.stateUpdatedAt,
          data: stored.stateData,
          fields: stored.stateFields,
        }),
      )
      return
    }

    const diffApi = /^\/api\/documents\/([a-z0-9]{12})\/diff$/.exec(
      url.pathname,
    )
    if (diffApi && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const id = diffApi[1]!
      if (id === 'largediff001') {
        response.statusCode = 413
        response.end(
          JSON.stringify({
            ok: false,
            code: 'diff_too_large',
            message: 'Diff exceeds the response limit.',
          }),
        )
        return
      }
      const stored = documents.get(id)
      if (!stored) {
        response.statusCode = 404
        response.end(JSON.stringify({ ok: false, code: 'not_found' }))
        return
      }
      lastDiffQuery = url.search
      const from = Number(
        url.searchParams.get('from') ?? Math.max(1, stored.version - 1),
      )
      const to = Number(url.searchParams.get('to') ?? stored.version)
      response.end(
        JSON.stringify({
          ok: true,
          documentId: id,
          from: {
            versionNumber: from,
            createdAt: '2026-09-12T00:00:00.000Z',
            fileSize: 24,
          },
          to: {
            versionNumber: to,
            createdAt: '2026-09-12T00:01:00.000Z',
            fileSize: 23,
          },
          mode: url.searchParams.get('mode') === 'text' ? 'text' : 'html',
          hunks:
            from === to
              ? []
              : [
                  {
                    oldStart: 1,
                    oldLines: 2,
                    newStart: 1,
                    newLines: 2,
                    lines: [
                      { op: ' ', text: '<main>' },
                      { op: '-', text: '<p>Before</p>' },
                      { op: '+', text: '<p>After</p>' },
                    ],
                  },
                ],
          stats:
            from === to ? { added: 0, removed: 0 } : { added: 1, removed: 1 },
        }),
      )
      return
    }

    if (url.pathname === '/api/workspace') {
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      if (request.method === 'GET') {
        response.end(
          JSON.stringify({
            ok: true,
            members: workspaceMembers,
            allowlist: workspaceAllowlist,
          }),
        )
        return
      }
    }

    if (
      url.pathname === '/api/workspace/allowlist' &&
      request.method === 'POST'
    ) {
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const payload = await bodyJson(request)
      workspaceAllowlist.push({
        id: `allow_${workspaceAllowlist.length + 1}`,
        kind: payload.kind === 'domain' ? 'domain' : 'email',
        value: String(payload.value),
        role: payload.role === 'admin' ? 'admin' : 'member',
      })
      response.end(
        JSON.stringify({
          ok: true,
          message: `${String(payload.value)} allowed.`,
        }),
      )
      return
    }

    const workspaceAllowlistDelete =
      /^\/api\/workspace\/allowlist\/([^/]+)$/.exec(url.pathname)
    if (workspaceAllowlistDelete && request.method === 'DELETE') {
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const index = workspaceAllowlist.findIndex(
        (entry) =>
          entry.id === decodeURIComponent(workspaceAllowlistDelete[1]!),
      )
      if (index < 0) {
        response.statusCode = 404
        response.end(JSON.stringify({ ok: false, code: 'not_found' }))
        return
      }
      workspaceAllowlist.splice(index, 1)
      response.end(JSON.stringify({ ok: true, message: 'Entry removed.' }))
      return
    }

    const workspaceMember = /^\/api\/workspace\/members\/([^/]+)$/.exec(
      url.pathname,
    )
    if (workspaceMember) {
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const accountId = decodeURIComponent(workspaceMember[1]!)
      const index = workspaceMembers.findIndex(
        (member) => member.accountId === accountId,
      )
      if (index < 0) {
        response.statusCode = 404
        response.end(JSON.stringify({ ok: false, code: 'not_found' }))
        return
      }
      if (request.method === 'POST') {
        const payload = await bodyJson(request)
        workspaceMembers[index]!.role =
          payload.role === 'admin' ? 'admin' : 'member'
        response.end(JSON.stringify({ ok: true, message: 'Role updated.' }))
        return
      }
      if (request.method === 'DELETE') {
        workspaceMembers.splice(index, 1)
        response.end(JSON.stringify({ ok: true, message: 'Member removed.' }))
        return
      }
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
                  candidate.parentId === id &&
                  candidate.deletionBatchId === null,
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
      stdout: `${JSON.stringify({
        ok: true,
        service: 'dossier',
        version: '0.0.0',
        features: ['state'],
      })}\n`,
      stderr: '',
      exitCode: 0,
    })
    const bun = await cli('bun', ['health', '--api-url', apiUrl, '--json'])
    expect(bun.exitCode).toBe(0)
    expect(JSON.parse(bun.stdout)).toEqual({
      ok: true,
      service: 'dossier',
      version: '0.0.0',
      features: ['state'],
    })
  })

  it('runs when invoked through an npm-style bin symlink', async () => {
    const home = await temporaryHome()
    const executable = join(home, 'dossier')
    await symlink(artifact, executable)
    const result = await exec(
      executable,
      ['health', '--api-url', apiUrl, '--json'],
      {
        env: { ...process.env, DOSSIER_HOME: home },
      },
    )
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      service: 'dossier',
      version: '0.0.0',
      features: ['state'],
    })
  })

  it('updates an npm-style install through the configured registry', async () => {
    const home = await temporaryHome()
    const npmRoot = join(home, 'npm-root')
    const packageRoot = join(npmRoot, '@agent964', 'dossier')
    const fakeArtifact = join(packageRoot, 'dist', 'index.js')
    const manifest = join(packageRoot, 'package.json')
    const binDirectory = join(home, 'bin')
    const npmStub = join(binDirectory, 'npm')
    const record = join(home, 'npm-argv.txt')
    const updateManifest = join(home, 'update-manifest.cjs')
    await mkdir(join(packageRoot, 'dist'), { recursive: true })
    await mkdir(binDirectory, { recursive: true })
    await copyFile(artifact, fakeArtifact)
    await writeFile(
      manifest,
      JSON.stringify({
        name: '@agent964/dossier',
        version: currentVersion,
        type: 'module',
      }),
      'utf8',
    )
    await writeFile(
      updateManifest,
      `const fs = require('fs')
const path = process.env.DOSSIER_TEST_PACKAGE_JSON
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'))
manifest.version = ${JSON.stringify(nextVersion)}
fs.writeFileSync(path, JSON.stringify(manifest))
`,
      'utf8',
    )
    await writeFile(
      npmStub,
      `#!/bin/sh
printf '%s\n' "$*" >> "$DOSSIER_UPDATE_RECORD"
if [ "$1" = "root" ] && [ "$2" = "-g" ]; then
  printf '%s\n' "$DOSSIER_TEST_NPM_ROOT"
  exit 0
fi
node "$DOSSIER_TEST_UPDATE_MANIFEST"
`,
      'utf8',
    )
    await chmod(npmStub, 0o755)

    const result = await exec('node', [fakeArtifact, 'update', '--json'], {
      env: {
        ...process.env,
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ''}`,
        DOSSIER_UPDATE_REGISTRY_URL: apiUrl,
        DOSSIER_UPDATE_RECORD: record,
        DOSSIER_TEST_NPM_ROOT: npmRoot,
        DOSSIER_TEST_PACKAGE_JSON: manifest,
        DOSSIER_TEST_UPDATE_MANIFEST: updateManifest,
      },
    })
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      currentVersion,
      latestVersion: nextVersion,
      installMethod: 'npm',
      updateAvailable: true,
      checked: false,
      updated: true,
    })
    expect((await readFile(record, 'utf8')).trim().split('\n')).toContain(
      `install -g @agent964/dossier@${nextVersion}`,
    )
  })

  it('calls the protected setup endpoint with a piped bootstrap key', async () => {
    const result = await cli('node', ['setup', '--api-url', apiUrl, '--json'], {
      input: 'ds_bootstrap\n',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      workspaceId: 'workspace_test',
      workspaceSlug: 'test',
      bootstrapAccountId: 'acct_bootstrap',
      bootstrapApiKeyId: 'key_bootstrap',
    })
  })

  it('keeps health hidden from root help', async () => {
    const help = await cli('node', ['--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).not.toMatch(/- health/)
  })

  it('describes diff arguments and options in built-in help', async () => {
    const help = await cli('node', ['diff', '--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('Document ID, id@n, or dossier URL')
    expect(help.stdout).toContain('Older version number')
    expect(help.stdout).toContain('Newer version number')
    expect(help.stdout).toContain('Compare visible text instead of HTML source')
  })

  it('runs static upload validation before requiring credentials', async () => {
    const home = await temporaryHome()
    const file = join(home, 'invalid.html')
    await writeFile(file, '<!doctype html><form></form>', 'utf8')
    const result = await cli('node', ['upload', file, '--api-url', apiUrl], {
      home,
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`dossier: policy rejected ${file}\n`)
    expect(result.stderr).toContain('  - Blocked <form> tag found.')
    expect(result.stderr).not.toContain('not authenticated')
  })

  it('rejects invalid saved-value fields before upload', async () => {
    const home = await temporaryHome()
    const file = join(home, 'duplicate-state.html')
    await writeFile(
      file,
      `<!doctype html>
<html><head><title>Duplicate state</title></head><body>
  <input data-state="notes">
  <textarea data-state="notes"></textarea>
</body></html>`,
      'utf8',
    )
    const before = uploadRequests
    const result = await cli(
      'node',
      ['upload', file, '--stateful', '--new', '--api-url', apiUrl],
      { home },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`dossier: policy rejected ${file}
`)
    expect(result.stderr).toContain(
      'data-state "notes" is declared twice: line 3 col 3 and line 4 col 3',
    )
    expect(uploadRequests).toBe(before)
  })

  it('renders server-side policy error details', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const file = join(home, 'server-policy.html')
    await writeFile(
      file,
      '<!doctype html><html><head><title>Server policy</title></head><body></body></html>',
      'utf8',
    )
    const result = await cli(
      'node',
      ['upload', file, '--new', '--api-url', apiUrl],
      { home },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      'HTML failed the saved-values field policy.\n',
    )
    expect(result.stderr).toContain(
      '  - data-state "notes" is declared twice: line 3 col 3 and line 4 col 3',
    )
  })

  it('defers foreign stylesheet allowlists to the server', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const file = join(home, 'foreign-stylesheet.html')
    await writeFile(
      file,
      '<!doctype html><title>Foreign</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
      'utf8',
    )
    const before = uploadRequests
    const result = await cli(
      'node',
      ['upload', file, '--api-url', apiUrl, '--json'],
      { home },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(uploadRequests).toBe(before + 1)
  })

  it('rejects unsafe CSS before credentials or an asset request', async () => {
    const home = await temporaryHome()
    const file = join(home, 'unsafe.css')
    await writeFile(file, '.card { behavior: url("/a/unsafe.htc"); }', 'utf8')
    const before = assetRequests
    const result = await cli(
      'node',
      ['assets', 'push', file, '--api-url', apiUrl],
      { home },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Blocked unsafe CSS behavior property.')
    expect(result.stderr).not.toContain('not authenticated')
    expect(assetRequests).toBe(before)
  })

  it('explains invalid slugs derived from filenames', async () => {
    const home = await temporaryHome()
    const file = join(home, 'Shared_Theme.css')
    await writeFile(file, ':root { color: black }', 'utf8')
    const result = await cli(
      'node',
      ['assets', 'push', file, '--api-url', apiUrl],
      { home },
    )
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(
      'slug "Shared_Theme" derived from the filename is not valid',
    )
    expect(result.stderr).toContain('pass --slug shared-theme')
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

  it('honors API URL precedence flag over env over config', async () => {
    const home = await temporaryHome()
    await writeFile(
      join(home, 'config.json'),
      `${JSON.stringify({ apiUrl })}\n`,
      'utf8',
    )
    const configWins = await cli('node', ['health', '--json'], { home })
    expect(configWins.exitCode).toBe(0)

    await writeFile(join(home, 'config.json'), '{broken', 'utf8')
    const envWins = await cli('node', ['health', '--json'], {
      home,
      env: { DOSSIER_API_URL: apiUrl },
    })
    expect(envWins.exitCode).toBe(0)

    const flagWins = await cli(
      'node',
      ['--api-url', apiUrl, 'health', '--json'],
      {
        home,
        env: { DOSSIER_API_URL: 'https://env.invalid' },
      },
    )
    expect(flagWins.exitCode).toBe(0)
  })

  it('uses an environment key without reading lower-precedence credentials', async () => {
    const home = await temporaryHome()
    await writeFile(join(home, 'credentials.json'), '{broken', 'utf8')
    const result = await cli(
      'node',
      ['whoami', '--api-url', apiUrl, '--json'],
      { home, env: { DOSSIER_API_KEY: 'ds_integration' } },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({ accountId: 'acct_test' })
  })

  it('accepts global flags around nested subcommands', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const before = await cli('node', ['--json', 'workspace', 'members'], {
      home,
    })
    const after = await cli('node', ['workspace', 'members', '--json'], {
      home,
    })
    expect(before.exitCode).toBe(0)
    expect(after.exitCode).toBe(0)
    expect(JSON.parse(before.stdout)).toEqual(JSON.parse(after.stdout))
  })

  it('pushes CSS using the basename slug and prints its URLs', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const result = await cli('node', ['assets', 'push', cssFixture], { home })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.startsWith('Created\n')).toBe(true)
    expect(result.stdout).toContain('Slug: shared-theme')
    expect(result.stdout).toContain('Version: 1')
    expect(result.stdout).toContain(`${apiUrl}/a/shared-theme.css`)
    expect(result.stdout).toContain(`${apiUrl}/a/shared-theme@1.css`)
    expect(assets.get('shared-theme')?.bytes).toEqual(
      await readFile(cssFixture),
    )
  })

  it('pushes WOFF2 bytes with an explicit slug', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const result = await cli(
      'bun',
      ['assets', 'push', woff2Fixture, '--slug', 'dossier-font', '--json'],
      { home },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      slug: 'dossier-font',
      ext: 'woff2',
      versionNumber: 1,
      url: `${apiUrl}/a/dossier-font.woff2`,
      pinnedUrl: `${apiUrl}/a/dossier-font@1.woff2`,
    })
    const bytes = assets.get('dossier-font')?.bytes
    expect(bytes?.subarray(0, 4).toString('ascii')).toBe('wOF2')
    expect(bytes).toEqual(await readFile(woff2Fixture))
  })

  it('prints the server slug_taken conflict message', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const result = await cli(
      'node',
      ['assets', 'push', cssFixture, '--slug', 'taken-theme'],
      { home },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('409 Conflict')
    expect(result.stderr).toContain('slug_taken')
    expect(result.stderr).toContain('another workspace')
  })

  it('lists uploaded shared assets', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const result = await cli('node', ['assets', 'list', '--json'], { home })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'shared-theme',
          ext: 'css',
          latestVersionNumber: 1,
          url: `${apiUrl}/a/shared-theme.css`,
          pinnedUrl: `${apiUrl}/a/shared-theme@1.css`,
        }),
        expect.objectContaining({
          slug: 'dossier-font',
          ext: 'woff2',
          latestVersionNumber: 1,
        }),
      ]),
    )
  })

  it('prints compact human asset listings', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const result = await cli('node', ['assets', 'list'], { home })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'shared-theme.css\n  v1 · updated 2026-09-12',
    )
    expect(result.stdout).toContain(`  pinned ${apiUrl}/a/shared-theme@1.css`)
  })

  it('deletes a shared asset from listings', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const deleted = await cli(
      'node',
      ['assets', 'delete', 'shared-theme', '--json'],
      { home },
    )
    expect(deleted.exitCode).toBe(0)
    expect(deleted.stderr).toBe('')
    expect(JSON.parse(deleted.stdout)).toEqual({ ok: true })

    const listed = await cli('node', ['assets', 'list', '--json'], { home })
    expect(
      JSON.parse(listed.stdout).some(
        (asset: { slug: string }) => asset.slug === 'shared-theme',
      ),
    ).toBe(false)
  })

  it('uploads stateful documents in human, JSON, and quiet modes', async () => {
    const home = await temporaryHome()
    await authenticate(home)

    const humanFile = join(home, 'stateful-human.html')
    await writeFile(humanFile, statefulHtml('Stateful human'), 'utf8')
    const beforeHealth = healthRequests
    const human = await cli(
      'node',
      ['upload', humanFile, '--stateful', '--new', '--api-url', apiUrl],
      { home },
    )
    expect(human.exitCode).toBe(0)
    expect(human.stderr).toBe('')
    expect(human.stdout).toContain(
      'State: enabled, one shared set of saved values\n',
    )
    expect(human.stdout).toContain('Last saved: never\n')
    expect(healthRequests).toBe(beforeHealth + 1)

    await writeFile(humanFile, statefulHtml('Stateful update'), 'utf8')
    const continued = await cli(
      'node',
      ['upload', humanFile, '--api-url', apiUrl],
      { home },
    )
    expect(continued.exitCode).toBe(0)
    expect(continued.stderr).toBe('')
    expect(continued.stdout).toContain('Updated\n')
    expect(continued.stdout).toContain(
      'State: enabled, one shared set of saved values\n',
    )
    expect(continued.stdout).toContain('Last saved: never\n')

    const jsonFile = join(home, 'stateful-json.html')
    await writeFile(jsonFile, statefulHtml('Stateful JSON'), 'utf8')
    const json = await cli(
      'node',
      ['upload', jsonFile, '--stateful', '--new', '--json'],
      { home },
    )
    expect(json.exitCode).toBe(0)
    expect(json.stderr).toBe('')
    expect(JSON.parse(json.stdout)).toMatchObject({
      created: true,
      stateful: true,
      stateRevision: 0,
      stateUpdatedAt: null,
    })

    const quietFile = join(home, 'stateful-quiet.html')
    await writeFile(quietFile, statefulHtml('Stateful quiet'), 'utf8')
    const quiet = await cli(
      'node',
      ['upload', quietFile, '--stateful', '--new', '--quiet'],
      { home },
    )
    expect(quiet).toEqual({
      stdout: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:\d+\/d\/[a-z0-9]{12}\n$/,
      ),
      stderr: '',
      exitCode: 0,
    })
  })

  it('reads saved values in human, JSON, and quiet modes', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set(
      'stateget0001',
      storedDocument('State values.html', {
        version: 3,
        stateful: true,
        stateRevision: 7,
        stateUpdatedAt: '2026-09-14T07:42:00Z',
        stateData: {
          objective: 'Launch the new website',
          approved: false,
          notes: '',
        },
        stateFields: {
          objective: {
            value: 'Launch the new website',
            revision: 3,
            type: 'text',
          },
          approved: { value: false, revision: 0, type: 'checkbox' },
          notes: { value: '', revision: 7, type: 'textarea' },
        },
      }),
    )

    const human = await cli('node', ['state', 'get', 'stateget0001'], {
      home,
    })
    expect(human.exitCode).toBe(0)
    expect(human.stderr).toBe('')
    expect(human.stdout).toContain('Values:\n{\n')
    expect(human.stdout).toContain('  "approved": false')
    expect(human.stdout).toContain('  "notes": ""')
    expect(human.stdout).toContain('Revision: 7\n')
    expect(human.stdout).toContain('Last saved: 2026-09-14T07:42:00Z\n')

    const json = await cli(
      'node',
      ['state', 'get', `${apiUrl}/d/stateget0001/v/3`, '--json'],
      { home },
    )
    expect(json.exitCode).toBe(0)
    expect(json.stderr).toBe('')
    expect(JSON.parse(json.stdout)).toEqual({
      documentId: 'stateget0001',
      version: 3,
      revision: 7,
      updatedAt: '2026-09-14T07:42:00Z',
      data: {
        objective: 'Launch the new website',
        approved: false,
        notes: '',
      },
      fields: {
        objective: {
          value: 'Launch the new website',
          revision: 3,
          type: 'text',
        },
        approved: { value: false, revision: 0, type: 'checkbox' },
        notes: { value: '', revision: 7, type: 'textarea' },
      },
    })

    const quiet = await cli(
      'node',
      ['state', 'get', 'stateget0001', '--quiet'],
      { home },
    )
    expect(quiet).toEqual({ stdout: '', stderr: '', exitCode: 0 })
  })

  it('preserves __proto__ through the derived state client', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set(
      'stateproto01',
      storedDocument('Special state.html', {
        stateful: true,
        stateRevision: 0,
        stateData: JSON.parse('{"__proto__":"keep me"}'),
        stateFields: JSON.parse(
          '{"__proto__":{"value":"keep me","revision":0,"type":"text"}}',
        ),
      }),
    )

    const result = await cli(
      'node',
      ['state', 'get', 'stateproto01', '--json'],
      { home },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const response = JSON.parse(result.stdout) as {
      data: Record<string, unknown>
      fields: Record<string, unknown>
    }
    expect(Object.hasOwn(response.data, '__proto__')).toBe(true)
    expect(response.data.__proto__).toBe('keep me')
    expect(Object.hasOwn(response.fields, '__proto__')).toBe(true)
  })

  it('explains ordinary documents and legacy deployments for saved values', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set('stateoff0001', storedDocument('Ordinary.html'))

    const ordinary = await cli('node', ['state', 'get', 'stateoff0001'], {
      home,
    })
    expect(ordinary.exitCode).toBe(1)
    expect(ordinary.stderr).toContain(
      'Saved values are not enabled for this document',
    )

    const file = join(home, 'legacy-stateful.html')
    await writeFile(file, statefulHtml('Legacy deployment'), 'utf8')
    const beforeUploads = uploadRequests
    const legacyUpload = await cli(
      'node',
      ['upload', file, '--stateful', '--new', '--api-url', apiUrl],
      { home, env: { DOSSIER_API_KEY: 'ds_legacy' } },
    )
    expect(legacyUpload.exitCode).toBe(1)
    expect(legacyUpload.stderr).toContain(
      'This Dossier deployment does not support saved values. Update the deployment.',
    )
    expect(uploadRequests).toBe(beforeUploads)

    const legacyGet = await cli(
      'node',
      ['state', 'get', 'stateget0001', '--api-url', apiUrl],
      { home, env: { DOSSIER_API_KEY: 'ds_legacy' } },
    )
    expect(legacyGet.exitCode).toBe(1)
    expect(legacyGet.stderr).toContain(
      'This Dossier deployment does not support saved values. Update the deployment.',
    )
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

  it('prints a standard unified diff and exits zero when versions differ', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set(
      'diffdoc00001',
      storedDocument('Diff Document.html', { version: 2 }),
    )
    const result = await cli(
      'node',
      ['diff', 'diffdoc00001', '--from', '1', '--to', '2'],
      { home },
    )
    expect(result).toEqual({
      stdout:
        '--- a/diffdoc00001@1\n' +
        '+++ b/diffdoc00001@2\n' +
        '@@ -1,2 +1,2 @@\n' +
        ' <main>\n' +
        '-<p>Before</p>\n' +
        '+<p>After</p>\n',
      stderr: '',
      exitCode: 0,
    })
    expect(result.stdout).not.toContain(`${String.fromCharCode(27)}[`)
  })

  it('explains an identical comparison while keeping patch headers', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set(
      'diffsame0001',
      storedDocument('Identical Diff.html', { version: 2 }),
    )
    const result = await cli(
      'node',
      ['diff', 'diffsame0001', '--from', '2', '--to', '2'],
      { home },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('--- a/diffsame0001@2\n+++ b/diffsame0001@2\n')
    expect(result.stderr).toBe('dossier: v2 and v2 are identical\n')
  })

  it('supports pinned diff URLs, text mode, and raw JSON output', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set(
      'diffjson0001',
      storedDocument('Diff JSON.html', { version: 3 }),
    )
    const result = await cli(
      'node',
      [
        '--json',
        'diff',
        `${apiUrl}/d/diffjson0001/v/3`,
        '--from',
        '1',
        '--text',
      ],
      { home },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      documentId: 'diffjson0001',
      from: { versionNumber: 1 },
      to: { versionNumber: 3 },
      mode: 'text',
      stats: { added: 1, removed: 1 },
    })
    expect(lastDiffQuery).toContain('from=1')
    expect(lastDiffQuery).toContain('to=3')
    expect(lastDiffQuery).toContain('mode=text')
  })

  it('prints fetch guidance for an oversized diff', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const result = await cli('node', ['diff', 'largediff001'], { home })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('dossier: diff is too large')
    expect(result.stderr).toContain('dossier fetch largediff001@<version>')
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
    await writeFile(
      firstParentFile,
      '<!doctype html><title>First</title>',
      'utf8',
    )
    await writeFile(
      secondParentFile,
      '<!doctype html><title>Second</title>',
      'utf8',
    )
    await writeFile(childFile, '<!doctype html><title>Child</title>', 'utf8')
    const firstParent = JSON.parse(
      (
        await cli('node', ['upload', firstParentFile, '--new', '--json'], {
          home,
        })
      ).stdout,
    )
    const secondParent = JSON.parse(
      (
        await cli('node', ['upload', secondParentFile, '--new', '--json'], {
          home,
        })
      ).stdout,
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
      [
        'move',
        'movedoc00001@1',
        '--parent',
        `${apiUrl}/d/movepar00001/v/1`,
        '--json',
      ],
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

  it('lists members and manages the workspace allowlist', async () => {
    const home = await temporaryHome()
    await authenticate(home)

    const listed = await cli('node', ['workspace', '--json'], { home })
    expect(listed.exitCode).toBe(0)
    expect(JSON.parse(listed.stdout)).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({ email: 'test@example.com' }),
      ]),
      allowlist: expect.arrayContaining([
        expect.objectContaining({ value: 'example.com' }),
      ]),
    })

    const allowed = await cli(
      'node',
      ['workspace', 'allow', '@outside.example', '--role', 'admin', '--json'],
      { home },
    )
    expect(allowed.exitCode).toBe(0)
    expect(workspaceAllowlist).toContainEqual(
      expect.objectContaining({
        kind: 'domain',
        value: 'outside.example',
        role: 'admin',
      }),
    )

    const disallowed = await cli(
      'node',
      ['workspace', 'disallow', '@outside.example', '--json'],
      { home },
    )
    expect(disallowed.exitCode).toBe(0)
    expect(
      workspaceAllowlist.some((entry) => entry.value === 'outside.example'),
    ).toBe(false)
  })

  it('promotes and removes workspace members by email', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const promoted = await cli(
      'node',
      ['workspace', 'promote', 'member@example.com', '--json'],
      { home },
    )
    expect(promoted.exitCode).toBe(0)
    expect(
      workspaceMembers.find((member) => member.email === 'member@example.com')
        ?.role,
    ).toBe('admin')

    const removed = await cli(
      'node',
      ['workspace', 'remove', 'member@example.com', '--json'],
      { home },
    )
    expect(removed.exitCode).toBe(0)
    expect(
      workspaceMembers.some((member) => member.email === 'member@example.com'),
    ).toBe(false)
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

  it('uses exit code 2 and the dossier prefix for command usage errors', async () => {
    const result = await cli('node', ['diff', 'not-an-id'])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^dossier: /)
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
