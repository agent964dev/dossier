import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { Effect } from 'effect'

import { apiError, Db, Ids, PersistenceError } from '../services'
import { verifyCsrf } from './csrf'
import { runSurface, type SurfaceFailure } from './runtime'
import { resolveWeb, type Viewer } from './viewer'

export interface MemberRow {
  readonly accountId: string
  readonly name: string
  readonly email: string | null
  readonly pictureUrl: string | null
  readonly role: 'admin' | 'member'
  readonly joinedAt: string
  readonly lastLoginAt: string | null
  readonly disabled: boolean
  readonly deploymentAdmin: boolean
  readonly kind: 'user' | 'service'
}

export interface AllowlistRow {
  readonly id: string
  readonly kind: 'email' | 'domain'
  readonly value: string
  readonly role: 'admin' | 'member'
  readonly createdAt: string
  readonly createdByName: string | null
  readonly lastUsedAt: string | null
}

export interface WorkspaceData {
  readonly viewer: Viewer
  readonly members: readonly MemberRow[]
  readonly allowlist: readonly AllowlistRow[]
}

function loadMembers(workspaceId: string) {
  return Effect.gen(function* () {
    const db = yield* Db
    const result = yield* Effect.tryPromise({
      try: () =>
        db.raw
          .prepare(
            `SELECT a.id, a.name, a.kind, a.deployment_admin, a.disabled_at,
                    m.role, m.created_at AS joined_at,
                    (SELECT i.email FROM identities i
                      WHERE i.account_id = a.id AND i.email_verified = 1
                      ORDER BY i.last_login_at DESC LIMIT 1) AS email,
                    (SELECT i.picture_url FROM identities i
                      WHERE i.account_id = a.id
                      ORDER BY i.last_login_at DESC LIMIT 1) AS picture_url,
                    (SELECT i.last_login_at FROM identities i
                      WHERE i.account_id = a.id
                      ORDER BY i.last_login_at DESC LIMIT 1) AS last_login_at
               FROM memberships m
               JOIN accounts a ON a.id = m.account_id
              WHERE m.workspace_id = ?
              ORDER BY m.role = 'member', a.name COLLATE NOCASE`,
          )
          .bind(workspaceId)
          .all<{
            id: string
            name: string
            kind: 'user' | 'service'
            deployment_admin: number
            disabled_at: string | null
            role: 'admin' | 'member'
            joined_at: string
            email: string | null
            picture_url: string | null
            last_login_at: string | null
          }>(),
      catch: (cause) =>
        new PersistenceError({ operation: 'list workspace members', cause }),
    })
    return result.results.map(
      (row): MemberRow => ({
        accountId: row.id,
        name: row.name,
        email: row.email,
        pictureUrl: row.picture_url,
        role: row.role,
        joinedAt: row.joined_at,
        lastLoginAt: row.last_login_at,
        disabled: row.disabled_at !== null,
        deploymentAdmin: row.deployment_admin === 1,
        kind: row.kind,
      }),
    )
  })
}

function loadAllowlist(workspaceId: string) {
  return Effect.gen(function* () {
    const db = yield* Db
    const result = yield* Effect.tryPromise({
      try: () =>
        db.raw
          .prepare(
            `SELECT al.id, al.kind, al.value, al.role, al.created_at,
                    al.last_used_at, a.name AS created_by_name
               FROM allowlist al
          LEFT JOIN accounts a ON a.id = al.created_by
              WHERE al.workspace_id = ?
              ORDER BY al.kind DESC, al.value`,
          )
          .bind(workspaceId)
          .all<{
            id: string
            kind: 'email' | 'domain'
            value: string
            role: 'admin' | 'member'
            created_at: string
            last_used_at: string | null
            created_by_name: string | null
          }>(),
      catch: (cause) =>
        new PersistenceError({ operation: 'list allowlist entries', cause }),
    })
    return result.results.map(
      (row): AllowlistRow => ({
        id: row.id,
        kind: row.kind,
        value: row.value,
        role: row.role,
        createdAt: row.created_at,
        createdByName: row.created_by_name,
        lastUsedAt: row.last_used_at,
      }),
    )
  })
}

export const loadWorkspace = createServerFn({ method: 'GET' }).handler(
  async () => {
    const request = getRequest()
    return runSurface(
      Effect.gen(function* () {
        const { viewer } = yield* resolveWeb(request)
        // Roster identities and allowlist entries are workspace-management
        // data, not document-read data. Authorize before loading either.
        yield* requireAdmin(viewer)
        const members = yield* loadMembers(viewer.workspaceId)
        const allowlist = yield* loadAllowlist(viewer.workspaceId)
        return { viewer, members, allowlist } satisfies WorkspaceData
      }),
    )
  },
)

function requireAdmin(viewer: Viewer) {
  return viewer.admin
    ? Effect.void
    : Effect.fail(
        apiError(
          'editor_required',
          'Only workspace admins can change members and the allowlist.',
        ),
      )
}

