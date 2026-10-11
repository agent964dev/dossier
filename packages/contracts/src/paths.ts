// Plain TypeScript with no Effect import, so browser code can use it.
import type { TreeId } from './ids.ts'

/** Stands for a tree's ID in the content host pattern. */
export const TREE_TOKEN = '{tree}'

const TREE_LABEL = /^[a-z0-9]+$/

/**
 * A tree's own origin, the one place it is derived. Every content host is
 * served over HTTPS, locally too.
 */
export const contentOrigin = (contentHost: string, treeId: TreeId): string =>
  `https://${contentHost.replace(TREE_TOKEN, treeId)}`

/**
 * The tree a content host serves: the part of the host `{tree}` stands for,
 * when it is lowercase letters and digits only; otherwise null.
 */
export const treeIdForHost = (
  contentHost: string,
  host: string,
): TreeId | null => {
  const at = contentHost.indexOf(TREE_TOKEN)
  if (at < 0) return null
  const prefix = contentHost.slice(0, at)
  const suffix = contentHost.slice(at + TREE_TOKEN.length)
  const lower = host.toLowerCase()
  if (lower.length <= prefix.length + suffix.length) return null
  if (!lower.startsWith(prefix) || !lower.endsWith(suffix)) return null
  const label = lower.slice(prefix.length, lower.length - suffix.length)
  return TREE_LABEL.test(label) ? (label as TreeId) : null
}

/** The rule every workspace and tree name follows, in words. */
export const NAME_RULE =
  'Use 1 to 63 lowercase letters, digits and hyphens, not starting with a hyphen.'

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
/** Workspace names CLI 0.2.x calls under, kept for its upgrade error. */
export const RESERVED_WORKSPACE_NAMES: ReadonlySet<string> = new Set([
  'api',
  'cli',
])

export const isTreeName = (name: string): boolean => NAME.test(name)

export const isWorkspaceName = (name: string): boolean =>
  NAME.test(name) && !RESERVED_WORKSPACE_NAMES.has(name)

/** The deepest a node sits below its tree's root. */
export const MAX_DEPTH = 32

// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const encoder = new TextEncoder()

/**
 * A folder or file name: not empty, `.` or `..`; no `/`, NUL or control
 * characters; at most 255 bytes of UTF-8.
 */
export const isNodeName = (name: string): boolean =>
  name !== '' &&
  name !== '.' &&
  name !== '..' &&
  !name.includes('/') &&
  !CONTROL.test(name) &&
  encoder.encode(name).length <= 255

/** A `_` file or folder: inherited below, never listed as a page. */
export const isKitName = (name: string): boolean => name.startsWith('_')

/** A page is a `.html` file, or a folder holding `index.html`. */
export const isPageFile = (path: string): boolean => path.endsWith('.html')

/** A node in a tree, as a link or a CLI argument names it. */
export interface LinkRef {
  readonly workspace: string
  readonly tree: string
  /** Inside the tree, without a leading or trailing slash; '' is the root. */
  readonly path: string
  /** True for a trailing slash, and for the tree's root. */
  readonly folder: boolean
}

const fromSegments = (
  segments: readonly string[],
  decode: boolean,
): LinkRef | null => {
  const [workspace = '', tree = '', ...rest] = segments
  if (!isWorkspaceName(workspace) || !isTreeName(tree)) return null
  const trailing = rest.length > 0 && rest[rest.length - 1] === ''
  const named = trailing ? rest.slice(0, -1) : rest
  const path: string[] = []
  for (const segment of named) {
    let name = segment
    if (decode) {
      try {
        name = decodeURIComponent(segment)
      } catch {
        return null
      }
    }
    if (!isNodeName(name)) return null
    path.push(name)
  }
  if (path.length > MAX_DEPTH) return null
  return {
    workspace,
    tree,
    path: path.join('/'),
    folder: trailing || path.length === 0,
  }
}

/**
 * Reads `agent964/acme/questions`, `agent964/acme/`, or a link on this
 * deployment. Anything else, a link to another host included, is null.
 */
export const parseTarget = (
  input: string,
  deploymentOrigin: URL,
): LinkRef | null => {
  const trimmed = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return null
    }
    if (url.host !== deploymentOrigin.host) return null
    return fromSegments(url.pathname.slice(1).split('/'), true)
  }
  const relative = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
  return fromSegments(relative.split('/'), false)
}

export type LinkKind = 'page' | 'folder' | 'file'

const encodePath = (path: string): string =>
  path === '' ? '' : path.split('/').map(encodeURIComponent).join('/')

/**
 * The one function for every absolute URL Dossier writes. A page `a/b.html`
 * is `/ws/tree/a/b`, `a/index.html` is `/ws/tree/a/`, a folder `a` is
 * `/ws/tree/a/`, and any other file keeps its exact path.
 */
export const linkFor = (
  origin: URL | string,
  at: {
    readonly workspace: string
    readonly tree: string
    readonly path: string
    readonly kind: LinkKind
  },
): string => {
  const base =
    typeof origin === 'string' ? new URL(origin).origin : origin.origin
  let path = at.path
  let folder = at.kind === 'folder'
  if (at.kind === 'page') {
    if (path === 'index.html' || path.endsWith('/index.html')) {
      path = path.slice(0, -'index.html'.length).replace(/\/$/, '')
      folder = true
    } else if (path.endsWith('.html')) {
      path = path.slice(0, -'.html'.length)
    }
  }
  const tail = encodePath(path)
  const slash = folder && tail !== '' ? '/' : ''
  return `${base}/${encodeURIComponent(at.workspace)}/${encodeURIComponent(at.tree)}/${tail}${slash}`
}
