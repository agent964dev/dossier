import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { Check, Copy, Info, KeyRound, LogOut, User, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { AppHeader } from '../../components/app-header'
import { SectionLabel } from '../../components/section-label'
import { Button } from '../../components/ui/button'
import { Input, Label } from '../../components/ui/input'
import { Modal } from '../../components/ui/modal'
import { signOut } from '../../lib/auth-client'
import type { AgentKeyView } from '../../core/index'
import {
  accountView,
  createKey,
  revokeKey,
  signOutEverywhere,
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
          <p className="flex items-center gap-2 text-[0.9375rem] text-neutral-300">
            <User aria-hidden className="size-4 text-neutral-500" />
            <span className="min-w-0 break-words">
              <span className="break-all">{view.email}</span> · signed in with
              Google
            </span>
          </p>
        </div>

        <section
          aria-labelledby="workspaces-label"
          className="flex flex-col gap-3"
        >
          <SectionLabel id="workspaces-label" count={0}>
            Workspaces
          </SectionLabel>
          <p className="text-[0.9375rem] text-neutral-400">
            No workspaces yet.
          </p>
        </section>

        <AgentKeys keys={view.keys} onChange={() => router.invalidate()} />

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
      </main>
    </div>
  )
}

function AgentKeys({
  keys,
  onChange,
}: {
  keys: readonly AgentKeyView[]
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
                <p className="font-mono text-xs text-neutral-500">
                  {usedAgo(key.lastUsedAt, now)}
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
        onClose={() => setCreating(false)}
        onCreated={onChange}
      />
    </section>
  )
}

function NewKeyDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => Promise<void>
}) {
  const [name, setName] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const close = () => {
    setName('')
    setSecret(null)
    setError(null)
    setCopied(false)
    onClose()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await createKey({ data: { name } })
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