/**
 * A workspace must keep at least one admin, or nobody can ever manage it
 * again. Counting here (rather than trusting the page) makes the guard hold
 * even when two admins act at the same time on stale views.
 */
function countAdmins(workspaceId: string) {
  return Effect.gen(function* () {
    const db = yield* Db
    const row = yield* Effect.tryPromise({
      try: () =>
        db.raw
          .prepare(
            `SELECT COUNT(*) AS total FROM memberships
              WHERE workspace_id = ? AND role = 'admin'`,
          )
          .bind(workspaceId)
          .first<{ total: number }>(),
      catch: (cause) =>
        new PersistenceError({ operation: 'count workspace admins', cause }),
    })
    return row?.total ?? 0
  })
}

export type WorkspaceMutationResult =
  | { readonly ok: true; readonly message: string }
  | SurfaceFailure

/** `@example.com` allows a whole domain; anything else must be one address. */
export function parseAllowlistValue(
  raw: string,
): { kind: 'email' | 'domain'; value: string } | null {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > 254 || /\s/.test(trimmed)) {
    return null
  }
  if (trimmed.startsWith('@')) {
    const domain = trimmed.slice(1)
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
      domain,
    )
      ? { kind: 'domain', value: domain }
      : null
  }
  const at = trimmed.indexOf('@')
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return null
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return null
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
    domain,
  )
    ? { kind: 'email', value: trimmed }
    : null
}

export const addAllowlistEntry = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>
    if (typeof value.value !== 'string') {
      throw new Error('An email address or @domain is required.')
    }
    return {
      value: value.value,
      role: value.role === 'admin' ? ('admin' as const) : ('member' as const),
      csrfToken: typeof value.csrfToken === 'string' ? value.csrfToken : '',
    }
  })
  .handler(async ({ data }): Promise<WorkspaceMutationResult> => {
    const request = getRequest()
    return runSurface(
      Effect.gen(function* () {
        const { viewer } = yield* resolveWeb(request)
        yield* verifyCsrf({
          request,
          token: data.csrfToken,
          accountId: viewer.accountId,
        })
        yield* requireAdmin(viewer)

        const parsed = parseAllowlistValue(data.value)
        if (parsed === null) {
          return yield* Effect.fail(
            apiError(
              'conflict',
              'Enter one email address, or @ followed by a domain.',
            ),
          )
        }

        const db = yield* Db
        const ids = yield* Ids
        const existing = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT workspace_id FROM allowlist WHERE value = ? LIMIT 1`,
              )
              .bind(parsed.value)
              .first<{ workspace_id: string }>(),
          catch: (cause) =>
            new PersistenceError({ operation: 'check allowlist entry', cause }),
        })
        if (existing) {
          return yield* Effect.fail(
            apiError(
              'conflict',
              existing.workspace_id === viewer.workspaceId
                ? `${parsed.value} is already allowed here.`
                : `${parsed.value} is already allowed in another workspace.`,
            ),
          )
        }

        yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `INSERT INTO allowlist
                   (id, kind, value, workspace_id, role, created_by, created_at, last_used_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
              )
              .bind(
                ids.internalId('allow_'),
                parsed.kind,
                parsed.value,
                viewer.workspaceId,
                data.role,
                viewer.accountId,
                new Date().toISOString(),
              )
              .run(),
          catch: (cause) =>
            new PersistenceError({ operation: 'add allowlist entry', cause }),
        })

        return {
          ok: true as const,
          message:
            parsed.kind === 'domain'
              ? `Anyone with a verified @${parsed.value} address can now sign in as ${data.role}.`
              : `${parsed.value} can now sign in as ${data.role}.`,
        }
      }),
    ) as Promise<WorkspaceMutationResult>
  })

export const removeAllowlistEntry = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>
    if (typeof value.id !== 'string' || value.id.length === 0) {
      throw new Error('An allowlist entry id is required.')
    }
    return {
      id: value.id,
      csrfToken: typeof value.csrfToken === 'string' ? value.csrfToken : '',
    }
  })
  .handler(async ({ data }): Promise<WorkspaceMutationResult> => {
    const request = getRequest()
    return runSurface(
      Effect.gen(function* () {
        const { viewer } = yield* resolveWeb(request)
        yield* verifyCsrf({
          request,
          token: data.csrfToken,
          accountId: viewer.accountId,
        })
        yield* requireAdmin(viewer)

        const db = yield* Db
        const result = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `DELETE FROM allowlist WHERE id = ? AND workspace_id = ?`,
              )
              .bind(data.id, viewer.workspaceId)
              .run(),
          catch: (cause) =>
            new PersistenceError({
              operation: 'remove allowlist entry',
              cause,
            }),
        })
        if ((result.meta.changes ?? 0) === 0) {
          return yield* Effect.fail(
            apiError('not_found', 'That allowlist entry no longer exists.'),
          )
        }
        // Removing an entry closes the door to new sign-ins; it never deletes
        // the account or the membership it already created (PLAN section 5.1).
        return {
          ok: true as const,
          message: 'Entry removed. Existing members keep their access.',
        }
      }),
    ) as Promise<WorkspaceMutationResult>
  })

