import { Effect } from 'effect'

import {
  Access,
  Db,
  DossierError,
  PersistenceError,
  Principal,
  SessionError,
  State,
  apiError,
  errorResponse,
  type StateActor,
  type StateSnapshot,
} from '../services'

interface StateSurfaceRow {
  readonly title: string
  readonly workspace_id: string
  readonly version_number: number
  readonly state_fields_json: string | null
}

export interface StateSurfaceData {
  readonly mode: 'account' | 'public'
  readonly snapshot: StateSnapshot
  readonly frameTicket: string
  readonly frameVersion: number
  readonly frameHasRuntime: boolean
  readonly title: string
}

function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      code: 'method_not_allowed',
      message: 'Use GET for this saved-values surface.',
    }),
    {
      status: 405,
      headers: {
        allow: 'GET',
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

export function loadStateSurface(
  request: Request,
  documentId: string,
  requestedVersion?: number,
): Effect.Effect<
  StateSurfaceData,
  DossierError | PersistenceError | SessionError,
  Access | Db | Principal | State
> {
  return Effect.gen(function* () {
    const version = requestedVersion
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
    const actor: StateActor =
      principalResult._tag === 'Right'
        ? { kind: 'account', principal: principalResult.right }
        : { kind: 'public' }

    const state = yield* State
    const snapshot = yield* state.read(documentId, actor, version)
    const access = yield* Access
    const decision = yield* access.requireReadable(
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
    if (!row || row.workspace_id !== decision.workspaceId) {
      return yield* Effect.fail(apiError('not_found', 'Document not found.'))
    }

    const frameTicket = yield* state.issueFrameTicket(
      documentId,
      decision.workspaceId,
      row.version_number,
      actor,
    )
    return {
      mode: actor.kind === 'account' ? 'account' : 'public',
      snapshot,
      frameTicket,
      frameVersion: row.version_number,
      frameHasRuntime: row.state_fields_json !== null,
      title: row.title,
    }
  })
}

export function handleStateSurface(
  request: Request,
  documentId: string,
): Effect.Effect<
  Response,
  PersistenceError | SessionError,
  Access | Db | Principal | State
> {
  if (request.method !== 'GET') return Effect.succeed(methodNotAllowed())
  return pinnedVersion(request).pipe(
    Effect.flatMap((version) => loadStateSurface(request, documentId, version)),
    Effect.map((surface) =>
      jsonResponse({
        ...surface.snapshot,
        frameTicket: surface.frameTicket,
        frameVersion: surface.frameVersion,
        frameHasRuntime: surface.frameHasRuntime,
      }),
    ),
    Effect.catchIf(
      (error): error is DossierError => error instanceof DossierError,
      (error) => Effect.succeed(errorResponse(error)),
    ),
  )
}
