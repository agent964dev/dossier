import {
  AllowlistCreate,
  ApiKeyCreate,
  AssetUploadRequest,
  DocumentPatch,
  DossierApi,
  MemberRoleUpdate,
  ShareDelta,
  type DiffMode,
  ShareReplacement,
  isDocumentEditor,
  type DocumentEditor,
  UploadRequest,
} from '@dossier/contracts'
import {
  HttpApiBuilder,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from '@effect/platform'
import { Context, Effect, Layer, Schema } from 'effect'

import {
  AssetSlugTaken,
  Assets,
  CoreServicesLive,
  Db,
  Diff,
  DiffTooLarge,
  Documents,
  DossierError,
  Ids,
  PersistenceError,
  Principal,
  Publish,
  Shares,
  Tree,
  type PrincipalIdentity,
  WorkerEnv,
  Workspace,
  parseAllowlistValue,
} from '../services'
import { SystemLive } from './health'
import {
  apiErrorServerResponse,
  apiErrorWebResponse,
  bodyTooLargeResponse,
  jsonServerResponse,
  positiveInteger,
  readBoundedBody,
  requestWithBody,
  workerEnvWithOptionalRateLimiter,
  workerEnvWithoutUploadRateLimit,
} from './request'

const RestorePayload = Schema.Struct({ batchId: Schema.String })
const DisablePayload = Schema.Struct({
  reason: Schema.optional(Schema.NullOr(Schema.String)),
})

interface ApiRequestState {
  readonly principal: PrincipalIdentity
  readonly requestBytes: number
}

class ApiRequest extends Context.Tag('@dossier/web/ApiRequest')<
  ApiRequest,
  ApiRequestState
>() {}

function malformedInput(_cause?: unknown): DossierError {
  return new DossierError({
    code: 'policy_rejected',
    message: 'The request body does not match the API schema.',
  })
}

function sourceRequest(request: HttpServerRequest.HttpServerRequest): Request {
  if (request.source instanceof Request) return request.source
  throw new Error('The HTTP request is not backed by a web Request.')
}

function decodeJsonBody<A, I>(
  request: HttpServerRequest.HttpServerRequest,
  schema: Schema.Schema<A, I, never>,
): Effect.Effect<A, DossierError> {
  const source = sourceRequest(request)
  const contentType = source.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/json')) {
    return Effect.fail(malformedInput('Content-Type must be application/json.'))
  }

  return Effect.tryPromise({
    try: () => source.json() as Promise<unknown>,
    catch: malformedInput,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(schema, { onExcessProperty: 'error' })),
    Effect.mapError(malformedInput),
  )
}

function withApiErrors<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, R> {
  return effect.pipe(
    Effect.catchAll((error) => Effect.succeed(apiErrorServerResponse(error))),
  )
}

function parseLimit(
  limit: string | undefined,
): Effect.Effect<number | undefined, DossierError> {
  if (limit === undefined) return Effect.succeed(undefined)
  const parsed = Number(limit)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    return Effect.fail(
      malformedInput('limit must be an integer from 1 through 100.'),
    )
  }
  return Effect.succeed(parsed)
}

function parseTree(
  tree: string | undefined,
): Effect.Effect<boolean, DossierError> {
  if (tree === undefined) return Effect.succeed(false)
  if (tree !== '1') {
    return Effect.fail(malformedInput('tree must be 1 when supplied.'))
  }
  return Effect.succeed(true)
}

function parseForce(
  force: string | undefined,
): Effect.Effect<boolean, DossierError> {
  if (force === undefined) return Effect.succeed(false)
  if (force !== '1') {
    return Effect.fail(malformedInput('force must be 1 when supplied.'))
  }
  return Effect.succeed(true)
}

function parseDiffVersion(
  value: string | undefined,
  name: 'from' | 'to',
): Effect.Effect<number | undefined, DossierError> {
  if (value === undefined) return Effect.succeed(undefined)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return Effect.fail(
      new DossierError({
        code: 'policy_rejected',
        message: `${name} must be a positive integer version number.`,
      }),
    )
  }
  return Effect.succeed(parsed)
}

function parseDiffMode(
  value: string | undefined,
): Effect.Effect<DiffMode, DossierError> {
  if (value === undefined || value === 'html') return Effect.succeed('html')
  if (value === 'text') return Effect.succeed('text')
  return Effect.fail(
    new DossierError({
      code: 'policy_rejected',
      message: 'mode must be html or text.',
    }),
  )
}

