import { StateChange } from '@dossier/contracts'
import { Effect, Schema } from 'effect'

import {
  Access,
  Db,
  DossierError,
  PersistenceError,
  Principal,
  Session,
  SessionError,
  State,
  WorkerEnv,
  apiError,
  errorResponse,
  type StateActor,
  type StateSnapshot,
} from '../services'
import { issueCsrfToken, verifyCsrf } from '../server/csrf'
import { positiveInteger, readBoundedBody, stateRateLimiter } from './request'

const StateSurfaceSaveRequest = Schema.Struct({
  version: Schema.Number.pipe(Schema.int(), Schema.positive()),
  changes: Schema.Array(StateChange),
})

type StateSurfaceSaveRequest = typeof StateSurfaceSaveRequest.Type

interface StateSurfaceRow {
  readonly title: string
  readonly workspace_id: string
  readonly version_number: number
  readonly state_fields_json: string | null
}

export interface StateSurfaceData {
  readonly mode: 'account' | 'link' | 'public'
  readonly snapshot: StateSnapshot
  readonly frameTicket: string
  readonly frameVersion: number
  readonly frameHasRuntime: boolean
  readonly title: string
  readonly csrfToken?: string
}

function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      code: 'method_not_allowed',
      message: 'Use GET or POST for this saved-values surface.',
    }),
    {
      status: 405,
      headers: {
        allow: 'GET, POST',
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    },
  )
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  })
}

function malformedInput(): DossierError {
  return apiError(
    'policy_rejected',
    'The request body does not match the API schema.',
  )
}

function resolveActor(
  request: Request,
  documentId: string,
  acceptEditToken: boolean,
): Effect.Effect<
  StateActor,
  DossierError | PersistenceError,
  Principal | State
> {
  return Effect.gen(function* () {
    const editToken = acceptEditToken
      ? request.headers.get('x-dossier-edit-token')
      : null
    if (editToken !== null) {
      const state = yield* State
      return yield* state.resolveEditToken(documentId, editToken)
    }

    const principals = yield* Principal
    const principalResult = yield* principals
      .resolveSession(request)
      .pipe(Effect.either)
    if (
      principalResult._tag === 'Left' &&
      principalResult.left instanceof PersistenceError
    ) {
      return yield* Effect.fail(principalResult.left)
    }
    return principalResult._tag === 'Right'
      ? { kind: 'account', principal: principalResult.right }
      : { kind: 'public' }
  })
}

function pinnedVersion(
  request: Request,
): Effect.Effect<number | undefined, DossierError> {
  const value = new URL(request.url).searchParams.get('version')
  if (value === null) return Effect.succeed(undefined)
  if (!/^[1-9][0-9]*$/.test(value)) {
    return Effect.fail(apiError('not_found', 'Document version not found.'))
  }
  const version = Number(value)
  return Number.isSafeInteger(version)
    ? Effect.succeed(version)
    : Effect.fail(apiError('not_found', 'Document version not found.'))
}

function decodeSaveRequest(
  request: Request,
): Effect.Effect<StateSurfaceSaveRequest, DossierError, WorkerEnv> {
  return Effect.gen(function* () {
    const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.startsWith('application/json')) {
      return yield* Effect.fail(malformedInput())
    }

    const env = yield* WorkerEnv
    const maxBytes = positiveInteger(env.MAX_REQUEST_BYTES, 'MAX_REQUEST_BYTES')
    const body = yield* Effect.tryPromise({
      try: () => readBoundedBody(request, maxBytes),
      catch: malformedInput,
    })
    if (body === null) {
      return yield* Effect.fail(
        apiError(
          'body_too_large',
          `Request body exceeds the ${maxBytes} byte limit.`,
        ),
      )
    }

    const decoded = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(body)) as unknown,
      catch: malformedInput,
    })
    return yield* Schema.decodeUnknown(StateSurfaceSaveRequest, {
      onExcessProperty: 'error',
    })(decoded).pipe(Effect.mapError(malformedInput))
  })
}

function checkStateRateLimit(
  documentId: string,
  actor: Exclude<StateActor, { readonly kind: 'public' }>,
): Effect.Effect<void, DossierError, WorkerEnv> {
  return Effect.gen(function* () {
    const env = yield* WorkerEnv
    const limiter = stateRateLimiter(env)
    if (limiter === undefined) {
      return yield* Effect.fail(
        apiError(
          'state_unavailable',
          'Saved values are temporarily unavailable.',
        ),
      )
    }

    const actorKey =
      actor.kind === 'account'
        ? `account:${actor.principal.accountId}`
        : `link:${actor.generation}`
    const outcome = yield* Effect.tryPromise({
      try: () => limiter.limit({ key: `document:${documentId}:${actorKey}` }),
      catch: () =>
        apiError(
          'state_unavailable',
          'Saved values are temporarily unavailable.',
        ),
    })
    if (!outcome.success) {
      return yield* Effect.fail(
        new DossierError({
          code: 'rate_limited',
          message: 'State rate limit exceeded.',
          retryAfter: 60,
        }),
      )
    }
  })
}

