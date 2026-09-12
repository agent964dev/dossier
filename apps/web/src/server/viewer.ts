import { Effect } from 'effect'

import {
  Db,
  DossierError,
  PersistenceError,
  Principal,
  SessionError,
  WorkerEnv,
  type PrincipalIdentity,
} from '../services'
import { issueCsrfToken } from './csrf'
import type { CoreServices } from './runtime'

/**
 * Everything the shell and every page header need about the signed-in person,
 * resolved once per request from the cookie via `Principal` (verified emails
 * come from `identities`, never from the cookie — PLAN section 5.1).
 */
export interface Viewer {
  readonly accountId: string
  readonly accountName: string
  readonly email: string | null
  readonly pictureUrl: string | null
  readonly workspaceId: string
  readonly workspaceSlug: string
  readonly workspaceName: string
  readonly workspaceKind: 'team' | 'personal'
  readonly workspaceDomain: string | null
  readonly role: 'admin' | 'member' | null
  readonly deploymentAdmin: boolean
  /** May publish, mint keys and act on documents in this workspace. */
  readonly publisher: boolean
  /** May manage members and the allowlist for this workspace. */
  readonly admin: boolean
  /** Signed, account-bound token every mutation on the page must echo back. */
  readonly csrfToken: string
  /** Rendered on the server so relative timestamps never mismatch on hydration. */
  readonly now: string
}

/**
 * The signed-in person in both shapes the surface needs: `viewer` for
 * rendering, `principal` for the services, resolved from the same lookup so
 * the two can never disagree.
 */
export interface WebSession {
  readonly viewer: Viewer
  readonly principal: PrincipalIdentity
}

export function resolveWeb(
  request: Request,
): Effect.Effect<
  WebSession,
  DossierError | PersistenceError | SessionError,
  CoreServices
> {
  return Effect.gen(function* () {
    const principals = yield* Principal
    const db = yield* Db
    yield* WorkerEnv
    const principal = yield* principals.resolveSession(request)

    const profile = yield* Effect.tryPromise({
      try: () =>
        db.raw
          .prepare(
            `SELECT w.name AS workspace_name, w.email_domain,
                    (SELECT i.picture_url FROM identities i
                      WHERE i.account_id = ?
                      ORDER BY i.last_login_at DESC NULLS LAST LIMIT 1) AS picture_url
               FROM workspaces w
              WHERE w.id = ?
              LIMIT 1`,
          )
          .bind(principal.accountId, principal.workspaceId)
          .first<{
            workspace_name: string
            email_domain: string | null
            picture_url: string | null
          }>(),
      catch: (cause) =>
        new PersistenceError({ operation: 'load viewer profile', cause }),
    })

    const csrfToken = yield* issueCsrfToken(principal.accountId)

    const viewer: Viewer = {
      accountId: principal.accountId,
      accountName: principal.accountName,
      email: principal.verifiedEmails[0] ?? null,
      pictureUrl: profile?.picture_url ?? null,
      workspaceId: principal.workspaceId,
      workspaceSlug: principal.workspaceSlug,
      workspaceName: profile?.workspace_name ?? principal.workspaceSlug,
      workspaceKind: principal.workspaceKind,
      workspaceDomain: profile?.email_domain ?? null,
      role: principal.role,
      deploymentAdmin: principal.deploymentAdmin,
      publisher: principal.accountKind === 'service' || principal.role !== null,
      admin: principal.role === 'admin' || principal.deploymentAdmin,
      csrfToken,
      now: new Date().toISOString(),
    }

    return { viewer, principal }
  })
}

export function viewerEffect(
  request: Request,
): Effect.Effect<
  Viewer,
  DossierError | PersistenceError | SessionError,
  CoreServices
> {
  return Effect.map(resolveWeb(request), (session) => session.viewer)
}
