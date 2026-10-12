// Which of a tree's events a caller may see, and where: the one rule the
// events route and the watch hints follow, written as SQL over a table of
// callers so that one query answers for one caller or for hundreds.
import type { TreeId } from '@dossier/contracts'
import { sql, type SQL } from 'drizzle-orm'

import {
  nodeColumn,
  readableOn,
  underColumn,
  type CallerFacts,
} from './access.ts'
import type { Caller } from './caller.ts'

/** A caller as the SQL table `cs` holds it. */
export interface CallerRef {
  readonly person: string | null
  /** Lower-cased. */
  readonly email: string | null
  /** The node an agent key is limited to. */
  readonly scope: string | null
}

/** The caller of a request, or null for one who reads nothing in a tree. */
export const callerRefOf = (
  caller: Caller,
  treeId: TreeId,
): CallerRef | null => {
  if (caller.via.kind === 'system') return null
  if (caller.via.kind === 'handle' && caller.via.treeId !== treeId) return null
  return {
    person: caller.person?.id ?? null,
    email: caller.person?.email.toLowerCase() ?? null,
    scope: caller.via.kind === 'agent' ? caller.via.scope : null,
  }
}

/**
 * The CTE `cs (i, person, email, scope_id, scope_path, role, teams)`: each
 * caller, indexed from 0 in the order given, with their place in the tree's
 * workspace.
 */
export const callersCte = (
  treeId: TreeId,
  workspaceId: string,
  callers: readonly CallerRef[],
): SQL => sql`cs as (select c.key as i,
    json_extract(c.value, '$.person') as person,
    json_extract(c.value, '$.email') as email,
    json_extract(c.value, '$.scope') as scope_id,
    (select sn.path from nodes sn where sn.id = json_extract(c.value, '$.scope')
       and sn.tree_id = ${treeId} and sn.deleted_at is null) as scope_path,
    (select m.role from workspace_members m where m.workspace_id = ${workspaceId}
       and m.user_id = json_extract(c.value, '$.person')) as role,
    (select json_group_array(tm.team_id) from team_members tm
       join teams tt on tt.id = tm.team_id
       where tt.workspace_id = ${workspaceId}
         and tm.user_id = json_extract(c.value, '$.person')) as teams
  from json_each(${JSON.stringify(callers)}) c)`

/** The facts of the caller in the current row of `cs`. */
const csFacts: CallerFacts = {
  email: sql`cs.email`,
  person: sql`cs.person`,
  member: sql`(cs.role is not null)`,
  admin: sql`(cs.role = 'admin')`,
  teams: sql`(case when cs.role is not null then cs.teams else '[]' end)`,
  // A key whose node is gone reaches nothing.
  within: (path) =>
    sql`(cs.scope_id is null or (cs.scope_path is not null
      and ${underColumn(path, sql`cs.scope_path`)}))`,
}

/** Whole segments, either root, trailing slashes ignored: pathsMeet in SQL. */
export const meetsSql = (a: SQL, b: SQL): SQL => {
  const x = sql`rtrim(${a}, '/')`
  const y = sql`rtrim(${b}, '/')`
  return sql`(${x} = '' or ${y} = '' or ${x} = ${y}
    or substr(${x}, 1, length(${y}) + 1) = ${y} || '/'
    or substr(${y}, 1, length(${x}) + 1) = ${x} || '/')`
}

/**
 * Holds when the event `e` is one the caller in the current row of `cs` may
 * see at a path meeting `path` (NULL for any path): its own node is readable
 * there, or it is a push and a node it versioned is readable there, or it has
 * no node and the folder its path lies in is readable. A push of a folder
 * above what someone reads is seen through what it changed there.
 */
export const visibleEventSql = (
  treeId: TreeId,
  workspaceId: string,
  path: SQL,
): SQL => {
  const read = readableOn(treeId, workspaceId, csFacts)(nodeColumn)
  const at = (p: SQL) => sql`(${path} is null or ${meetsSql(p, path)})`
  return sql`(exists (select 1 from nodes where nodes.id = e.node_id and ${read}
        and ${at(sql`e.path`)})
    or (e.type = 'push' and e.push_id is not null and exists (
        select 1 from node_versions v join nodes on nodes.id = v.node_id
        where v.push_id = e.push_id and ${read} and ${at(sql`nodes.path`)}))
    or (e.node_id is null and ${at(sql`e.path`)} and coalesce((
        select case when ${read} then 1 else 0 end from nodes
        where nodes.tree_id = ${treeId} and nodes.deleted_at is null
          and (nodes.path = ''
            or substr(e.path, 1, length(nodes.path) + 1) = nodes.path || '/')
        order by nodes.depth desc limit 1), 0) = 1))`
}
