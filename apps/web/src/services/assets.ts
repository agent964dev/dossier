import type {
  AssetListItem,
  AssetPushRequest,
  AssetPushResponse,
} from '@dossier/contracts'
import { validateCss } from '@dossier/policy'
import { Context, Data, Effect, Layer } from 'effect'

import { Db } from './db'
import { WorkerEnv } from './env'
import { apiError, type DossierError, PersistenceError, StorageError } from './errors'
import { Ids } from './ids'
import { Objects } from './objects'
import { Principal, type PrincipalIdentity } from './principal'

interface AssetRow {
  readonly id: string
  readonly workspace_id: string
  readonly slug: string
  readonly ext: 'css' | 'woff2'
  readonly deleted_at: string | null
}

interface AssetVersionRow {
  readonly slug: string
  readonly ext: 'css' | 'woff2'
  readonly version_number: number
}

interface AssetListRow extends AssetVersionRow {
  readonly updated_at: string
}

interface ServedAssetRow {
  readonly object_key: string
  readonly file_size: number
  readonly content_type: string
}

interface AssetTarget {
  readonly slug: string
  readonly ext: 'css' | 'woff2'
  readonly versionNumber?: number
}

export class AssetSlugTaken extends Data.TaggedError('AssetSlugTaken')<{
  readonly slug: string
}> {}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function commaSeparatedHosts(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

type Base64DecodeResult =
  | { readonly _tag: 'Decoded'; readonly bytes: Uint8Array }
  | { readonly _tag: 'Invalid' }
  | { readonly _tag: 'TooLarge'; readonly decodedLength: number }

function decodeBase64(value: string, maxBytes: number): Base64DecodeResult {
  const compact = value.replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return { _tag: 'Invalid' }

  const paddingLength = compact.length - compact.replace(/=+$/, '').length
  const unpadded = compact.slice(0, compact.length - paddingLength)
  const remainder = unpadded.length % 4
  if (remainder === 1) return { _tag: 'Invalid' }
  const expectedPadding = remainder === 0 ? 0 : 4 - remainder
  if (paddingLength !== 0 && paddingLength !== expectedPadding) {
    return { _tag: 'Invalid' }
  }

  const decodedLength = Math.floor((unpadded.length * 3) / 4)
  if (decodedLength > maxBytes) {
    return { _tag: 'TooLarge', decodedLength }
  }

  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=')
  try {
    const binary = atob(padded)
    return {
      _tag: 'Decoded',
      bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    }
  } catch {
    return { _tag: 'Invalid' }
  }
}

function isWoff2(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x77 &&
    bytes[1] === 0x4f &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x32
  )
}

function failureText(error: PersistenceError): string {
  return String(error.cause)
}

function isGuardFailure(error: PersistenceError): boolean {
  return failureText(error).includes('publication_guards_ok_check')
}

function isDefiniteRollbackFailure(error: PersistenceError): boolean {
  const text = failureText(error)
  return (
    isGuardFailure(error) ||
    /SQLITE_(?:CONSTRAINT|ABORT|ERROR|MISMATCH|TOOBIG|RANGE|NOTADB|CORRUPT|FULL|READONLY)/i.test(
      text,
    ) ||
    /(?:CHECK|FOREIGN KEY|NOT NULL|UNIQUE) constraint failed/i.test(text)
  )
}

function assetPushDto(
  row: AssetVersionRow,
  origin: string,
): AssetPushResponse {
  return {
    slug: row.slug,
    ext: row.ext,
    versionNumber: row.version_number,
    url: `${origin}/a/${row.slug}.${row.ext}`,
    pinnedUrl: `${origin}/a/${row.slug}@${row.version_number}.${row.ext}`,
  }
}

export function parseAssetPath(pathname: string): AssetTarget | null {
  const match =
    /^\/a\/([a-z0-9][a-z0-9-]{0,63})(?:@([1-9][0-9]*))?\.(css|woff2)$/.exec(
      pathname,
    )
  if (!match) return null
  return {
    slug: match[1],
    ext: match[3] as 'css' | 'woff2',
    ...(match[2] === undefined ? {} : { versionNumber: Number(match[2]) }),
  }
}

