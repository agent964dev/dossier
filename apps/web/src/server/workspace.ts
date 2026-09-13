import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { Effect } from 'effect'

import { Workspace, type MemberRow, type AllowlistRow } from '../services'
import { verifyCsrf } from './csrf'
import { runSurface, type SurfaceFailure } from './runtime'
import { resolveWeb, type Viewer } from './viewer'

export { parseAllowlistValue } from '../services/workspace'
export type { MemberRow, AllowlistRow } from '../services/workspace'

export interface WorkspaceData {
  readonly viewer: Viewer
  readonly members: readonly MemberRow[]
  readonly allowlist: readonly AllowlistRow[]
}

export type WorkspaceMutationResult =
  | { readonly ok: true; readonly message: string }
  | SurfaceFailure

export const loadWorkspace = createServerFn({ method: 'GET' }).handler(
  async () => {
    const request = getRequest()
    return runSurface(
      Effect.gen(function* () {
        const { viewer, principal } = yield* resolveWeb(request)
        const workspace = yield* Workspace
        const { members, allowlist } = yield* workspace.get(principal)
        return { viewer, members, allowlist } satisfies WorkspaceData
      }),
    )
  },
)

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
        const { viewer, principal } = yield* resolveWeb(request)
        yield* verifyCsrf({
          request,
          token: data.csrfToken,
          accountId: viewer.accountId,
        })
        const workspace = yield* Workspace
        const value = data.value.trim()
        const domain = value.startsWith('@')
        return yield* workspace.addAllowlistEntry(principal, {
          kind: domain ? 'domain' : 'email',
          value: domain ? value.slice(1) : value,
          role: data.role,
        })
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
        const { viewer, principal } = yield* resolveWeb(request)
        yield* verifyCsrf({
          request,
          token: data.csrfToken,
          accountId: viewer.accountId,
        })
        const workspace = yield* Workspace
        return yield* workspace.removeAllowlistEntry(principal, data.id)
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
    } as const
  })
  .handler(async ({ data }): Promise<WorkspaceMutationResult> => {
    const request = getRequest()
    return runSurface(
      Effect.gen(function* () {
        const { viewer, principal } = yield* resolveWeb(request)
        yield* verifyCsrf({
          request,
          token: data.csrfToken,
          accountId: viewer.accountId,
        })
        const workspace = yield* Workspace
        return yield* workspace.setMemberRole(
          principal,
          data.accountId,
          data.role,
        )
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
        const { viewer, principal } = yield* resolveWeb(request)
        yield* verifyCsrf({
          request,
          token: data.csrfToken,
          accountId: viewer.accountId,
        })
        const workspace = yield* Workspace
        return yield* workspace.removeMember(principal, data.accountId)
      }),
    ) as Promise<WorkspaceMutationResult>
  })
