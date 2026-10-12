// The shell and page client's shared vocabulary. Plain TypeScript that
// imports only ./codes.ts at run time, so the page client's bundle carries no
// Effect.
import type { DocWire } from './api.ts'
import {
  ERRORS,
  isErrorCode,
  type ErrorCode,
  type ErrorFields,
} from './codes.ts'

export type { DocWire } from './api.ts'
export {
  ERRORS,
  exitCodeFor,
  isErrorCode,
  statusFor,
  type ErrorCode,
  type ErrorFields,
} from './codes.ts'
export type {
  BaseBuilds,
  BaseComponentTag,
  BaseGrammar,
  BaseLibraries,
} from './base.ts'

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json }
export type JsonObject = { readonly [key: string]: Json }

/** A file field's stored value: an upload in the writer's own folder. */
export interface UploadRef {
  /** Relative to the writer's own folder in the target: 'files/cv.pdf'. */
  readonly file: string
  readonly name: string
  readonly size: number
  readonly type: string
}

/** Which form a send is for: the page or layout holding it, its target and id. */
export interface FormRef {
  /** The node ID of the page or layout the form sits in. */
  readonly host: string
  /** A tree path: 'questions/answers/' for a folder, 'board.json' for a file. */
  readonly target: string
  readonly id: string | null
}

/** A form Dossier manages, in the composed page's bootstrap. */
export interface FormInfo extends FormRef {
  /** The value of the form's data-dossier-form. */
  readonly n: number
  readonly kind: 'person' | 'entries' | 'shared'
  /** ISO 8601. */
  readonly closesAt: string | null
  readonly closed: boolean
}

/** The key of a form's drafts and pending sends. */
export const formKey = (form: FormRef): string =>
  `${form.host}|${form.target}|${form.id ?? ''}`

/** A form's unsent values by field name: lists for several values. */
export type DraftValues = Readonly<Record<string, string | readonly string[]>>

/**
 * One value of a send: text, a file the shell uploads first, or an upload
 * already stored (a file field kept as it was).
 */
export type SendValue = string | File | UploadRef

export interface SendRequest {
  readonly form: FormRef
  /** The tree's sequence the page was served at. */
  readonly seq: number
  readonly entries: readonly (readonly [string, SendValue])[]
  readonly submitter: { readonly name: string; readonly value: string } | null
  readonly opId: string
}

/** A send the shell keeps until it is answered: after sign-in, or online. */
export interface PendingSend extends SendRequest {
  /** The page's tree path: 'questions/index.html'. */
  readonly page: string
  /** Who sent it; null for a visitor. */
  readonly by: string | null
  /** ISO 8601. */
  readonly savedAt: string
}

const treePath = (path: string): string => path.replace(/^\/+/, '')

const isSegmentName = (name: string): boolean =>
  name !== '' &&
  name !== '.' &&
  name !== '..' &&
  !name.includes('/') &&
  // oxlint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/.test(name)

/**
 * A path a page names, as a tree path: relative to the page like a URL, `/`
 * from the tree's root, and `~` standing for the viewer's email. A folder
 * keeps its trailing slash. Null when it leaves the tree, names nothing, or
 * holds `~` with no email.
 */
export const resolvePath = (
  pagePath: string,
  input: string,
  email: string | null,
): string | null => {
  if (input.includes('~') && email === null) return null
  const page = treePath(pagePath)
  const folder = input.startsWith('/')
    ? []
    : page.includes('/')
      ? page.slice(0, page.lastIndexOf('/')).split('/')
      : []
  const parts = input.split('/')
  const isFolder =
    input === '' ||
    input.endsWith('/') ||
    parts[parts.length - 1] === '.' ||
    parts[parts.length - 1] === '..'
  const out = [...folder]
  for (const raw of parts) {
    const part = raw.replaceAll('~', email ?? '')
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    if (!isSegmentName(part)) return null
    out.push(part)
  }
  if (out.length === 0) return isFolder ? '' : null
  return isFolder ? `${out.join('/')}/` : out.join('/')
}

