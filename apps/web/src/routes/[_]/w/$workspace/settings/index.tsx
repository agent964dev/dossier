import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'

import { MenuButton, RowMenu } from '../../../../../components/row-menu'
import {
  ConfirmDialog,
  Initial,
  Note,
  Refusal,
  refusalOf,
  ROW,
  RowList,
} from '../../../../../components/settings-parts'
import { Badge } from '../../../../../components/ui/badge'
import { Button } from '../../../../../components/ui/button'
import { Input, Select } from '../../../../../components/ui/input'
import type {
  InvitationRow,
  MemberRow,
  WorkspaceRole,
} from '../../../../../core/index'
import {
  cancelInvitation,
  invite,
  membersView,
  removeMember,
  setRole,
  type MembersView,
} from '../../../../../server/workspace-settings'
import { Tab, tabRead } from './-tab'

export const Route = createFileRoute('/_/w/$workspace/settings/')({
  loader: async ({ params, location }) =>
    tabRead(
      await membersView({ data: { workspace: params.workspace } }),
      location.href,
    ),
  component: () => (
    <Tab read={Route.useLoaderData()}>
      {(view: MembersView) => <Members view={view} />}
    </Tab>
  ),
})

/** Teams, roles and invitations line up in columns on wider screens. */
const COLUMNS =
  'min-w-0 flex-1 sm:grid sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] sm:items-center sm:gap-4'

function Members({ view }: { view: MembersView }) {
  const router = useRouter()
  const [refused, setRefused] = useState<string | null>(null)
  const [removing, setRemoving] = useState<MemberRow | null>(null)
  const refresh = () => router.invalidate()

  const changeRole = async (member: MemberRow, role: WorkspaceRole) => {
    if (member.role === role) return
    setRefused(null)
    const message = refusalOf(
      await setRole({
        data: { workspace: view.workspace, userId: member.person.id, role },
      }),
    )
    setRefused(message)
    await refresh()
  }

  const cancel = async (invitation: InvitationRow) => {
    setRefused(null)
    setRefused(
      refusalOf(
        await cancelInvitation({
          data: { workspace: view.workspace, email: invitation.email },
        }),
      ),
    )
    await refresh()
  }

  return (
    <div className="flex flex-col gap-5">
      <InviteRow view={view} onInvited={refresh} />
      <RowList
        label="Members and invitations"
        heads={
          <div
            aria-hidden
            className="hidden items-center gap-3 border-b border-border/80 px-3.5 py-2 font-mono text-[0.6875rem] tracking-[0.2em] text-neutral-500 uppercase sm:flex"
          >
            <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-4">
              <span>Member</span>
              <span>Teams</span>
            </span>
            <span className="w-44 shrink-0">Role</span>
          </div>
        }
      >
        {view.members.map((member) => {
          const who = member.isMe ? 'You' : member.person.email
          const teams = member.teams.map((team) => team.name).join(', ')
          return (
            <li key={member.person.id} className={ROW}>
              <Initial of={who} className="sm:hidden" />
              <div className={COLUMNS}>
                <span className="block truncate text-[0.9375rem] text-neutral-50">
                  {who}
                </span>
                <span className="block truncate font-mono text-xs text-neutral-400">
                  {teams === '' ? null : (
                    <span className="sr-only">Teams: </span>
                  )}
                  {teams}
                </span>
              </div>
              <span className="flex shrink-0 sm:w-44">
                <RowMenu
                  trigger={roleName(member.role)}
                  about={`role of ${who}`}
                >
                  <MenuButton
                    chosen={member.role === 'admin'}
                    onSelect={() => changeRole(member, 'admin')}
                  >
                    Admin
                  </MenuButton>
                  <MenuButton
                    chosen={member.role === 'member'}
                    onSelect={() => changeRole(member, 'member')}
                  >
                    Member
                  </MenuButton>
                  <MenuButton destructive onSelect={() => setRemoving(member)}>
                    Remove
                  </MenuButton>
                </RowMenu>
              </span>
            </li>
          )
        })}
        {view.invitations.map((invitation) => (
          <li key={invitation.email} className={ROW}>
            <Initial of={invitation.email} className="sm:hidden" />
            <div className={COLUMNS}>
              <span className="block truncate text-[0.9375rem] text-neutral-50">
                {invitation.email}
              </span>
              <span className="block truncate font-mono text-xs text-neutral-400">
                invited, not signed in yet
              </span>
            </div>
            <span className="flex shrink-0 items-center justify-end gap-3 sm:w-44 sm:justify-between">
              <Badge variant="warn" className="hidden sm:inline-flex">
                Invited
              </Badge>
              <Button
                variant="destructive"
                size="xs"
                aria-label={`Remove the invitation of ${invitation.email}`}
                onClick={() => cancel(invitation)}
              >
                Remove
              </Button>
            </span>
          </li>
        ))}
      </RowList>
      <Refusal message={refused} />
      <ConfirmDialog
        open={removing !== null}
        title={
          removing === null
            ? ''
            : `Remove ${removing.isMe ? 'yourself' : removing.person.email} from ${view.workspace}?`
        }
        action="Remove"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (removing === null) return null
          const message = refusalOf(
            await removeMember({
              data: { workspace: view.workspace, userId: removing.person.id },
            }),
          )
          if (message === null) {
            if (removing.isMe) window.location.assign('/')
            else await refresh()
          }
          return message
        }}
      />
    </div>
  )
}

const roleName = (role: WorkspaceRole) =>
  role === 'admin' ? 'Admin' : 'Member'

function InviteRow({
  view,
  onInvited,
}: {
  view: MembersView
  onInvited: () => Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [team, setTeam] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setRefused(null)
    const message = refusalOf(
      await invite({
        data: {
          workspace: view.workspace,
          email,
          teamIds: team === '' ? [] : [team],
        },
      }),
    )
    setBusy(false)
    setRefused(message)
    if (message === null) {
      setEmail('')
      setTeam('')
      await onInvited()
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      <div
        className={`grid grid-cols-[minmax(0,1fr)_auto] gap-2.5 ${view.teams.length === 0 ? '' : 'sm:grid-cols-[minmax(0,1fr)_auto_auto]'}`}
      >
        <Input
          type="email"
          aria-label="Email to invite"
          value={email}
          required
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="name@example.com"
          aria-invalid={refused === null ? undefined : true}
          onChange={(event) => setEmail(event.target.value)}
        />
        {view.teams.length === 0 ? null : (
          <Select
            aria-label="Add to a team"
            value={team}
            wrapperClassName="col-span-2 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:w-56"
            className={team === '' ? 'text-neutral-400' : undefined}
            onChange={(event) => setTeam(event.target.value)}
          >
            <option value="">Add to a team</option>
            {view.teams.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </Select>
        )}
        <Button
          type="submit"
          size="lg"
          disabled={busy}
          className={`col-start-2 row-start-1 ${view.teams.length === 0 ? '' : 'sm:col-start-3'}`}
        >
          Invite
        </Button>
      </div>
      <Refusal message={refused} />
      <Note>
        Dossier sends no email. Tell the person. They get access at their first
        sign-in.
      </Note>
    </form>
  )
}
