import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import {
  Building2,
  Check,
  Copy,
  FileText,
  Info,
  KeyRound,
  LogOut,
  MessageSquare,
  Trash2,
  TriangleAlert,
  User,
  X,
} from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'

import { AppHeader } from '../../components/app-header'
import { Avatar } from '../../components/avatar'
import { DeploymentSettings } from '../../components/deployment-settings'
import { SectionLabel } from '../../components/section-label'
import { SignInAccounts } from '../../components/sign-in-accounts'
import { Button } from '../../components/ui/button'
import { Refusal, refusalOf } from '../../components/settings-parts'
import { Input, Label, Select } from '../../components/ui/input'
import { Modal } from '../../components/ui/modal'
import { signOut } from '../../lib/auth-client'
import type { AgentKeyView, DeletionPreview } from '../../core/index'
import {
  accountView,
  createKey,
  createWorkspace,
  deleteAccount,
  deletionPreview,
  leaveWorkspace,
  revokeKey,
  signOutEverywhere,
  type WorkspaceRowView,
} from '../../server/account'
import { isScreenFailure } from '../../server/failure'

export const Route = createFileRoute('/_/settings')({
  loader: async () => {
    const view = await accountView()
    if (isScreenFailure(view)) {
      if (view.error.code === 'sign_in_required') {
        throw redirect({ href: '/_/sign-in?next=%2F_%2Fsettings' })
      }
      throw new Error(view.error.message)
    }
    return view
  },
  head: () => ({ meta: [{ title: 'Account · Dossier' }] }),
  component: AccountSettings,
})

const minute = 60_000

/** "used 2 min ago", from the last use the server records once a minute. */
export function usedAgo(lastUsedAt: number | null, now: number): string {
  if (lastUsedAt === null) return 'never used'
  const minutes = Math.max(0, Math.floor((now - lastUsedAt) / minute))
  if (minutes < 1) return 'used just now'
  if (minutes < 60) return `used ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `used ${hours} h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'used yesterday' : `used ${days} days ago`
}

function AccountSettings() {
  const view = Route.useLoaderData()
  const router = useRouter()
  const [leaving, setLeaving] = useState<'one' | 'all' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const leave = async (scope: 'one' | 'all') => {
    setLeaving(scope)
    setFailed(null)
    try {
      if (scope === 'one') {
        await signOut()
      } else {
        const result = await signOutEverywhere()
        if (isScreenFailure(result)) throw new Error(result.error.message)
      }
      window.location.assign('/')
    } catch {
      setLeaving(null)
      setFailed('Signing out did not finish. Try again.')
    }
  }

  return (
    <div className="min-h-dvh">
      <AppHeader email={view.email} />
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-6">
        <div className="flex flex-col gap-2">
          <p className="font-mono text-xs text-neutral-500">
            settings <span aria-hidden>/</span>{' '}
            <span className="text-neutral-300">account</span>
          </p>
          <h1 className="font-clash text-[1.875rem] font-semibold tracking-[-0.03em] text-neutral-50">
            Account
          </h1>
          <p className="flex items-center gap-2.5 text-[0.9375rem] text-neutral-300">
            <Avatar person={view} className="size-8 rounded-lg text-sm" />
            <span className="min-w-0 break-words">
              {view.name.trim() === '' ? null : (
                <>
                  <span className="font-medium text-neutral-50">
                    {view.name.trim()}
                  </span>{' '}
                  ·{' '}
                </>
              )}
              <span className="break-all">{view.email}</span>
            </span>
          </p>
        </div>

        <SignInAccounts
          accounts={view.signInAccounts}
          personEmail={view.email}
          onChange={() => router.invalidate()}
        />

        <Workspaces
          workspaces={view.workspaces}
          mayCreate={view.mayCreateWorkspace}
          onChange={() => router.invalidate()}
        />

        <AgentKeys
          keys={view.keys}
          trees={view.trees}
          onChange={() => router.invalidate()}
        />

        <DeploymentSettings superAdmin={view.superAdmin} />

        <section
          aria-labelledby="signing-out-label"
          className="flex flex-col gap-3"
        >
          <SectionLabel id="signing-out-label">Signing out</SectionLabel>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={leaving !== null}
              onClick={() => leave('one')}
            >
              <LogOut aria-hidden />
              Sign out
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={leaving !== null}
              onClick={() => leave('all')}
            >
              <X aria-hidden />
              Sign out everywhere
            </Button>
          </div>
          <p className="flex gap-2 text-sm text-neutral-400">
            <Info
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-neutral-500"
            />
            Ends every browser session. Agent keys stay until you revoke them
            above.
          </p>
          {failed === null ? null : (
            <p role="alert" className="text-sm text-error-300">
              {failed}
            </p>
          )}
        </section>

        <DeleteAccount />
      </main>
    </div>
  )
}

