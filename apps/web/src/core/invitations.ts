import { dossierError, type DossierError } from '@dossier/contracts'
import { Effect } from 'effect'

/**
 * The statements that turn the invitations to a person's current email into
 * memberships, with the teams each names that still exist, and delete them.
 * Invitations to deleted workspaces wait for the purge. The first statement
 * reads the names of the workspaces joined.
 */
export const claimStatements = (
  DB: D1Database,
  person: { readonly id: string },
  now: number,
): readonly D1PreparedStatement[] => {
  const invited = `select i.workspace_id, i.team_ids_json from invitations i
    join workspaces w on w.id = i.workspace_id
    where i.email = (select lower(email) from "user" where id = ?1)
      and w.deleted_at is null`
  return [
    DB.prepare(
      `select w.name from (${invited}) i join workspaces w on w.id = i.workspace_id
       where not exists (select 1 from workspace_members m
         where m.workspace_id = i.workspace_id and m.user_id = ?1)
       order by w.name`,
    ).bind(person.id),
    DB.prepare(
      `insert into workspace_members (workspace_id, user_id, role, created_at)
       select i.workspace_id, ?1, 'member', ?2 from (${invited}) i
       where true
       on conflict do nothing`,
    ).bind(person.id, now),
    DB.prepare(
      `insert into team_members (team_id, user_id, created_at)
       select t.id, ?1, ?2 from (${invited}) i, json_each(i.team_ids_json) j
       join teams t on t.id = j.value and t.workspace_id = i.workspace_id
       where true
       on conflict do nothing`,
    ).bind(person.id, now),
    DB.prepare(
      `delete from invitations
       where email = (select lower(email) from "user" where id = ?1)
         and workspace_id in (select id from workspaces where deleted_at is null)`,
    ).bind(person.id),
  ]
}

/** Claims a person's invitations in one batch; the workspace names joined. */
export const claimInvitations = (
  DB: D1Database,
  person: { readonly id: string },
  now: number,
): Effect.Effect<readonly string[], DossierError<'unavailable'>> =>
  Effect.tryPromise({
    try: () => DB.batch([...claimStatements(DB, person, now)]),
    catch: (error) => {
      console.error('Claiming invitations failed', error)
      return dossierError('unavailable')
    },
  }).pipe(
    Effect.map(([names]) =>
      ((names?.results ?? []) as { name: string }[]).map((row) => row.name),
    ),
  )