export const setMemberRole = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>
    if (typeof value.accountId !== 'string' || value.accountId.length === 0) {
      throw new Error('An account id is required.')
    }
    if (value.role !== 'admin' && value.role !== 'member') {
      throw new Error('A role of admin or member is required.')
    }
    return {
      accountId: value.accountId,
      role: value.role,
      csrfToken: typeof value.csrfToken === 'string' ? value.csrfToken : '',
    }
  })
  .handler(async ({ data }): Promise<WorkspaceMutationResult> => {
    const request = getRequest()
    return runSurface(
      Effect.gen(function* () {
        const { viewer } = yield* resolveWeb(request)
        yield* verifyCsrf({
          request,
          token: data.csrfToken,
          accountId: viewer.accountId,
        })
        yield* requireAdmin(viewer)

        const db = yield* Db
        const current = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT m.role, a.name
                   FROM memberships m JOIN accounts a ON a.id = m.account_id
                  WHERE m.workspace_id = ? AND m.account_id = ?`,
              )
              .bind(viewer.workspaceId, data.accountId)
              .first<{ role: 'admin' | 'member'; name: string }>(),
          catch: (cause) =>
            new PersistenceError({ operation: 'load membership', cause }),
        })
        if (!current) {
          return yield* Effect.fail(
            apiError(
              'not_found',
              'That person is not a member of this workspace.',
            ),
          )
        }
        if (current.role === data.role) {
          return {
            ok: true as const,
            message: `${current.name} is already ${data.role}.`,
          }
        }
        if (
          current.role === 'admin' &&
          (yield* countAdmins(viewer.workspaceId)) <= 1
        ) {
          return yield* Effect.fail(
            apiError('conflict', 'A workspace must keep at least one admin.'),
          )
        }

        yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `UPDATE memberships SET role = ?
                  WHERE workspace_id = ? AND account_id = ?`,
              )
              .bind(data.role, viewer.workspaceId, data.accountId)
              .run(),
          catch: (cause) =>
            new PersistenceError({ operation: 'update member role', cause }),
        })
        return {
          ok: true as const,
          message: `${current.name} is now ${data.role}.`,
        }
      }),
    ) as Promise<WorkspaceMutationResult>
  })

export const removeMember = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const value = (input ?? {}) as Record<string, unknown>
    if (typeof value.accountId !== 'string' || value.accountId.length === 0) {
      throw new Error('An account id is required.')
    }
    return {
      accountId: value.accountId,
      csrfToken: typeof value.csrfToken === 'string' ? value.csrfToken : '',
    }
  })
  .handler(async ({ data }): Promise<WorkspaceMutationResult> => {
    const request = getRequest()
    return runSurface(
      Effect.gen(function* () {
        const { viewer } = yield* resolveWeb(request)
        yield* verifyCsrf({
          request,
          token: data.csrfToken,
          accountId: viewer.accountId,
        })
        yield* requireAdmin(viewer)

        if (data.accountId === viewer.accountId) {
          return yield* Effect.fail(
            apiError(
              'conflict',
              'Removing yourself would lock you out; ask another admin.',
            ),
          )
        }

        const db = yield* Db
        const current = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT m.role, a.name
                   FROM memberships m JOIN accounts a ON a.id = m.account_id
                  WHERE m.workspace_id = ? AND m.account_id = ?`,
              )
              .bind(viewer.workspaceId, data.accountId)
              .first<{ role: 'admin' | 'member'; name: string }>(),
          catch: (cause) =>
            new PersistenceError({ operation: 'load membership', cause }),
        })
        if (!current) {
          return yield* Effect.fail(
            apiError(
              'not_found',
              'That person is not a member of this workspace.',
            ),
          )
        }
        if (
          current.role === 'admin' &&
          (yield* countAdmins(viewer.workspaceId)) <= 1
        ) {
          return yield* Effect.fail(
            apiError('conflict', 'A workspace must keep at least one admin.'),
          )
        }

        yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `DELETE FROM memberships WHERE workspace_id = ? AND account_id = ?`,
              )
              .bind(viewer.workspaceId, data.accountId)
              .run(),
          catch: (cause) =>
            new PersistenceError({ operation: 'remove member', cause }),
        })
        // Their keys stop working on the next write: publisher status is
        // checked per request against memberships (PLAN section 5.1).
        return {
          ok: true as const,
          message: `${current.name} can no longer publish here. Their documents are untouched.`,
        }
      }),
    ) as Promise<WorkspaceMutationResult>
  })
