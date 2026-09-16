import { createHash } from 'node:crypto'
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
import { promisify, stripVTControlCharacters } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ShareDelta, StateChange, StateGrant } from '@dossier/contracts'
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
  grants: StateGrant[]
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

interface StoredEditLink {
  generation: number
  active: boolean
}

const documents = new Map<string, StoredDocument>()
const assets = new Map<string, StoredAsset>()
const editLinks = new Map<string, StoredEditLink>()
const idempotencyKeys: string[] = []
const stateSchemaRequestHashes: string[] = []
const listQueries: Array<{ scope: string | null; parent: string | null }> = []
const shareDeltas: ShareDelta[] = []
let shareRequests = 0
let nextId = 1
let retryFailureSeen = false
let redirectWasFollowed = false
let uploadRequests = 0
let healthRequests = 0
let assetRequests = 0
let lastDiffQuery = ''
const legacyRequests: string[] = []
const unavailableRequests: string[] = []
const stateGetRequests: string[] = []
const stateSetRequests: Array<{
  readonly id: string
  readonly changes: readonly StateChange[]
}> = []
const stateVersionChanges = new Map<
  string,
  | { readonly kind: 'version-only' }
  | {
      readonly kind: 'move-field'
      readonly name: string
      readonly value: unknown
    }
>()
const forcedStateErrors = new Map<
  string,
  { readonly status: number; readonly value: Record<string, unknown> }
>()
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
    grants: [],
    deletionBatchId: null,
    deletionRootTitle: null,
    deletedBy: null,
    ...overrides,
  }
}

function statefulHtml(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><label>Objective <input data-state="objective" value="Launch"></label><label><input type="checkbox" data-state="approved"> Approved</label><textarea data-state="notes"></textarea></body></html>`
}

function stateSchemaRequestHash(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        html: payload.html,
        documentId: payload.documentId ?? null,
        acceptStateChanges: payload.acceptStateChanges === true,
      }),
    )
    .digest('hex')
}

function stateResponse(id: string, stored: StoredDocument) {
  return {
    documentId: id,
    version: stored.version,
    revision: stored.stateRevision,
    updatedAt: stored.stateUpdatedAt,
    data: stored.stateData,
    fields: stored.stateFields,
  }
}

function editLinkResponse(id: string) {
  const link = editLinks.get(id)
  const active = link?.active === true
  return {
    documentId: id,
    active,
    editUrl: active
      ? `${apiUrl}/d/${id}/edit#edit-link-${link!.generation}`
      : null,
  }
}