/**
 * Whether a change at one tree path concerns a watch of another: the same
 * path, one below the other, or either the tree's root. Folders may end in
 * `/`; the rule compares whole segments, so `plan` never meets `plan.json`.
 */
export const pathsMeet = (a: string, b: string): boolean => {
  const x = treePath(a).replace(/\/+$/, '')
  const y = treePath(b).replace(/\/+$/, '')
  return (
    x === '' ||
    y === '' ||
    x === y ||
    x.startsWith(`${y}/`) ||
    y.startsWith(`${x}/`)
  )
}

/** The Doc shape page code sees. */
export interface Doc<T = Json> {
  /** Relative to the page, like a URL: 'answers/sara@acme.com.json'. */
  readonly path: string
  readonly data: T
  /**
   * The writer's email for data; for an authored file the pusher's email to
   * members of the tree's workspace and to the pusher, else the pusher's name.
   */
  readonly by: string
  /** ISO 8601. */
  readonly at: string
  /** The push the writer saw (data), or that wrote it (authored). */
  readonly push: number
}

/** A tree path as a path relative to the page: 'board.json' → '../board.json'. */
export const relativeToPage = (pagePath: string, path: string): string => {
  const from = treePath(pagePath).split('/').slice(0, -1)
  const to = treePath(path).split('/')
  let common = 0
  while (
    common < from.length &&
    common < to.length - 1 &&
    from[common] === to[common]
  ) {
    common += 1
  }
  const up = from.length - common
  return `${'../'.repeat(up)}${to.slice(common).join('/')}`
}

/** The one conversion from the wire to what page code sees. */
export const docFromWire = <T = Json>(
  wire: DocWire,
  pagePath: string,
): Doc<T> => ({
  path: relativeToPage(pagePath, wire.path),
  data: wire.data as T,
  by: wire.by,
  at: wire.at,
  push: wire.push,
})

export const BRIDGE_VERSION = 1 as const
/** The prefix of the boot data the shell puts in a top page's window.name. */
export const WINDOW_NAME_PREFIX = 'dossier-boot:'

export type RoleName = 'read' | 'respond' | 'write'

export interface Me {
  readonly email: string
  readonly name: string
  /** The highest role the viewer holds on this page. */
  readonly role: RoleName
}

/** JSON in the shell document, in `#dossier-shell`. */
export interface ShellBoot {
  readonly v: 1
  readonly deployment: { readonly origin: string; readonly name: string }
  readonly tree: {
    readonly id: string
    readonly workspace: string
    readonly name: string
  }
  /** The tree's own origin, `https://<tree-id>.dossier-content.com`. */
  readonly contentOrigin: string
  /** Tree path of the page or file, `questions/index.html`. */
  readonly path: string
  /** The link of it on the main host. */
  readonly link: string
  /** The link's path inside the tree, `questions/`. */
  readonly linkPath: string
  /** The tree's authored sequence when the shell was served. */
  readonly seq: number
  /** The base layer's version. */
  readonly base: string
  readonly me: { readonly email: string; readonly name: string } | null
}

/** JSON in the composed page, in `#dossier-bootstrap`; alike for every viewer. */
export interface PageBootstrap {
  readonly v: 1
  /** The deployment's main origin, the only target of hello. */
  readonly origin: string
  readonly tree: {
    readonly id: string
    readonly workspace: string
    readonly name: string
  }
  /** From the tree root, `/questions/index.html`. */
  readonly path: string
  readonly link: string
  /** The push number of the page's version at `seq`. */
  readonly push: number
  readonly seq: number
  readonly base: string
  /**
   * Every component available at the page's folder: custom element name →
   * its URL relative to the page, or `/_/base/<version>/_components/<tag>.js`
   * on the page's own content host for a base component.
   */
  readonly kit: Readonly<Record<string, string>>
  /** The kit tags the composed page uses, which the client imports at once. */
  readonly used: readonly string[]
  /** The forms Dossier manages, by their data-dossier-form number. */
  readonly forms: readonly FormInfo[]
}

