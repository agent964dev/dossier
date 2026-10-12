import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { MenuButton, RowMenu } from '../../../../../components/row-menu'
import { SectionLabel } from '../../../../../components/section-label'
import {
  Initial,
  Refusal,
  refusalOf,
  ROW,
  RowList,
} from '../../../../../components/settings-parts'
import { Button } from '../../../../../components/ui/button'
import { Modal } from '../../../../../components/ui/modal'
import type { TeamRef } from '../../../../../core/index'
import {
  addToTeam,
  moveToTeam,
  removeFromTeam,
  teamView,
  type TeamView,
} from '../../../../../server/workspace-settings'
import { Tab, tabRead } from './-tab'
import { DeleteTeamDialog, NameDialog } from './-team-dialogs'

export const Route = createFileRoute('/_/w/$workspace/settings/teams/$team')({
  loader: async ({ params, location }) =>
    tabRead(
      await teamView({
        data: { workspace: params.workspace, teamId: params.team },
      }),
      location.href,
    ),
  component: () => (
    <Tab read={Route.useLoaderData()}>
      {(view: TeamView) => <Team view={view} />}
    </Tab>
  ),
})

function Team({ view }: { view: TeamView }) {
  const router = useRouter()
  const navigate = useNavigate()
  const { team, workspace } = view
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState<TeamRef | null>(null)
  const [adding, setAdding] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const refresh = () => router.invalidate()

  const act = async (result: Promise<unknown>) => {
    setRefused(null)
    setRefused(refusalOf(await result))
    await refresh()
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="min-w-0 font-clash text-[1.375rem] font-semibold tracking-[-0.02em] break-words text-neutral-50">
          {team.name}
        </h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setRenaming(true)}>
            <Pencil aria-hidden />
            Rename
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleting({ id: team.id, name: team.name })}
          >
            <Trash2 aria-hidden />
            Delete
          </Button>
        </div>
      </div>

      <section
        aria-labelledby="team-members-label"
        className="flex flex-col gap-3"
      >
        <SectionLabel id="team-members-label" count={team.members.length}>
          Members
        </SectionLabel>
        {team.members.length === 0 ? (
          <p className="text-[0.9375rem] text-neutral-400">
            No members in {team.name} yet.
          </p>
        ) : (
          <RowList>
            {team.members.map((member) => {
              const who = member.isMe ? 'You' : member.person.email
              const destinations = view.otherTeams.filter(
                (other) => !member.otherTeams.includes(other.name),
              )
              return (
                <li key={member.person.id} className={ROW}>
                  <Initial of={who} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.9375rem] text-neutral-50">
                      {who}
                    </span>
                    {member.otherTeams.length === 0 ? null : (
                      <span className="block truncate font-mono text-xs text-neutral-400">
                        also in {member.otherTeams.join(', ')}
                      </span>
                    )}
                  </span>
                  <RowMenu label={`Move ${who} to`} trigger="Move to">
                    {destinations.map((other) => (
                      <MenuButton
                        key={other.id}
                        onSelect={() =>
                          act(
                            moveToTeam({
                              data: {
                                workspace,
                                from: team.id,
                                to: other.id,
                                userId: member.person.id,
                              },
                            }),
                          )
                        }
                      >
                        {other.name}
                      </MenuButton>
                    ))}
                    <MenuButton
                      destructive
                      onSelect={() =>
                        act(
                          removeFromTeam({
                            data: {
                              workspace,
                              teamId: team.id,
                              userId: member.person.id,
                            },
                          }),
                        )
                      }
                    >
                      Remove from team
                    </MenuButton>
                  </RowMenu>
                </li>
              )
            })}
          </RowList>
        )}
        <Refusal message={refused} />
        {team.addable.length === 0 ? null : (
          <Button className="w-fit" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Add member
          </Button>
        )}
      </section>

      <AddMemberDialog
        open={adding}
        view={view}
        onClose={() => setAdding(false)}
        onAdded={refresh}
      />
      <NameDialog
        key={renaming ? 'open' : 'closed'}
        open={renaming}
        workspace={workspace}
        team={{ id: team.id, name: team.name }}
        onClose={() => setRenaming(false)}
        onSaved={async () => {
          setRenaming(false)
          await refresh()
        }}
      />
      <DeleteTeamDialog
        workspace={workspace}
        team={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() =>
          navigate({
            to: '/_/w/$workspace/settings/teams',
            params: { workspace },
          })
        }
      />
    </div>
  )
}

/** The workspace's members who are not in the team yet. */
function AddMemberDialog({
  open,
  view,
  onClose,
  onAdded,
}: {
  open: boolean
  view: TeamView
  onClose: () => void
  onAdded: () => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const close = () => {
    setRefused(null)
    onClose()
  }
  const add = async (userId: string) => {
    setBusy(userId)
    setRefused(null)
    const message = refusalOf(
      await addToTeam({
        data: { workspace: view.workspace, teamId: view.team.id, userId },
      }),
    )
    setRefused(message)
    await onAdded()
    setBusy(null)
    if (message === null) close()
  }
  return (
    <Modal open={open} onClose={close} title="Add member">
      <div className="flex flex-col gap-3">
        {view.team.addable.length === 0 ? null : (
          <RowList>
            {view.team.addable.map((person) => (
              <li key={person.id} className={ROW}>
                <Initial of={person.email} />
                <span className="min-w-0 flex-1 truncate text-[0.9375rem] text-neutral-50">
                  {person.email}
                </span>
                <Button
                  variant="secondary"
                  size="xs"
                  aria-label={`Add ${person.email}`}
                  disabled={busy !== null}
                  onClick={() => add(person.id)}
                >
                  Add
                </Button>
              </li>
            ))}
          </RowList>
        )}
        <Refusal message={refused} />
      </div>
    </Modal>
  )
}
