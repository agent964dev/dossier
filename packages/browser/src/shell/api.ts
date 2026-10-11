import {
  DossierError,
  ERRORS,
  type ErrorCode,
  type RoleName,
} from '@dossier/contracts/bridge'
import type { ShellApi, ViewGrant } from './create-shell.ts'

// The API's CSRF header. Written out here because the contracts root, where
// the shared constant lives, carries Effect, which the browser bundles leave
// out.
const CSRF_HEADER = 'Dossier-CSRF'

const ROLES: ReadonlySet<unknown> = new Set<RoleName>([
  'read',
  'respond',
  'write',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && Object.hasOwn(ERRORS, value)

const orNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null

const unavailable = (): DossierError =>
  new DossierError({
    code: 'unavailable',
    message: ERRORS.unavailable.message,
    fix: null,
    path: null,
  })

const readGrant = (body: unknown): ViewGrant | null => {
  if (
    !isRecord(body) ||
    typeof body.handle !== 'string' ||
    typeof body.expiresAt !== 'string' ||
    typeof body.seq !== 'number' ||
    !ROLES.has(body.role)
  ) {
    return null
  }
  return {
    handle: body.handle,
    expiresAt: body.expiresAt,
    seq: body.seq,
    role: body.role as RoleName,
  }
}

const readError = (body: unknown): DossierError | null => {
  if (!isRecord(body) || !isRecord(body.error)) return null
  const { code, message, fix, path } = body.error
  if (!isCode(code) || typeof message !== 'string') return null
  return new DossierError({
    code,
    message,
    fix: orNull(fix),
    path: orNull(path),
  })
}

/** The shell's calls to the deployment's API on its own origin. */
export const shellApi = (
  fetch: typeof globalThis.fetch,
  origin: string,
): ShellApi => ({
  view: async ({ tree, path }) => {
    let response: Response
    let body: unknown
    try {
      response = await fetch(`${origin}/_/api/view`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CSRF_HEADER]: '1',
        },
        body: JSON.stringify({ tree, path }),
        credentials: 'same-origin',
      })
      body = await response.json()
    } catch {
      throw unavailable()
    }
    if (response.ok) {
      const grant = readGrant(body)
      if (grant !== null) return grant
      throw unavailable()
    }
    throw readError(body) ?? unavailable()
  },
})