/** The codes page code's calls reject with. */
export type PageErrorCode =
  | 'forbidden'
  | 'invalid'
  | 'not_mergeable'
  | 'closed'
  | 'too_large'
  | 'rate_limited'
  | 'sign_in_required'
  | 'offline'
  | 'not_in_export'
  | 'unavailable'

export const PAGE_ERROR_CODES: readonly PageErrorCode[] = [
  'forbidden',
  'invalid',
  'not_mergeable',
  'closed',
  'too_large',
  'rate_limited',
  'sign_in_required',
  'offline',
  'not_in_export',
  'unavailable',
]

const PAGE_CODES: ReadonlySet<string> = new Set(PAGE_ERROR_CODES)

export type PageOp = 'read' | 'write' | 'withdraw' | 'upload' | 'watch'

/** What an error answer means for page code's call. */
export type PageOutcome =
  | {
      readonly kind: 'error'
      readonly error: ErrorFields & { readonly code: PageErrorCode }
    }
  /** A read answers null, or [] for a folder. */
  | { readonly kind: 'empty' }
  /** A withdraw resolves: the file is gone either way. */
  | { readonly kind: 'done' }

/**
 * The one mapping from an answer's error to what page code sees: missing
 * reads as nothing, a withdrawal of something gone is done, a write or an
 * upload where nothing may be written is forbidden, the page client's codes
 * pass as they are, and any other code is unavailable with its message.
 */
export const toPageError = (fields: ErrorFields, op: PageOp): PageOutcome => {
  if (fields.code === 'not_found') {
    if (op === 'read' || op === 'watch') return { kind: 'empty' }
    if (op === 'withdraw') return { kind: 'done' }
    return {
      kind: 'error',
      error: {
        code: 'forbidden',
        message: ERRORS.forbidden.message,
        fix: fields.fix,
        path: fields.path,
      },
    }
  }
  if (PAGE_CODES.has(fields.code)) {
    return {
      kind: 'error',
      error: fields as ErrorFields & { readonly code: PageErrorCode },
    }
  }
  return { kind: 'error', error: { ...fields, code: 'unavailable' } }
}

/** In a top page's window.name, after WINDOW_NAME_PREFIX. */
export interface TopBoot {
  readonly v: 1
  readonly me: Me | null
  /** This viewer's drafts on this page, by formKey. */
  readonly drafts: Readonly<Record<string, DraftValues>>
  /** The formKeys whose pending send the shell is replaying. */
  readonly resume: readonly string[]
}

/** Page client → window.top, with exactly one transferred MessagePort. */
export interface Hello {
  readonly dossier: 'hello'
  readonly v: 1
  /** Read from the page's own URL. */
  readonly handle: string
  /** PageBootstrap.path. */
  readonly path: string
  readonly nested: boolean
}

export type ShellToPage =
  | {
      readonly type: 'welcome'
      readonly v: 1
      readonly me: Me | null
      readonly drafts: Readonly<Record<string, DraftValues>>
      readonly resume: readonly string[]
    }
  /** The answer to a request, by its id. */
  | {
      readonly type: 'result'
      readonly id: number
      readonly ok: true
      readonly value: unknown
    }
  | {
      readonly type: 'result'
      readonly id: number
      readonly ok: false
      readonly error: ErrorFields
    }
  /** The answer to a pending send the shell replayed, by formKey. */
  | {
      readonly type: 'resumed'
      readonly form: string
      readonly ok: true
      readonly value: unknown
    }
  | {
      readonly type: 'resumed'
      readonly form: string
      readonly ok: false
      readonly error: ErrorFields
    }
  /** A watched path's value now: at once, then after each change. */
  | {
      readonly type: 'changed'
      readonly sub: number
      readonly value: DocWire | readonly DocWire[] | null
    }

