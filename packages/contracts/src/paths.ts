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
