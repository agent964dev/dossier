import type {
  NodeId,
  PushId,
  ShareId,
  TreeId,
  VersionId,
  WorkspaceId,
} from '@dossier/contracts'

import type {
  events,
  nodes,
  nodeVersions,
  pushes,
  shares,
  trees,
  workspaces,
} from '../db/schema.ts'

export type WorkspaceRow = typeof workspaces.$inferSelect & {
  readonly id: WorkspaceId
}
export type TreeRow = typeof trees.$inferSelect & {
  readonly id: TreeId
  readonly workspaceId: WorkspaceId
}
export type NodeRow = typeof nodes.$inferSelect & {
  readonly id: NodeId
  readonly treeId: TreeId
}
export type VersionRow = typeof nodeVersions.$inferSelect & {
  readonly id: VersionId
}
export type PushRow = typeof pushes.$inferSelect & { readonly id: PushId }
export type ShareRow = typeof shares.$inferSelect & { readonly id: ShareId }
export type EventRow = typeof events.$inferSelect

/** A node a link names that does not exist, or not in a tree that does. */
export interface MissingNode {
  readonly missing: true
  readonly treeId: TreeId | null
  readonly path: string
}

export const isMissing = (node: NodeRow | MissingNode): node is MissingNode =>
  'missing' in node

export type { EventType } from '@dossier/contracts'

/** Every prefix of a tree path, root first: 'a/b' → ['', 'a', 'a/b']. */
export const ancestorPaths = (path: string): readonly string[] => {
  if (path === '') return ['']
  const parts = path.split('/')
  return ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))]
}

/** SQL that holds when `column` is `prefix` or lies below it. */
export const underSql = (column: string, prefix: string): string =>
  `(${prefix} = '' or ${column} = ${prefix} or substr(${column}, 1, length(${prefix}) + 1) = ${prefix} || '/')`
