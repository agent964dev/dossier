import { Context, Effect, Layer } from 'effect'

import { Db } from './db'
import { apiError, DossierError, PersistenceError } from './errors'
import { Ids } from './ids'
import { Session } from './session'

export type PrincipalRole = 'admin' | 'member' | null

export interface PrincipalIdentity {
  readonly accountId: string
  readonly apiKeyId?: string
  readonly apiKeyName?: string
  readonly workspaceId: string
  readonly workspaceSlug: string
  readonly workspaceKind: 'team' | 'personal'
  readonly role: PrincipalRole
  readonly accountName: string
  readonly accountKind: 'user' | 'service'
  readonly deploymentAdmin: boolean
  readonly verifiedEmails: readonly string[]
}

export interface PrincipalService {
  readonly resolve: (
    request: Request,
  ) => Effect.Effect<PrincipalIdentity, DossierError | PersistenceError>
  readonly resolveReadOnly: (
    request: Request,
  ) => Effect.Effect<PrincipalIdentity, DossierError | PersistenceError>
  readonly resolveSession: (
    request: Request,
  ) => Effect.Effect<PrincipalIdentity, DossierError | PersistenceError>
  readonly fromAccountId: (
    accountId: string,
    workspaceId: string,
  ) => Effect.Effect<PrincipalIdentity, DossierError | PersistenceError>
  readonly requirePublisher: (
    principal: PrincipalIdentity,
    workspaceId?: string,
  ) => Effect.Effect<void, DossierError | PersistenceError>
}

export class Principal extends Context.Tag('@dossier/web/Principal')<
  Principal,
  PrincipalService
>() {}

type PrincipalRow = {
  account_id: string
  api_key_id: string | null
  api_key_name: string | null
  workspace_id: string
  workspace_slug: string
  workspace_kind: 'team' | 'personal'
  role: 'admin' | 'member' | null
  account_name: string
  account_kind: 'user' | 'service'
  deployment_admin: number
}

function persistence(operation: string, cause: unknown): PersistenceError {
  return new PersistenceError({ operation, cause })
}