function setStateValue(
  target: Record<string, unknown>,
  name: string,
  value: unknown,
): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
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
  return (
    request.headers.authorization === 'Bearer ds_integration' ||
    request.headers.authorization === 'Bearer ds_legacy' ||
    request.headers.authorization === 'Bearer ds_unavailable'
  )
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
    if (request.headers.authorization === 'Bearer ds_legacy') {
      legacyRequests.push(`${request.method} ${url.pathname}`)
    }
    if (request.headers.authorization === 'Bearer ds_unavailable') {
      unavailableRequests.push(`${request.method} ${url.pathname}`)
    }
    // A deployment that predates saved values omits the three state fields
    // from every document it returns. The legacy key sees that shape.
    const documentJson = (payload: unknown) =>
      JSON.stringify(payload, (key, item: unknown) =>
        request.headers.authorization === 'Bearer ds_legacy' &&
        ['stateful', 'stateRevision', 'stateUpdatedAt'].includes(key)
          ? undefined
          : item,
      )
    if (url.pathname === '/@agent964%2Fdossier/latest') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ version: nextVersion }))
      return
    }

    if (url.pathname === '/api/healthz') {
      healthRequests += 1
      response.setHeader('content-type', 'application/json')
      // ds_legacy is a deployment that predates saved values and reports no
      // feature list. ds_unavailable is a current deployment whose state
      // limiter is missing, so it reports an empty list.
      response.end(
        JSON.stringify({
          ok: true,
          service: 'dossier',
          version: '0.0.0',
          ...(request.headers.authorization === 'Bearer ds_legacy'
            ? {}
            : request.headers.authorization === 'Bearer ds_unavailable'
              ? { features: [] }
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
      if (payload.filename === 'schema-change.html') {
        stateSchemaRequestHashes.push(stateSchemaRequestHash(payload))
        if (payload.acceptStateChanges !== true) {
          response.statusCode = 409
          response.end(
            JSON.stringify({
              ok: false,
              code: 'state_schema_change',
              message: 'Saved-value fields changed.',
              details: {
                retyped: [{ name: 'notes', from: 'textarea', to: 'text' }],
                orphaned: ['legacyNotes'],
              },
            }),
          )
          return
        }
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
        grants: previous?.grants ?? [],
        deletionBatchId: previous?.deletionBatchId ?? null,
        deletionRootTitle: previous?.deletionRootTitle ?? null,
        deletedBy: previous?.deletedBy ?? null,
      }
      documents.set(id, stored)
      const document = documentDto(id, stored)
      response.statusCode = previous ? 200 : 201
      response.end(
        documentJson({
          ok: true,
          document,
          versionNumber: stored.version,
          versionUrl: `${apiUrl}/d/${id}/v/${stored.version}`,
          warnings: [],
          ...(payload.filename === 'schema-change.html' &&
          payload.acceptStateChanges === true
            ? { resetStateFields: ['notes'] }
            : {}),
          draftId: id,
          publicUrl: document.url,
          rawUrl: document.rawUrl,
        }),
      )
      return
    }

    const stateLinkApi = /^\/api\/documents\/([a-z0-9]{12})\/state\/link$/.exec(
      url.pathname,
    )
    if (stateLinkApi) {
      response.setHeader('content-type', 'application/json')
      if (!authenticated(request)) {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      const id = stateLinkApi[1]!
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

      if (request.method === 'POST') {
        const current = editLinks.get(id)
        if (current?.active !== true) {
          editLinks.set(id, {
            generation: (current?.generation ?? 0) + 1,
            active: true,
          })
        }
        response.end(JSON.stringify(editLinkResponse(id)))
        return
      }
      if (request.method === 'GET') {
        response.end(JSON.stringify(editLinkResponse(id)))
        return
      }
      if (request.method === 'DELETE') {
        const current = editLinks.get(id)
        const revoked = current?.active === true
        if (current) current.active = false
        response.end(JSON.stringify({ documentId: id, revoked }))
        return
      }
    }

    const stateApi = /^\/api\/documents\/([a-z0-9]{12})\/state$/.exec(
      url.pathname,
    )
    if (stateApi) {
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

      if (request.method === 'GET') {
        stateGetRequests.push(id)
        response.end(JSON.stringify(stateResponse(id, stored)))
        return
      }

      if (request.method === 'PUT') {
        const payload = await bodyJson(request)
        const changes = Array.isArray(payload.changes)
          ? (payload.changes as StateChange[])
          : []
        stateSetRequests.push({ id, changes })

        const forcedError = forcedStateErrors.get(id)
        if (forcedError) {
          response.statusCode = forcedError.status
          response.end(JSON.stringify(forcedError.value))
          return
        }

        const versionChange = stateVersionChanges.get(id)
        if (versionChange) {
          stateVersionChanges.delete(id)
          stored.version += 1
          if (versionChange.kind === 'move-field') {
            const revision = (stored.stateRevision ?? 0) + 1
            const current = stored.stateFields[versionChange.name]
            stored.stateRevision = revision
            stored.stateUpdatedAt = '2026-09-14T09:00:00Z'
            setStateValue(
              stored.stateData,
              versionChange.name,
              versionChange.value,
            )
            stored.stateFields[versionChange.name] = {
              value: versionChange.value,
              revision,
              type: current?.type ?? 'json',
            }
          }
          response.statusCode = 409
          response.end(
            JSON.stringify({
              ok: false,
              code: 'state_version_changed',
              message: 'The current document version changed.',
              details: { currentVersion: stored.version },
            }),
          )
          return
        }

        const conflicts = changes.flatMap((change) => {
          const field = stored.stateFields[change.name]
          if ((field?.revision ?? 0) <= change.base) return []
          return [
            {
              name: change.name,
              revision: field!.revision,
              value: field!.value,
            },
          ]
        })
        if (conflicts.length > 0) {
          response.statusCode = 409
          response.end(
            JSON.stringify({
              ok: false,
              code: 'state_conflict',
              message: 'Saved values changed after the supplied baseline.',
              details: { fields: conflicts },
            }),
          )
          return
        }

        const revision = (stored.stateRevision ?? 0) + 1
        stored.stateRevision = revision
        stored.stateUpdatedAt = '2026-09-14T09:01:00Z'
        for (const change of changes) {
          const current = stored.stateFields[change.name]
          setStateValue(stored.stateData, change.name, change.value)
          stored.stateFields[change.name] = {
            value: change.value,
            revision,
            type: current?.type ?? 'json',
          }
        }
        response.end(JSON.stringify(stateResponse(id, stored)))
        return
      }
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
      const legacyShares =
        documentApi[2] === 'shares' &&
        request.headers.authorization === 'Bearer ds_legacy'
      if (documentApi[2] === 'shares') shareRequests += 1
      if (!authenticated(request) && !legacyShares) {
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
          documentJson({
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
          documentJson({
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
          documentJson({ ok: true, document: documentDto(id, stored) }),
        )
        return
      }
      if (action === 'shares' && request.method === 'GET') {
        response.end(
          JSON.stringify({
            configured: stored.shares,
            effective: stored.shares,
            accessSource: 'own',
            ...(legacyShares ? {} : { grants: stored.grants }),
          }),
        )
        return
      }
      if (action === 'shares' && request.method === 'POST') {
        const payload = await bodyJson(request)
        shareDeltas.push(payload as ShareDelta)
        if (
          legacyShares &&
          ['removeGrants', 'addSavers', 'removeSavers'].some(
            (key) => key in payload,
          )
        ) {
          response.statusCode = 400
          response.end(
            JSON.stringify({
              ok: false,
              code: 'bad_request',
              message: 'The request body does not match the API schema.',
            }),
          )
          return
        }
        const shares = new Set(stored.shares)
        const grants = new Map(
          stored.grants.map((grant) => [grant.email, grant.canSave]),
        )
        if (Array.isArray(payload.add)) {
          for (const email of payload.add) shares.add(String(email))
        }
        if (Array.isArray(payload.remove)) {
          for (const email of payload.remove) shares.delete(String(email))
        }
        if (Array.isArray(payload.addSavers)) {
          for (const email of payload.addSavers) grants.set(String(email), true)
        }
        if (Array.isArray(payload.removeSavers)) {
          for (const email of payload.removeSavers) {
            const normalized = String(email)
            if (grants.has(normalized)) grants.set(normalized, false)
          }
        }
        if (Array.isArray(payload.removeGrants)) {
          for (const email of payload.removeGrants) grants.delete(String(email))
        }
        stored.shares = [...shares]
        stored.grants = [...grants].map(([email, canSave]) => ({
          email,
          canSave,
        }))
        stored.revision += 1
        response.end(
          JSON.stringify({
            configured: stored.shares,
            effective: stored.shares,
            accessSource: 'own',
            ...(legacyShares ? {} : { grants: stored.grants }),
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
          documentJson({ ok: true, document: documentDto(id, stored) }),
        )
        return
      }
      if (request.method === 'POST' && action === 'disable') {
        await bodyJson(request)
        response.end(
          documentJson({ ok: true, document: documentDto(id, stored) }),
        )
        return
      }
      if (request.method === 'POST' && action === 'enable') {
        response.end(
          documentJson({ ok: true, document: documentDto(id, stored) }),
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
        documentJson({
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

// Phase 8 acceptance comes from PRD 5.1, 5.10, A17 and TDD 03, not the
// existing prose. Keep this fixture verbatim when rewriting the skill.
const savedValuesPromise =
  'Publish an HTML plan with shared saved values. ' +
  'Collaborators edit, save, and return to the same document.'
const launchPlanExample = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Launch plan</title>
</head>
<body>
  <h1>Launch plan</h1>
  <label>Objective <input data-state="objective" value="Launch the new website"></label>
  <label><input type="checkbox" data-state="approved"> Design approved</label>
  <label>Notes <textarea data-state="notes"></textarea></label>
</body>
</html>`
const deploymentCompatibilityMessage =
  'This Dossier deployment does not support saved values. ' +
  'Update the deployment.'

// These are executable example lines, not a second command parser. The skill
// acceptance below requires the same spellings, and the journey substitutes
// only the example filenames, document ID, and revision returned by the CLI.
const savedValuesJourney = {
  publish: 'dossier upload plan.html --kind plan --stateful',
  publishJson: 'dossier upload plan.html --kind plan --stateful --json',
  grant: 'dossier share <id> --add person@example.com --edit-state',
  inspectGrants: 'dossier share <id> --json',
  createLink: 'dossier state link create <id>',
  getLink: 'dossier state link get <id>',
  getLinkJson: 'dossier state link get <id> --json',
  revokeLink: 'dossier state link revoke <id>',
  read: 'dossier state get <id>',
  readJson: 'dossier state get <id> --json',
  save: 'dossier state set <id> --data values.json --revision <revision>',
  republish: 'dossier upload plan.html',
  republishById: 'dossier upload revised-plan.html --doc <id>',
  newDocument: 'dossier upload plan.html --kind plan --stateful --new',
} as const

function normalizedHelp(stdout: string): string {
  return stripVTControlCharacters(stdout).replace(
    /^dossier \S+$/m,
    'dossier <version>',
  )
}

function proseText(source: string): string {
  return source.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim()
}

type HelpRequirement = readonly [meaning: string, pattern: RegExp]

// Output-mode checks belong in DESCRIPTION. Merely showing the global
// --json/--quiet options does not explain a command's actual output.
async function savedValuesHelp(
  command: readonly string[],
  requirements: readonly HelpRequirement[],
): Promise<string> {
  const result = await cli('node', [...command, '--help'])
  expect(result, `dossier ${command.join(' ')} --help runs`).toMatchObject({
    exitCode: 0,
    stderr: '',
  })
  const help = normalizedHelp(result.stdout)
  const description = proseText(
    help.split('\nDESCRIPTION\n')[1]?.split(/\n(?:ARGUMENTS|OPTIONS)\n/)[0] ??
      '',
  )
  for (const [meaning, pattern] of requirements) {
    expect.soft(description, meaning).toMatch(pattern)
  }
  return help
}

describe('phase 8 help acceptance', () => {
  it('root help carries the PRD one-line saved-values promise', async () => {
    const help = await cli('node', ['--help'])
    expect(help).toMatchObject({ exitCode: 0, stderr: '' })
    expect(proseText(normalizedHelp(help.stdout))).toContain(savedValuesPromise)
  })

  it('root help spells executable state link paths without a repeated state', async () => {
    const help = await cli('node', ['--help'])
    expect(help).toMatchObject({ exitCode: 0, stderr: '' })
    const text = normalizedHelp(help.stdout)
    for (const operation of ['create', 'get', 'revoke']) {
      expect.soft(text).toMatch(new RegExp(`- state link ${operation} `))
    }
    expect(text).not.toMatch(/- state state link /)
  })

  it.each([
    'state get',
    'state set',
    'state link create',
    'state link get',
    'state link revoke',
  ])('%s help explains the document reference argument', async (command) => {
    const result = await cli('node', [...command.split(' '), '--help'])
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    const argumentsText = proseText(
      normalizedHelp(result.stdout)
        .split('\nARGUMENTS\n')[1]
        ?.split('\nOPTIONS\n')[0] ?? '',
    )
    expect(argumentsText).toMatch(/<ref>.*document ID.*id@n.*Dossier URL/i)
  })

  it('fetch help explains the document reference and pinned versions', async () => {
    const result = await cli('node', ['fetch', '--help'])
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    const help = normalizedHelp(result.stdout)
    const argumentsText = proseText(
      help.split('\nARGUMENTS\n')[1]?.split('\nOPTIONS\n')[0] ?? '',
    )
    expect(argumentsText).toMatch(
      /<ref>.*document ID.*id@n.*Dossier URL.*pinned.*version/i,
    )
    expect(help).toMatchInlineSnapshot(`
      "dossier

      dossier <version>

      USAGE

      $ fetch [--version integer] [(-o, --output text)] <ref>

      DESCRIPTION

      Fetch a document without changing its bytes

      ARGUMENTS

      <ref>

        A user-defined piece of text.

        Use a document ID, id@n, or a Dossier URL. A pinned reference selects that HTML version.

      OPTIONS

      --version integer

        An integer.

        This setting is optional.

      (-o, --output text)

        A user-defined piece of text.

        This setting is optional.

      --completions sh | bash | fish | zsh

        One of the following: sh, bash, fish, zsh

        Generate a completion script for a specific shell.

        This setting is optional.

      --log-level all | trace | debug | info | warning | error | fatal | none

        One of the following: all, trace, debug, info, warning, error, fatal, none

        Sets the minimum log level for a command.

        This setting is optional.

      (-h, --help)

        A true or false value.

        Show the help documentation for a command.

        This setting is optional.

      --wizard

        A true or false value.

        Start wizard mode for a command.

        This setting is optional.

      --version

        A true or false value.

        Show the version of the application.

        This setting is optional.

      "
    `)
  })

  it('state help explains the shared-value commands, output modes, and authority', async () => {
    const help = await savedValuesHelp(
      ['state'],
      [
        [
          'effect: read and save one shared set',
          /read.*save.*(?:one shared set|shared saved values)/i,
        ],
        [
          'human output: values, revision and last saved',
          /human.*values.*revision.*last saved/i,
        ],
        [
          'JSON output: state snapshot',
          /--json.*(?:snapshot|documentId.*revision.*data)/i,
        ],
        [
          'quiet output: get is silent and set prints the revision',
          /--quiet.*get.*(?:silent|nothing|no output).*set.*revision/i,
        ],
        ['read permission', /(?:anyone|readers?).*(?:read|view).*values/i],
        [
          'save permission',
          /(?:manag\w*|edit-state).*(?:save|writ)|(?:save|writ).*(?:manag\w*|edit-state)/i,
        ],
        [
          'saving is not publishing or sharing',
          /(?:not|never|no).*(?:publish|replac\w* HTML).*shar/i,
        ],
      ],
    )
    expect(help).toMatchInlineSnapshot(`
      "dossier

      dossier <version>

      USAGE

      $ state

      DESCRIPTION

      Read and save one shared set of saved values. Human output prints the values, the revision, and the last saved time. --json prints one JSON snapshot with documentId, version, revision, updatedAt, data, and fields. With --quiet, get prints nothing and set prints only the new revision. Anyone who can read the document can read its values. Document managers and collaborators with an --edit-state grant can save, and saving never grants publishing or sharing.

      OPTIONS

      --completions sh | bash | fish | zsh

        One of the following: sh, bash, fish, zsh

        Generate a completion script for a specific shell.

        This setting is optional.

      --log-level all | trace | debug | info | warning | error | fatal | none

        One of the following: all, trace, debug, info, warning, error, fatal, none

        Sets the minimum log level for a command.

        This setting is optional.

      (-h, --help)

        A true or false value.

        Show the help documentation for a command.

        This setting is optional.

      --wizard

        A true or false value.

        Start wizard mode for a command.

        This setting is optional.

      --version

        A true or false value.

        Show the version of the application.

        This setting is optional.

      COMMANDS

        - get <ref>                                   Read the current saved values of one document. Human output prints the values, the revision, and the last saved time. --json prints one snapshot with documentId, version, revision, updatedAt, data, and fields, where fields carries each value with its revision and type. --quiet prints nothing on success. Anyone who can read the document can read its values, and reading never changes values or permissions. An ordinary document fails with "Saved values are not enabled for this document".

        - set --data text [--revision integer] <ref>  Save values from a JSON object of field names to values. Human output prints the new revision and the last saved time, --json prints the saved snapshot with documentId, version, revision, updatedAt, data, and fields, and --quiet prints only the new revision. Saving requires document management authority or an --edit-state grant, and saving never grants publishing or sharing. Always pass --revision from the read you prepared the changes from, so a field that anyone saved after that read fails with a conflict. Without --revision, the CLI reads first and uses that read as the baseline, which only guards against saves racing this command.

        - link                                        Manage one bearer edit link for a document. Anyone with it can read and change saved values without signing in and can forward it, so revoking it stops access for every holder, including a tab that is already open. Only document managers create, show, or revoke it. Human output prints the link URL, a warning on create, and the revocation result. With --json, create and get print documentId, active, and editUrl, and revoke prints documentId and revoked. With --quiet, create and get print only the URL and revoke prints nothing.

        - link create <ref>                           Create the bearer edit link, or return the existing active link instead of replacing it. Anyone with it can read and change saved values without signing in and can forward it. Only document managers can create it. Human output prints a one-line warning and then the URL, --json prints documentId, active, and editUrl, and --quiet prints only the URL.

        - link get <ref>                              Show the active bearer edit link without creating or rotating one. Only document managers can read it. Human output prints the URL, or "No active edit link" when none exists. --json prints documentId, active, and editUrl, with active false and editUrl null when none exists. --quiet prints the URL or nothing.

        - link revoke <ref>                           Revoke the bearer edit link so it stops opening or saving the document from the next request, including from a tab that is already open. Only document managers can revoke it, and signed-in grants remain unchanged. Human output prints "Edit link revoked", or "No edit link to revoke" when none was active. --json prints documentId and revoked. --quiet prints nothing.

      "
    `)
  })

  it('state get help explains readable values, the JSON snapshot, silence, and read access', async () => {
    const help = await savedValuesHelp(
      ['state', 'get'],
      [
        [
          'effect: read current saved values',
          /read.*(?:current )?saved values/i,
        ],
        [
          'human output: values, revision and last saved',
          /human.*values.*revision.*last saved/i,
        ],
        ['JSON identifies the document', /--json.*documentId/i],
        [
          'JSON includes revision and timestamp',
          /--json.*revision.*updatedAt/i,
        ],
        ['JSON includes data, version and field revisions', /--json.*data/i],
        [
          'JSON includes HTML version and per-field metadata',
          /--json.*version.*fields/i,
        ],
        [
          'quiet success is silent, not a URL or revision',
          /--quiet.*(?:silent|nothing|no output)/i,
        ],
        [
          'read access is enough',
          /(?:anyone|readers?).*(?:read|view).*values/i,
        ],
        [
          'reading neither saves nor changes permissions',
          /(?:does not|never|no).*(?:chang\w*|grant\w*).*(?:access|permission)/i,
        ],
      ],
    )
    expect(help).toMatchInlineSnapshot(`
      "dossier

      dossier <version>

      USAGE

      $ get <ref>

      DESCRIPTION

      Read the current saved values of one document. Human output prints the values, the revision, and the last saved time. --json prints one snapshot with documentId, version, revision, updatedAt, data, and fields, where fields carries each value with its revision and type. --quiet prints nothing on success. Anyone who can read the document can read its values, and reading never changes values or permissions. An ordinary document fails with "Saved values are not enabled for this document".

      ARGUMENTS

      <ref>

        A user-defined piece of text.

        Use a document ID, id@n, or a Dossier URL.

      OPTIONS

      --completions sh | bash | fish | zsh

        One of the following: sh, bash, fish, zsh

        Generate a completion script for a specific shell.

        This setting is optional.

      --log-level all | trace | debug | info | warning | error | fatal | none

        One of the following: all, trace, debug, info, warning, error, fatal, none

        Sets the minimum log level for a command.

        This setting is optional.

      (-h, --help)

        A true or false value.

        Show the help documentation for a command.

        This setting is optional.

      --wizard

        A true or false value.

        Start wizard mode for a command.

        This setting is optional.

      --version

        A true or false value.

        Show the version of the application.

        This setting is optional.

      "
    `)
  })

  it('state set help explains saved output, permission, and the omitted-revision race guard', async () => {
    const help = await savedValuesHelp(
      ['state', 'set'],
      [
        ['effect: save the JSON values', /save.*(?:JSON|values)/i],
        [
          'human output: revision and last saved',
          /human.*revision.*last saved/i,
        ],
        [
          'JSON returns the saved state snapshot',
          /--json.*(?:snapshot|documentId.*revision.*data)/i,
        ],
        ['quiet success prints the new revision', /--quiet.*revision/i],
        [
          'save requires manage or edit-state authority',
          /(?:requir\w*|only).*(?:manag\w*).*(?:edit-state|saving grant)/i,
        ],
        [
          'saving does not grant publishing or sharing',
          /(?:not|never|no).*(?:publish|replac\w* HTML).*shar/i,
        ],
        [
          'omitting revision guards only racing saves',
          /without --revision.*only guards against saves racing this command/i,
        ],
        [
          'prepared changes carry the earlier read revision',
          /pass --revision from the read you prepared the changes from/i,
        ],
      ],
    )
    expect(help).toMatchInlineSnapshot(`
      "dossier

      dossier <version>

      USAGE

      $ set --data text [--revision integer] <ref>

      DESCRIPTION

      Save values from a JSON object of field names to values. Human output prints the new revision and the last saved time, --json prints the saved snapshot with documentId, version, revision, updatedAt, data, and fields, and --quiet prints only the new revision. Saving requires document management authority or an --edit-state grant, and saving never grants publishing or sharing. Always pass --revision from the read you prepared the changes from, so a field that anyone saved after that read fails with a conflict. Without --revision, the CLI reads first and uses that read as the baseline, which only guards against saves racing this command.

      ARGUMENTS

      <ref>

        A user-defined piece of text.

        Use a document ID, id@n, or a Dossier URL.

      OPTIONS

      --data text

        A user-defined piece of text.

        Read the changes from this JSON file of saved-value names to values.

      --revision integer

        An integer.

        Pass the revision of the read you prepared the changes from.

        This setting is optional.

      --completions sh | bash | fish | zsh

        One of the following: sh, bash, fish, zsh

        Generate a completion script for a specific shell.

        This setting is optional.

      --log-level all | trace | debug | info | warning | error | fatal | none

        One of the following: all, trace, debug, info, warning, error, fatal, none

        Sets the minimum log level for a command.

        This setting is optional.

      (-h, --help)

        A true or false value.

        Show the help documentation for a command.

        This setting is optional.

      --wizard

        A true or false value.

        Start wizard mode for a command.

        This setting is optional.

      --version

        A true or false value.

        Show the version of the application.

        This setting is optional.

      "
    `)
  })

  it('state link help explains bearer access and each output mode', async () => {
    const help = await savedValuesHelp(
      ['state', 'link'],
      [
        [
          'effect: manage one bearer edit link',
          /(?:manag\w*|create).*bearer edit link/i,
        ],
        [
          'human output: URL, warning and revocation result',
          /human.*(?:URL|link).*warn.*revok/i,
        ],
        ['JSON create/get output', /--json.*documentId.*active.*editUrl/i],
        ['JSON revoke output', /--json.*revoked/i],
        [
          'quiet create/get returns URL, revoke is silent',
          /--quiet.*URL.*revoke.*(?:silent|nothing|no output)/i,
        ],
        [
          'only document managers manage links',
          /(?:requir\w*|only).*(?:manag\w*)/i,
        ],
        [
          'bearer can read and change values',
          /anyone.*read and change.*values/i,
        ],
        [
          'link can be forwarded and revocation stops access',
          /forward.*revok.*(?:stop|access)/i,
        ],
      ],
    )
    expect(help).toMatchInlineSnapshot(`
      "dossier

      dossier <version>

      USAGE

      $ link

      DESCRIPTION

      Manage one bearer edit link for a document. Anyone with it can read and change saved values without signing in and can forward it, so revoking it stops access for every holder, including a tab that is already open. Only document managers create, show, or revoke it. Human output prints the link URL, a warning on create, and the revocation result. With --json, create and get print documentId, active, and editUrl, and revoke prints documentId and revoked. With --quiet, create and get print only the URL and revoke prints nothing.

      OPTIONS

      --completions sh | bash | fish | zsh

        One of the following: sh, bash, fish, zsh

        Generate a completion script for a specific shell.

        This setting is optional.

      --log-level all | trace | debug | info | warning | error | fatal | none

        One of the following: all, trace, debug, info, warning, error, fatal, none

        Sets the minimum log level for a command.

        This setting is optional.

      (-h, --help)

        A true or false value.

        Show the help documentation for a command.

        This setting is optional.

      --wizard

        A true or false value.

        Start wizard mode for a command.

        This setting is optional.

      --version

        A true or false value.

        Show the version of the application.

        This setting is optional.

      COMMANDS

        - create <ref>  Create the bearer edit link, or return the existing active link instead of replacing it. Anyone with it can read and change saved values without signing in and can forward it. Only document managers can create it. Human output prints a one-line warning and then the URL, --json prints documentId, active, and editUrl, and --quiet prints only the URL.

        - get <ref>     Show the active bearer edit link without creating or rotating one. Only document managers can read it. Human output prints the URL, or "No active edit link" when none exists. --json prints documentId, active, and editUrl, with active false and editUrl null when none exists. --quiet prints the URL or nothing.

        - revoke <ref>  Revoke the bearer edit link so it stops opening or saving the document from the next request, including from a tab that is already open. Only document managers can revoke it, and signed-in grants remain unchanged. Human output prints "Edit link revoked", or "No edit link to revoke" when none was active. --json prints documentId and revoked. --quiet prints nothing.

      "
    `)
  })

  it('state link create help explains reuse, warning, JSON, quiet URL, and bearer permissions', async () => {
    const help = await savedValuesHelp(
      ['state', 'link', 'create'],
      [
        [
          'effect: create or return the existing active link',
          /create.*(?:return|reus\w*|existing).*link/i,
        ],
        ['human output: warning and URL', /human.*warn.*URL/i],
        ['JSON output shape', /--json.*documentId.*active.*editUrl/i],
        [
          'quiet output: URL only',
          /--quiet.*(?:only.*URL|URL.*(?:only|alone))/i,
        ],
        [
          'management permission is required',
          /(?:requir\w*|only).*(?:manag\w*)/i,
        ],
        [
          'bearer may read and change saved values',
          /anyone.*read and change.*values/i,
        ],
        [
          'anonymous access, no sign-in',
          /(?:no sign-in|without sign\w* in|without an account)/i,
        ],
      ],
    )
    expect(help).toMatchInlineSnapshot(`
      "dossier

      dossier <version>

      USAGE

      $ create <ref>

      DESCRIPTION

      Create the bearer edit link, or return the existing active link instead of replacing it. Anyone with it can read and change saved values without signing in and can forward it. Only document managers can create it. Human output prints a one-line warning and then the URL, --json prints documentId, active, and editUrl, and --quiet prints only the URL.

      ARGUMENTS

      <ref>

        A user-defined piece of text.

        Use a document ID, id@n, or a Dossier URL.

      OPTIONS

      --completions sh | bash | fish | zsh

        One of the following: sh, bash, fish, zsh

        Generate a completion script for a specific shell.

        This setting is optional.

      --log-level all | trace | debug | info | warning | error | fatal | none

        One of the following: all, trace, debug, info, warning, error, fatal, none

        Sets the minimum log level for a command.

        This setting is optional.

      (-h, --help)

        A true or false value.

        Show the help documentation for a command.

        This setting is optional.

      --wizard

        A true or false value.

        Start wizard mode for a command.

        This setting is optional.

      --version

        A true or false value.

        Show the version of the application.

        This setting is optional.

      "
    `)
  })

  it('state link get help explains absent links, JSON, quiet output, and manager-only reading', async () => {
    const help = await savedValuesHelp(
      ['state', 'link', 'get'],
      [
        [
          'effect: get the active link without creating one',
          /(?:show|return|read|get).*active.*link/i,
        ],
        [
          'human output: URL or no active link',
          /human.*URL.*(?:no active|none)/i,
        ],
        ['JSON output shape', /--json.*documentId.*active.*editUrl/i],
        ['absent JSON link is false and null', /false.*null/i],
        [
          'quiet output: URL or silence',
          /--quiet.*URL.*(?:silent|nothing|no output)/i,
        ],
        [
          'only document managers can retrieve the link',
          /(?:requir\w*|only).*manag\w*/i,
        ],
        [
          'get does not create or rotate a link',
          /(?:does not|without|never).*(?:creat\w*|rotat\w*)/i,
        ],
      ],
    )
    expect(help).toMatchInlineSnapshot(`
      "dossier

      dossier <version>

      USAGE

      $ get <ref>

      DESCRIPTION

      Show the active bearer edit link without creating or rotating one. Only document managers can read it. Human output prints the URL, or "No active edit link" when none exists. --json prints documentId, active, and editUrl, with active false and editUrl null when none exists. --quiet prints the URL or nothing.

      ARGUMENTS

      <ref>

        A user-defined piece of text.

        Use a document ID, id@n, or a Dossier URL.

      OPTIONS

      --completions sh | bash | fish | zsh

        One of the following: sh, bash, fish, zsh

        Generate a completion script for a specific shell.

        This setting is optional.

      --log-level all | trace | debug | info | warning | error | fatal | none

        One of the following: all, trace, debug, info, warning, error, fatal, none

        Sets the minimum log level for a command.

        This setting is optional.

      (-h, --help)

        A true or false value.

        Show the help documentation for a command.

        This setting is optional.

      --wizard

        A true or false value.

        Start wizard mode for a command.

        This setting is optional.

      --version

        A true or false value.

        Show the version of the application.

        This setting is optional.

      "
    `)
  })

  it('state link revoke help explains revocation, absent links, JSON, silence, and other grants', async () => {
    const help = await savedValuesHelp(
      ['state', 'link', 'revoke'],
      [
        ['effect: revoke bearer access', /revoke.*(?:bearer|edit link)/i],
        [
          'human output: success or nothing to revoke',
          /human.*revok.*(?:nothing|no .*link|none)/i,
        ],
        [
          'JSON output identifies the document and revocation',
          /--json.*documentId.*revoked/i,
        ],
        ['quiet success is silent', /--quiet.*(?:silent|nothing|no output)/i],
        ['management permission is required', /(?:requir\w*|only).*manag\w*/i],
        [
          'revocation stops link access including open tabs',
          /(?:open tabs|open pages|already open)/i,
        ],
        [
          'revocation leaves signed-in grants alone',
          /(?:other|signed-in).*grants?.*(?:keep|remain|unchanged|unaffected)|(?:does not|without).*chang.*grants?/i,
        ],
      ],
    )
    expect(help).toMatchInlineSnapshot(`
      "dossier

      dossier <version>

      USAGE

      $ revoke <ref>

      DESCRIPTION

      Revoke the bearer edit link so it stops opening or saving the document from the next request, including from a tab that is already open. Only document managers can revoke it, and signed-in grants remain unchanged. Human output prints "Edit link revoked", or "No edit link to revoke" when none was active. --json prints documentId and revoked. --quiet prints nothing.

      ARGUMENTS

      <ref>

        A user-defined piece of text.

        Use a document ID, id@n, or a Dossier URL.

      OPTIONS

      --completions sh | bash | fish | zsh

        One of the following: sh, bash, fish, zsh

        Generate a completion script for a specific shell.

        This setting is optional.

      --log-level all | trace | debug | info | warning | error | fatal | none

        One of the following: all, trace, debug, info, warning, error, fatal, none

        Sets the minimum log level for a command.

        This setting is optional.

      (-h, --help)

        A true or false value.

        Show the help documentation for a command.

        This setting is optional.

      --wizard

        A true or false value.

        Start wizard mode for a command.

        This setting is optional.

      --version

        A true or false value.

        Show the version of the application.

        This setting is optional.

      "
    `)
  })

  it('upload help explains enabled state, output modes, preserved values, and separate visibility', async () => {
    const help = await savedValuesHelp(
      ['upload'],
      [
        [
          'effect: publish HTML with opt-in shared values',
          /(?:upload|publish).*HTML.*--stateful.*shared/i,
        ],
        [
          'human output includes state and last saved',
          /human.*State.*Last saved/i,
        ],
        [
          'JSON adds stateful, revision and timestamp',
          /--json.*stateful.*stateRevision.*stateUpdatedAt/i,
        ],
        [
          'quiet output stays URL only',
          /--quiet.*(?:only.*URL|URL.*(?:only|alone))/i,
        ],
        [
          'plain republish preserves values',
          /(?:republish|later upload|re-upload).*keep.*values/i,
        ],
        [
          'republish by path or explicit ID',
          /same file path.*--doc <id>.*(?:update|republish).*document/i,
        ],
        ['new creates separate defaults', /--new.*(?:fresh|default|separate)/i],
        ['manager can save immediately', /manag\w*.*save/i],
        [
          'visibility does not become anonymous editing',
          /(?:not|never|no).*anonym.*edit|anonym.*edit.*(?:not|never)/i,
        ],
        [
          'visibility stays separate',
          /visibility.*(?:separate|unchanged)|(?:separate|unchanged).*visibility/i,
        ],
      ],
    )
    const argumentsText = proseText(
      help.split('\nARGUMENTS\n')[1]?.split('\nOPTIONS\n')[0] ?? '',
    )
    expect.soft(argumentsText).toMatch(/<file>.*read.*complete HTML.*file/i)
    const options = proseText(help.split('\nOPTIONS\n')[1] ?? '')
    for (const [meaning, pattern] of [
      [
        'share accepts a comma-separated initial view-share list',
        /--share text.*initial view-share list.*comma-separated email addresses/i,
      ],
      [
        'description sets the document description',
        /--description text.*set the document description/i,
      ],
      [
        'doc updates the explicit ID instead of the mapped path',
        /--doc text.*Update this document ID instead of the mapped path/i,
      ],
      [
        'new creates a separate document without copying saved access',
        /--new.*Create a separate document.*no copied values, grants, or edit link/i,
      ],
      [
        'parent chooses a document or root and never moves an existing one',
        /--parent text.*Create beneath this document ID or URL, or use root.*dossier move/i,
      ],
      [
        'kind labels the document',
        /--kind text.*Set the document kind.*plan.*report.*checklist/i,
      ],
    ] as const) {
      expect.soft(options, meaning).toMatch(pattern)
    }
    expect(help).toMatchInlineSnapshot(`
      "dossier

      dossier <version>

      USAGE

      $ upload [--parent text] [--kind text] [--visibility public | team | private | inherit] [--share text] [--description text] [--new] [--stateful] [--accept-state-changes] [--doc text] <file>

      DESCRIPTION

      Validate and upload one complete HTML document. --stateful enables one shared set of saved values for controls marked with data-state. The document manager can save immediately, publishing never makes the document anonymously editable, and visibility stays a separate choice. Human output keeps the existing lines and adds State and Last saved for a saved-values document. --json adds stateful, stateRevision, and stateUpdatedAt, and --quiet prints only the URL. Use the same file path or --doc <id> to update an existing document. A later upload of the same document keeps its saved values, its enabled state, its grants, and its edit link, and --new starts a separate document with authored defaults. A retype or removal of a saved field fails until you pass --accept-state-changes.

      ARGUMENTS

      <file>

        A user-defined piece of text.

        Read one complete HTML document from this file.

      OPTIONS

      --parent text

        A user-defined piece of text.

        Create beneath this document ID or URL, or use root. Use dossier move to change the parent of an existing document.

        This setting is optional.

      --kind text

        A user-defined piece of text.

        Set the document kind, such as plan, report, or checklist.

        This setting is optional.

      --visibility public | team | private | inherit

        One of the following: public, team, private, inherit

        This setting is optional.

      --share text

        A user-defined piece of text.

        Set the initial view-share list with comma-separated email addresses.

        This setting is optional.

      --description text

        A user-defined piece of text.

        Set the document description.

        This setting is optional.

      --new

        A true or false value.

        Create a separate document with no copied values, grants, or edit link.

        This setting is optional.

      --stateful

        A true or false value.

        Enable one shared set of saved values for marked controls.

        This setting is optional.

      --accept-state-changes

        A true or false value.

        Accept a retype or removal of a saved field. Retyped values reset to their new defaults and removed values stay saved.

        This setting is optional.

      --doc text

        A user-defined piece of text.

        Update this document ID instead of the mapped path.

        This setting is optional.

      --completions sh | bash | fish | zsh

        One of the following: sh, bash, fish, zsh

        Generate a completion script for a specific shell.

        This setting is optional.

      --log-level all | trace | debug | info | warning | error | fatal | none

        One of the following: all, trace, debug, info, warning, error, fatal, none

        Sets the minimum log level for a command.

        This setting is optional.

      (-h, --help)

        A true or false value.

        Show the help documentation for a command.

        This setting is optional.

      --wizard

        A true or false value.

        Start wizard mode for a command.

        This setting is optional.

      --version

        A true or false value.

        Show the version of the application.

        This setting is optional.

      "
    `)
  })

  it('share help explains view/save output, grants JSON, silence, and document-local permission effects', async () => {
    const help = await savedValuesHelp(
      ['share'],
      [
        ['effect: manage viewing and saving', /manag\w*.*view.*sav/i],
        [
          'add with edit-state grants view and save',
          /--add.*--edit-state.*view and save|view and save.*--add.*--edit-state/i,
        ],
        [
          'remove with edit-state keeps viewing',
          /--remove.*--edit-state.*(?:keep\w* view|view.*remain)/i,
        ],
        [
          'plain remove drops both permissions',
          /(?:plain|without --edit-state).*--remove.*(?:view and save|both)|--remove.*without --edit-state.*(?:view and save|both)/i,
        ],
        ['human output says who can view and save', /human.*view.*save/i],
        [
          'JSON has grants and canSave, not a savers field',
          /--json.*grants.*canSave/i,
        ],
        ['quiet success is silent', /--quiet.*(?:silent|nothing|no output)/i],
        [
          'saving never grants publishing or sharing',
          /saving never grants publishing or sharing/i,
        ],
        [
          'grants do not change workspace membership',
          /(?:not|never|no).*chang\w*.*workspace membership/i,
        ],
        [
          'sign-in must satisfy deployment rules',
          /sign.in.*(?:rules|allowlist|deployment)/i,
        ],
      ],
    )
    const argumentsText = proseText(
      help.split('\nARGUMENTS\n')[1]?.split('\nOPTIONS\n')[0] ?? '',
    )
    expect.soft(argumentsText).toMatch(/<id>.*document ID.*id@n.*Dossier URL/i)
    expect(help).toMatchInlineSnapshot(`
      "dossier

      dossier <version>

      USAGE

      $ share [--add text] [--remove text] [--edit-state] <id>

      DESCRIPTION

      Manage who can view a document and who can save its values. --add grants viewing, and --add with --edit-state grants view and save. --remove with --edit-state drops saving and keeps viewing, and --remove without --edit-state drops view and save. Human output lists each person as view or view and save, --json prints the shares with grants and each grant's canSave, and --quiet prints nothing on success. The person must complete Dossier sign-in under the deployment's rules, a grant never changes workspace membership, and saving never grants publishing or sharing.

      ARGUMENTS

      <id>

        A user-defined piece of text.

        Use a document ID, id@n, or a Dossier URL.

      OPTIONS

      --add text

        A user-defined piece of text.

        Grant viewing, or viewing and saving with --edit-state.

        This setting is optional.

      --remove text

        A user-defined piece of text.

        Drop viewing and saving, or only saving with --edit-state.

        This setting is optional.

      --edit-state

        A true or false value.

        With --add, grant saving. With --remove, drop saving and keep viewing.

        This setting is optional.

      --completions sh | bash | fish | zsh

        One of the following: sh, bash, fish, zsh

        Generate a completion script for a specific shell.

        This setting is optional.

      --log-level all | trace | debug | info | warning | error | fatal | none

        One of the following: all, trace, debug, info, warning, error, fatal, none

        Sets the minimum log level for a command.

        This setting is optional.

      (-h, --help)

        A true or false value.

        Show the help documentation for a command.

        This setting is optional.

      --wizard

        A true or false value.

        Start wizard mode for a command.

        This setting is optional.

      --version

        A true or false value.

        Show the version of the application.

        This setting is optional.

      "
    `)
  })
})

describe('phase 8 documented journey', () => {
  it('publishes the PRD plan, grants saving, manages a link, reads and saves, then republishes or starts fresh', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    await writeFile(join(home, 'plan.html'), launchPlanExample)
    const defaults = {
      objective: 'Launch the new website',
      approved: false,
      notes: '',
    }
    const saved = { ...defaults, approved: true, notes: 'Use revised designs.' }
    await writeFile(join(home, 'values.json'), JSON.stringify(saved))

    async function run(
      command: string,
      id = '',
      revision = 0,
    ): Promise<string> {
      const substitutions: Record<string, string> = {
        'plan.html': join(home, 'plan.html'),
        'revised-plan.html': join(home, 'revised-plan.html'),
        'values.json': join(home, 'values.json'),
        '<id>': id,
        '<revision>': String(revision),
      }
      const args = command
        .split(' ')
        .slice(1)
        .map((arg) => substitutions[arg] ?? arg)
      const result = await cli('node', args, { home })
      expect(result, command).toMatchObject({ exitCode: 0, stderr: '' })
      return result.stdout
    }

    function uploadId(output: string): string {
      expect(output).toMatch(/^ID: [a-z0-9]{12}$/m)
      return /^ID: ([a-z0-9]{12})$/m.exec(output)![1]!
    }

    const published = await run(savedValuesJourney.publish)
    const id = uploadId(published)
    expect(published).toContain(`URL: ${apiUrl}/d/${id}\n`)
    expect(published).toContain(
      'State: enabled, one shared set of saved values\n',
    )
    expect(published).toContain('Last saved: never\n')
    expect(published).not.toContain('/edit#')
    const receipt = JSON.parse(await run(savedValuesJourney.publishJson))
    expect(receipt).toMatchObject({
      id,
      stateful: true,
      stateRevision: 0,
      stateUpdatedAt: null,
      versionNumber: 2,
    })
    expect(receipt).not.toHaveProperty('editUrl')

    expect(await run(savedValuesJourney.grant, id)).toContain(
      'person@example.com: view and save\n',
    )
    // Contracts expose grants[].canSave. The TDD's older `savers` noun is
    // not the shipped JSON API and must not enter the skill.
    const permissions = {
      configured: [],
      effective: [],
      accessSource: 'own',
      grants: [{ email: 'person@example.com', canSave: true }],
    }
    expect(JSON.parse(await run(savedValuesJourney.inspectGrants, id))).toEqual(
      permissions,
    )

    const created = await run(savedValuesJourney.createLink, id)
    const warning =
      'Anyone with this link can read and change the saved values and can forward it.'
    const link = created.trimEnd().split('\n').at(-1)!
    expect(created).toBe(`${warning}\n${link}\n`)
    expect(link).toMatch(new RegExp(`^${apiUrl}/d/${id}/edit#.+$`))
    expect(await run(savedValuesJourney.getLink, id)).toBe(`${link}\n`)
    expect(await run(savedValuesJourney.createLink, id)).toBe(created)
    expect(JSON.parse(await run(savedValuesJourney.getLinkJson, id))).toEqual({
      documentId: id,
      active: true,
      editUrl: link,
    })

    const beforeSave = JSON.parse(await run(savedValuesJourney.readJson, id))
    expect(beforeSave).toEqual({
      documentId: id,
      version: 2,
      revision: 0,
      updatedAt: null,
      data: defaults,
      fields: {
        objective: { value: defaults.objective, revision: 0, type: 'text' },
        approved: { value: false, revision: 0, type: 'checkbox' },
        notes: { value: '', revision: 0, type: 'textarea' },
      },
    })
    expect(await run(savedValuesJourney.read, id)).toBe(
      `Values:\n${JSON.stringify(defaults, null, 2)}\nRevision: 0\nLast saved: never\n`,
    )
    expect(await run(savedValuesJourney.save, id, beforeSave.revision)).toBe(
      'Revision: 1\nLast saved: 2026-09-14T09:01:00Z\n',
    )
    const afterSave = JSON.parse(await run(savedValuesJourney.readJson, id))
    expect(afterSave).toMatchObject({
      documentId: id,
      version: 2,
      revision: 1,
      updatedAt: '2026-09-14T09:01:00Z',
      data: saved,
    })
    for (const name of Object.keys(saved)) {
      expect(afterSave.fields[name]).toMatchObject({ revision: 1 })
    }

    // A real changed HTML upload, not an identical retry, must retain state.
    await writeFile(
      join(home, 'plan.html'),
      launchPlanExample.replace(
        '<h1>Launch plan</h1>',
        '<h1>Revised launch plan</h1>',
      ),
    )
    const republished = await run(savedValuesJourney.republish)
    expect(uploadId(republished)).toBe(id)
    expect(republished).toContain('Updated\n')
    expect(republished).toContain(
      'State: enabled, one shared set of saved values\n',
    )
    expect(republished).toContain('Last saved: 2026-09-14T09:01:00Z\n')
    expect(JSON.parse(await run(savedValuesJourney.readJson, id))).toEqual({
      ...afterSave,
      version: 3,
    })
    expect(await run(savedValuesJourney.getLink, id)).toBe(`${link}\n`)
    expect(JSON.parse(await run(savedValuesJourney.inspectGrants, id))).toEqual(
      permissions,
    )

    // The by-ID republish carries a second, distinct HTML change, so the test
    // proves an update by ID and not a re-upload of identical bytes.
    const revisedPlan = launchPlanExample.replace(
      '<h1>Launch plan</h1>',
      '<h1>Launch plan, revised</h1>',
    )
    expect(revisedPlan).not.toBe(launchPlanExample)
    expect(revisedPlan).not.toBe(documents.get(id)?.html.toString('utf8'))
    await writeFile(join(home, 'revised-plan.html'), revisedPlan)
    expect(uploadId(await run(savedValuesJourney.republishById, id))).toBe(id)
    expect(documents.get(id)?.html.toString('utf8')).toBe(revisedPlan)
    expect(JSON.parse(await run(savedValuesJourney.readJson, id))).toEqual({
      ...afterSave,
      version: 4,
    })
    expect(await run(savedValuesJourney.getLink, id)).toBe(`${link}\n`)
    expect(JSON.parse(await run(savedValuesJourney.inspectGrants, id))).toEqual(
      permissions,
    )

    const fresh = await run(savedValuesJourney.newDocument)
    const freshId = uploadId(fresh)
    expect(freshId).not.toBe(id)
    expect(fresh).toContain('State: enabled, one shared set of saved values\n')
    expect(fresh).toContain('Last saved: never\n')
    expect(JSON.parse(await run(savedValuesJourney.readJson, freshId))).toEqual(
      {
        ...beforeSave,
        documentId: freshId,
        version: 1,
      },
    )
    expect(
      JSON.parse(await run(savedValuesJourney.getLinkJson, freshId)),
    ).toEqual({
      documentId: freshId,
      active: false,
      editUrl: null,
    })
    expect(
      JSON.parse(await run(savedValuesJourney.inspectGrants, freshId)),
    ).toEqual({
      ...permissions,
      grants: [],
    })
    expect(JSON.parse(await run(savedValuesJourney.readJson, id))).toEqual({
      ...afterSave,
      version: 4,
    })

    expect(await run(savedValuesJourney.revokeLink, id)).toBe(
      'Edit link revoked\n',
    )
    expect(await run(savedValuesJourney.getLink, id)).toBe(
      'No active edit link\n',
    )
    expect(JSON.parse(await run(savedValuesJourney.getLinkJson, id))).toEqual({
      documentId: id,
      active: false,
      editUrl: null,
    })
    expect(await run(savedValuesJourney.revokeLink, id)).toBe(
      'No edit link to revoke\n',
    )
    expect(JSON.parse(await run(savedValuesJourney.inspectGrants, id))).toEqual(
      permissions,
    )
    const replacement = await run(savedValuesJourney.createLink, id)
    expect(replacement).toContain(`${warning}\n`)
    expect(replacement).not.toBe(created)
    expect(await run(savedValuesJourney.getLink, id)).toBe(
      `${replacement.trimEnd().split('\n').at(-1)}\n`,
    )
  }, 60_000)
})

describe('phase 8 compatibility acceptance', () => {
  // `state link` itself only displays help. Exercise every operation instead
  // of expecting a help group to contact the deployment (TDD 03).
  const commands = [
    ['upload', 'plan.html', '--kind', 'plan', '--stateful'],
    ['state', 'get', 'compatstate1'],
    ['state', 'set', 'compatstate1', '--data', 'values.json'],
    ['state', 'link', 'create', 'compatstate1'],
    ['state', 'link', 'get', 'compatstate1'],
    ['state', 'link', 'revoke', 'compatstate1'],
    ['share', 'compatstate1', '--add', 'person@example.com', '--edit-state'],
    ['share', 'compatstate1', '--remove', 'person@example.com', '--edit-state'],
  ]
  for (const [healthResponse, key, requests] of [
    ['legacy', 'ds_legacy', legacyRequests],
    ['current-but-unavailable', 'ds_unavailable', unavailableRequests],
  ] as const) {
    for (const command of commands) {
      it(`${command.join(' ')} refuses a ${healthResponse} health response before any operation`, async () => {
        const home = await temporaryHome()
        await writeFile(join(home, 'plan.html'), launchPlanExample)
        await writeFile(join(home, 'values.json'), '{"approved":true}')
        const args = command.map((arg) =>
          arg === 'plan.html' || arg === 'values.json' ? join(home, arg) : arg,
        )
        const before = requests.length
        const result = await cli('node', [...args, '--api-url', apiUrl], {
          home,
          env: { DOSSIER_API_KEY: key },
        })
        expect(result).toEqual({
          exitCode: 1,
          stdout: '',
          stderr: `dossier: ${deploymentCompatibilityMessage}\n`,
        })
        // Log before authentication/routing, so even a rejected write attempt
        // fails this check. Unchanged maps alone would be a false positive.
        expect(requests.slice(before)).toEqual(['GET /api/healthz'])
      })
    }
  }
})

describe('phase 8 packaged guidance acceptance', () => {
  const skillFile = join(packageDirectory, 'skills/dossier/SKILL.md')
  const rootDirectory = join(packageDirectory, '../..')

  it('the skill contains the PRD promise and complete 5.1 HTML example verbatim', async () => {
    const skill = await readFile(skillFile, 'utf8')
    expect.soft(proseText(skill)).toContain(savedValuesPromise)
    expect(skill).toContain(launchPlanExample)
  })

  it('the skill documents every command spelling executed by the journey', async () => {
    const skill = await readFile(skillFile, 'utf8')
    const commands = [
      ...skill.matchAll(/```(?:sh|bash|shell|text)?\n([\s\S]*?)```/g),
    ]
      .flatMap((block) => block[1]!.split('\n'))
      .map((line) => line.split(/\s+#/)[0]!.trim())
    for (const command of Object.values(savedValuesJourney)) {
      expect.soft(commands, command).toContain(command)
    }
  })

  it('the skill identifies the edit-link fragment and explains safe log redaction', async () => {
    const skill = proseText(await readFile(skillFile, 'utf8'))
    expect.soft(skill).toContain('/d/<id>/edit#<token>')
    expect.soft(skill).toMatch(/fragment after # holds the bearer token/i)
    expect
      .soft(skill)
      .toMatch(/redact the entire non-null editUrl value before displaying/i)
    expect
      .soft(skill)
      .toMatch(/do not rely on a query-parameter pattern to hide it/i)
  })

  it('the skill explains stable names, defaults, preserved removals, and confirmed retypes', async () => {
    const skill = proseText(await readFile(skillFile, 'utf8'))
    const rules: readonly HelpRequirement[] = [
      [
        'field names are identity',
        /(?:name|data-state).*(?:identity|stable|same name)/i,
      ],
      [
        'label and layout edits keep values',
        /(?:label|layout|order).*keep.*values/i,
      ],
      ['new fields use authored defaults', /new fields?.*defaults?/i],
      [
        'saved false and empty values survive',
        /(?:false|unchecked).*(?:empty|cleared)|(?:empty|cleared).*false/i,
      ],
      [
        'removing does not erase, re-adding restores',
        /remov.*(?:keep|retain|preserv|not erase).*re.add.*restor/i,
      ],
      [
        'rename and retype need deliberate confirmation',
        /(?:renam\w*|retyp\w*|chang\w*.*type).*--accept-state-changes/i,
      ],
      [
        'accepted retypes reset to authored defaults',
        /retyp\w*.*reset.*default|reset.*retyp\w*.*default/i,
      ],
      [
        'plain reupload keeps grants and edit link',
        /(?:republish|re-upload|upload).*keep.*(?:grants|access).*edit link/i,
      ],
      [
        'new documents copy neither grants nor link',
        /--new.*(?:no|not|without|nothing).*(?:grants|access).*link/i,
      ],
    ]
    for (const [meaning, pattern] of rules) {
      expect.soft(skill, meaning).toMatch(pattern)
    }
  })

  it('the skill explains one shared set, explicit Save, and the custom-control contract', async () => {
    const skill = await readFile(skillFile, 'utf8')
    const text = proseText(skill)
    expect.soft(text).toMatch(/one shared set of (?:saved )?values/i)
    expect.soft(text).toMatch(/(?:press|click|choose).*Save|explicit.*Save/i)
    expect
      .soft(text)
      .toMatch(/(?:other|open).*tabs?.*reload|reload.*(?:other|open).*tabs?/i)
    expect
      .soft(text)
      .toMatch(
        /(?:not|no|never).*(?:per-visitor|separate response|individual submission)/i,
      )
    for (const token of [
      'data-state-default',
      'window.dossierState.register',
      'read:',
      'write:',
    ]) {
      expect.soft(skill, `custom controls: ${token}`).toContain(token)
    }
  })

  it('the skill distinguishes an outdated deployment from an outdated CLI and gives next steps', async () => {
    const skill = proseText(await readFile(skillFile, 'utf8'))
    expect.soft(skill).toContain(deploymentCompatibilityMessage)
    expect
      .soft(skill)
      .toMatch(
        /(?:deployment|server).*(?:older|out of date|outdated|does not support)/i,
      )
    expect.soft(skill).toContain('dossier update --check')
    expect
      .soft(skill)
      .toMatch(
        /(?:missing|unknown|unrecognized).*command|command.*(?:missing|unknown|unrecognized)/i,
      )
    expect
      .soft(skill)
      .toMatch(
        /(?:do not|never|don't).*(?:drop|omit|remove|without).*--stateful/i,
      )
  })

  it('the skill explains unavailable saved values and checks configuration before an update', async () => {
    const skill = await readFile(skillFile, 'utf8')
    const compatibility = proseText(skill.split('### Compatibility\n')[1] ?? '')
    expect
      .soft(compatibility, 'health reports availability, not age')
      .toMatch(/does not advertise saved-values availability/i)
    expect
      .soft(compatibility, 'a current deployment can lack its limiter')
      .toMatch(/current deployment.*STATE_RATE_LIMITER.*missing/i)
    expect
      .soft(compatibility, 'check configuration before updating or redeploying')
      .toMatch(
        /check.*\/api\/healthz.*STATE_RATE_LIMITER.*configuration before updating or redeploying/i,
      )
    expect
      .soft(compatibility, 'restore a missing binding')
      .toMatch(/restore a missing binding/i)
    expect
      .soft(compatibility, 'confirm availability before retrying')
      .toMatch(/confirm that health advertises state, then retry/i)
  })

  it('the README carries the same promise and lists the saved-values command tree', async () => {
    const readme = await readFile(join(packageDirectory, 'README.md'), 'utf8')
    expect.soft(proseText(readme)).toContain(savedValuesPromise)
    for (const token of [
      'state get',
      'state set',
      'state link create',
      'state link get',
      'state link revoke',
      '--stateful',
      '--edit-state',
    ]) {
      expect.soft(readme, token).toContain(token)
    }
  })

  it('CI pack smoke verifies the shipped skill as well as the README', async () => {
    const workflow = await readFile(
      join(rootDirectory, '.github/workflows/ci.yml'),
      'utf8',
    )
    const smoke =
      workflow
        .split('- name: Pack and smoke test CLI')[1]
        ?.split('\n  browser:')[0] ?? ''
    expect(smoke).toContain('npm pack')
    expect(smoke).toMatch(
      /test -s .*node_modules\/@agent964\/dossier\/README\.md/,
    )
    expect(smoke).toMatch(
      /test -s .*node_modules\/@agent964\/dossier\/skills\/dossier\/SKILL\.md/,
    )
    expect(packageJson.files).toContain('skills')
    expect(packageJson.exports['./skills/dossier/SKILL.md']).toBe(
      './skills/dossier/SKILL.md',
    )
  })

  it('the global flag table keeps two Markdown cells per row', async () => {
    const reference = await readFile(join(rootDirectory, 'docs/CLI.md'), 'utf8')
    const section = reference.split('## Global flags')[1]?.split('###')[0] ?? ''
    const rows = section.split('\n').filter((line) => line.startsWith('|'))
    expect(rows.length).toBeGreaterThan(2)
    expect.soft(rows.some((row) => row.includes('--completions'))).toBe(true)
    expect.soft(rows.some((row) => row.includes('--log-level'))).toBe(true)
    for (const row of rows) {
      expect.soft(row.split(/(?<!\\)\|/), row).toHaveLength(4)
    }
  })

  it('CLI reference documents state commands, upload/share flags, and state error exit codes', async () => {
    const reference = await readFile(join(rootDirectory, 'docs/CLI.md'), 'utf8')
    for (const token of [
      'dossier state get',
      'dossier state set',
      'dossier state link create',
      'dossier state link get',
      'dossier state link revoke',
      '--stateful',
      '--accept-state-changes',
      '--edit-state',
      'state_not_enabled',
      'state_conflict',
      'state_schema_change',
      'state_version_changed',
      'state_type_mismatch',
      'state_edit_required',
      'state_too_large',
      'state_unavailable',
      'link_revoked',
      'rate_limited',
    ]) {
      expect.soft(reference, token).toContain(token)
    }
    expect
      .soft(proseText(reference))
      .toMatch(/state_.*(?:exit(?: code)? 1|code 1)/i)
  })

  it('architecture names the wrapper, frame ticket, State service, and actual four tables', async () => {
    const architecture = await readFile(
      join(rootDirectory, 'docs/ARCHITECTURE.md'),
      'utf8',
    )
    for (const token of [
      'wrapper',
      'frame',
      'ticket',
      'State',
      'document_state',
      'document_state_fields',
      'document_state_grants',
      'document_edit_links',
    ]) {
      expect.soft(architecture, token).toContain(token)
    }
  })

  it('architecture distinguishes view-share materialization from grant-only deltas', async () => {
    const architecture = proseText(
      await readFile(join(rootDirectory, 'docs/ARCHITECTURE.md'), 'utf8'),
    )
    expect(architecture).toContain(
      'Only a view-share delta with nonempty add or remove entries ' +
        'materializes inherited access.',
    )
    expect(architecture).toContain(
      'Grant-only deltas (addSavers, removeSavers, or removeGrants) leave ' +
        'visibility and inherited view shares unchanged.',
    )
  })

  it('runbook explains the state secret, limiter, and fail-closed 503', async () => {
    const runbook = await readFile(
      join(rootDirectory, 'docs/RUNBOOK.md'),
      'utf8',
    )
    for (const token of [
      'LINK_SECRET',
      'STATE_RATE_LIMITER',
      '503',
      'state_unavailable',
    ]) {
      expect.soft(runbook, token).toContain(token)
    }
    expect
      .soft(proseText(runbook))
      .toMatch(
        /(?:missing|absent|unavailable).*(?:binding|limiter|secret)|(?:binding|limiter|secret).*(?:missing|absent|unavailable)/i,
      )
  })
})

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

  it('renders state schema changes and sends the acceptance flag', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const file = join(home, 'schema-change.html')
    await writeFile(
      file,
      '<!doctype html><html><head><title>Schema change</title></head><body></body></html>',
      'utf8',
    )
    const before = stateSchemaRequestHashes.length

    const human = await cli('node', ['upload', file, '--new'], { home })
    expect(human.exitCode).toBe(1)
    expect(human.stdout).toBe('')
    expect(human.stderr).toContain(
      'dossier: Retyped saved values:\n' +
        '  notes: textarea -> text\n' +
        'Removed from the document (saved values kept):\n' +
        '  legacyNotes\n' +
        'Re-run with --accept-state-changes to accept these schema changes.\n' +
        'Retyped values reset to their new defaults. Removed values stay saved.\n',
    )

    const json = await cli('node', ['upload', file, '--new', '--json'], {
      home,
    })
    expect(json.exitCode).toBe(1)
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      code: 'state_schema_change',
      message: 'Saved-value fields changed.',
      details: {
        retyped: [{ name: 'notes', from: 'textarea', to: 'text' }],
        orphaned: ['legacyNotes'],
      },
      exitCode: 1,
    })

    const accepted = await cli(
      'node',
      ['upload', file, '--new', '--accept-state-changes'],
      { home },
    )
    expect(accepted.exitCode).toBe(0)
    expect(accepted.stdout).toContain('Reset saved values:\n  - notes\n')

    const acceptedJson = await cli(
      'node',
      ['upload', file, '--new', '--accept-state-changes', '--json'],
      { home },
    )
    expect(acceptedJson.exitCode).toBe(0)
    expect(JSON.parse(acceptedJson.stdout)).toMatchObject({
      resetStateFields: ['notes'],
    })
    expect(stateSchemaRequestHashes.slice(before, before + 3)).toHaveLength(3)
    expect(stateSchemaRequestHashes[before + 2]).not.toBe(
      stateSchemaRequestHashes[before],
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

  it('uses a stateful path mapping for validation before upload', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const file = join(home, 'mapped-stateful.html')
    await writeFile(file, statefulHtml('Mapped stateful'), 'utf8')
    const created = await cli(
      'node',
      ['upload', file, '--stateful', '--new', '--json'],
      { home },
    )
    expect(created.exitCode).toBe(0)

    const mappings = JSON.parse(
      await readFile(join(home, 'documents.json'), 'utf8'),
    )
    expect(mappings[apiUrl].acct_test[file]).toMatchObject({ stateful: true })

    await writeFile(
      file,
      '<!doctype html><html><head><title>One</title></head><head><title>Two</title></head><body><input data-state="notes"></body></html>',
      'utf8',
    )
    const beforeUploads = uploadRequests
    const result = await cli('node', ['upload', file], { home })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      'Stateful HTML must contain exactly one literal <head> start tag.',
    )
    expect(uploadRequests).toBe(beforeUploads)
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

  it('manages edit links in human, JSON, and quiet modes', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const ids = [
      'linkcreate01',
      'linkcreate02',
      'linkcreate03',
      'linkget00001',
      'linkget00002',
      'linkget00003',
      'linkrevoke01',
      'linkrevoke02',
      'linkrevoke03',
    ]
    for (const id of ids) {
      documents.set(
        id,
        storedDocument(`${id}.html`, {
          stateful: true,
          stateRevision: 0,
        }),
      )
    }

    const warning =
      'Anyone with this link can read and change the saved values and can forward it.'
    const url = (id: string, generation: number) =>
      `${apiUrl}/d/${id}/edit#edit-link-${generation}`

    const humanCreate = await cli(
      'node',
      ['state', 'link', 'create', 'linkcreate01'],
      { home },
    )
    expect(humanCreate).toEqual({
      stdout: `${warning}\n${url('linkcreate01', 1)}\n`,
      stderr: '',
      exitCode: 0,
    })

    const jsonCreate = await cli(
      'node',
      ['state', 'link', 'create', 'linkcreate02', '--json'],
      { home },
    )
    expect(jsonCreate.exitCode).toBe(0)
    expect(jsonCreate.stderr).toBe('')
    expect(JSON.parse(jsonCreate.stdout)).toEqual({
      documentId: 'linkcreate02',
      active: true,
      editUrl: url('linkcreate02', 1),
    })

    const quietCreate = await cli(
      'node',
      ['state', 'link', 'create', 'linkcreate03', '--quiet'],
      { home },
    )
    expect(quietCreate).toEqual({
      stdout: `${url('linkcreate03', 1)}\n`,
      stderr: '',
      exitCode: 0,
    })

    editLinks.set('linkget00001', { generation: 4, active: true })
    editLinks.set('linkget00003', { generation: 8, active: true })
    const humanGet = await cli(
      'node',
      ['state', 'link', 'get', 'linkget00001'],
      { home },
    )
    expect(humanGet).toEqual({
      stdout: `${url('linkget00001', 4)}\n`,
      stderr: '',
      exitCode: 0,
    })

    const jsonGet = await cli(
      'node',
      ['state', 'link', 'get', 'linkget00002', '--json'],
      { home },
    )
    expect(jsonGet.exitCode).toBe(0)
    expect(jsonGet.stderr).toBe('')
    expect(JSON.parse(jsonGet.stdout)).toEqual({
      documentId: 'linkget00002',
      active: false,
      editUrl: null,
    })

    const quietGet = await cli(
      'node',
      ['state', 'link', 'get', 'linkget00003', '--quiet'],
      { home },
    )
    expect(quietGet).toEqual({
      stdout: `${url('linkget00003', 8)}\n`,
      stderr: '',
      exitCode: 0,
    })

    const noActiveGet = await cli(
      'node',
      ['state', 'link', 'get', 'linkget00002'],
      { home },
    )
    expect(noActiveGet).toEqual({
      stdout: 'No active edit link\n',
      stderr: '',
      exitCode: 0,
    })

    editLinks.set('linkrevoke01', { generation: 2, active: true })
    editLinks.set('linkrevoke03', { generation: 9, active: true })
    const humanRevoke = await cli(
      'node',
      ['state', 'link', 'revoke', 'linkrevoke01'],
      { home },
    )
    expect(humanRevoke).toEqual({
      stdout: 'Edit link revoked\n',
      stderr: '',
      exitCode: 0,
    })

    const jsonRevoke = await cli(
      'node',
      ['state', 'link', 'revoke', 'linkrevoke02', '--json'],
      { home },
    )
    expect(jsonRevoke.exitCode).toBe(0)
    expect(jsonRevoke.stderr).toBe('')
    expect(JSON.parse(jsonRevoke.stdout)).toEqual({
      documentId: 'linkrevoke02',
      revoked: false,
    })

    const quietRevoke = await cli(
      'node',
      ['state', 'link', 'revoke', 'linkrevoke03', '--quiet'],
      { home },
    )
    expect(quietRevoke).toEqual({ stdout: '', stderr: '', exitCode: 0 })
    expect(editLinks.get('linkrevoke03')?.active).toBe(false)

    const noRevoke = await cli(
      'node',
      ['state', 'link', 'revoke', 'linkrevoke02'],
      { home },
    )
    expect(noRevoke).toEqual({
      stdout: 'No edit link to revoke\n',
      stderr: '',
      exitCode: 0,
    })
  })

  it('explains the bearer authority and revocation in state link help', async () => {
    const help = await cli('node', ['state', 'link', '--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stderr).toBe('')
    expect(help.stdout).toContain('bearer edit link')
    expect(help.stdout).toContain(
      'Anyone with it can read and change saved values',
    )
    expect(help.stdout).toContain('revoking it stops access')
  })

  it('explains the omitted-revision baseline in state set help', async () => {
    const help = await cli('node', ['state', 'set', '--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain(
      'Read the changes from this JSON file of saved-value names to values.',
    )
    expect(help.stdout).toContain(
      'only guards against saves racing this command',
    )
    expect(help.stdout).toContain(
      'pass --revision from the read you prepared the changes from',
    )
  })

  it('sets saved values in human, JSON, and quiet modes', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const file = join(home, 'state-values.json')
    await writeFile(
      file,
      JSON.stringify({ objective: 'Ship it', approved: true }),
      'utf8',
    )
    for (const id of ['sethuman0001', 'setjson00001', 'setquiet0001']) {
      documents.set(
        id,
        storedDocument(`${id}.html`, {
          version: 2,
          stateful: true,
          stateRevision: 5,
          stateUpdatedAt: '2026-09-14T08:00:00Z',
          stateData: { objective: 'Before', approved: false },
          stateFields: {
            objective: { value: 'Before', revision: 4, type: 'text' },
            approved: { value: false, revision: 0, type: 'checkbox' },
          },
        }),
      )
    }

    const human = await cli(
      'node',
      ['state', 'set', 'sethuman0001', '--data', file],
      { home },
    )
    expect(human).toEqual({
      stdout: 'Revision: 6\nLast saved: 2026-09-14T09:01:00Z\n',
      stderr: '',
      exitCode: 0,
    })

    const json = await cli(
      'node',
      ['state', 'set', 'setjson00001', '--data', file, '--json'],
      { home },
    )
    expect(json.exitCode).toBe(0)
    expect(json.stderr).toBe('')
    expect(JSON.parse(json.stdout)).toEqual({
      documentId: 'setjson00001',
      version: 2,
      revision: 6,
      updatedAt: '2026-09-14T09:01:00Z',
      data: { objective: 'Ship it', approved: true },
      fields: {
        objective: { value: 'Ship it', revision: 6, type: 'text' },
        approved: { value: true, revision: 6, type: 'checkbox' },
      },
    })

    const quiet = await cli(
      'node',
      ['state', 'set', 'setquiet0001', '--data', file, '--quiet'],
      { home },
    )
    expect(quiet).toEqual({ stdout: '6\n', stderr: '', exitCode: 0 })
  })

  it('uses an explicit revision without reading and renders conflicts', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const id = 'setconf00001'
    const file = join(home, 'conflicting-state.json')
    await writeFile(file, JSON.stringify({ objective: 'My draft' }), 'utf8')
    documents.set(
      id,
      storedDocument('Conflict.html', {
        stateful: true,
        stateRevision: 7,
        stateUpdatedAt: '2026-09-14T08:00:00Z',
        stateData: { objective: 'Current value' },
        stateFields: {
          objective: { value: 'Current value', revision: 7, type: 'text' },
        },
      }),
    )
    const beforeGets = stateGetRequests.length
    const beforeSets = stateSetRequests.length
    const result = await cli(
      'node',
      ['state', 'set', id, '--data', file, '--revision', '3'],
      { home },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('objective: "Current value" (revision 7)')
    expect(result.stderr).toContain(
      'Read the latest saved values, then re-run the command.',
    )
    expect(stateGetRequests).toHaveLength(beforeGets)
    expect(stateSetRequests.slice(beforeSets)).toEqual([
      {
        id,
        changes: [{ name: 'objective', value: 'My draft', base: 3 }],
      },
    ])

    const json = await cli(
      'node',
      ['state', 'set', id, '--data', file, '--revision', '3', '--json'],
      { home },
    )
    expect(json.exitCode).toBe(1)
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      code: 'state_conflict',
      message: 'Saved values changed after the supplied baseline.',
      details: {
        fields: [{ name: 'objective', revision: 7, value: 'Current value' }],
      },
      exitCode: 1,
    })
  })

  it('retries one version change and succeeds with the original bases', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const id = 'setretry0001'
    const file = join(home, 'retry-state.json')
    await writeFile(file, JSON.stringify({ objective: 'After' }), 'utf8')
    documents.set(
      id,
      storedDocument('Retry state.html', {
        version: 2,
        stateful: true,
        stateRevision: 5,
        stateData: { objective: 'Before' },
        stateFields: {
          objective: { value: 'Before', revision: 4, type: 'text' },
        },
      }),
    )
    stateVersionChanges.set(id, { kind: 'version-only' })
    const before = stateSetRequests.length
    const result = await cli(
      'node',
      ['state', 'set', id, '--data', file, '--json'],
      { home },
    )
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      documentId: id,
      version: 3,
      revision: 6,
      data: { objective: 'After' },
    })
    expect(stateSetRequests.slice(before)).toEqual([
      {
        id,
        changes: [{ name: 'objective', value: 'After', base: 4 }],
      },
      {
        id,
        changes: [{ name: 'objective', value: 'After', base: 4 }],
      },
    ])
  })

  it('keeps the original bases when a field moves before the retry', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const id = 'setmoved0001'
    const file = join(home, 'moved-state.json')
    await writeFile(file, JSON.stringify({ objective: 'My draft' }), 'utf8')
    documents.set(
      id,
      storedDocument('Moved state.html', {
        version: 2,
        stateful: true,
        stateRevision: 5,
        stateData: { objective: 'Before' },
        stateFields: {
          objective: { value: 'Before', revision: 4, type: 'text' },
        },
      }),
    )
    stateVersionChanges.set(id, {
      kind: 'move-field',
      name: 'objective',
      value: 'Collaborator value',
    })
    const before = stateSetRequests.length
    const result = await cli('node', ['state', 'set', id, '--data', file], {
      home,
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      'objective: "Collaborator value" (revision 6)',
    )
    expect(stateSetRequests.slice(before)).toEqual([
      {
        id,
        changes: [{ name: 'objective', value: 'My draft', base: 4 }],
      },
      {
        id,
        changes: [{ name: 'objective', value: 'My draft', base: 4 }],
      },
    ])
  })

  it('renders state type and size errors from the typed client', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const file = join(home, 'invalid-state-values.json')
    await writeFile(
      file,
      JSON.stringify({ objective: 42, approved: 'yes' }),
      'utf8',
    )
    documents.set(
      'settypes0001',
      storedDocument('Types.html', { stateful: true, stateRevision: 0 }),
    )
    forcedStateErrors.set('settypes0001', {
      status: 422,
      value: {
        ok: false,
        code: 'state_type_mismatch',
        message: 'Some values do not match the current field types.',
        details: { fields: ['objective', 'approved'] },
      },
    })
    const mismatch = await cli(
      'node',
      ['state', 'set', 'settypes0001', '--data', file, '--revision', '0'],
      { home },
    )
    expect(mismatch.exitCode).toBe(1)
    expect(mismatch.stderr).toContain(
      'Values do not match the current types for: objective, approved',
    )

    documents.set(
      'setlarge0001',
      storedDocument('Large.html', { stateful: true, stateRevision: 0 }),
    )
    forcedStateErrors.set('setlarge0001', {
      status: 413,
      value: {
        ok: false,
        code: 'state_too_large',
        message: 'Saved values exceed the document limit.',
        details: { bytes: 300000, limit: 262144 },
      },
    })
    const tooLarge = await cli(
      'node',
      ['state', 'set', 'setlarge0001', '--data', file, '--revision', '0'],
      { home },
    )
    expect(tooLarge.exitCode).toBe(1)
    expect(tooLarge.stderr).toContain(
      'Saved values use 300000 bytes; the limit is 262144 bytes.',
    )

    documents.set(
      'setlimit0001',
      storedDocument('Rate limit.html', { stateful: true, stateRevision: 0 }),
    )
    forcedStateErrors.set('setlimit0001', {
      status: 429,
      value: {
        ok: false,
        code: 'rate_limited',
        message: 'State rate limit exceeded.',
      },
    })
    const rateLimited = await cli(
      'node',
      [
        'state',
        'set',
        'setlimit0001',
        '--data',
        file,
        '--revision',
        '0',
        '--json',
      ],
      { home },
    )
    expect(rateLimited.exitCode).toBe(1)
    expect(JSON.parse(rateLimited.stdout)).toEqual({
      ok: false,
      code: 'rate_limited',
      message: 'State rate limit exceeded.',
      exitCode: 1,
    })
  })

  it('rejects state data that is not a JSON object with usage exit code', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const file = join(home, 'state-array.json')
    await writeFile(file, JSON.stringify(['not', 'an', 'object']), 'utf8')
    const before = stateSetRequests.length
    const result = await cli(
      'node',
      ['state', 'set', 'settypes0001', '--data', file, '--revision', '0'],
      { home },
    )
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(
      'must contain a JSON object of saved-value names to values',
    )
    expect(stateSetRequests).toHaveLength(before)
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

    const legacyLink = await cli(
      'node',
      ['state', 'link', 'get', 'stateget0001', '--api-url', apiUrl],
      { home, env: { DOSSIER_API_KEY: 'ds_legacy' } },
    )
    expect(legacyLink.exitCode).toBe(1)
    expect(legacyLink.stderr).toContain(
      'This Dossier deployment does not support saved values. Update the deployment.',
    )
  })

  it('keeps ordinary commands working against a legacy deployment', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    const options = { home, env: { DOSSIER_API_KEY: 'ds_legacy' } }
    const id = 'legacydoc001'
    documents.set(id, storedDocument('Legacy.html'))

    const listed = await cli('node', ['list', '--json'], options)
    expect(listed).toMatchObject({ exitCode: 0, stderr: '' })
    expect(JSON.parse(listed.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id,
          stateful: false,
          stateRevision: null,
          stateUpdatedAt: null,
        }),
      ]),
    )

    const tree = await cli('node', ['tree', id], options)
    expect(tree).toMatchObject({ exitCode: 0, stderr: '' })
    expect(tree.stdout).toContain('Legacy')

    const file = join(home, 'legacy-ordinary.html')
    await writeFile(file, statefulHtml('Legacy ordinary upload'), 'utf8')
    const uploaded = await cli(
      'node',
      ['upload', file, '--new', '--json'],
      options,
    )
    expect(uploaded).toMatchObject({ exitCode: 0, stderr: '' })
    expect(JSON.parse(uploaded.stdout)).toMatchObject({
      created: true,
      stateful: false,
    })

    const beforeUploads = uploadRequests
    const stateful = await cli(
      'node',
      ['upload', file, '--stateful', '--new', '--json'],
      options,
    )
    expect(stateful.exitCode).toBe(1)
    expect(stateful.stderr).toContain(
      'This Dossier deployment does not support saved values. Update the deployment.',
    )
    expect(uploadRequests).toBe(beforeUploads)
  })

  it('keeps view-only sharing working against a legacy deployment', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set('sharelegacy2', storedDocument('Legacy View Sharing.html'))
    const options = { home, env: { DOSSIER_API_KEY: 'ds_legacy' } }
    const beforeDeltas = shareDeltas.length
    const beforeRequests = shareRequests
    const beforeHealth = healthRequests
    const viewOnlyOutput =
      'Configured: reader@example.com\n' +
      'Effective: reader@example.com\n' +
      'Permissions:\n  reader@example.com: view\n' +
      'Access source: own\n'

    const added = await cli(
      'node',
      ['share', 'sharelegacy2', '--add', 'reader@example.com'],
      options,
    )
    expect(added).toEqual({
      stdout: viewOnlyOutput,
      stderr: '',
      exitCode: 0,
    })
    expect(healthRequests).toBe(beforeHealth)

    const read = await cli('node', ['share', 'sharelegacy2'], options)
    expect(read).toEqual({
      stdout: viewOnlyOutput,
      stderr: '',
      exitCode: 0,
    })
    expect(healthRequests).toBe(beforeHealth)

    const removed = await cli(
      'node',
      ['share', 'sharelegacy2', '--remove', 'reader@example.com'],
      options,
    )
    expect(removed).toEqual({
      stdout:
        'Configured: none\nEffective: none\n' +
        'Permissions:\n  none\nAccess source: own\n',
      stderr: '',
      exitCode: 0,
    })
    expect(healthRequests).toBe(beforeHealth + 1)
    expect(shareDeltas.slice(beforeDeltas)).toEqual([
      { add: ['reader@example.com'] },
      { remove: ['reader@example.com'] },
    ])
    expect(shareRequests).toBe(beforeRequests + 3)

    const edit = await cli(
      'node',
      ['share', 'sharelegacy2', '--add', 'x', '--edit-state'],
      options,
    )
    expect(edit.exitCode).toBe(1)
    expect(edit.stderr).toContain(
      'This Dossier deployment does not support saved values. Update the deployment.',
    )
    expect(healthRequests).toBe(beforeHealth + 2)
    expect(shareRequests).toBe(beforeRequests + 3)
    expect(shareDeltas).toHaveLength(beforeDeltas + 2)
  })

  it('still removes the saving grant when a current deployment has saved values switched off', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set(
      'shareunavail',
      storedDocument('Unavailable Sharing.html', {
        stateful: true,
        stateRevision: 0,
        shares: ['person@example.com'],
        grants: [{ email: 'person@example.com', canSave: true }],
      }),
    )
    const options = { home, env: { DOSSIER_API_KEY: 'ds_unavailable' } }
    const beforeDeltas = shareDeltas.length

    const removed = await cli(
      'node',
      ['share', 'shareunavail', '--remove', 'person@example.com'],
      options,
    )
    expect(removed).toEqual({
      stdout:
        'Configured: none\nEffective: none\n' +
        'Permissions:\n  none\nAccess source: own\n',
      stderr: '',
      exitCode: 0,
    })
    expect(shareDeltas.slice(beforeDeltas)).toEqual([
      {
        remove: ['person@example.com'],
        removeGrants: ['person@example.com'],
      },
    ])
    expect(documents.get('shareunavail')?.grants).toEqual([])

    const edit = await cli(
      'node',
      ['share', 'shareunavail', '--add', 'person@example.com', '--edit-state'],
      options,
    )
    expect(edit.exitCode).toBe(1)
    expect(edit.stderr).toContain(
      'This Dossier deployment does not support saved values. Update the deployment.',
    )
    expect(shareDeltas).toHaveLength(beforeDeltas + 1)
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
    const before = shareDeltas.length
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
      grants: [],
    })
    expect(shareDeltas.slice(before)).toEqual([
      {
        add: ['one@example.com', 'two@example.com'],
        remove: ['old@example.com'],
        removeGrants: ['old@example.com'],
      },
    ])
  })

  it('reads current shares and grants without a delta', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set(
      'shareread001',
      storedDocument('Read Shares.html', {
        shares: ['reader@example.com'],
        grants: [
          { email: 'reader@example.com', canSave: true },
          { email: 'local@example.com', canSave: false },
        ],
      }),
    )
    const before = shareDeltas.length

    const result = await cli('node', ['share', 'shareread001', '--json'], {
      home,
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      configured: ['reader@example.com'],
      effective: ['reader@example.com'],
      accessSource: 'own',
      grants: [
        { email: 'reader@example.com', canSave: true },
        { email: 'local@example.com', canSave: false },
      ],
    })
    expect(shareDeltas).toHaveLength(before)
  })

  it('maps saving flags in human, JSON, and quiet modes', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set(
      'sharestate01',
      storedDocument('State Sharing.html', {
        shares: ['reader@example.com'],
      }),
    )
    const before = shareDeltas.length

    const human = await cli(
      'node',
      ['share', 'sharestate01', '--add', 'saver@example.com', '--edit-state'],
      { home },
    )
    expect(human.exitCode).toBe(0)
    expect(human.stdout).toContain('reader@example.com: view')
    expect(human.stdout).toContain('saver@example.com: view and save')

    const json = await cli(
      'node',
      [
        'share',
        'sharestate01',
        '--remove',
        'saver@example.com',
        '--edit-state',
        '--json',
      ],
      { home },
    )
    expect(json.exitCode).toBe(0)
    expect(JSON.parse(json.stdout)).toEqual({
      configured: ['reader@example.com'],
      effective: ['reader@example.com'],
      accessSource: 'own',
      grants: [{ email: 'saver@example.com', canSave: false }],
    })

    const quiet = await cli(
      'node',
      [
        'share',
        'sharestate01',
        '--add',
        'quiet@example.com',
        '--edit-state',
        '--quiet',
      ],
      { home },
    )
    expect(quiet).toEqual({ stdout: '', stderr: '', exitCode: 0 })

    const removed = await cli(
      'node',
      ['share', 'sharestate01', '--remove', 'saver@example.com', '--quiet'],
      { home },
    )
    expect(removed).toEqual({ stdout: '', stderr: '', exitCode: 0 })
    expect(shareDeltas.slice(before)).toEqual([
      { addSavers: ['saver@example.com'] },
      { removeSavers: ['saver@example.com'] },
      { addSavers: ['quiet@example.com'] },
      {
        remove: ['saver@example.com'],
        removeGrants: ['saver@example.com'],
      },
    ])
  })

  it('checks deployment support before changing saving access', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set('sharelegacy1', storedDocument('Legacy Share.html'))
    const before = shareDeltas.length

    const result = await cli(
      'node',
      [
        'share',
        'sharelegacy1',
        '--add',
        'saver@example.com',
        '--edit-state',
        '--api-url',
        apiUrl,
      ],
      { home, env: { DOSSIER_API_KEY: 'ds_legacy' } },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      'This Dossier deployment does not support saved values. Update the deployment.',
    )
    expect(shareDeltas).toHaveLength(before)
  })

  it('rejects --edit-state without an add or remove flag', async () => {
    const home = await temporaryHome()
    await authenticate(home)
    documents.set('shareusage01', storedDocument('Share Usage.html'))
    const before = shareDeltas.length
    const result = await cli(
      'node',
      ['share', 'shareusage01', '--edit-state'],
      { home },
    )
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(
      '--edit-state requires --add and/or --remove',
    )
    expect(shareDeltas).toHaveLength(before)
  })

  it('explains saving permissions in share help', async () => {
    const help = await cli('node', ['share', '--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain(
      'Grant viewing, or viewing and saving with --edit-state.',
    )
    expect(help.stdout).toContain(
      'Drop viewing and saving, or only saving with --edit-state.',
    )
    expect(help.stdout).toContain('saving never grants publishing or sharing')
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
