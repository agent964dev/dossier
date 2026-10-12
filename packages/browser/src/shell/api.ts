import {
  DossierError,
  ERRORS,
  type DocWire,
  type ErrorCode,
  type RoleName,
} from '@dossier/contracts/bridge'
import type {
  SendPayloadWire,
  SendResultWire,
  ShellApi,
  UploadParamsWire,
  UploadResultWire,
  ViewGrant,
} from './create-shell.ts'

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

/** No answer at all: the request never reached Dossier, or its answer was lost. */
export const offline = (): DossierError =>
  new DossierError({
    code: 'offline',
    message: ERRORS.offline.message,
    fix: null,
    path: null,
  })

const readGrant = (body: unknown): ViewGrant | null => {
  if (
    !isRecord(body) ||
    typeof body.handle !== 'string' ||
    typeof body.expiresAt !== 'string' ||
    typeof body.seq !== 'number' ||
    typeof body.path !== 'string' ||
    !ROLES.has(body.role)
  ) {
    return null
  }
  return {
    handle: body.handle,
    expiresAt: body.expiresAt,
    seq: body.seq,
    role: body.role as RoleName,
    path: body.path,
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

const isDocWire = (value: unknown): value is DocWire =>
  isRecord(value) &&
  typeof value.path === 'string' &&
  'data' in value &&
  typeof value.by === 'string' &&
  typeof value.at === 'string' &&
  typeof value.push === 'number'

const readFiles = (body: unknown): DocWire | DocWire[] | null | undefined => {
  if (!isRecord(body)) return undefined
  if ('file' in body) {
    if (body.file === null) return null
    return isDocWire(body.file) ? body.file : undefined
  }
  if (Array.isArray(body.files) && body.files.every(isDocWire)) {
    return body.files
  }
  return undefined
}

const readSendResult = (body: unknown): SendResultWire | null =>
  isRecord(body) &&
  typeof body.replayed === 'boolean' &&
  (body.doc === null || isDocWire(body.doc))
    ? { doc: body.doc as DocWire | null, replayed: body.replayed }
    : null

const readUploadResult = (body: unknown): UploadResultWire | null =>
  isRecord(body) &&
  typeof body.path === 'string' &&
  typeof body.file === 'string' &&
  typeof body.name === 'string' &&
  typeof body.size === 'number' &&
  typeof body.type === 'string'
    ? {
        path: body.path,
        file: body.file,
        name: body.name,
        size: body.size,
        type: body.type,
      }
    : null

/** The shell's calls to the deployment's API on its own origin. */
export const shellApi = (
  fetch: typeof globalThis.fetch,
  origin: string,
): ShellApi => {
  const writeHeaders = (contentType: string): Record<string, string> => ({
    'content-type': contentType,
    [CSRF_HEADER]: '1',
  })

  /**
   * One data call: a network failure is offline, an answer that is not
   * Dossier's is unavailable, an error body is its DossierError. `read` gives
   * null for a body it does not know.
   */
  const call = async <T>(
    url: string,
    init: RequestInit,
    read: (body: unknown) => { readonly value: T } | null,
    empty = false,
  ): Promise<T> => {
    let response: Response
    try {
      response = await fetch(url, { ...init, credentials: 'same-origin' })
    } catch {
      throw offline()
    }
    let body: unknown = null
    if (!(empty && response.ok)) {
      try {
        body = await response.json()
      } catch {
        throw unavailable()
      }
    }
    if (!response.ok) throw readError(body) ?? unavailable()
    const answer = read(body)
    if (answer === null) throw unavailable()
    return answer.value
  }

  const known = <T>(
    value: T | null | undefined,
  ): { readonly value: T } | null =>
    value === null || value === undefined ? null : { value }

  return {
    view: async ({ tree, path }) => {
      let response: Response
      let body: unknown
      try {
        response = await fetch(`${origin}/_/api/view`, {
          method: 'POST',
          headers: writeHeaders('application/json'),
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
    read: ({ tree, path }) =>
      call(
        `${origin}/_/api/data/read?${new URLSearchParams({ tree, path })}`,
        { method: 'GET' },
        (body) => {
          const files = readFiles(body)
          return files === undefined ? null : { value: files }
        },
      ),
    send: (payload: SendPayloadWire) =>
      call(
        `${origin}/_/api/data/send`,
        {
          method: 'POST',
          headers: writeHeaders('application/json'),
          body: JSON.stringify(payload),
        },
        (body) => known(readSendResult(body)),
      ),
    upload: ({
      body: bytes,
      ...params
    }: UploadParamsWire & { readonly body: Blob }) => {
      const query = new URLSearchParams()
      for (const [name, value] of Object.entries(params)) {
        if (value !== null && value !== undefined) {
          query.set(name, String(value))
        }
      }
      return call(
        `${origin}/_/api/data/upload?${query}`,
        {
          method: 'PUT',
          headers: writeHeaders(params.type),
          body: bytes,
        },
        (body) => known(readUploadResult(body)),
      )
    },
    withdraw: async ({ tree, path, opId }) => {
      await call(
        `${origin}/_/api/data/withdraw`,
        {
          method: 'POST',
          headers: writeHeaders('application/json'),
          body: JSON.stringify({ tree, path, opId }),
        },
        () => ({ value: undefined }),
        true,
      )
    },
  }
}
