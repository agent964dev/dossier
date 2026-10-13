import {
  DossierError,
  ERRORS,
  type DocWire,
  type ErrorCode,
  type Mentionable,
  type RoleName,
} from '@dossier/contracts/bridge'
import type {
  EventWire,
  EventsResponseWire,
  SendPayloadWire,
  SendResultWire,
  ShellApi,
  UploadParamsWire,
  UploadResultWire,
  ViewGrant,
  WritePayloadWire,
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
    !(body.email === null || typeof body.email === 'string') ||
    typeof body.events !== 'string' ||
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
    email: body.email as string | null,
    events: body.events,
  }
}

/**
 * A page's tree path as its link names it: 'a/index.html' → 'a/',
 * 'a/b.html' → 'a/b', each name encoded.
 */
export const linkPathOfPage = (page: string): string => {
  const bare = page.endsWith('index.html')
    ? page === 'index.html' || page.endsWith('/index.html')
      ? page.slice(0, -'index.html'.length)
      : page
    : page.endsWith('.html')
      ? page.slice(0, -'.html'.length)
      : page
  const folder = bare === '' || bare.endsWith('/')
  const names = (folder ? bare.slice(0, -1) : bare)
    .split('/')
    .filter((n) => n !== '')
  const encoded = names.map(encodeURIComponent).join('/')
  return folder && encoded !== '' ? `${encoded}/` : encoded
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

const readMentionable = (body: unknown): Mentionable | null =>
  isRecord(body) &&
  Array.isArray(body.people) &&
  body.people.every(
    (p: unknown) =>
      isRecord(p) &&
      typeof p.email === 'string' &&
      (p.name === null || typeof p.name === 'string') &&
      (p.image === null || typeof p.image === 'string'),
  ) &&
  Array.isArray(body.teams) &&
  body.teams.every(
    (t: unknown) =>
      isRecord(t) &&
      typeof t.name === 'string' &&
      typeof t.members === 'number',
  )
    ? (body as unknown as Mentionable)
    : null

const isEventWire = (value: unknown): value is EventWire =>
  isRecord(value) &&
  typeof value.cursor === 'string' &&
  typeof value.type === 'string' &&
  typeof value.path === 'string' &&
  typeof value.at === 'string' &&
  (value.by === null || typeof value.by === 'string') &&
  (value.push === null || typeof value.push === 'number')

const readEvents = (body: unknown): EventsResponseWire | null =>
  isRecord(body) &&
  Array.isArray(body.events) &&
  body.events.every(isEventWire) &&
  typeof body.next === 'string' &&
  typeof body.more === 'boolean'
    ? { events: body.events, next: body.next, more: body.more }
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

  const view: ShellApi['view'] = async ({ tree, path, renewal = false }) => {
    let response: Response
    let body: unknown
    try {
      response = await fetch(`${origin}/_/api/view`, {
        method: 'POST',
        headers: writeHeaders('application/json'),
        // A first view leaves renewal out: the API takes it as false.
        body: JSON.stringify(
          renewal ? { tree, path, renewal } : { tree, path },
        ),
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
  }

  return {
    view,
    // The deployment's own answer for the page a nested page names: a view
    // of it, as the person the session is now.
    confirm: async ({ tree, page }) => {
      const grant = await view({ tree, path: linkPathOfPage(page) })
      return { path: grant.path, email: grant.email }
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
    withdraw: async ({ tree, path, opId, as }) => {
      await call(
        `${origin}/_/api/data/withdraw`,
        {
          method: 'POST',
          headers: writeHeaders('application/json'),
          body: JSON.stringify({ tree, path, opId, as }),
        },
        () => ({ value: undefined }),
        true,
      )
    },
    write: (payload: WritePayloadWire) =>
      call(
        `${origin}/_/api/data/write`,
        {
          method: 'POST',
          headers: writeHeaders('application/json'),
          body: JSON.stringify(payload),
        },
        (body) => known(isDocWire(body) ? body : null),
      ),
    mentionable: ({ tree, page, query }) =>
      call(
        `${origin}/_/api/data/mentionable?${new URLSearchParams({ tree, page, q: query })}`,
        { method: 'GET' },
        (body) => known(readMentionable(body)),
      ),
    events: ({ tree, after }) =>
      call(
        `${origin}/_/api/events?${new URLSearchParams({ tree, after })}`,
        { method: 'GET' },
        (body) => known(readEvents(body)),
      ),
  }
}
