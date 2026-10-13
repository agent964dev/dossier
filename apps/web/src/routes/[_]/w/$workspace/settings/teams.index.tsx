import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Plus, Users } from 'lucide-react'
import { useState } from 'react'

import { MenuButton, RowMenu } from '../../../../../components/row-menu'
import { ROW, RowList } from '../../../../../components/settings-parts'
import { Button } from '../../../../../components/ui/button'
import type { TeamRef } from '../../../../../core/index'
import {
  teamsView,
  type TeamsView,
} from '../../../../../server/workspace-settings'
import { Tab, tabRead } from './-tab'
import { DeleteTeamDialog, NameDialog } from './-team-dialogs'

export const Route = createFileRoute('/_/w/$workspace/settings/teams/')({
  loader: async ({ params, location }) =>
    tabRead(
      await teamsView({ data: { workspace: params.workspace } }),
      location.href,
    ),
  component: () => (
    <Tab read={Route.useLoaderData()}>
      {(view: TeamsView) => <Teams view={view} />}
    </Tab>
  ),
})

const membersText = (count: number) =>
  count === 1 ? '1 member' : `${count} members`

function Teams({ view }: { view: TeamsView }) {
  const router = useRouter()
  const [naming, setNaming] = useState<{ team: TeamRef | null } | null>(null)
  const [deleting, setDeleting] = useState<TeamRef | null>(null)
  const refresh = () => router.invalidate()

  return (
    <div className="flex flex-col gap-4">
      {view.teams.length === 0 ? (
        <p className="text-[0.9375rem] text-neutral-400">No teams yet.</p>
      ) : (
        <RowList label="Teams">
          {view.teams.map((team) => (
            <li key={team.id} className={ROW}>
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-300"
              >
                <Users className="size-4" />
              </span>
              <Link
                to="/_/w/$workspace/settings/teams/$team"
                params={{ workspace: view.workspace, team: team.id }}
                className="min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="block truncate text-[0.9375rem] text-neutral-50 hover:text-brand-100">
                  {team.name}
                </span>
                <span className="block font-mono text-xs text-neutral-400">
                  {membersText(team.members)}
                </span>
              </Link>
              <RowMenu label={`More for ${team.name}`}>
                <MenuButton onSelect={() => setNaming({ team })}>
                  Rename
                </MenuButton>
                <MenuButton destructive onSelect={() => setDeleting(team)}>
                  Delete
                </MenuButton>
              </RowMenu>
            </li>
          ))}
        </RowList>
      )}
      <Button className="w-fit" onClick={() => setNaming({ team: null })}>
        <Plus aria-hidden />
        New team
      </Button>
      <NameDialog
        key={naming === null ? 'closed' : (naming.team?.id ?? 'new')}
        open={naming !== null}
        workspace={view.workspace}
        team={naming?.team ?? null}
        onClose={() => setNaming(null)}
        onSaved={async () => {
          setNaming(null)
          await refresh()
        }}
      />
      <DeleteTeamDialog
        workspace={view.workspace}
        team={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={refresh}
      />
    </div>
  )
}
