import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { Effect } from 'effect'

import { apiError, Db, Ids, PersistenceError } from '../services'
import { verifyCsrf } from './csrf'
import { runSurface, type SurfaceFailure } from './runtime'
import { resolveWeb, type Viewer } from './viewer'

export interface ApiKeyRow {
  readonly id: string
  readonly name: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly revokedAt: string | null
}

export interface CliAuthData {
  readonly viewer: Viewer
  readonly keys: readonly ApiKeyRow[]
}

interface KeyRecord {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

/**
 * Keys are per account *and* per workspace: a key minted here can only ever
 * publish into the workspace it was minted in (PLAN section 5.1), so the list
 * is scoped the same way.
 */
function listKeys(accountId: string, workspaceId: string) {
  return Effect.gen(function* () {
    const db = yield* Db
    const result = yield* Effect.tryPromise({
      try: () =>
        db.raw
          .prepare(
            `SELECT id, name, created_at, last_used_at, revoked_at
               FROM api_keys
              WHERE account_id = ? AND workspace_id = ?
              ORDER BY revoked_at IS NOT NULL, created_at DESC, id DESC`,
          )
          .bind(accountId, workspaceId)
          .all<KeyRecord>(),
      catch: (cause) =>
        new PersistenceError({ operation: 'list API keys', cause }),
    })
    return result.results.map((row): ApiKeyRow => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }))
  })
}

export const loadCliAuth = createServerFn({ method: 'GET' }).handler(
  async () => {
    const request = getRequest()
    return runSurface(
      Effect.gen(function* () {
        const { viewer } = yield* resolveWeb(request)
        const keys = viewer.publisher
          ? yield* listKeys(viewer.accountId, viewer.workspaceId)
          : []
        return { viewer, keys } satisfies CliAuthData
      }),
    )
  },
)

export type MintKeyResult =
  | {
      readonly ok: true
      /** Shown once and never stored: only the SHA-256 hash reaches D1. */
      readonly token: string
      readonly key: ApiKeyRow
    }
  | SurfaceFailure

function defaultKeyName(now: Date): string {
  return `CLI · ${now.toISOString().slice(0, 10)}`
}

export const mintApiKey = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    if (name.length > 64) {
      throw new Error('A key name may be at most 64 characters.')
    }
    return {
      name,
      csrfToken: typeof value.csrfToken === 'string' ? value.csrfToken : '',
    }
  })
  .handler(async ({ data }): Promise<MintKeyResult> => {
    const request = getRequest()
    return runSurface(
      Effect.gen(function* () {
        const { viewer, principal } = yield* resolveWeb(request)
        yield* verifyCsrf({
          request,
          token: data.csrfToken,
          accountId: viewer.accountId,
        })
        if (!viewer.publisher) {
          return yield* Effect.fail(
            apiError(
              'publisher_required',
              'Only workspace members can mint API keys.',
            ),
          )
        }

        const db = yield* Db
        const ids = yield* Ids
        const now = new Date()
        const token = ids.apiToken()
        const keyHash = yield* ids.sha256Hex(token)
        const id = ids.internalId('key_')
        const name = data.name || defaultKeyName(now)
        const createdAt = now.toISOString()

        yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `INSERT INTO api_keys
                   (id, account_id, workspace_id, name, key_hash,
                    created_at, last_used_at, revoked_at)
                 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
              )
              .bind(
                id,
                principal.accountId,
                principal.workspaceId,
                name,
                keyHash,
                createdAt,
              )
              .run(),
          catch: (cause) =>
            new PersistenceError({ operation: 'mint API key', cause }),
        })

        return {
          ok: true as const,
          token,
          key: {
            id,
            name,
            createdAt,
            lastUsedAt: null,
            revokedAt: null,
          },
        }
      }),
    ) as Promise<MintKeyResult>
  })

export type RevokeKeyResult =
  | { readonly ok: true; readonly id: string }
  | SurfaceFailure

export const revokeApiKey = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>
    if (typeof value.id !== 'string' || value.id.length === 0) {
      throw new Error('A key id is required.')
    }
    return {
      id: value.id,
      csrfToken: typeof value.csrfToken === 'string' ? value.csrfToken : '',
    }
  })
  .handler(async ({ data }): Promise<RevokeKeyResult> => {
    const request = getRequest()
    return runSurface(
      Effect.gen(function* () {
        const { viewer, principal } = yield* resolveWeb(request)
        yield* verifyCsrf({
          request,
          token: data.csrfToken,
          accountId: viewer.accountId,
        })

        const db = yield* Db
        // Revoking one's own key is allowed even without publisher status
        // (PLAN section 5.1), so this is scoped by account, not membership.
        const result = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `UPDATE api_keys
                    SET revoked_at = ?
                  WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
              )
              .bind(new Date().toISOString(), data.id, principal.accountId)
              .run(),
          catch: (cause) =>
            new PersistenceError({ operation: 'revoke API key', cause }),
        })
        if ((result.meta.changes ?? 0) === 0) {
          return yield* Effect.fail(
            apiError(
              'not_found',
              'That key is already revoked or does not exist.',
            ),
          )
        }
        return { ok: true as const, id: data.id }
      }),
    ) as Promise<RevokeKeyResult>
  })
