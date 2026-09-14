import { Effect, Layer } from 'effect'

import frameRuntime from '../runtime/frame-runtime.js?raw'
import {
  Access,
  CoreServicesLive,
  Db,
  DossierError,
  Objects,
  PersistenceError,
  Principal,
  Serving,
  State,
  StorageError,
  Tree,
  WorkerEnv,
  errorResponse,
  servingCsp,
} from '../services'
import { allowedOrigins } from '../server/csrf'
import { renderHubPage } from './hub'
import { workerEnvWithOptionalRateLimiter } from './request'
import { handleStateSurface, loadStateSurface } from './state-surface'
import { renderWrapperPage } from './wrapper'

interface StatefulDocumentRow {
  readonly stateful: number
}

interface FrameRow {
  readonly document_id: string
  readonly workspace_id: string
  readonly version_number: number
  readonly object_key: string
  readonly file_size: number
  readonly state_fields_json: string | null
}

function notFound(): Response {
  return new Response(
    '<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Not found</h1></body></html>',
    {
      status: 404,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      },
    },
  )
}

function internalServingError(error: unknown): Response {
  if (error instanceof PersistenceError || error instanceof StorageError) {
    console.error(`Dossier ${error.operation} failed`, error.cause)
  } else {
    console.error('Dossier serving request failed', error)
  }
  return new Response(
    '<!doctype html><html><head><meta charset="utf-8"><title>Error</title></head><body><h1>Request failed</h1></body></html>',
    {
      status: 500,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      },
    },
  )
}

function frameHeaders(
  env: Cloudflare.Env,
  request: Request,
  row: FrameRow,
): Headers {
  // Only the wrapper may frame the bytes. The origin the frame was requested
  // from counts alongside the configured one, the same rule verifyCsrf applies,
  // so a preview URL or a second local port works without configuration. An
  // attacker's page is still refused: frame-ancestors is matched against the
  // ancestors, never against the origin that served the response.
  const ancestors = allowedOrigins(env.PUBLIC_BASE_URL, request.url).join(' ')
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-security-policy': `${servingCsp(env)}; frame-ancestors ${ancestors}`,
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-dossier-document-id': row.document_id,
    'x-dossier-version': String(row.version_number),
  })
  if (row.state_fields_json === null) {
    headers.set('content-length', String(row.file_size))
  }
  return headers
}

function serveFrame(
  request: Request,
  documentId: string,
  routeVersion: number | undefined,
) {
  return Effect.gen(function* () {
    if (request.method !== 'GET') return notFound()
    const ticket = new URL(request.url).searchParams.get('t')
    if (!ticket) return notFound()

    const state = yield* State
    const claimsResult = yield* state
      .verifyFrameTicket(ticket)
      .pipe(Effect.either)
    if (claimsResult._tag === 'Left') return notFound()
    const claims = claimsResult.right
    if (
      claims.documentId !== documentId ||
      (routeVersion !== undefined && claims.version !== routeVersion)
    ) {
      return notFound()
    }

    const actorResult = yield* state
      .resolveFrameViewer(claims)
      .pipe(Effect.either)
    if (actorResult._tag === 'Left') {
      if (actorResult.left instanceof DossierError) return notFound()
      return yield* Effect.fail(actorResult.left)
    }
    const actor = actorResult.right
    if (actor.kind !== 'link') {
      const access = yield* Access
      const canRead = yield* access.canReadContent(
        documentId,
        actor.kind === 'account' ? actor.principal : null,
      )
      if (!canRead) return notFound()
    }

    const db = yield* Db
    const row = yield* Effect.tryPromise({
      try: () => {
        if (routeVersion !== undefined) {
          return db.raw
            .prepare(
              `SELECT d.id AS document_id, d.workspace_id,
                      v.version_number, v.object_key, v.file_size,
                      v.state_fields_json
                 FROM documents d
                 JOIN document_versions v
                   ON v.document_id = d.id AND v.version_number = ?
                WHERE d.id = ? AND d.deleted_at IS NULL
                  AND d.disabled_at IS NULL AND d.stateful = 1
                LIMIT 1`,
            )
            .bind(routeVersion, documentId)
            .first<FrameRow>()
        }
        return db.raw
          .prepare(
            `SELECT d.id AS document_id, d.workspace_id,
                    v.version_number, v.object_key, v.file_size,
                    v.state_fields_json
               FROM documents d
               JOIN document_versions v ON v.id = d.current_version_id
              WHERE d.id = ? AND d.deleted_at IS NULL
                AND d.disabled_at IS NULL AND d.stateful = 1
              LIMIT 1`,
          )
          .bind(documentId)
          .first<FrameRow>()
      },
      catch: (cause) =>
        new PersistenceError({ operation: 'load framed document', cause }),
    })
    if (
      !row ||
      row.workspace_id !== claims.workspaceId ||
      row.version_number !== claims.version
    ) {
      return notFound()
    }

    const objects = yield* Objects
    const object = yield* objects.get(row.object_key)
    if (!object) return notFound()
    const response = new Response((object as R2ObjectBody).body, {
      headers: frameHeaders(yield* WorkerEnv, request, row),
    })
    if (row.state_fields_json === null) return response

    let injected = false
    return new HTMLRewriter()
      .on('head', {
        element(element) {
          if (injected) return
          injected = true
          element.prepend(`<script>${frameRuntime}</script>`, { html: true })
        },
      })
      .transform(response)
  })
}

