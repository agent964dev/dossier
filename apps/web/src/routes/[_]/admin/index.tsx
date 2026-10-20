import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { Building2, ChevronRight, Lock, Pencil, Plus } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import { AppHeader } from '../../../components/app-header'
import { HostName } from '../../../components/host-name'
import { NoAccessScreen } from '../../../components/no-access'
import { LastPurge, PurgeNow } from '../../../components/purge-now'
import { SectionLabel } from '../../../components/section-label'
import {
  Initial,
  Refusal,
  refusalOf,
  ROW,
  RowList,
} from '../../../components/settings-parts'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Input, Label, Select } from '../../../components/ui/input'
import { Modal } from '../../../components/ui/modal'
import type {
  Health,
  LimitValues,
  WorkspaceCreation,
} from '../../../core/index'
import {
  addCreator,
  addSuperAdmin,
  adminView,
  liftSuspension,
  removeCreator,
  removeSuperAdmin,
  restoreWorkspace,
  setLimits,
  setRetention,
  setWorkspaceCreation,
  suspendWorkspace,
  type AdminPrivacy,
  type AdminView,
  type LimitRow,
} from '../../../server/admin'
import { isScreenFailure } from '../../../server/failure'
import { setPrivacyText } from '../../../server/privacy'
import { noAccessView } from '../../../server/no-access'

type Loaded =
  | { readonly kind: 'admin'; readonly view: AdminView }
  | { readonly kind: 'no-access'; readonly email: string | null }

export const Route = createFileRoute('/_/admin/')({
  loader: async ({ location }): Promise<Loaded> => {
    const view = await adminView()
    if (!isScreenFailure(view)) return { kind: 'admin', view }
    if (view.error.code === 'sign_in_required') {
      throw redirect({
        href: `/_/sign-in?next=${encodeURIComponent(location.href)}`,
      })
    }
    if (view.error.code !== 'not_found') throw new Error(view.error.message)
    const who = await noAccessView()
    return {
      kind: 'no-access',
      email: isScreenFailure(who) ? null : who.email,
    }
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData?.kind === 'admin'
            ? `Super admin · ${loaderData.view.deployment}`
            : 'Dossier',
      },
    ],
  }),
  component: AdminRoute,
})

function AdminRoute() {
  const loaded = Route.useLoaderData()
  return loaded.kind === 'no-access' ? (
    <NoAccessScreen email={loaded.email} />
  ) : (
    <SuperAdmin view={loaded.view} />
  )
}

function SuperAdmin({ view }: { view: AdminView }) {
  const router = useRouter()
  const refresh = () => router.invalidate()
  const me = view.superAdmins.find((admin) => admin.isMe)
  return (
    <div className="min-h-dvh">
      <AppHeader
        email={me?.person.email ?? null}
        beside={
          <span className="font-mono text-[0.6875rem] tracking-[0.2em] whitespace-nowrap text-neutral-400 uppercase">
            Super admin
          </span>
        }
      />
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-6">
        <div className="flex flex-col gap-2">
          <p className="font-mono text-xs break-all text-neutral-500">
            {view.deployment} <span aria-hidden>/</span>{' '}
            <span className="text-neutral-300">admin</span>
          </p>
          <h1 className="font-clash text-[1.625rem] leading-tight font-semibold tracking-[-0.03em] break-words text-neutral-50 sm:text-[1.875rem]">
            <HostName host={view.deployment} />
          </h1>
        </div>
        {view.firstRun ? (
          <FirstRun view={view} onChange={refresh} />
        ) : (
          <>
            <HealthLine health={view.health} lastPurge={view.lastPurge} />
            <WhoMayCreate view={view} onChange={refresh} />
            <Limits rows={view.limitRows} onChange={refresh} />
            <Retention days={view.retentionDays} onChange={refresh} />
            <SuperAdmins view={view} onChange={refresh} />
            <Workspaces view={view} onChange={refresh} />
            <LookRow look={view.look} />
            <PrivacyPage privacy={view.privacy} onChange={refresh} />
          </>
        )}
      </main>
    </div>
  )
}