function assetHeaders(cacheControl: string): Headers {
  return new Headers({
    'access-control-allow-origin': '*',
    'cache-control': cacheControl,
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
  })
}

function assetNotFound(): Response {
  const headers = assetHeaders('no-store')
  headers.set('content-type', 'text/plain; charset=utf-8')
  return new Response('Not found', { status: 404, headers })
}

function assetListDto(row: AssetListRow, origin: string): AssetListItem {
  return {
    slug: row.slug,
    ext: row.ext,
    latestVersionNumber: row.version_number,
    url: `${origin}/a/${row.slug}.${row.ext}`,
    pinnedUrl: `${origin}/a/${row.slug}@${row.version_number}.${row.ext}`,
    updatedAt: row.updated_at,
  }
}

export interface AssetsService {
  readonly push: (
    payload: AssetPushRequest,
    principal: PrincipalIdentity,
  ) => Effect.Effect<
    AssetPushResponse,
    DossierError | PersistenceError | StorageError | AssetSlugTaken
  >
  readonly list: (
    principal: PrincipalIdentity,
  ) => Effect.Effect<readonly AssetListItem[], PersistenceError>
  readonly delete: (
    slug: string,
    principal: PrincipalIdentity,
  ) => Effect.Effect<void, DossierError | PersistenceError>
  readonly serve: (
    request: Request,
  ) => Effect.Effect<Response, PersistenceError | StorageError>
}

export class Assets extends Context.Tag('@dossier/web/Assets')<
  Assets,
  AssetsService
>() {}