export type PageToShell =
  | {
      readonly type: 'location'
      readonly path: string
      readonly hash: string
      readonly title: string
    }
  /** Another page of this tree; the shell loads it. */
  | { readonly type: 'open'; readonly path: string; readonly hash: string }
  /** Anything else, opened at the top. */
  | { readonly type: 'navigate'; readonly href: string }
  /** A path the page names, as resolvePath reads it. */
  | {
      readonly type: 'request'
      readonly id: number
      readonly op: 'read'
      readonly path: string
    }
  | {
      readonly type: 'request'
      readonly id: number
      readonly op: 'send'
      readonly send: SendRequest
    }
  | {
      readonly type: 'request'
      readonly id: number
      readonly op: 'withdraw'
      readonly path: string
      readonly opId: string
    }
  /** Page code's write: merged into the file, or a new entry for a folder. */
  | {
      readonly type: 'request'
      readonly id: number
      readonly op: 'write'
      readonly path: string
      readonly patch: JsonObject
      readonly replace: boolean
      readonly opId: string
      /** PageBootstrap.seq: the push the writer saw. */
      readonly seq: number
    }
  /** Page code's upload, stored beside the page. */
  | {
      readonly type: 'request'
      readonly id: number
      readonly op: 'upload'
      readonly file: Blob
      readonly name: string
      /** The file's MIME type. */
      readonly contentType: string
      readonly opId: string
      readonly seq: number
    }
  /** Calls `changed` for `sub` at once, then after each relevant change. */
  | {
      readonly type: 'request'
      readonly id: number
      readonly op: 'watch'
      readonly sub: number
      readonly path: string
    }
  | {
      readonly type: 'request'
      readonly id: number
      readonly op: 'unwatch'
      readonly sub: number
    }
  /** A form's unsent values, or null once there are none. */
  | {
      readonly type: 'draft'
      readonly form: string
      readonly values: DraftValues | null
    }

const isRecord = (data: unknown): data is Record<string, unknown> =>
  typeof data === 'object' && data !== null && !Array.isArray(data)

const isString = (value: unknown): value is string => typeof value === 'string'

const ROLES: ReadonlySet<unknown> = new Set(['read', 'respond', 'write'])

const isMe = (value: unknown): value is Me =>
  isRecord(value) &&
  isString(value.email) &&
  isString(value.name) &&
  ROLES.has(value.role)

export const isHello = (data: unknown): data is Hello =>
  isRecord(data) &&
  data.dossier === 'hello' &&
  data.v === BRIDGE_VERSION &&
  isString(data.handle) &&
  isString(data.path) &&
  typeof data.nested === 'boolean'

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isString)

const isDraftValues = (value: unknown): value is DraftValues =>
  isRecord(value) &&
  Object.values(value).every((v) => isString(v) || isStringList(v))

const isDrafts = (
  value: unknown,
): value is Readonly<Record<string, DraftValues>> =>
  isRecord(value) && Object.values(value).every(isDraftValues)

const isErrorFields = (value: unknown): value is ErrorFields =>
  isRecord(value) &&
  isErrorCode(value.code) &&
  isString(value.message) &&
  (value.fix === null || isString(value.fix)) &&
  (value.path === null || isString(value.path))

/** An answer's outcome: a value, or the error fields. */
const isOutcome = (data: Record<string, unknown>): boolean =>
  data.ok === true
    ? 'value' in data
    : data.ok === false && isErrorFields(data.error)

