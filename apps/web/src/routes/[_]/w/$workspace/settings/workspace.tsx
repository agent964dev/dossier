import { createFileRoute } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { SectionLabel } from '../../../../../components/section-label'
import { Refusal, refusalOf } from '../../../../../components/settings-parts'
import { Button } from '../../../../../components/ui/button'
import { Input, Label } from '../../../../../components/ui/input'
import {
  deleteWorkspace,
  workspaceView,
  type WorkspaceView,
} from '../../../../../server/workspace-settings'
import { Tab, tabRead } from './-tab'

export const Route = createFileRoute('/_/w/$workspace/settings/workspace')({
  loader: async ({ params, location }) =>
    tabRead(
      await workspaceView({ data: { workspace: params.workspace } }),
      location.href,
    ),
  component: () => (
    <Tab read={Route.useLoaderData()}>
      {(view: WorkspaceView) => <DeleteWorkspace view={view} />}
    </Tab>
  ),
})

const daysText = (days: number) => (days === 1 ? '1 day' : `${days} days`)

function DeleteWorkspace({ view }: { view: WorkspaceView }) {
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const matches = confirm === view.workspace

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!matches) return
    setBusy(true)
    setRefused(null)
    const message = refusalOf(
      await deleteWorkspace({
        data: { workspace: view.workspace, confirm },
      }),
    )
    if (message === null) {
      window.location.assign('/')
      return
    }
    setBusy(false)
    setRefused(message)
  }

  return (
    <section
      aria-labelledby="delete-workspace-label"
      className="flex flex-col gap-3"
    >
      <SectionLabel id="delete-workspace-label">Delete workspace</SectionLabel>
      <form
        onSubmit={submit}
        className="flex flex-col gap-3 rounded-xl border border-border border-l-2 border-l-destructive/70 bg-card px-4 py-4"
      >
        <p className="text-[0.9375rem] leading-relaxed text-neutral-300">
          Its trees stay restorable for {daysText(view.retentionDays)}, then are
          purged.
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="delete-workspace-confirm">
            Type {view.workspace} to confirm
          </Label>
          <Input
            id="delete-workspace-confirm"
            value={confirm}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
            aria-invalid={refused === null ? undefined : true}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
        <Refusal message={refused} />
        <Button
          type="submit"
          variant="destructive"
          className="w-fit"
          disabled={!matches || busy}
        >
          <Trash2 aria-hidden />
          Delete workspace
        </Button>
      </form>
    </section>
  )
}
