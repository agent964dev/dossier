import { Schema } from 'effect'

import { isTreeName, isWorkspaceName, NAME_RULE } from './paths.ts'

/** A workspace's name in links: never `api` or `cli`. */
export const WorkspaceName: Schema.Schema<string> = Schema.String.pipe(
  Schema.filter((name) => isWorkspaceName(name) || NAME_RULE),
)

/** A tree's name in links. */
export const TreeName: Schema.Schema<string> = Schema.String.pipe(
  Schema.filter((name) => isTreeName(name) || NAME_RULE),
)