/** A new deployment's first super admin chooses who may create workspaces. */
function FirstRun({
  view,
  onChange,
}: {
  view: AdminView
  onChange: () => Promise<void>
}) {
  const navigate = useNavigate()
  const [choice, setChoice] = useState(view.workspaceCreation)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setRefused(null)
    const message = refusalOf(
      await setWorkspaceCreation({ data: { value: choice } }),
    )
    if (message === null) {
      await navigate({ to: '/' })
      return
    }
    setBusy(false)
    setRefused(message)
  }
  return (
    <>
      <p className="rounded-xl border border-brand-300/30 bg-brand-300/8 px-4 py-3 text-[0.9375rem] leading-relaxed text-neutral-100">
        You are a super admin of {view.deployment}, named in its configuration.
        Choose who may create workspaces.
      </p>
      <CreationChoice
        value={choice}
        creators={view.creators}
        firstRun
        onChoose={setChoice}
        onListChange={onChange}
      />
      <Refusal message={refused} />
      <Button className="w-fit" disabled={busy} onClick={save}>
        Save
      </Button>
    </>
  )
}

const minute = 60_000

/** "checked 1 min ago", kept current while the screen stays open. */
function checkedAgo(checkedAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - checkedAt) / minute))
  if (minutes < 1) return 'checked just now'
  if (minutes < 60) return `checked ${minutes} min ago`
  return `checked ${Math.floor(minutes / 60)} h ago`
}