function diffTooLargeResponse(
  error: DiffTooLarge,
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.unsafeJson(
    {
      ok: false,
      code: 'diff_too_large',
      message: error.message,
    },
    { status: 413, headers: { 'cache-control': 'no-store' } },
  )
}

const UploadsLive = HttpApiBuilder.group(DossierApi, 'uploads', (handlers) =>
  handlers.handleRaw('publish', ({ request }) =>
    withApiErrors(
      Effect.gen(function* () {
        const state = yield* ApiRequest
        const publisher = yield* Publish
        const payload = yield* decodeJsonBody(request, UploadRequest)
        const update =
          payload.documentId !== undefined ||
          (payload.draftId !== undefined && payload.draftId !== null)
        const receipt = yield* publisher.publish(payload, state.principal, {
          requestBytes: state.requestBytes,
        })
        return jsonServerResponse(receipt, update ? 200 : 201)
      }),
    ),
  ),
)

function slugTakenResponse(
  slug: string,
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.unsafeJson(
    {
      ok: false,
      code: 'slug_taken',
      message: `Asset slug ${slug} is reserved by another workspace.`,
    },
    { status: 409, headers: { 'cache-control': 'no-store' } },
  )
}

const AssetsLive = HttpApiBuilder.group(DossierApi, 'assets', (handlers) =>
  handlers
    .handleRaw('push', ({ request }) =>
      withApiErrors(
        Effect.gen(function* () {
          const state = yield* ApiRequest
          const assets = yield* Assets
          const payload = yield* decodeJsonBody(request, AssetUploadRequest)
          const result = yield* assets
            .push(payload, state.principal)
            .pipe(Effect.either)
          if (result._tag === 'Left') {
            if (result.left instanceof AssetSlugTaken) {
              return slugTakenResponse(result.left.slug)
            }
            return yield* Effect.fail(result.left)
          }
          return jsonServerResponse(result.right)
        }),
      ),
    )
    .handleRaw('list', () =>
      withApiErrors(
        Effect.gen(function* () {
          const state = yield* ApiRequest
          const assets = yield* Assets
          return jsonServerResponse({
            ok: true,
            assets: yield* assets.list(state.principal),
          })
        }),
      ),
    )
    .handleRaw('delete', ({ path }) =>
      withApiErrors(
        Effect.gen(function* () {
          const state = yield* ApiRequest
          const assets = yield* Assets
          yield* assets.delete(path.slug, state.principal)
          return jsonServerResponse({ ok: true })
        }),
      ),
    ),
)

