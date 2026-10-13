// "mentioned you": an unread notification of a mention of the person on a
// page, in a comment that still names them (by their email, or by the team
// that reached them). Reading the notification, or opening the page, reads
// it.
import { dossierError, type NodeId, type TreeId } from '@dossier/contracts'
import { Effect } from 'effect'

export interface UnseenMention {
  readonly pageId: NodeId
  readonly treeId: TreeId
  /** The page's tree path. */
  readonly path: string
}

/** Every page on which the person has a mention they have not read yet. */
export const unseenMentions = (
  DB: D1Database,
  person: { readonly id: string; readonly email: string },
) =>
  Effect.tryPromise({
    try: () =>
      DB.prepare(
        `select distinct n.page_node_id as pageId, p.tree_id as treeId, p.path
         from notifications n
           join nodes c on c.id = n.comment_node_id and c.deleted_at is null
           join node_versions v on v.id = c.current_version_id
           join nodes p on p.id = n.page_node_id and p.deleted_at is null
           join trees t on t.id = p.tree_id and t.deleted_at is null
         where n.email = lower(?1) and n.read_at is null and n.type = 'mention'
           and json_extract(v.json_value, '$.text') <> ''
           and exists (select 1 from json_each(v.json_value, '$.mentions') j
             where j.value = coalesce(n.via, n.email))`,
      )
        .bind(person.email)
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

const read = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      console.error(`${what} failed`, error)
      return dossierError('unavailable')
    },
  })

/** Whether the person is a member of the workspace. */
export const isMemberOf = (
  DB: D1Database,
  workspaceId: string,
  personId: string,
) =>
  read('A membership read', () =>
    DB.prepare(
      'select 1 as one from workspace_members where workspace_id = ? and user_id = ?',
    )
      .bind(workspaceId, personId)
      .first<{ one: number }>(),
  ).pipe(Effect.map((row) => row !== null))

/**
 * The members of the workspace's teams with these names, whatever their
 * case, by lower-cased name: lower-cased emails of people who still have
 * an account and are still members of the workspace.
 */
export const teamMembersByName = (
  DB: D1Database,
  workspaceId: string,
  names: readonly string[],
) =>
  read('A team members read', () =>
    DB.prepare(
      `select lower(t.name) as team, lower(u.email) as email
       from teams t
         join team_members tm on tm.team_id = t.id
         join workspace_members wm on wm.workspace_id = t.workspace_id
           and wm.user_id = tm.user_id
         join "user" u on u.id = tm.user_id
         join people p on p.user_id = u.id and p.deleted_at is null
       where t.workspace_id = ?1
         and lower(t.name) in (select lower(value) from json_each(?2))
       order by lower(u.email)`,
    )
      .bind(workspaceId, JSON.stringify(names))
      .all<{ team: string; email: string }>(),
  ).pipe(
    Effect.map((rows) => {
      const out = new Map<string, string[]>()
      for (const row of rows.results) {
        const list = out.get(row.team) ?? []
        list.push(row.email)
        out.set(row.team, list)
      }
      return out as ReadonlyMap<string, readonly string[]>
    }),
  )

/**
 * How many candidates are read at a time before who can open the page is
 * checked, and how many such batches at most.
 */
export const CANDIDATES_MAX = 50
export const CANDIDATE_BATCHES_MAX = 10

/** A photo only by an https address. */
const imageOf = (image: string | null): string | null =>
  image !== null && /^https:\/\/[^\s"'<>]+$/i.test(image) ? image : null

export interface MentionCandidate {
  readonly email: string
  readonly name: string | null
  readonly image: string | null
}

/**
 * Who a member could mention on a page, before who can open it is checked:
 * the workspace's members with an account, and the emails the page or a
 * folder above it is shared with, whose name or email holds `query`
 * (lower-cased), those it starts first, then by name and email, without
 * `me`.
 */
export const mentionCandidates = (
  DB: D1Database,
  i: {
    readonly workspaceId: string
    readonly treeId: string
    /** The tree paths of the page and every folder above it. */
    readonly line: readonly string[]
    readonly query: string
    readonly me: string
    /** How many candidates earlier batches read. */
    readonly offset?: number
  },
) =>
  read('A mention candidates read', () =>
    DB.prepare(
      `with c(email, name, image) as (
         select lower(u.email), u.name, u.image from workspace_members m
           join "user" u on u.id = m.user_id
           join people p on p.user_id = u.id and p.deleted_at is null
         where m.workspace_id = ?1
         union
         select s.target,
           (select u.name from "user" u join people p on p.user_id = u.id
             where lower(u.email) = s.target and p.deleted_at is null limit 1),
           (select u.image from "user" u join people p on p.user_id = u.id
             where lower(u.email) = s.target and p.deleted_at is null limit 1)
         from shares s join nodes a on a.id = s.node_id and a.deleted_at is null
         where s.tree_id = ?2 and s.target_kind = 'email'
           and a.path in (select value from json_each(?3)))
       select email, max(name) as name, max(image) as image,
         min(case when substr(email, 1, length(?4)) = ?4
           or substr(lower(coalesce(name, '')), 1, length(?4)) = ?4
           or instr(lower(coalesce(name, '')), ' ' || ?4) > 0 then 0 else 1 end) as rank
       from c
       where email <> ?5
         and (?4 = '' or instr(email, ?4) > 0
           or instr(lower(coalesce(name, '')), ?4) > 0)
       group by email
       order by rank, lower(coalesce(nullif(max(name), ''), email)), email
       limit ${CANDIDATES_MAX} offset ?6`,
    )
      .bind(
        i.workspaceId,
        i.treeId,
        JSON.stringify(i.line),
        i.query,
        i.me,
        i.offset ?? 0,
      )
      .all<{ email: string; name: string | null; image: string | null }>(),
  ).pipe(
    Effect.map((rows) =>
      rows.results.map((row): MentionCandidate => ({
        email: row.email,
        name: row.name === null || row.name === '' ? null : row.name,
        image: imageOf(row.image),
      })),
    ),
  )

/**
 * The workspace's teams whose name holds `query` (lower-cased) and whose
 * members open the page through a team share or a workspace share on it or
 * a folder above it, with how many members they have; those it starts
 * first, then by name. Teams with nobody in them are left out.
 */
export const mentionTeams = (
  DB: D1Database,
  i: {
    readonly workspaceId: string
    readonly treeId: string
    readonly line: readonly string[]
    readonly query: string
    readonly max: number
  },
) =>
  read('A mention teams read', () =>
    DB.prepare(
      `select t.name, (select count(*) from team_members tm
           join workspace_members wm on wm.workspace_id = t.workspace_id
             and wm.user_id = tm.user_id
           join people p on p.user_id = tm.user_id and p.deleted_at is null
           where tm.team_id = t.id) as members
       from teams t
       where t.workspace_id = ?1
         and (?4 = '' or instr(lower(t.name), ?4) > 0)
         and exists (select 1 from shares s
           join nodes a on a.id = s.node_id and a.deleted_at is null
           where s.tree_id = ?2 and a.path in (select value from json_each(?3))
             and ((s.target_kind = 'team' and s.target = t.id)
               or (s.target_kind = 'workspace' and s.target = ?1)))
         and members > 0
       order by case when substr(lower(t.name), 1, length(?4)) = ?4 then 0 else 1 end,
         lower(t.name)
       limit ?5`,
    )
      .bind(i.workspaceId, i.treeId, JSON.stringify(i.line), i.query, i.max)
      .all<{ name: string; members: number }>(),
  ).pipe(Effect.map((rows) => rows.results))