export const PrincipalLive = Layer.effect(
  Principal,
  Effect.gen(function* () {
    const db = yield* Db
    const ids = yield* Ids
    const session = yield* Session

    const verifiedEmails = (accountId: string) =>
      Effect.tryPromise({
        try: async () => {
          const result = await db.raw
            .prepare(
              `SELECT DISTINCT email
                 FROM identities
                WHERE account_id = ? AND email_verified = 1
                ORDER BY email`,
            )
            .bind(accountId)
            .all<{ email: string }>()
          return result.results.map((row) => row.email)
        },
        catch: (cause) => persistence('load verified identities', cause),
      })

    const fromRow = (
      row: PrincipalRow,
      emails: readonly string[],
    ): PrincipalIdentity => ({
      accountId: row.account_id,
      ...(row.api_key_id === null ? {} : { apiKeyId: row.api_key_id }),
      ...(row.api_key_name === null ? {} : { apiKeyName: row.api_key_name }),
      workspaceId: row.workspace_id,
      workspaceSlug: row.workspace_slug,
      workspaceKind: row.workspace_kind,
      role: row.role,
      accountName: row.account_name,
      accountKind: row.account_kind,
      deploymentAdmin: row.deployment_admin === 1,
      verifiedEmails: emails,
    })

    const resolveBearer = (token: string, stampUse: boolean) =>
      Effect.gen(function* () {
        if (token.length === 0) {
          return yield* Effect.fail(
            apiError('unauthenticated', 'Invalid bearer token.'),
          )
        }
        const hash = yield* ids.sha256Hex(token)
        const row = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT k.account_id, k.id AS api_key_id, k.name AS api_key_name,
                        k.workspace_id, w.slug AS workspace_slug, w.kind AS workspace_kind,
                        m.role, a.name AS account_name, a.kind AS account_kind,
                        a.deployment_admin
                   FROM api_keys k
                   JOIN accounts a ON a.id = k.account_id
                   JOIN workspaces w ON w.id = k.workspace_id
              LEFT JOIN memberships m
                     ON m.workspace_id = k.workspace_id AND m.account_id = k.account_id
                  WHERE k.key_hash = ?
                    AND k.revoked_at IS NULL
                    AND a.disabled_at IS NULL
                  LIMIT 1`,
              )
              .bind(hash)
              .first<PrincipalRow>(),
          catch: (cause) => persistence('resolve bearer principal', cause),
        })
        if (!row) {
          return yield* Effect.fail(
            apiError('unauthenticated', 'Invalid bearer token.'),
          )
        }

        if (stampUse) {
          const now = new Date()
          const cutoff = new Date(now.getTime() - 60_000).toISOString()
          yield* Effect.tryPromise({
            try: () =>
              db.raw
                .prepare(
                  `UPDATE api_keys
                      SET last_used_at = ?
                    WHERE id = ?
                      AND (last_used_at IS NULL OR last_used_at < ?)`,
                )
                .bind(now.toISOString(), row.api_key_id, cutoff)
                .run(),
            catch: (cause) => persistence('stamp API key use', cause),
          })
        }
        return fromRow(row, yield* verifiedEmails(row.account_id))
      })

    const fromAccountId: PrincipalService['fromAccountId'] = (
      accountId,
      workspaceId,
    ) =>
      Effect.gen(function* () {
        const row = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT a.id AS account_id, NULL AS api_key_id, NULL AS api_key_name,
                        w.id AS workspace_id, w.slug AS workspace_slug,
                        w.kind AS workspace_kind, m.role, a.name AS account_name,
                        a.kind AS account_kind, a.deployment_admin
                   FROM accounts a
                   JOIN workspaces w ON w.id = ?
              LEFT JOIN memberships m
                     ON m.account_id = a.id AND m.workspace_id = w.id
                  WHERE a.id = ? AND a.disabled_at IS NULL
                  LIMIT 1`,
              )
              .bind(workspaceId, accountId)
              .first<PrincipalRow>(),
          catch: (cause) => persistence('rehydrate account principal', cause),
        })
        if (!row) {
          return yield* Effect.fail(
            apiError('unauthenticated', 'Account is no longer available.'),
          )
        }
        return fromRow(row, yield* verifiedEmails(row.account_id))
      })

    const resolveCookie = (request: Request) =>
      Effect.gen(function* () {
        const payload = yield* session.readSession(request)
        if (!payload) {
          return yield* Effect.fail(
            apiError('unauthenticated', 'Sign in required.'),
          )
        }
        return yield* fromAccountId(payload.accountId, payload.workspaceId)
      })

    const resolveWithBearerStamp = (request: Request, stampUse: boolean) => {
      const authorization = request.headers.get('authorization')
      if (authorization !== null && /^Bearer(?:\s|$)/i.test(authorization)) {
        const match = /^Bearer\s+(.+)$/i.exec(authorization)
        return resolveBearer(match?.[1]?.trim() ?? '', stampUse)
      }
      return resolveCookie(request)
    }

    const resolve: PrincipalService['resolve'] = (request) =>
      resolveWithBearerStamp(request, true)

    const resolveReadOnly: PrincipalService['resolveReadOnly'] = (request) =>
      resolveWithBearerStamp(request, false)

    const requirePublisher: PrincipalService['requirePublisher'] = (
      principal,
      workspaceId = principal.workspaceId,
    ) =>
      Effect.gen(function* () {
        const row = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT a.kind, a.disabled_at, m.account_id AS member
                   FROM accounts a
              LEFT JOIN memberships m
                     ON m.account_id = a.id AND m.workspace_id = ?
                  WHERE a.id = ?`,
              )
              .bind(workspaceId, principal.accountId)
              .first<{
                kind: 'user' | 'service'
                disabled_at: string | null
                member: string | null
              }>(),
          catch: (cause) => persistence('check publisher status', cause),
        })
        if (!row || row.disabled_at !== null) {
          return yield* Effect.fail(
            apiError('unauthenticated', 'Account is disabled.'),
          )
        }
        if (row.kind !== 'service' && row.member === null) {
          return yield* Effect.fail(
            apiError(
              'publisher_required',
              'Workspace membership is required to publish.',
            ),
          )
        }
      })

    return {
      resolve,
      resolveReadOnly,
      resolveSession: resolveCookie,
      fromAccountId,
      requirePublisher,
    }
  }),
)