export const AssetsLive = Layer.effect(
  Assets,
  Effect.gen(function* () {
    const db = yield* Db
    const objects = yield* Objects
    const ids = yield* Ids
    const env = yield* WorkerEnv
    const principals = yield* Principal
    const origin = env.PUBLIC_BASE_URL.replace(/\/$/, '')

    const loadAsset = (slug: string) =>
      Effect.tryPromise({
        try: () =>
          db.raw
            .prepare(
              `SELECT id, workspace_id, slug, ext, deleted_at
                 FROM assets WHERE slug = ? LIMIT 1`,
            )
            .bind(slug)
            .first<AssetRow>(),
        catch: (cause) =>
          new PersistenceError({ operation: 'load asset', cause }),
      })

    const push: AssetsService['push'] = (payload, principal) =>
      Effect.gen(function* () {
        yield* principals.requirePublisher(principal)

        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(payload.slug)) {
          return yield* Effect.fail(
            apiError(
              'policy_rejected',
              'Asset slug must start with a lowercase letter or digit and contain only lowercase letters, digits, and hyphens.',
            ),
          )
        }

        const maxAssetBytes = positiveInteger(
          env.MAX_ASSET_BYTES,
          'MAX_ASSET_BYTES',
        )
        const decoded = decodeBase64(payload.contentBase64, maxAssetBytes)
        if (decoded._tag === 'Invalid') {
          return yield* Effect.fail(
            apiError('policy_rejected', 'Asset contentBase64 is not valid base64.'),
          )
        }
        if (decoded._tag === 'TooLarge') {
          return yield* Effect.fail(
            apiError(
              'body_too_large',
              `Asset exceeds the ${maxAssetBytes} byte limit.`,
            ),
          )
        }
        const bytes = decoded.bytes

        if (payload.ext === 'css') {
          let css: string
          try {
            css = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          } catch {
            return yield* Effect.fail(
              apiError(
                'policy_rejected',
                'CSS asset must contain valid UTF-8.',
                { errors: ['CSS asset must contain valid UTF-8.'], warnings: [] },
              ),
            )
          }
          const policy = validateCss(css, {
            publicOrigin: env.PUBLIC_BASE_URL,
            styleHostAllowlist: commaSeparatedHosts(env.STYLE_HOST_ALLOWLIST),
          })
          if (!policy.ok) {
            return yield* Effect.fail(
              apiError(
                'policy_rejected',
                'CSS failed the dossier asset policy.',
                { errors: policy.errors, warnings: policy.warnings },
              ),
            )
          }
        } else if (!isWoff2(bytes)) {
          return yield* Effect.fail(
            apiError(
              'policy_rejected',
              'WOFF2 asset does not start with the wOF2 magic bytes.',
              {
                errors: ['WOFF2 asset does not start with the wOF2 magic bytes.'],
                warnings: [],
              },
            ),
          )
        }

        const existing = yield* loadAsset(payload.slug)
        if (existing && existing.workspace_id !== principal.workspaceId) {
          return yield* Effect.fail(new AssetSlugTaken({ slug: payload.slug }))
        }
        if (existing && existing.ext !== payload.ext) {
          return yield* Effect.fail(
            apiError(
              'conflict',
              `Asset ${payload.slug} is already reserved with extension .${existing.ext}.`,
            ),
          )
        }

        const persist = (
          target: AssetRow | null,
          allowConcurrentCreateRetry: boolean,
        ): Effect.Effect<
          AssetPushResponse,
          DossierError | PersistenceError | StorageError | AssetSlugTaken
        > =>
          Effect.gen(function* () {
            const assetId = target?.id ?? ids.internalId()
            const versionId = ids.internalId()
            const guardId = ids.internalId()
            const objectKey = `assets/${assetId}/${versionId}.${payload.ext}`
            const now = new Date().toISOString()
            const contentHash = yield* ids.sha256Hex(bytes)
            const contentType =
              payload.ext === 'css' ? 'text/css; charset=utf-8' : 'font/woff2'

            yield* objects.put(objectKey, bytes, {
              httpMetadata: { contentType },
              customMetadata: {
                assetId,
                versionId,
                contentHash,
                slug: payload.slug,
              },
            })

            const statements: D1PreparedStatement[] = []
            if (target === null) {
              statements.push(
                db.raw
                  .prepare(
                    `INSERT INTO publication_guards (id, ok)
                     VALUES (?, CASE WHEN NOT EXISTS (
                       SELECT 1 FROM assets WHERE slug = ?
                     ) AND EXISTS (
                       SELECT 1 FROM accounts actor
                       JOIN workspaces workspace ON workspace.id = ?
                  LEFT JOIN memberships publisher
                         ON publisher.workspace_id = workspace.id
                        AND publisher.account_id = actor.id
                      WHERE actor.id = ? AND actor.disabled_at IS NULL
                        AND (actor.kind = 'service' OR publisher.account_id IS NOT NULL)
                     ) THEN 1 ELSE 0 END)`,
                  )
                  .bind(
                    guardId,
                    payload.slug,
                    principal.workspaceId,
                    principal.accountId,
                  ),
                db.raw
                  .prepare(
                    `INSERT INTO assets
                       (id, workspace_id, created_by, slug, ext,
                        current_version_id, next_version_number, created_at,
                        updated_at, deleted_at)
                     VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, NULL)`,
                  )
                  .bind(
                    assetId,
                    principal.workspaceId,
                    principal.accountId,
                    payload.slug,
                    payload.ext,
                    now,
                    now,
                  ),
              )
            } else {
              statements.push(
                db.raw
                  .prepare(
                    `INSERT INTO publication_guards (id, ok)
                     VALUES (?, CASE WHEN EXISTS (
                       SELECT 1 FROM assets asset
                       JOIN accounts actor ON actor.id = ? AND actor.disabled_at IS NULL
                  LEFT JOIN memberships publisher
                         ON publisher.workspace_id = asset.workspace_id
                        AND publisher.account_id = actor.id
                      WHERE asset.id = ? AND asset.slug = ?
                        AND asset.workspace_id = ? AND asset.ext = ?
                        AND (actor.kind = 'service' OR publisher.account_id IS NOT NULL)
                     ) THEN 1 ELSE 0 END)`,
                  )
                  .bind(
                    guardId,
                    principal.accountId,
                    target.id,
                    payload.slug,
                    principal.workspaceId,
                    payload.ext,
                  ),
              )
            }

            statements.push(
              db.raw
                .prepare(
                  `UPDATE assets
                      SET next_version_number = next_version_number + 1
                    WHERE id = ?`,
                )
                .bind(assetId),
              db.raw
                .prepare(
                  `INSERT INTO asset_versions
                     (id, asset_id, version_number, object_key, content_type,
                      content_hash, file_size, created_at, created_by_api_key_id)
                   SELECT ?, id, next_version_number - 1, ?, ?, ?, ?, ?, ?
                     FROM assets WHERE id = ?`,
                )
                .bind(
                  versionId,
                  objectKey,
                  contentType,
                  contentHash,
                  bytes.byteLength,
                  now,
                  principal.apiKeyId ?? null,
                  assetId,
                ),
              db.raw
                .prepare(
                  `UPDATE assets
                      SET current_version_id = ?, updated_at = ?, deleted_at = NULL
                    WHERE id = ?`,
                )
                .bind(versionId, now, assetId),
              db.raw
                .prepare('DELETE FROM publication_guards WHERE id = ?')
                .bind(guardId),
            )

            const batchResult = yield* db.batch(statements).pipe(Effect.either)
            if (batchResult._tag === 'Left') {
              const failure = batchResult.left
              if (isDefiniteRollbackFailure(failure)) {
                yield* objects
                  .delete(objectKey)
                  .pipe(Effect.catchAll(() => Effect.void))
              }

              if (isGuardFailure(failure)) {
                if (target === null && allowConcurrentCreateRetry) {
                  const winner = yield* loadAsset(payload.slug)
                  if (winner?.workspace_id !== principal.workspaceId) {
                    if (winner) {
                      return yield* Effect.fail(
                        new AssetSlugTaken({ slug: payload.slug }),
                      )
                    }
                  } else if (winner.ext !== payload.ext) {
                    return yield* Effect.fail(
                      apiError(
                        'conflict',
                        `Asset ${payload.slug} is already reserved with extension .${winner.ext}.`,
                      ),
                    )
                  } else {
                    return yield* persist(winner, false)
                  }
                }
                return yield* Effect.fail(
                  apiError(
                    'conflict',
                    'An asset publication precondition changed before commit.',
                  ),
                )
              }
              return yield* Effect.fail(failure)
            }

            const row = yield* Effect.tryPromise({
              try: () =>
                db.raw
                  .prepare(
                    `SELECT a.slug, a.ext, v.version_number
                       FROM asset_versions v
                       JOIN assets a ON a.id = v.asset_id
                      WHERE v.id = ? LIMIT 1`,
                  )
                  .bind(versionId)
                  .first<AssetVersionRow>(),
              catch: (cause) =>
                new PersistenceError({
                  operation: 'load asset publication result',
                  cause,
                }),
            })
            if (!row) {
              return yield* Effect.fail(
                new PersistenceError({
                  operation: 'load asset publication result',
                  cause: new Error('Committed asset version row was not found.'),
                }),
              )
            }
            return assetPushDto(row, origin)
          })

        return yield* persist(existing ?? null, true)
      })

    const list: AssetsService['list'] = (principal) =>
      Effect.gen(function* () {
        const rows = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT a.slug, a.ext, v.version_number, a.updated_at
                   FROM assets a
                   JOIN asset_versions v ON v.id = a.current_version_id
                  WHERE a.workspace_id = ? AND a.deleted_at IS NULL
                  ORDER BY a.updated_at DESC, a.slug ASC`,
              )
              .bind(principal.workspaceId)
              .all<AssetListRow>(),
          catch: (cause) =>
            new PersistenceError({ operation: 'list assets', cause }),
        })
        return rows.results.map((row) => assetListDto(row, origin))
      })

    const deleteAsset: AssetsService['delete'] = (slug, principal) =>
      Effect.gen(function* () {
        yield* principals.requirePublisher(principal)
        const asset = yield* loadAsset(slug)
        if (
          !asset ||
          asset.workspace_id !== principal.workspaceId ||
          asset.deleted_at !== null
        ) {
          return yield* Effect.fail(apiError('not_found', 'Asset not found.'))
        }

        const now = new Date().toISOString()
        const guardId = ids.internalId()
        const result = yield* db
          .batch([
            db.raw
              .prepare(
                `INSERT INTO publication_guards (id, ok)
                 VALUES (?, CASE WHEN EXISTS (
                   SELECT 1 FROM assets asset
                   JOIN accounts actor ON actor.id = ? AND actor.disabled_at IS NULL
              LEFT JOIN memberships publisher
                     ON publisher.workspace_id = asset.workspace_id
                    AND publisher.account_id = actor.id
                  WHERE asset.id = ? AND asset.slug = ?
                    AND asset.workspace_id = ? AND asset.deleted_at IS NULL
                    AND (actor.kind = 'service' OR publisher.account_id IS NOT NULL)
                 ) THEN 1 ELSE 0 END)`,
              )
              .bind(
                guardId,
                principal.accountId,
                asset.id,
                slug,
                principal.workspaceId,
              ),
            db.raw
              .prepare(
                `UPDATE assets
                    SET current_version_id = NULL, deleted_at = ?, updated_at = ?
                  WHERE id = ?`,
              )
              .bind(now, now, asset.id),
            db.raw
              .prepare('DELETE FROM publication_guards WHERE id = ?')
              .bind(guardId),
          ])
          .pipe(Effect.either)

        if (result._tag === 'Left') {
          if (isGuardFailure(result.left)) {
            return yield* Effect.fail(apiError('not_found', 'Asset not found.'))
          }
          return yield* Effect.fail(result.left)
        }
      })

    const serve: AssetsService['serve'] = (request) =>
      Effect.gen(function* () {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return assetNotFound()
        }
        const target = parseAssetPath(new URL(request.url).pathname)
        if (!target) return assetNotFound()

        const row = yield* Effect.tryPromise({
          try: () => {
            if (target.versionNumber !== undefined) {
              return db.raw
                .prepare(
                  `SELECT v.object_key, v.file_size, v.content_type
                     FROM assets a
                     JOIN asset_versions v ON v.asset_id = a.id
                    WHERE a.slug = ? AND a.ext = ? AND v.version_number = ?
                    LIMIT 1`,
                )
                .bind(target.slug, target.ext, target.versionNumber)
                .first<ServedAssetRow>()
            }
            return db.raw
              .prepare(
                `SELECT v.object_key, v.file_size, v.content_type
                   FROM assets a
                   JOIN asset_versions v ON v.id = a.current_version_id
                  WHERE a.slug = ? AND a.ext = ? AND a.deleted_at IS NULL
                  LIMIT 1`,
              )
              .bind(target.slug, target.ext)
              .first<ServedAssetRow>()
          },
          catch: (cause) =>
            new PersistenceError({ operation: 'load served asset version', cause }),
        })
        if (!row) return assetNotFound()

        const object =
          request.method === 'HEAD'
            ? yield* objects.head(row.object_key)
            : yield* objects.get(row.object_key)
        if (!object) return assetNotFound()

        const headers = assetHeaders(
          target.versionNumber === undefined
            ? 'public, max-age=60'
            : 'public, max-age=31536000, immutable',
        )
        headers.set('content-type', row.content_type)
        headers.set('content-length', String(row.file_size))
        return new Response(
          request.method === 'HEAD' ? null : (object as R2ObjectBody).body,
          { status: 200, headers },
        )
      })

    return { push, list, delete: deleteAsset, serve }
  }),
)
