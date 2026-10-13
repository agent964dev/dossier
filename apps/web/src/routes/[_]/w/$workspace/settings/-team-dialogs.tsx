import { useState, type FormEvent } from 'react'

import {
  ConfirmDialog,
  Refusal,
  refusalOf,
} from '../../../../../components/settings-parts'
import { Button } from '../../../../../components/ui/button'
import { Input, Label } from '../../../../../components/ui/input'
import { Modal } from '../../../../../components/ui/modal'
import type { TeamRef } from '../../../../../core/index'
import {
  createTeam,
  deleteTeam,
  renameTeam,
} from '../../../../../server/workspace-settings'

/** Names a new team, or renames one; give it a key per opening. */
export function NameDialog({
  open,
  workspace,
  team,
  onClose,
  onSaved,
}: {
  open: boolean
  workspace: string
  /** The team to rename; null names a new one. */
  team: TeamRef | null
  onClose: () => void
  onSaved: (team: TeamRef) => Promise<void> | void
}) {
  const [name, setName] = useState(team?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  const close = () => {
    setRefused(null)
    onClose()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setRefused(null)
    if (team === null) {
      const result = await createTeam({ data: { workspace, name } })
      const message = refusalOf(result)
      setBusy(false)
      setRefused(message)
      if (message === null) await onSaved(result as TeamRef)
      return
    }
    const message = refusalOf(
      await renameTeam({ data: { workspace, teamId: team.id, name } }),
    )
    setBusy(false)
    setRefused(message)
    if (message === null) await onSaved({ id: team.id, name: name.trim() })
  }

  const form = team === null ? 'new-team-form' : 'rename-team-form'
  return (
    <Modal
      open={open}
      onClose={close}
      title={team === null ? 'New team' : `Rename ${team.name}`}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={form} disabled={busy}>
            {team === null ? 'New team' : 'Rename'}
          </Button>
        </>
      }
    >
      <form id={form} onSubmit={submit} className="flex flex-col gap-2">
        <Label htmlFor={`${form}-name`}>Name</Label>
        <Input
          id={`${form}-name`}
          value={name}
          maxLength={60}
          required
          autoComplete="off"
          aria-invalid={refused === null ? undefined : true}
          onChange={(event) => setName(event.target.value)}
        />
        <Refusal message={refused} />
      </form>
    </Modal>
  )
}

/** Deleting a team asks again, because its shares go with it. */
export function DeleteTeamDialog({
  workspace,
  team,
  onClose,
  onDeleted,
}: {
  workspace: string
  team: TeamRef | null
  onClose: () => void
  onDeleted: () => Promise<void> | void
}) {
  return (
    <ConfirmDialog
      open={team !== null}
      title={team === null ? '' : `Delete ${team.name}?`}
      description={
        team === null
          ? undefined
          : `Shares to ${team.name} are removed with it.`
      }
      action="Delete"
      onClose={onClose}
      onConfirm={async () => {
        if (team === null) return null
        const message = refusalOf(
          await deleteTeam({ data: { workspace, teamId: team.id } }),
        )
        if (message === null) await onDeleted()
        return message
      }}
    />
  )
}
