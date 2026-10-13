// "mentioned you": a mention of the person on a page, in a comment that still
// names them, newer than their last Seen by of that page.
import { dossierError, type NodeId, type TreeId } from '@dossier/contracts'
import { Effect } from 'effect'

export interface UnseenMention {
  readonly pageId: NodeId
  readonly treeId: TreeId
  /** The page's tree path. */
  readonly path: string
}

/** Every page on which the person has a mention they have not seen yet. */
export const unseenMentions = (
  DB: D1Database,
  person: { readonly id: string; readonly email: string },
) =>
  Effect.tryPromise({
    try: () =>
      DB.prepare(
        `select distinct m.page_node_id as pageId, p.tree_id as treeId, p.path
         from mentions m
           join nodes c on c.id = m.comment_node_id and c.deleted_at is null
           join node_versions v on v.id = c.current_version_id
           join nodes p on p.id = m.page_node_id and p.deleted_at is null
           join trees t on t.id = p.tree_id and t.deleted_at is null
           left join seen_by s on s.node_id = m.page_node_id and s.user_id = ?2
         where m.email = lower(?1)
           and (s.last_seen_at is null or m.created_at > s.last_seen_at)
           and json_extract(v.json_value, '$.text') <> ''
           and exists (select 1 from json_each(v.json_value, '$.mentions') j
             where j.value = m.email)`,
      )
        .bind(person.email, person.id)
        .all<UnseenMention>(),
    catch: (error) => {
      console.error('A mentions read failed', error)
      return dossierError('unavailable')
    },
  }).pipe(Effect.map((rows) => rows.results))

/** Whether one of these mentions is on a page at or below a tree path. */
export const mentionedAt = (
  mentions: readonly UnseenMention[],
  node: {
    readonly id: string
    readonly treeId: string
    readonly kind: string
    readonly path: string
  },
): boolean =>
  mentions.some(
    (m) =>
      m.treeId === node.treeId &&
      (node.kind !== 'folder'
        ? m.pageId === node.id
        : node.path === '' || m.path.startsWith(`${node.path}/`)),
  )

/** A member's tree row: a mention waits on any page of the tree. */
export const mentionedInTree = (
  mentions: readonly UnseenMention[],
  treeId: string,
): boolean => mentions.some((m) => m.treeId === treeId)

/** A listing's page row: a mention waits on that page. */
export const mentionedOnPage = (
  mentions: readonly UnseenMention[],
  treeId: string,
  pagePath: string,
): boolean => mentions.some((m) => m.treeId === treeId && m.path === pagePath)
