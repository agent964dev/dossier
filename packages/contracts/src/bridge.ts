// The shell and page client's shared vocabulary. Plain TypeScript that
// imports only ./codes.ts, so the page client's bundle carries no Effect.
import type { ErrorCode, ErrorFields } from './codes.ts'

export {
  ERRORS,
  exitCodeFor,
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
}

/** In a top page's window.name, after WINDOW_NAME_PREFIX. */
export interface TopBoot {
  readonly v: 1
  readonly me: Me | null
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

export type ShellToPage = {
  readonly type: 'welcome'
  readonly v: 1
  readonly me: Me | null
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

export const isShellToPage = (data: unknown): data is ShellToPage =>
  isRecord(data) &&
  data.type === 'welcome' &&
  data.v === BRIDGE_VERSION &&
  (data.me === null || isMe(data.me))

export const isPageToShell = (data: unknown): data is PageToShell => {
  if (!isRecord(data)) return false
  switch (data.type) {
    case 'location':
      return isString(data.path) && isString(data.hash) && isString(data.title)
    case 'open':
      return isString(data.path) && isString(data.hash)
    case 'navigate':
      return isString(data.href)
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
    return { v: 1, me: value.me }
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