const DocumentsLive = HttpApiBuilder.group(
  DossierApi,
  'documents',
  (handlers) =>
    handlers
      .handleRaw('get', ({ path }) =>
        withApiErrors(
          Effect.gen(function* () {
            const state = yield* ApiRequest
            const documents = yield* Documents
            const result = yield* documents.get(path.id, state.principal)
            return jsonServerResponse({ ok: true, ...result })
          }),
        ),
      )
      .handleRaw('diff', ({ path, urlParams }) =>
        withApiErrors(
          Effect.gen(function* () {
            const state = yield* ApiRequest
            const diffs = yield* Diff
            const from = yield* parseDiffVersion(urlParams.from, 'from')
            const to = yield* parseDiffVersion(urlParams.to, 'to')
            const mode = yield* parseDiffMode(urlParams.mode)
            const result = yield* diffs
              .compare(
                path.id,
                {
                  ...(from === undefined ? {} : { from }),
                  ...(to === undefined ? {} : { to }),
                  mode,
                },
                state.principal,
              )
              .pipe(Effect.either)
            if (result._tag === 'Left') {
              if (result.left instanceof DiffTooLarge) {
                return diffTooLargeResponse(result.left)
              }
              return yield* Effect.fail(result.left)
            }
            return jsonServerResponse(result.right)
          }),
        ),
      )
      .handleRaw('list', ({ urlParams }) =>
        withApiErrors(
          Effect.gen(function* () {
            const state = yield* ApiRequest
            const documents = yield* Documents
            const tree = yield* parseTree(urlParams.tree)
            const limit = yield* parseLimit(urlParams.limit)
            const result = yield* documents.list(
              {
                ...(tree ? { tree: true } : {}),
                ...(urlParams.scope === undefined
                  ? {}
                  : { scope: urlParams.scope }),
                ...(limit === undefined ? {} : { limit }),
                ...(urlParams.cursor === undefined
                  ? {}
                  : { cursor: urlParams.cursor }),
                ...(urlParams.parent === undefined
                  ? {}
                  : {
                      parent:
                        urlParams.parent === 'root' ? null : urlParams.parent,
                    }),
              },
              state.principal,
            )
            return jsonServerResponse(result)
          }),
        ),
      )
      .handleRaw('tree', ({ path }) =>
        withApiErrors(
          Effect.gen(function* () {
            const state = yield* ApiRequest
            const tree = yield* Tree
            return jsonServerResponse(yield* tree.get(path.id, state.principal))
          }),
        ),
      )
      .handleRaw('patch', ({ path, request }) =>
        withApiErrors(
          Effect.gen(function* () {
            const state = yield* ApiRequest
            const tree = yield* Tree
            const payload = yield* decodeJsonBody(request, DocumentPatch)
            const document = yield* tree.patch(
              path.id,
              payload,
              state.principal,
            )
            return jsonServerResponse({ ok: true, document })
          }),
        ),
      )
      .handleRaw('sharesGet', ({ path }) =>
        withApiErrors(
          Effect.gen(function* () {
            const state = yield* ApiRequest
            const shares = yield* Shares
            return jsonServerResponse(
              yield* shares.get(path.id, state.principal),
            )
          }),
        ),
      )
      .handleRaw('sharesDelta', ({ path, request }) =>
        withApiErrors(
          Effect.gen(function* () {
            const state = yield* ApiRequest
            const shares = yield* Shares
            const payload = yield* decodeJsonBody(request, ShareDelta)
            return jsonServerResponse(
              yield* shares.delta(path.id, payload, state.principal),
            )
          }),
        ),
      )
      .handleRaw('sharesPut', ({ path, request }) =>
        withApiErrors(
          Effect.gen(function* () {
            const state = yield* ApiRequest
            const shares = yield* Shares
            const payload = yield* decodeJsonBody(request, ShareReplacement)
            return jsonServerResponse(
              yield* shares.replace(path.id, payload, state.principal),
            )
          }),
        ),
      )
      .handleRaw('delete', ({ path, urlParams }) =>
        withApiErrors(
          Effect.gen(function* () {
            const state = yield* ApiRequest
            const documents = yield* Documents
            const force = yield* parseForce(urlParams.force)
            return jsonServerResponse(
              yield* documents.delete(path.id, state.principal, force),
            )
          }),
        ),
      )
      .handleRaw('restore', ({ path, request }) =>
        withApiErrors(
          Effect.gen(function* () {
            const state = yield* ApiRequest
            const documents = yield* Documents
            const payload = yield* decodeJsonBody(request, RestorePayload)
            const document = yield* documents.restore(
              path.id,
              payload.batchId,
              state.principal,
            )
            return jsonServerResponse({ ok: true, document })
          }),
        ),
      )
      .handleRaw('disable', ({ path, request }) =>
        withApiErrors(
          Effect.gen(function* () {
            const state = yield* ApiRequest
            const documents = yield* Documents
            const payload = yield* decodeJsonBody(request, DisablePayload)
            const document = yield* documents.disable(
              path.id,
              state.principal,
              payload.reason,
            )
            return jsonServerResponse({ ok: true, document })
          }),
        ),
      )
      .handleRaw('enable', ({ path }) =>
        withApiErrors(
          Effect.gen(function* () {
            const state = yield* ApiRequest
            const documents = yield* Documents
            const document = yield* documents.enable(path.id, state.principal)
            return jsonServerResponse({ ok: true, document })
          }),
        ),
      ),
)

interface ApiKeyRow {
  readonly id: string
  readonly name: string
  readonly workspace_id: string
  readonly created_at: string
  readonly last_used_at: string | null
  readonly revoked_at: string | null
}

function apiKeyDto(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }
}