function loadStateSurfaceForActor(
  documentId: string,
  version: number | undefined,
  actor: StateActor,
): Effect.Effect<
  StateSurfaceData,
  DossierError | PersistenceError | SessionError,
  Access | Db | Session | State
> {
  return Effect.gen(function* () {
    const state = yield* State
    const snapshot = yield* state.read(documentId, actor, version)
    const decision =
      actor.kind === 'link'
        ? null
        : yield* (yield* Access).requireReadable(
            documentId,
            actor.kind === 'account' ? actor.principal : null,
          )
    const frameVersion = version ?? snapshot.version
    const db = yield* Db
    const row = yield* Effect.tryPromise({
      try: () =>
        db.raw
          .prepare(
            `SELECT d.title, d.workspace_id, v.version_number,
                    v.state_fields_json
               FROM documents d
               JOIN document_versions v
                 ON v.document_id = d.id AND v.version_number = ?
              WHERE d.id = ? AND d.deleted_at IS NULL
                AND d.disabled_at IS NULL AND d.stateful = 1
              LIMIT 1`,
          )
          .bind(frameVersion, documentId)
          .first<StateSurfaceRow>(),
      catch: (cause) =>
        new PersistenceError({
          operation: 'load saved-values browser surface',
          cause,
        }),
    })
    if (
      !row ||
      (decision !== null && row.workspace_id !== decision.workspaceId)
    ) {
      return yield* Effect.fail(apiError('not_found', 'Document not found.'))
    }

    const frameTicket = yield* state.issueFrameTicket(
      documentId,
      row.workspace_id,
      row.version_number,
      actor,
    )
    const csrfToken =
      actor.kind === 'account'
        ? yield* issueCsrfToken(actor.principal.accountId)
        : undefined
    return {
      mode: actor.kind,
      snapshot,
      frameTicket,
      frameVersion: row.version_number,
      frameHasRuntime: row.state_fields_json !== null,
      title: row.title,
      ...(csrfToken === undefined ? {} : { csrfToken }),
    }
  })
}

export function loadStateSurface(
  request: Request,
  documentId: string,
  requestedVersion?: number,
): Effect.Effect<
  StateSurfaceData,
  DossierError | PersistenceError | SessionError,
  Access | Db | Principal | Session | State
> {
  return Effect.gen(function* () {
    const actor = yield* resolveActor(request, documentId, false)
    return yield* loadStateSurfaceForActor(documentId, requestedVersion, actor)
  })
}

function getStateSurface(
  request: Request,
  documentId: string,
): Effect.Effect<
  Response,
  DossierError | PersistenceError | SessionError,
  Access | Db | Principal | Session | State | WorkerEnv
> {
  return Effect.gen(function* () {
    const version = yield* pinnedVersion(request)
    const actor = yield* resolveActor(request, documentId, true)
    if (actor.kind !== 'public') {
      yield* checkStateRateLimit(documentId, actor)
    }
    const surface = yield* loadStateSurfaceForActor(documentId, version, actor)
    return jsonResponse({
      ...surface.snapshot,
      title: surface.title,
      frameTicket: surface.frameTicket,
      frameVersion: surface.frameVersion,
      frameHasRuntime: surface.frameHasRuntime,
      ...(surface.csrfToken === undefined
        ? {}
        : { csrfToken: surface.csrfToken }),
    })
  })
}

function postStateSurface(
  request: Request,
  documentId: string,
): Effect.Effect<
  Response,
  DossierError | PersistenceError,
  Principal | Session | State | WorkerEnv
> {
  return Effect.gen(function* () {
    const actor = yield* resolveActor(request, documentId, true)
    if (actor.kind === 'public') {
      return yield* Effect.fail(
        apiError('state_edit_required', 'State edit access is required.'),
      )
    }

    if (actor.kind === 'account') {
      yield* verifyCsrf({
        request,
        token: request.headers.get('x-dossier-csrf'),
        accountId: actor.principal.accountId,
      }).pipe(
        Effect.mapError(() =>
          apiError('state_edit_required', 'State edit access is required.'),
        ),
      )
    }
    yield* checkStateRateLimit(documentId, actor)
    const payload = yield* decodeSaveRequest(request)
    const state = yield* State
    const snapshot = yield* state.save(documentId, actor, payload)
    return jsonResponse(snapshot)
  })
}

export function handleStateSurface(
  request: Request,
  documentId: string,
): Effect.Effect<
  Response,
  PersistenceError | SessionError,
  Access | Db | Principal | Session | State | WorkerEnv
> {
  if (request.method === 'GET') {
    return getStateSurface(request, documentId).pipe(
      Effect.catchIf(
        (error): error is DossierError => error instanceof DossierError,
        (error) => Effect.succeed(errorResponse(error)),
      ),
    )
  }
  if (request.method === 'POST') {
    return postStateSurface(request, documentId).pipe(
      Effect.catchIf(
        (error): error is DossierError => error instanceof DossierError,
        (error) => Effect.succeed(errorResponse(error)),
      ),
    )
  }
  return Effect.succeed(methodNotAllowed())
}