export async function handleServingRequest(
  request: Request,
  rawEnv: Cloudflare.Env,
): Promise<Response> {
  const env = workerEnvWithOptionalRateLimiter(rawEnv)
  const WorkerEnvLive = Layer.succeed(WorkerEnv, env)
  const CoreLive = CoreServicesLive.pipe(Layer.provideMerge(WorkerEnvLive))
  const pathname = new URL(request.url).pathname
  const hubMatch = /^\/d\/([a-z0-9]{12})\/tree$/.exec(pathname)
  const stateMatch = /^\/d\/([a-z0-9]{12})\/state$/.exec(pathname)
  const frameMatch = /^\/d\/([a-z0-9]{12})(?:\/v\/([1-9][0-9]*))?\/frame$/.exec(
    pathname,
  )
  const docMatch = /^\/d\/([a-z0-9]{12})(?:\/v\/([1-9][0-9]*))?$/.exec(pathname)
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      if (hubMatch) {
        const authorization = request.headers.get('authorization')
        const bearerSupplied =
          authorization !== null && /^Bearer(?:\s|$)/i.test(authorization)
        const principals = yield* Principal
        const principalResult = yield* principals
          .resolve(request)
          .pipe(Effect.either)
        if (principalResult._tag === 'Left' && bearerSupplied) {
          const error = principalResult.left
          return error instanceof DossierError &&
            error.code === 'unauthenticated'
            ? errorResponse(error)
            : notFound()
        }
        const principal =
          principalResult._tag === 'Right' ? principalResult.right : null
        const tree = yield* Tree
        const response = yield* tree
          .get(hubMatch[1], principal)
          .pipe(Effect.either)
        return response._tag === 'Right'
          ? renderHubPage(response.right)
          : notFound()
      }
      if (stateMatch) {
        return yield* handleStateSurface(request, stateMatch[1])
      }
      if (frameMatch) {
        return yield* serveFrame(
          request,
          frameMatch[1],
          frameMatch[2] === undefined ? undefined : Number(frameMatch[2]),
        )
      }
      if (docMatch && (request.method === 'GET' || request.method === 'HEAD')) {
        const db = yield* Db
        const document = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare('SELECT stateful FROM documents WHERE id = ? LIMIT 1')
              .bind(docMatch[1])
              .first<StatefulDocumentRow>(),
          catch: (cause) =>
            new PersistenceError({
              operation: 'check stateful serving route',
              cause,
            }),
        })
        if (document?.stateful === 1) {
          const version =
            docMatch[2] === undefined ? undefined : Number(docMatch[2])
          const surfaceResult = yield* loadStateSurface(
            request,
            docMatch[1],
            version,
          ).pipe(Effect.either)
          if (surfaceResult._tag === 'Left') {
            if (surfaceResult.left instanceof DossierError) return notFound()
            return yield* Effect.fail(surfaceResult.left)
          }
          const surface = surfaceResult.right
          const response = renderWrapperPage({
            mode: surface.mode,
            snapshot: surface.snapshot,
            ticket: surface.frameTicket,
            version: surface.frameVersion,
            hasRuntime: surface.frameHasRuntime,
            title: surface.title,
            pinned: version !== undefined,
          })
          return request.method === 'HEAD'
            ? new Response(null, {
                status: response.status,
                headers: response.headers,
              })
            : response
        }
      }
      const serving = yield* Serving
      return yield* serving.serve(request)
    }).pipe(Effect.either, Effect.provide(CoreLive)),
  )
  return result._tag === 'Right'
    ? result.right
    : internalServingError(result.left)
}