const KeysLive = HttpApiBuilder.group(DossierApi, 'keys', (handlers) =>
  handlers
    .handleRaw('create', ({ request }) =>
      withApiErrors(
        Effect.gen(function* () {
          const state = yield* ApiRequest
          const principals = yield* Principal
          const db = yield* Db
          const ids = yield* Ids
          yield* principals.requirePublisher(state.principal)
          const payload = yield* decodeJsonBody(request, ApiKeyCreate)

          const token = ids.apiToken()
          const row: ApiKeyRow = {
            id: ids.internalId('key_'),
            name: payload.name.trim() || 'CLI API Key',
            workspace_id: state.principal.workspaceId,
            created_at: new Date().toISOString(),
            last_used_at: null,
            revoked_at: null,
          }
          const hash = yield* ids.sha256Hex(token)
          yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `INSERT INTO api_keys
                     (id, account_id, workspace_id, name, key_hash, created_at,
                      last_used_at, revoked_at)
                   VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
                )
                .bind(
                  row.id,
                  state.principal.accountId,
                  row.workspace_id,
                  row.name,
                  hash,
                  row.created_at,
                )
                .run(),
            catch: (cause) =>
              new PersistenceError({ operation: 'create API key', cause }),
          })
          return jsonServerResponse(
            { ok: true, apiKey: apiKeyDto(row), token },
            201,
          )
        }),
      ),
    )
    .handleRaw('list', () =>
      withApiErrors(
        Effect.gen(function* () {
          const state = yield* ApiRequest
          const db = yield* Db
          const rows = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `SELECT id, name, workspace_id, created_at, last_used_at, revoked_at
                     FROM api_keys
                    WHERE account_id = ? AND workspace_id = ?
                    ORDER BY created_at DESC, id DESC`,
                )
                .bind(state.principal.accountId, state.principal.workspaceId)
                .all<ApiKeyRow>(),
            catch: (cause) =>
              new PersistenceError({ operation: 'list API keys', cause }),
          })
          return jsonServerResponse({
            ok: true,
            apiKeys: rows.results.map(apiKeyDto),
          })
        }),
      ),
    )
    .handleRaw('revoke', ({ path }) =>
      withApiErrors(
        Effect.gen(function* () {
          const state = yield* ApiRequest
          const db = yield* Db
          // Self-revocation remains available after membership removal.
          const result = yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `UPDATE api_keys
                      SET revoked_at = ?
                    WHERE id = ? AND account_id = ? AND workspace_id = ?
                      AND revoked_at IS NULL`,
                )
                .bind(
                  new Date().toISOString(),
                  path.id,
                  state.principal.accountId,
                  state.principal.workspaceId,
                )
                .run(),
            catch: (cause) =>
              new PersistenceError({ operation: 'revoke API key', cause }),
          })
          if (result.meta.changes === 0) {
            return yield* Effect.fail(
              new DossierError({
                code: 'not_found',
                message: 'API key not found.',
              }),
            )
          }
          return jsonServerResponse({ ok: true })
        }),
      ),
    ),
)

const WorkspaceLive = HttpApiBuilder.group(
  DossierApi,
  'workspace',
  (handlers) =>
    handlers
      .handleRaw('get', () =>
        withApiErrors(
          Effect.gen(function* () {
            const { principal } = yield* ApiRequest
            const workspace = yield* Workspace
            return jsonServerResponse(yield* workspace.get(principal))
          }),
        ),
      )
      .handleRaw('addAllowlistEntry', ({ request }) =>
        withApiErrors(
          Effect.gen(function* () {
            const { principal } = yield* ApiRequest
            const workspace = yield* Workspace
            const payload = yield* decodeJsonBody(request, AllowlistCreate)
            // The CLI sends bare domains with an explicit kind. Reconstruct the
            // browser syntax for shared validation; mismatches are HTTP 422.
            const parsed = parseAllowlistValue(
              payload.kind === 'domain'
                ? `@${payload.value.trim()}`
                : payload.value,
            )
            if (parsed === null || parsed.kind !== payload.kind) {
              return yield* Effect.fail(
                new DossierError({
                  code: 'policy_rejected',
                  message:
                    'Enter one email address, or a domain matching the supplied kind.',
                }),
              )
            }
            return jsonServerResponse(
              yield* workspace.addAllowlistEntry(principal, {
                ...parsed,
                role: payload.role,
              }),
            )
          }),
        ),
      )
      .handleRaw('removeAllowlistEntry', ({ path }) =>
        withApiErrors(
          Effect.gen(function* () {
            const { principal } = yield* ApiRequest
            const workspace = yield* Workspace
            return jsonServerResponse(
              yield* workspace.removeAllowlistEntry(principal, path.id),
            )
          }),
        ),
      )
      .handleRaw('setMemberRole', ({ path, request }) =>
        withApiErrors(
          Effect.gen(function* () {
            const { principal } = yield* ApiRequest
            const workspace = yield* Workspace
            const payload = yield* decodeJsonBody(request, MemberRoleUpdate)
            return jsonServerResponse(
              yield* workspace.setMemberRole(
                principal,
                path.accountId,
                payload.role,
              ),
            )
          }),
        ),
      )
      .handleRaw('removeMember', ({ path }) =>
        withApiErrors(
          Effect.gen(function* () {
            const { principal } = yield* ApiRequest
            const workspace = yield* Workspace
            return jsonServerResponse(
              yield* workspace.removeMember(principal, path.accountId),
            )
          }),
        ),
      ),
)

const MeLive = HttpApiBuilder.group(DossierApi, 'me', (handlers) =>
  handlers.handleRaw('get', () =>
    Effect.gen(function* () {
      const { principal } = yield* ApiRequest
      return jsonServerResponse({
        accountId: principal.accountId,
        accountName: principal.accountName,
        apiKeyId: principal.apiKeyId ?? null,
        apiKeyName: principal.apiKeyName ?? null,
        workspace: {
          id: principal.workspaceId,
          slug: principal.workspaceSlug,
          kind: principal.workspaceKind,
          role: principal.role,
        },
        email: principal.verifiedEmails[0] ?? null,
      })
    }),
  ),
)

interface LatestVersionRow {
  readonly id: string
  readonly latest_version_at: string | null
}

function legacyDraft(document: DocumentEditor, latestVersionAt: string | null) {
  return {
    draftId: document.id,
    id: document.id,
    title: document.title,
    description: document.description,
    repoOrg: null,
    repoName: null,
    repoHost: null,
    latestVersionNumber: document.latestVersionNumber,
    version: document.latestVersionNumber,
    versionCount: document.versionCount,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    latestVersionAt,
    disabled: document.disabled,
    publicUrl: document.url,
    url: document.url,
    rawUrl: document.rawUrl,
  }
}

const LegacyLive = HttpApiBuilder.group(DossierApi, 'legacy', (handlers) =>
  handlers.handleRaw('drafts', () =>
    withApiErrors(
      Effect.gen(function* () {
        const state = yield* ApiRequest
        const documents = yield* Documents
        const db = yield* Db
        const owned: DocumentEditor[] = []
        let cursor: string | undefined
        do {
          const page = yield* documents.list(
            { scope: 'mine', limit: 100, ...(cursor ? { cursor } : {}) },
            state.principal,
          )
          owned.push(...page.documents.filter(isDocumentEditor))
          cursor = page.nextCursor ?? undefined
        } while (cursor !== undefined)

        const latestRows = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT d.id, v.created_at AS latest_version_at
                   FROM documents d
              LEFT JOIN document_versions v ON v.id = d.current_version_id
                  WHERE d.workspace_id = ? AND d.created_by = ?
                    AND d.deleted_at IS NULL`,
              )
              .bind(state.principal.workspaceId, state.principal.accountId)
              .all<LatestVersionRow>(),
          catch: (cause) =>
            new PersistenceError({
              operation: 'load legacy draft versions',
              cause,
            }),
        })
        const latestById = new Map(
          latestRows.results.map((row) => [row.id, row.latest_version_at]),
        )
        return jsonServerResponse({
          ok: true,
          drafts: owned.map((document) =>
            legacyDraft(document, latestById.get(document.id) ?? null),
          ),
        })
      }),
    ),
  ),
)