function HealthLine({
  health,
  lastPurge,
}: {
  health: Health
  lastPurge: AdminView['lastPurge']
}) {
  const [now, setNow] = useState(health.checkedAt)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const failing = health.checks.filter((check) => !check.ok)
  return (
    <section
      aria-label="Health"
      className="divide-y divide-border/80 rounded-xl border border-border bg-card"
    >
      <div className={ROW}>
        <span className="min-w-0 flex-1">
          {health.ok ? (
            <span className="flex items-center gap-2 text-[0.9375rem] font-semibold text-neutral-50">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full bg-success-400"
              />
              Healthy
            </span>
          ) : (
            <ul className="flex flex-col gap-1">
              {failing.map((check) => (
                <li
                  key={check.name}
                  className="flex items-start gap-2 text-[0.9375rem] text-neutral-50"
                >
                  <span
                    aria-hidden
                    className="mt-2 size-2 shrink-0 rounded-full bg-error-400"
                  />
                  <span className="min-w-0">
                    <span className="font-semibold">{check.name}</span>
                    {check.detail === null ? null : (
                      <span className="text-error-300"> · {check.detail}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <span className="mt-0.5 block font-mono text-xs text-neutral-400">
            {checkedAgo(health.checkedAt, now)}
          </span>
        </span>
        <Badge variant={health.ok ? 'success' : 'destructive'}>Health</Badge>
      </div>
      <LastPurge run={lastPurge} />
    </section>
  )
}

const CREATIONS: readonly {
  readonly value: WorkspaceCreation
  readonly label: string
}[] = [
  { value: 'super_admins', label: 'Only super admins' },
  { value: 'listed', label: 'Listed people' },
  { value: 'anyone', label: 'Anyone who signs in' },
]

function WhoMayCreate({
  view,
  onChange,
}: {
  view: AdminView
  onChange: () => Promise<void>
}) {
  const [refused, setRefused] = useState<string | null>(null)
  const choose = async (value: WorkspaceCreation) => {
    setRefused(null)
    setRefused(refusalOf(await setWorkspaceCreation({ data: { value } })))
    await onChange()
  }
  return (
    <>
      <CreationChoice
        value={view.workspaceCreation}
        creators={view.creators}
        firstRun={false}
        onChoose={choose}
        onListChange={onChange}
      />
      <Refusal message={refused} />
    </>
  )
}

function CreationChoice({
  value,
  creators,
  firstRun,
  onChoose,
  onListChange,
}: {
  value: WorkspaceCreation
  creators: AdminView['creators']
  firstRun: boolean
  onChoose: (value: WorkspaceCreation) => void
  onListChange: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const listed =
    creators.length > 0
      ? creators.map((creator) => creator.entry).join(', ')
      : firstRun
        ? 'only you so far'
        : 'Nobody is listed yet.'
  return (
    <section aria-labelledby="creation-label" className="flex flex-col gap-3">
      <SectionLabel id="creation-label">Who may create workspaces</SectionLabel>
      <div className="rounded-xl border border-border bg-card">
        <div
          role="radiogroup"
          aria-labelledby="creation-label"
          className="divide-y divide-border/80"
        >
          {CREATIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-3 px-3.5 py-3 text-[0.9375rem] text-neutral-100 transition-colors duration-200 ease-agent hover:bg-neutral-800/35"
            >
              <input
                type="radio"
                name="workspace-creation"
                value={option.value}
                checked={value === option.value}
                onChange={() => onChoose(option.value)}
                className="size-4 accent-brand-300"
              />
              {option.label}
            </label>
          ))}
        </div>
        {value === 'listed' ? (
          <div className={`${ROW} border-t border-border/80`}>
            <span className="min-w-0 flex-1">
              <span className="block text-[0.9375rem] text-neutral-50">
                Listed
              </span>
              <span className="block font-mono text-xs break-words text-neutral-400">
                {listed}
              </span>
            </span>
            <Button
              variant="outline"
              size="xs"
              aria-label="Edit who is listed"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          </div>
        ) : null}
      </div>
      <ListSheet
        open={editing}
        creators={creators}
        onClose={() => setEditing(false)}
        onChange={onListChange}
      />
    </section>
  )
}

/** Add an email or a domain to the list, or remove one. */
function ListSheet({
  open,
  creators,
  onClose,
  onChange,
}: {
  open: boolean
  creators: AdminView['creators']
  onClose: () => void
  onChange: () => Promise<void>
}) {
  const [entry, setEntry] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const close = () => {
    setEntry('')
    setRefused(null)
    onClose()
  }
  const add = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setRefused(null)
    const message = refusalOf(await addCreator({ data: { entry } }))
    setRefused(message)
    if (message === null) setEntry('')
    await onChange()
    setBusy(false)
  }
  const remove = async (value: string) => {
    setBusy(true)
    setRefused(refusalOf(await removeCreator({ data: { entry: value } })))
    await onChange()
    setBusy(false)
  }
  return (
    <Modal
      open={open}
      onClose={close}
      title="Listed people"
      footer={
        <Button type="button" onClick={close}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <form onSubmit={add} className="flex gap-2">
          <Input
            aria-label="An email or a domain"
            value={entry}
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="sara@acme.com or acme.com"
            aria-invalid={refused === null ? undefined : true}
            onChange={(event) => setEntry(event.target.value)}
          />
          <Button type="submit" size="lg" variant="secondary" disabled={busy}>
            <Plus aria-hidden />
            Add
          </Button>
        </form>
        <Refusal message={refused} />
        {creators.length === 0 ? (
          <p className="text-[0.9375rem] text-neutral-400">
            Nobody is listed yet.
          </p>
        ) : (
          <RowList label="Listed">
            {creators.map((creator) => (
              <li key={creator.entry} className={ROW}>
                <span className="min-w-0 flex-1 font-mono text-sm break-all text-neutral-50">
                  {creator.entry}
                </span>
                <Button
                  variant="destructive"
                  size="xs"
                  aria-label={`Remove ${creator.entry}`}
                  disabled={busy}
                  onClick={() => remove(creator.entry)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </RowList>
        )}
      </div>
    </Modal>
  )
}

function Limits({
  rows,
  onChange,
}: {
  rows: readonly LimitRow[]
  onChange: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  return (
    <section aria-labelledby="limits-label" className="flex flex-col gap-3">
      <SectionLabel id="limits-label">Limits</SectionLabel>
      <RowList>
        {rows.map((row) => (
          <li key={row.key} className={`${ROW} min-h-12`}>
            <span className="min-w-0 flex-1">
              <span className="block text-[0.9375rem] text-neutral-50">
                {row.label}
              </span>
              <span className="block font-mono text-xs text-neutral-400">
                {row.text}
              </span>
            </span>
            {row.isDefault ? (
              <span className="font-mono text-xs text-neutral-500">
                default
              </span>
            ) : null}
          </li>
        ))}
      </RowList>
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        aria-label="Edit limits"
        onClick={() => setEditing(true)}
      >
        <Pencil aria-hidden />
        Edit
      </Button>
      <LimitsSheet
        key={editing ? 'open' : 'closed'}
        open={editing}
        rows={rows}
        onClose={() => setEditing(false)}
        onChange={onChange}
      />
    </section>
  )
}

const UNITS = [
  { label: 'GiB', size: 1024 ** 3 },
  { label: 'MiB', size: 1024 ** 2 },
  { label: 'KiB', size: 1024 },
] as const

/** A size as a number in the largest unit that holds it whole. */
const sizeOf = (bytes: number) => {
  const unit =
    UNITS.find(({ size }) => bytes >= size && bytes % size === 0) ??
    UNITS[UNITS.length - 1]
  return { amount: String(bytes / unit.size), unit: unit.size }
}

type Draft = Record<
  keyof LimitValues,
  { readonly amount: string; readonly unit: number }
>

const draftOf = (rows: readonly LimitRow[]): Draft =>
  Object.fromEntries(
    rows.map((row) => [
      row.key,
      row.bytes ? sizeOf(row.value) : { amount: String(row.value), unit: 1 },
    ]),
  ) as Draft

function LimitsSheet({
  open,
  rows,
  onClose,
  onChange,
}: {
  open: boolean
  rows: readonly LimitRow[]
  onClose: () => void
  onChange: () => Promise<void>
}) {
  const [draft, setDraft] = useState(() => draftOf(rows))
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  const close = () => {
    setRefused(null)
    onClose()
  }

  const finish = async (result: unknown) => {
    const message = refusalOf(result)
    setRefused(message)
    await onChange()
    setBusy(false)
    if (message === null) close()
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setRefused(null)
    const limits: Partial<Record<keyof LimitValues, number>> = {}
    for (const row of rows) {
      const { amount, unit } = draft[row.key]
      limits[row.key] = Math.round(Number(amount) * unit)
    }
    await finish(await setLimits({ data: { limits } }))
  }

  const reset = async () => {
    setBusy(true)
    setRefused(null)
    await finish(await setLimits({ data: { limits: 'defaults' } }))
  }

  const set = (key: keyof LimitValues, part: Partial<Draft[typeof key]>) =>
    setDraft((current) => ({
      ...current,
      [key]: { ...current[key], ...part },
    }))

  return (
    <Modal
      open={open}
      onClose={close}
      title="Limits"
      footer={
        <>
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            className="sm:mr-auto"
            onClick={reset}
          >
            Reset to defaults
          </Button>
          <Button variant="ghost" type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="limits-form" disabled={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="limits-form" onSubmit={save} className="flex flex-col gap-3">
        {rows.map((row) => (
          <div
            key={row.key}
            className="grid grid-cols-[minmax(0,1fr)_12.5rem] items-center gap-x-3 gap-y-1"
          >
            <Label htmlFor={`limit-${row.key}`}>{row.label}</Label>
            <span className="flex gap-1.5">
              <Input
                id={`limit-${row.key}`}
                type="number"
                inputMode="decimal"
                min={row.bytes ? 0.001 : 1}
                step={row.bytes ? 'any' : 1}
                required
                value={draft[row.key].amount}
                className="font-mono"
                onChange={(event) =>
                  set(row.key, { amount: event.target.value })
                }
              />
              {row.bytes ? (
                <Select
                  aria-label={`${row.label} unit`}
                  value={draft[row.key].unit}
                  wrapperClassName="w-[5.25rem] shrink-0"
                  onChange={(event) =>
                    set(row.key, { unit: Number(event.target.value) })
                  }
                >
                  {UNITS.map((unit) => (
                    <option key={unit.label} value={unit.size}>
                      {unit.label}
                    </option>
                  ))}
                </Select>
              ) : null}
            </span>
          </div>
        ))}
        <Refusal message={refused} />
      </form>
    </Modal>
  )
}

const daysText = (days: number) => (days === 1 ? '1 day' : `${days} days`)

function Retention({
  days,
  onChange,
}: {
  days: number
  onChange: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(days))
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const close = () => {
    setRefused(null)
    setEditing(false)
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setRefused(null)
    const message = refusalOf(
      await setRetention({ data: { days: Number(draft) } }),
    )
    setRefused(message)
    await onChange()
    setBusy(false)
    if (message === null) setEditing(false)
  }
  return (
    <section aria-labelledby="retention-label" className="flex flex-col gap-3">
      <SectionLabel id="retention-label">Retention period</SectionLabel>
      <div className="rounded-xl border border-border bg-card">
        <div className={ROW}>
          <span className="min-w-0 flex-1">
            <span className="block text-[0.9375rem] text-neutral-50">
              Deleted files and data
            </span>
            <span className="block font-mono text-xs text-neutral-400">
              restorable from history, then purged
            </span>
          </span>
          <span className="font-mono text-sm whitespace-nowrap text-neutral-100">
            {daysText(days)}
          </span>
          <Button
            variant="outline"
            size="xs"
            aria-label="Edit the retention period"
            onClick={() => {
              setDraft(String(days))
              setEditing(true)
            }}
          >
            Edit
          </Button>
        </div>
        <div className="border-t border-border/80">
          <PurgeNow days={days} onDone={onChange} />
        </div>
      </div>
      <Modal
        open={editing}
        onClose={close}
        title="Retention period"
        footer={
          <>
            <Button variant="ghost" type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="retention-form" disabled={busy}>
              Save
            </Button>
          </>
        }
      >
        <form
          id="retention-form"
          onSubmit={save}
          className="flex flex-col gap-2"
        >
          <Label htmlFor="retention-days">Days</Label>
          <Input
            id="retention-days"
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            step={1}
            required
            value={draft}
            className="w-32 font-mono"
            onChange={(event) => setDraft(event.target.value)}
          />
          <Refusal message={refused} />
        </form>
      </Modal>
    </section>
  )
}

function SuperAdmins({
  view,
  onChange,
}: {
  view: AdminView
  onChange: () => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const remove = async (userId: string) => {
    setBusy(true)
    setRefused(refusalOf(await removeSuperAdmin({ data: { userId } })))
    await onChange()
    setBusy(false)
  }
  return (
    <section
      aria-labelledby="super-admins-label"
      className="flex flex-col gap-3"
    >
      <SectionLabel id="super-admins-label" count={view.superAdmins.length}>
        Super admins
      </SectionLabel>
      <RowList>
        {view.superAdmins.map((admin) => (
          <li key={admin.person.id} className={ROW}>
            <Initial of={admin.person.email} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.9375rem] text-neutral-50">
                {admin.person.email}
              </span>
              <span className="block truncate font-mono text-xs text-neutral-400">
                {admin.configured
                  ? 'named in the configuration'
                  : admin.addedBy === null
                    ? null
                    : `added by ${admin.addedBy}`}
              </span>
            </span>
            {admin.configured ? null : (
              <Button
                variant="destructive"
                size="xs"
                aria-label={`Remove ${admin.person.email}`}
                disabled={busy}
                onClick={() => remove(admin.person.id)}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </RowList>
      <Refusal message={refused} />
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => setAdding(true)}
      >
        <Plus aria-hidden />
        Add super admin
      </Button>
      <AddSuperAdminDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={onChange}
      />
    </section>
  )
}

function AddSuperAdminDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean
  onClose: () => void
  onAdded: () => Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const close = () => {
    setEmail('')
    setRefused(null)
    onClose()
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setRefused(null)
    const message = refusalOf(await addSuperAdmin({ data: { email } }))
    setBusy(false)
    if (message !== null) {
      setRefused(message)
      return
    }
    await onAdded()
    close()
  }
  return (
    <Modal
      open={open}
      onClose={close}
      title="Add super admin"
      footer={
        <>
          <Button variant="ghost" type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="super-admin-form" disabled={busy}>
            Add super admin
          </Button>
        </>
      }
    >
      <form
        id="super-admin-form"
        onSubmit={submit}
        className="flex flex-col gap-2"
      >
        <Label htmlFor="super-admin-email">Email</Label>
        <Input
          id="super-admin-email"
          type="email"
          value={email}
          required
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={refused === null ? undefined : true}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Refusal message={refused} />
      </form>
    </Modal>
  )
}

/** How Dossier looks here, and the way into the Look section. */
function LookRow({ look }: { look: AdminView['look'] }) {
  return (
    <section aria-labelledby="look-label" className="flex flex-col gap-3">
      <SectionLabel id="look-label">Look</SectionLabel>
      <Link
        to="/_/admin/look"
        className={`${ROW} rounded-xl border border-border bg-card outline-none transition-colors duration-200 ease-agent hover:bg-neutral-800/40 focus-visible:ring-[3px] focus-visible:ring-ring/50`}
      >
        <span aria-hidden className="flex shrink-0 -space-x-1.5">
          {look.swatches.map((color, index) => (
            <span
              // The swatches are a fixed list: background, card, primary.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className="size-6 rounded-full border border-neutral-600"
              style={{ background: color }}
            />
          ))}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.9375rem] text-neutral-50">
            {look.name}
          </span>
          <span className="block font-mono text-xs text-neutral-400">
            {look.custom ? 'this deployment’s Look' : 'agent964, as shipped'}
          </span>
        </span>
        <span className="flex items-center gap-1 text-sm text-neutral-300">
          Edit
          <ChevronRight aria-hidden className="size-4" />
        </span>
      </Link>
    </section>
  )
}

const PRIVACY_LIMIT = 20_000

/**
 * The privacy page's text, shown at /_/privacy. Until a super admin edits
 * it, the page says what Dossier keeps; Reset brings that text back.
 */
function PrivacyPage({
  privacy,
  onChange,
}: {
  privacy: AdminPrivacy
  onChange: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(privacy.text)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const close = () => {
    setRefused(null)
    setEditing(false)
  }
  const save = async (text: string | null) => {
    setBusy(true)
    setRefused(null)
    const message = refusalOf(await setPrivacyText({ data: { text } }))
    setRefused(message)
    await onChange()
    setBusy(false)
    if (message === null) setEditing(false)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void save(draft)
  }
  return (
    <section aria-labelledby="privacy-label" className="flex flex-col gap-3">
      <SectionLabel id="privacy-label">Privacy page</SectionLabel>
      <div className="rounded-xl border border-border bg-card">
        <div className={ROW}>
          <span className="min-w-0 flex-1">
            <a
              href="/_/privacy"
              className="block truncate text-[0.9375rem] text-neutral-50 underline-offset-4 hover:underline"
            >
              /_/privacy
            </a>
            <span className="block font-mono text-xs text-neutral-400">
              {privacy.custom
                ? 'your text'
                : 'generated from what Dossier keeps'}
            </span>
          </span>
          <Button
            variant="outline"
            size="xs"
            aria-label="Edit the privacy page"
            onClick={() => {
              setDraft(privacy.text)
              setRefused(null)
              setEditing(true)
            }}
          >
            Edit
          </Button>
        </div>
      </div>
      <Modal
        open={editing}
        onClose={close}
        title="Privacy page"
        footer={
          <>
            <Button
              variant="outline"
              type="button"
              disabled={busy || !privacy.custom}
              className="sm:mr-auto"
              onClick={() => save(null)}
            >
              Reset
            </Button>
            <Button variant="ghost" type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="privacy-form" disabled={busy}>
              Save
            </Button>
          </>
        }
      >
        <form
          id="privacy-form"
          onSubmit={submit}
          className="flex flex-col gap-2"
        >
          <Label htmlFor="privacy-text">Text</Label>
          <textarea
            id="privacy-text"
            value={draft}
            rows={14}
            maxLength={PRIVACY_LIMIT}
            aria-describedby="privacy-help"
            aria-invalid={refused === null ? undefined : true}
            className="w-full rounded-lg border border-border bg-input px-3 py-2 font-mono text-base leading-relaxed text-neutral-100 outline-none transition-[color,border-color,box-shadow] duration-200 ease-agent focus-visible:border-brand-300/50 focus-visible:ring-[3px] focus-visible:ring-ring/40 md:text-sm"
            onChange={(event) => setDraft(event.target.value)}
          />
          <p id="privacy-help" className="text-sm text-neutral-400">
            Plain text. The first line is the heading. Empty text, or Reset,
            shows the generated text again.
          </p>
          <Refusal message={refused} />
        </form>
      </Modal>
    </section>
  )
}

function Workspaces({
  view,
  onChange,
}: {
  view: AdminView
  onChange: () => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const act = async (
    id: string,
    action: (i: { data: { id: string } }) => Promise<unknown>,
  ) => {
    setBusy(id)
    setRefused(null)
    setRefused(refusalOf(await action({ data: { id } })))
    await onChange()
    setBusy(null)
  }
  return (
    <section aria-labelledby="workspaces-label" className="flex flex-col gap-3">
      <SectionLabel id="workspaces-label" count={view.workspaces.length}>
        Workspaces
      </SectionLabel>
      {view.workspaces.length === 0 ? null : (
        <RowList>
          {view.workspaces.map((workspace) => (
            <li key={workspace.id} className={ROW}>
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-300"
              >
                <Building2 className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.9375rem] text-neutral-50">
                  {workspace.name}
                </span>
                <span className="block font-mono text-xs text-neutral-400">
                  {workspace.detail}
                </span>
                {workspace.suspendedAt === null ||
                workspace.deletedAt !== null ? null : (
                  <span className="block font-mono text-xs text-warning-300 sm:hidden">
                    Suspended
                  </span>
                )}
                {workspace.deleted === null ? null : (
                  <span className="block font-mono text-xs text-error-300">
                    {workspace.deleted}
                  </span>
                )}
              </span>
              {workspace.deletedAt !== null ? (
                <Button
                  variant="outline"
                  size="xs"
                  aria-label={`Restore ${workspace.name}`}
                  disabled={busy !== null}
                  onClick={() => act(workspace.id, restoreWorkspace)}
                >
                  Restore
                </Button>
              ) : workspace.suspendedAt !== null ? (
                <span className="flex shrink-0 items-center gap-2">
                  <Badge variant="warn" className="max-sm:hidden">
                    Suspended
                  </Badge>
                  <Button
                    variant="outline"
                    size="xs"
                    aria-label={`Lift the suspension of ${workspace.name}`}
                    disabled={busy !== null}
                    onClick={() => act(workspace.id, liftSuspension)}
                  >
                    Lift
                  </Button>
                </span>
              ) : (
                <Button
                  variant="destructive"
                  size="xs"
                  aria-label={`Suspend ${workspace.name}`}
                  disabled={busy !== null}
                  onClick={() => act(workspace.id, suspendWorkspace)}
                >
                  Suspend
                </Button>
              )}
            </li>
          ))}
        </RowList>
      )}
      <Refusal message={refused} />
      <p className="flex gap-2 text-sm text-neutral-400">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-neutral-500" />
        Super admins see each workspace&apos;s name and size, never its pages or
        data.
      </p>
    </section>
  )
}