function Workspaces({
  workspaces,
  mayCreate,
  onChange,
}: {
  workspaces: readonly WorkspaceRowView[]
  mayCreate: boolean
  onChange: () => Promise<void>
}) {
  const [creating, setCreating] = useState(false)
  const [leaving, setLeaving] = useState<string | null>(null)
  return (
    <section aria-labelledby="workspaces-label" className="flex flex-col gap-3">
      <SectionLabel id="workspaces-label" count={workspaces.length}>
        Workspaces
      </SectionLabel>
      {workspaces.length === 0 ? (
        <p className="text-[0.9375rem] text-neutral-400">No workspaces yet.</p>
      ) : (
        <ul className="divide-y divide-border/80 overflow-hidden rounded-xl border border-border bg-card">
          {workspaces.map((workspace) => (
            <li
              key={workspace.name}
              className="flex items-center gap-3 px-3.5 py-3 transition-colors duration-200 ease-agent hover:bg-neutral-800/40"
            >
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-300"
              >
                <Building2 className="size-4" />
              </span>
              <a
                href={`/?w=${encodeURIComponent(workspace.name)}`}
                className="min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="block truncate text-[0.9375rem] text-neutral-50">
                  {workspace.name}
                </span>
                <span className="block font-mono text-xs text-neutral-500">
                  {[
                    workspace.role === 'admin' ? 'Admin' : 'Member',
                    ...(workspace.teams.length === 0
                      ? []
                      : [workspace.teams.join(', ')]),
                  ].join(' · ')}
                </span>
              </a>
              <Button
                variant="outline"
                size="xs"
                aria-label={`Leave ${workspace.name}`}
                onClick={() => setLeaving(workspace.name)}
              >
                Leave
              </Button>
            </li>
          ))}
        </ul>
      )}
      <LeaveDialog
        workspace={leaving}
        onClose={() => setLeaving(null)}
        onLeft={onChange}
      />
      {mayCreate ? (
        <>
          <Button
            variant="secondary"
            size="sm"
            className="w-fit"
            onClick={() => setCreating(true)}
          >
            Create workspace
          </Button>
          <CreateWorkspaceDialog
            open={creating}
            onClose={() => setCreating(false)}
          />
        </>
      ) : null}
    </section>
  )
}

/** Leaving asks again; the last admin is told to hand over first. */
function LeaveDialog({
  workspace,
  onClose,
  onLeft,
}: {
  workspace: string | null
  onClose: () => void
  onLeft: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<{
    readonly message: string
    readonly lastAdmin: boolean
  } | null>(null)
  const close = () => {
    setRefused(null)
    onClose()
  }
  const leave = async () => {
    if (workspace === null) return
    setBusy(true)
    setRefused(null)
    const result = await leaveWorkspace({ data: { workspace } })
    setBusy(false)
    if (isScreenFailure(result)) {
      setRefused({
        message: result.error.message,
        lastAdmin: result.error.code === 'last_admin',
      })
      return
    }
    close()
    await onLeft()
  }
  return (
    <Modal
      open={workspace !== null}
      onClose={close}
      title={workspace === null ? '' : `Leave ${workspace}?`}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={close}>
            Cancel
          </Button>
          {refused?.lastAdmin === true && workspace !== null ? (
            <Button asChild>
              <a href={`/_/w/${encodeURIComponent(workspace)}/settings`}>
                Hand over admin
              </a>
            </Button>
          ) : (
            <Button
              variant="destructive"
              type="button"
              disabled={busy}
              onClick={leave}
            >
              <LogOut aria-hidden />
              Leave
            </Button>
          )}
        </>
      }
    >
      {refused === null ? null : <Refusal message={refused.message} />}
    </Modal>
  )
}

function CreateWorkspaceDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const close = () => {
    setName('')
    setError(null)
    onClose()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await createWorkspace({ data: { name } })
    if (isScreenFailure(result)) {
      setBusy(false)
      setError(result.error.message)
      return
    }
    window.location.assign(`/?w=${encodeURIComponent(result.name)}`)
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Create workspace"
      description="You become its first admin. Its name is part of every link in it."
      footer={
        <>
          <Button variant="ghost" type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="new-workspace-form" disabled={busy}>
            Create workspace
          </Button>
        </>
      }
    >
      <form
        id="new-workspace-form"
        onSubmit={submit}
        className="flex flex-col gap-2"
      >
        <Label htmlFor="new-workspace-name">Name</Label>
        <Input
          id="new-workspace-name"
          value={name}
          maxLength={63}
          required
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="agent964"
          aria-describedby="new-workspace-rule"
          aria-invalid={error === null ? undefined : true}
          className="font-mono"
          onChange={(event) => setName(event.target.value)}
        />
        <p id="new-workspace-rule" className="text-sm text-neutral-400">
          Lowercase letters, digits and hyphens.
        </p>
        {error === null ? null : (
          <p role="alert" className="text-sm text-error-300">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}

/** "agent964/acme/ · read only · used 2 min ago" */
export function keyDetails(key: AgentKeyView, now: number): string {
  return [
    key.reach ?? 'everything',
    ...(key.readOnly ? ['read only'] : []),
    usedAgo(key.lastUsedAt, now),
  ].join(' · ')
}

function AgentKeys({
  keys,
  trees,
  onChange,
}: {
  keys: readonly AgentKeyView[]
  trees: readonly string[]
  onChange: () => Promise<void>
}) {
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [now] = useState(() => Date.now())

  const revoke = async (id: string) => {
    setRevoking(id)
    setFailed(null)
    const result = await revokeKey({ data: { id } })
    if (isScreenFailure(result)) setFailed(result.error.message)
    await onChange()
    setRevoking(null)
  }

  return (
    <section aria-labelledby="keys-label" className="flex flex-col gap-3">
      <SectionLabel id="keys-label" count={keys.length}>
        Agent keys
      </SectionLabel>
      {keys.length === 0 ? (
        <p className="text-[0.9375rem] text-neutral-400">No agent keys yet.</p>
      ) : (
        <ul className="divide-y divide-border/80 overflow-hidden rounded-xl border border-border bg-card">
          {keys.map((key) => (
            <li key={key.id} className="flex items-center gap-3 px-3.5 py-3">
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-300"
              >
                <KeyRound className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.9375rem] text-neutral-50">
                  {key.name}
                </p>
                <p className="font-mono text-xs wrap-anywhere text-neutral-500">
                  {keyDetails(key, now)}
                </p>
              </div>
              <Button
                variant="destructive"
                size="xs"
                aria-label={`Revoke ${key.name}`}
                disabled={revoking !== null}
                onClick={() => revoke(key.id)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {failed === null ? null : (
        <p role="alert" className="text-sm text-error-300">
          {failed}
        </p>
      )}
      <Button
        variant="secondary"
        size="sm"
        className="w-fit"
        onClick={() => setCreating(true)}
      >
        New key
      </Button>
      <NewKeyDialog
        open={creating}
        trees={trees}
        onClose={() => setCreating(false)}
        onCreated={onChange}
      />
    </section>
  )
}

type Reach = 'everything' | 'tree' | 'path'

function NewKeyDialog({
  open,
  trees,
  onClose,
  onCreated,
}: {
  open: boolean
  trees: readonly string[]
  onClose: () => void
  onCreated: () => Promise<void>
}) {
  const [name, setName] = useState('')
  const [reach, setReach] = useState<Reach>('everything')
  const [tree, setTree] = useState('')
  const [path, setPath] = useState('')
  const [readOnly, setReadOnly] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const close = () => {
    setName('')
    setReach('everything')
    setTree('')
    setPath('')
    setReadOnly(false)
    setSecret(null)
    setError(null)
    setCopied(false)
    onClose()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const target =
      reach === 'tree'
        ? tree === ''
          ? (trees[0] ?? '')
          : tree
        : reach === 'path'
          ? path.trim()
          : null
    const result = await createKey({
      data: { name, reach: target, readOnly },
    })
    setBusy(false)
    if (isScreenFailure(result)) {
      setError(result.error.message)
      return
    }
    setSecret(result.secret)
    await onCreated()
  }

  const copy = async () => {
    if (secret === null) return
    await navigator.clipboard.writeText(secret)
    setCopied(true)
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={secret === null ? 'New agent key' : 'Copy the key now'}
      description={
        secret === null
          ? 'An agent key lets the CLI or plain HTTP act as you.'
          : 'This is the only time Dossier shows it.'
      }
      footer={
        secret === null ? (
          <>
            <Button variant="ghost" type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="new-key-form" disabled={busy}>
              Create key
            </Button>
          </>
        ) : (
          <Button type="button" onClick={close}>
            Done
          </Button>
        )
      }
    >
      {secret === null ? (
        <form
          id="new-key-form"
          onSubmit={submit}
          className="flex flex-col gap-2"
        >
          <Label htmlFor="new-key-name">Name</Label>
          <Input
            id="new-key-name"
            value={name}
            maxLength={64}
            required
            autoComplete="off"
            placeholder="CI for acme"
            onChange={(event) => setName(event.target.value)}
          />
          <fieldset className="mt-3 flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium text-neutral-300">
              Reach
            </legend>
            <ReachOption
              value="everything"
              current={reach}
              onChange={setReach}
              label="Everything"
              hint="Every tree you can open."
            />
            <ReachOption
              value="tree"
              current={reach}
              onChange={setReach}
              label="One tree"
              disabled={trees.length === 0}
              hint={trees.length === 0 ? 'No trees yet.' : undefined}
            />
            {reach === 'tree' && trees.length > 0 ? (
              <Select
                aria-label="Tree"
                value={tree === '' ? trees[0] : tree}
                wrapperClassName="pl-7"
                className="font-mono"
                onChange={(event) => setTree(event.target.value)}
              >
                {trees.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            ) : null}
            <ReachOption
              value="path"
              current={reach}
              onChange={setReach}
              label="A path in a tree"
            />
            {reach === 'path' ? (
              <div className="pl-7">
                <Input
                  aria-label="Path"
                  value={path}
                  required
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="agent964/acme/plans/"
                  className="font-mono"
                  onChange={(event) => setPath(event.target.value)}
                />
              </div>
            ) : null}
          </fieldset>
          <label className="mt-2 flex items-center gap-2.5 text-[0.9375rem] text-neutral-200">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(event) => setReadOnly(event.target.checked)}
              className="size-4 accent-brand-300"
            />
            Read only
          </label>
          {error === null ? null : (
            <p role="alert" className="text-sm text-error-300">
              {error}
            </p>
          )}
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <code className="block rounded-lg border border-border bg-neutral-950 px-3 py-2.5 font-mono text-xs break-all text-brand-100">
            {secret}
          </code>
          <Button variant="outline" size="sm" className="w-fit" onClick={copy}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
    </Modal>
  )
}

function ReachOption({
  value,
  current,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  value: Reach
  current: Reach
  onChange: (value: Reach) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <label
      className={`flex items-start gap-2.5 text-[0.9375rem] ${disabled ? 'text-neutral-500' : 'text-neutral-200'}`}
    >
      <input
        type="radio"
        name="key-reach"
        value={value}
        checked={current === value}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="mt-1 size-4 accent-brand-300"
      />
      <span>
        {label}
        {hint === undefined ? null : (
          <span className="block text-sm text-neutral-500">{hint}</span>
        )}
      </span>
    </label>
  )
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

/** "6 submissions and 2 entries"; null when there are neither. */
export function answersText(preview: DeletionPreview): string | null {
  const parts = [
    ...(preview.submissions > 0
      ? [plural(preview.submissions, 'submission', 'submissions')]
      : []),
    ...(preview.entries > 0
      ? [plural(preview.entries, 'entry', 'entries')]
      : []),
  ]
  return parts.length === 0 ? null : parts.join(' and ')
}

type Sheet =
  | { readonly kind: 'preview'; readonly preview: DeletionPreview }
  | {
      readonly kind: 'blocked'
      readonly blockedBy: NonNullable<DeletionPreview['blockedBy']>
    }

function DeleteAccount() {
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  const open = async () => {
    setBusy(true)
    setRefused(null)
    const preview = await deletionPreview()
    setBusy(false)
    if (isScreenFailure(preview)) {
      setRefused(preview.error.message)
      return
    }
    setSheet(
      preview.blockedBy === null
        ? { kind: 'preview', preview }
        : { kind: 'blocked', blockedBy: preview.blockedBy },
    )
  }

  return (
    <section
      aria-labelledby="delete-account-label"
      className="flex flex-col gap-3 rounded-xl border border-border border-l-2 border-l-destructive/70 bg-card px-4 py-4"
    >
      <h2
        id="delete-account-label"
        className="text-[0.9375rem] font-semibold text-error-300"
      >
        Delete my answers and account
      </h2>
      <p className="text-sm leading-relaxed text-neutral-300">
        Withdraws everything you wrote on this deployment, deletes the text of
        your comments, revokes your keys, ends your sessions and removes your
        memberships.
      </p>
      <Button
        variant="destructive"
        size="sm"
        className="w-fit"
        disabled={busy}
        onClick={open}
      >
        Delete my answers and account
      </Button>
      <Refusal message={sheet === null ? refused : null} />
      <DeletionSheet
        sheet={sheet?.kind === 'preview' ? sheet.preview : null}
        onClose={() => setSheet(null)}
      />
      <BlockedSheet
        blockedBy={sheet?.kind === 'blocked' ? sheet.blockedBy : null}
        onClose={() => setSheet(null)}
      />
    </section>
  )
}

function SheetRow({
  icon,
  title,
  detail,
}: {
  icon: ReactNode
  title: string
  detail: string
}) {
  return (
    <li className="flex items-center gap-3 px-3.5 py-2.5">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-300 [&_svg]:size-4"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[0.9375rem] text-neutral-50">{title}</span>
        <span className="block font-mono text-xs text-neutral-400">
          {detail}
        </span>
      </span>
    </li>
  )
}

/** What deleting removes, counted, before the person confirms. */
function DeletionSheet({
  sheet,
  onClose,
}: {
  sheet: DeletionPreview | null
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const close = () => {
    setRefused(null)
    onClose()
  }
  const remove = async () => {
    setBusy(true)
    setRefused(null)
    const message = refusalOf(await deleteAccount())
    if (message === null) {
      window.location.assign('/')
      return
    }
    setBusy(false)
    setRefused(message)
  }
  const answers = sheet === null ? null : answersText(sheet)
  return (
    <Modal
      open={sheet !== null}
      onClose={close}
      title="Delete my answers and account?"
      footer={
        <>
          <Button variant="ghost" type="button" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            type="button"
            disabled={busy}
            onClick={remove}
          >
            <Trash2 aria-hidden />
            Delete
          </Button>
        </>
      }
    >
      {sheet === null ? null : (
        <div className="flex flex-col gap-3">
          <ul className="divide-y divide-border/80 rounded-xl border border-border bg-neutral-950/40">
            {answers === null ? null : (
              <SheetRow
                icon={<FileText />}
                title={answers}
                detail="withdrawn, with every revision"
              />
            )}
            {sheet.comments === 0 ? null : (
              <SheetRow
                icon={<MessageSquare />}
                title={plural(sheet.comments, 'comment', 'comments')}
                detail={'text deleted, shown as "Comment deleted"'}
              />
            )}
            {sheet.keys === 0 ? null : (
              <SheetRow
                icon={<KeyRound />}
                title={plural(sheet.keys, 'agent key', 'agent keys')}
                detail="revoked"
              />
            )}
            <SheetRow
              icon={<User />}
              title="Every session"
              detail="ended on every device"
            />
            {sheet.workspaces.map((workspace) => (
              <SheetRow
                key={workspace}
                icon={<Building2 />}
                title={`Membership of ${workspace}`}
                detail="removed"
              />
            ))}
          </ul>
          <p className="flex gap-2 text-sm text-neutral-400">
            <Info
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-neutral-500"
            />
            Pages you pushed stay in their trees.
          </p>
          <Refusal message={refused} />
        </div>
      )}
    </Modal>
  )
}

/** Refused while the person is the last admin or the only super admin. */
function BlockedSheet({
  blockedBy,
  onClose,
}: {
  blockedBy: NonNullable<DeletionPreview['blockedBy']> | null
  onClose: () => void
}) {
  return (
    <Modal
      open={blockedBy !== null}
      onClose={onClose}
      title="Delete my answers and account?"
      footer={
        blockedBy === null ? undefined : (
          <>
            <Button variant="ghost" type="button" onClick={onClose}>
              Cancel
            </Button>
            {blockedBy.kind === 'last_admin' ? (
              <Button asChild>
                <a
                  href={`/_/w/${encodeURIComponent(blockedBy.workspace)}/settings`}
                >
                  Hand over admin
                </a>
              </Button>
            ) : (
              <Button asChild>
                <a href="/_/admin">Add super admin</a>
              </Button>
            )}
          </>
        )
      }
    >
      {blockedBy === null ? null : (
        <div
          role="alert"
          className="flex gap-2.5 rounded-xl border border-warning-400/30 bg-warning-400/8 px-3.5 py-3 text-[0.9375rem] leading-relaxed text-neutral-200"
        >
          <TriangleAlert
            aria-hidden
            className="mt-1 size-4 shrink-0 text-warning-300"
          />
          {blockedBy.kind === 'last_admin' ? (
            <p>
              <strong className="font-semibold text-neutral-50">
                You&apos;re the last admin of {blockedBy.workspace}.
              </strong>{' '}
              Hand over admin to another member first. Then you can delete your
              answers and account.
            </p>
          ) : (
            <p>Name another super admin first.</p>
          )}
        </div>
      )}
    </Modal>
  )
}