export const isShellToPage = (data: unknown): data is ShellToPage => {
  if (!isRecord(data)) return false
  switch (data.type) {
    case 'welcome':
      return (
        data.v === BRIDGE_VERSION &&
        (data.me === null || isMe(data.me)) &&
        isDrafts(data.drafts) &&
        isStringList(data.resume)
      )
    case 'result':
      return Number.isInteger(data.id) && isOutcome(data)
    case 'resumed':
      return isString(data.form) && isOutcome(data)
    case 'changed':
      return (
        Number.isInteger(data.sub) &&
        (data.value === null ||
          isRecord(data.value) ||
          Array.isArray(data.value))
      )
    default:
      return false
  }
}

const isFormRef = (value: unknown): value is FormRef =>
  isRecord(value) &&
  isString(value.host) &&
  isString(value.target) &&
  (value.id === null || isString(value.id))

const isUploadRef = (value: unknown): value is UploadRef =>
  isRecord(value) &&
  isString(value.file) &&
  isString(value.name) &&
  typeof value.size === 'number' &&
  isString(value.type)

const isSendValue = (value: unknown): value is SendValue =>
  isString(value) ||
  isUploadRef(value) ||
  (typeof File !== 'undefined' && value instanceof File)

export const isSendRequest = (value: unknown): value is SendRequest =>
  isRecord(value) &&
  isFormRef(value.form) &&
  Number.isInteger(value.seq) &&
  Array.isArray(value.entries) &&
  value.entries.every(
    (entry: unknown) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      isString(entry[0]) &&
      isSendValue(entry[1]),
  ) &&
  (value.submitter === null ||
    (isRecord(value.submitter) &&
      isString(value.submitter.name) &&
      isString(value.submitter.value))) &&
  isString(value.opId)

export const isPageToShell = (data: unknown): data is PageToShell => {
  if (!isRecord(data)) return false
  switch (data.type) {
    case 'location':
      return isString(data.path) && isString(data.hash) && isString(data.title)
    case 'open':
      return isString(data.path) && isString(data.hash)
    case 'navigate':
      return isString(data.href)
    case 'request':
      if (!Number.isInteger(data.id)) return false
      switch (data.op) {
        case 'read':
          return isString(data.path)
        case 'send':
          return isSendRequest(data.send)
        case 'withdraw':
          return isString(data.path) && isString(data.opId)
        case 'write':
          return (
            isString(data.path) &&
            isRecord(data.patch) &&
            typeof data.replace === 'boolean' &&
            isString(data.opId) &&
            Number.isInteger(data.seq)
          )
        case 'upload':
          return (
            typeof Blob !== 'undefined' &&
            data.file instanceof Blob &&
            isString(data.name) &&
            isString(data.contentType) &&
            isString(data.opId) &&
            Number.isInteger(data.seq)
          )
        case 'watch':
          return Number.isInteger(data.sub) && isString(data.path)
        case 'unwatch':
          return Number.isInteger(data.sub)
        default:
          return false
      }
    case 'draft':
      return (
        isString(data.form) &&
        (data.values === null || isDraftValues(data.values))
      )
    default:
      return false
  }
}

/** Reads `TopBoot` from a window name, or null when it is not boot data. */
export const readTopBoot = (name: string): TopBoot | null => {
  if (!name.startsWith(WINDOW_NAME_PREFIX)) return null
  try {
    const value: unknown = JSON.parse(name.slice(WINDOW_NAME_PREFIX.length))
    if (!isRecord(value) || value.v !== BRIDGE_VERSION) return null
    if (value.me !== null && !isMe(value.me)) return null
    return {
      v: 1,
      me: value.me,
      drafts: isDrafts(value.drafts) ? value.drafts : {},
      resume: isStringList(value.resume) ? value.resume : [],
    }
  } catch {
    return null
  }
}

/** The page client's error: the same fields as the API's error body. */
export class DossierError extends Error implements ErrorFields {
  override readonly name = 'DossierError'
  readonly code: ErrorCode
  readonly fix: string | null
  readonly path: string | null
  constructor(fields: ErrorFields) {
    super(fields.message)
    this.code = fields.code
    this.fix = fields.fix
    this.path = fields.path
  }
}
