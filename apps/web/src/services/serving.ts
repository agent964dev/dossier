import { Context, Effect, Layer } from 'effect'

import { Access } from './access'
import { Db } from './db'
import { WorkerEnv } from './env'
import { DossierError, errorResponse, PersistenceError, StorageError } from './errors'
import { Objects } from './objects'
import { Principal } from './principal'

interface ServingTarget {
  readonly documentId: string
  readonly versionNumber?: number
  readonly raw: boolean
}

interface ServingRow {
  document_id: string
  version_number: number
  object_key: string
  file_size: number
}

function hosts(value: string, protocol = 'https:'): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return new URL(entry.includes('://') ? entry : `${protocol}//${entry}`).origin
      } catch {
        return entry
      }
    })
}

export function servingCsp(env: Cloudflare.Env): string {
  const origin = new URL(env.PUBLIC_BASE_URL).origin
  const styles = [...new Set([origin, ...hosts(env.STYLE_HOST_ALLOWLIST)])]
  const scripts = hosts(env.SCRIPT_HOST_ALLOWLIST)
  const frames = [...new Set([origin, ...hosts(env.EMBED_HOST_ALLOWLIST)])]
  return [
    `default-src 'none'`,
    `script-src 'unsafe-inline'${scripts.length ? ` ${scripts.join(' ')}` : ''}`,
    `script-src-attr 'none'`,
    `style-src 'unsafe-inline' ${styles.join(' ')}`,
    `font-src ${styles.join(' ')}`,
    `img-src https: data:`,
    `connect-src 'none'`,
    `worker-src 'none'`,
    `frame-src ${frames.join(' ')}`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`,
  ].join('; ')
}

export function parseServingPath(pathname: string): ServingTarget | null {
  const match = /^\/d\/([a-z0-9]{12})(?:\/v\/([1-9][0-9]*))?(\/raw)?$/.exec(
    pathname,
  )
  if (!match) return null
  return {
    documentId: match[1],
    ...(match[2] ? { versionNumber: Number(match[2]) } : {}),
    raw: Boolean(match[3]),
  }
}

function securityHeaders(env: Cloudflare.Env): Headers {
  return new Headers({
    'cache-control': 'no-store',
    'content-security-policy': servingCsp(env),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
}

function notFound(env: Cloudflare.Env): Response {
  const headers = securityHeaders(env)
  headers.set('content-type', 'text/html; charset=utf-8')
  return new Response(
    '<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>Not found</h1></body></html>',
    { status: 404, headers },
  )
}

export interface ServingService {
  readonly serve: (
    request: Request,
  ) => Effect.Effect<Response, PersistenceError | StorageError>
}

export class Serving extends Context.Tag('@dossier/web/Serving')<
  Serving,
  ServingService
>() {}

export const ServingLive = Layer.effect(
  Serving,
  Effect.gen(function* () {
    const db = yield* Db
    const objects = yield* Objects
    const env = yield* WorkerEnv
    const principals = yield* Principal
    const access = yield* Access

    const serve: ServingService['serve'] = (request) =>
      Effect.gen(function* () {
        if (request.method !== 'GET' && request.method !== 'HEAD') return notFound(env)
        const target = parseServingPath(new URL(request.url).pathname)
        if (!target) return notFound(env)

        const authorization = request.headers.get('authorization')
        const bearerSupplied =
          authorization !== null && /^Bearer(?:\s|$)/i.test(authorization)
        const principalResult = yield* principals.resolve(request).pipe(Effect.either)
        if (principalResult._tag === 'Left') {
          const error = principalResult.left
          if (
            bearerSupplied &&
            error instanceof DossierError &&
            error.code === 'unauthenticated'
          ) {
            return errorResponse(error)
          }
          return notFound(env)
        }
        const canRead = yield* access.canReadContent(
          target.documentId,
          principalResult.right,
        )
        if (!canRead) return notFound(env)

        const row = yield* Effect.tryPromise({
          try: () => {
            if (target.versionNumber !== undefined) {
              return db.raw
                .prepare(
                  `SELECT document_id, version_number, object_key, file_size
                     FROM document_versions
                    WHERE document_id = ? AND version_number = ?
                    LIMIT 1`,
                )
                .bind(target.documentId, target.versionNumber)
                .first<ServingRow>()
            }
            return db.raw
              .prepare(
                `SELECT v.document_id, v.version_number, v.object_key, v.file_size
                   FROM documents d
                   JOIN document_versions v ON v.id = d.current_version_id
                  WHERE d.id = ?
                  LIMIT 1`,
              )
              .bind(target.documentId)
              .first<ServingRow>()
          },
          catch: (cause) =>
            new PersistenceError({ operation: 'load served document version', cause }),
        })
        if (!row) return notFound(env)

        const object = request.method === 'HEAD'
          ? yield* objects.head(row.object_key)
          : yield* objects.get(row.object_key)
        if (!object) return notFound(env)

        const responseHeaders = securityHeaders(env)
        responseHeaders.set(
          'content-type',
          target.raw ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8',
        )
        responseHeaders.set('content-length', String(row.file_size))
        responseHeaders.set('x-dossier-document-id', row.document_id)
        responseHeaders.set('x-dossier-version', String(row.version_number))

        return new Response(
          request.method === 'HEAD' ? null : (object as R2ObjectBody).body,
          { status: 200, headers: responseHeaders },
        )
      })

    return { serve }
  }),
)