const GroupsLive = Layer.mergeAll(
  SystemLive,
  UploadsLive,
  AssetsLive,
  DocumentsLive,
  KeysLive,
  WorkspaceLive,
  MeLive,
  LegacyLive,
)
const ApiLive = HttpApiBuilder.api(DossierApi).pipe(Layer.provide(GroupsLive))

function isProtectedApi(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

function isPublicSystemRoute(pathname: string): boolean {
  return pathname === '/api/healthz' || pathname === '/api/policy/check'
}

function bearerSupplied(request: Request): boolean {
  const authorization = request.headers.get('authorization')
  return authorization !== null && /^Bearer\s+\S+$/i.test(authorization)
}

function canonicalKeyRevokeRequest(request: Request): Request {
  const url = new URL(request.url)
  const match = /^\/api\/api-keys\/([^/]+)\/revoke$/.exec(url.pathname)
  if (!match) return request
  url.pathname = `/api/api-keys/${match[1]}`
  return new Request(url, request)
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'no-store')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function malformedDecodeResponse(): Response {
  return HttpServerResponse.toWeb(
    apiErrorServerResponse(
      malformedInput('A path, query parameter, or request body was malformed.'),
    ),
  )
}

export async function handleProtectedApiRequest(
  input: Request,
  rawEnv: Cloudflare.Env,
): Promise<Response> {
  const pathname = new URL(input.url).pathname
  if (!isProtectedApi(pathname) || isPublicSystemRoute(pathname)) {
    return new Response('Not found', { status: 404 })
  }
  if (!bearerSupplied(input)) {
    return apiErrorWebResponse(
      new DossierError({
        code: 'unauthenticated',
        message: 'A valid Bearer API key is required.',
      }),
    )
  }

  const env = workerEnvWithOptionalRateLimiter(rawEnv)
  const AuthWorkerEnvLive = Layer.succeed(WorkerEnv, env)
  const AuthCoreLive = CoreServicesLive.pipe(
    Layer.provideMerge(AuthWorkerEnvLive),
  )
  const principalResult = await Effect.runPromise(
    Effect.gen(function* () {
      const principals = yield* Principal
      return yield* principals.resolve(input)
    }).pipe(Effect.either, Effect.provide(AuthCoreLive)),
  )
  if (principalResult._tag === 'Left') {
    return apiErrorWebResponse(principalResult.left)
  }

  const uploadRequest = pathname === '/api/uploads'
  const assetMutation =
    (pathname === '/api/assets' && input.method === 'POST') ||
    (/^\/api\/assets\/[^/]+$/.test(pathname) && input.method === 'DELETE')
  if (uploadRequest || assetMutation) {
    const publisherResult = await Effect.runPromise(
      Effect.gen(function* () {
        const principals = yield* Principal
        yield* principals.requirePublisher(principalResult.right)
      }).pipe(Effect.either, Effect.provide(AuthCoreLive)),
    )
    if (publisherResult._tag === 'Left') {
      return apiErrorWebResponse(publisherResult.left)
    }

    const limiter = (rawEnv as Partial<Cloudflare.Env>).UPLOAD_RATE_LIMITER
    if (limiter !== undefined) {
      try {
        const outcome = await limiter.limit({
          key:
            principalResult.right.apiKeyId ?? principalResult.right.accountId,
        })
        if (!outcome.success) {
          return apiErrorWebResponse(
            new DossierError({
              code: 'rate_limited',
              message: 'Upload rate limit exceeded.',
              retryAfter: 60,
            }),
          )
        }
      } catch (cause) {
        return apiErrorWebResponse(
          new PersistenceError({
            operation: 'check upload rate limit',
            cause,
          }),
        )
      }
    }
  }

  let request = canonicalKeyRevokeRequest(input)
  let requestBytes = 0
  if (!['GET', 'HEAD'].includes(request.method)) {
    const maxBytes = positiveInteger(env.MAX_REQUEST_BYTES, 'MAX_REQUEST_BYTES')
    const body = await readBoundedBody(request, maxBytes)
    if (body === null) return bodyTooLargeResponse(maxBytes)
    requestBytes = body.byteLength
    request = requestWithBody(request, body)
  }

  const handlerEnv = uploadRequest ? workerEnvWithoutUploadRateLimit(env) : env
  const HandlerWorkerEnvLive = Layer.succeed(WorkerEnv, handlerEnv)
  const HandlerCoreLive = CoreServicesLive.pipe(
    Layer.provideMerge(HandlerWorkerEnvLive),
  )
  const RequestLive = Layer.succeed(ApiRequest, {
    principal: principalResult.right,
    requestBytes,
  })
  const RequestApiLive = ApiLive.pipe(
    Layer.provide(Layer.mergeAll(HandlerCoreLive, RequestLive)),
  )
  const { dispose, handler } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(RequestApiLive, HttpServer.layerContext),
  )

  try {
    const response = await handler(request)
    if (response.status === 400) return malformedDecodeResponse()
    return withNoStore(response)
  } finally {
    await dispose()
  }
}
