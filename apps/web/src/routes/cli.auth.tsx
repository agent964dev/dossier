import { useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { KeyRound, ShieldAlert, Sparkles, Trash2 } from 'lucide-react'

import { AppShell } from '../components/app-shell'
import { CopyField } from '../components/copy-field'
import { absoluteDateTime, relativeTime } from '../components/format'
import { PageHeader, SectionLabel } from '../components/page-header'
import { StatusMessage } from '../components/status-message'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Input, Label } from '../components/ui/input'
import { loadCliAuth, mintApiKey, revokeApiKey } from '../server/keys'
import { isSurfaceFailure, requireData, RouteError } from './-lib/guard'

export const Route = createFileRoute('/cli/auth')({
  loader: async () => requireData(await loadCliAuth(), '/cli/auth'),
  head: () => ({ meta: [{ title: 'CLI keys — dossier' }] }),
  component: CliAuthPage,
  errorComponent: RouteError,
})

const STEPS = [
  {
    n: '01',
    title: 'Generate a key',
    body: 'Name it after the machine or the agent that will use it, so you can revoke exactly one later.',
  },
  {
    n: '02',
    title: 'Store it on that machine',
    body: 'Paste the token into the CLI once; it is written to ~/.dossier/credentials.json with mode 0600.',
  },
  {
    n: '03',
    title: 'Check it works',
    body: 'whoami prints the account and workspace the key is bound to.',
  },
] as const

function CliAuthPage() {
  const { viewer, keys } = Route.useLoaderData()
  const router = useRouter()
  const [name, setName] = useState('')
  const [minted, setMinted] = useState<{ token: string; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  async function mint() {
    setPending('mint')
    setError(null)
    const result = await mintApiKey({
      data: { name: name.trim(), csrfToken: viewer.csrfToken },
    })
    setPending(null)
    if (isSurfaceFailure(result)) {
      setError(result.message)
      return
    }
    setMinted({ token: result.token, name: result.key.name })
    setName('')
    await router.invalidate()
  }

  async function revoke(id: string) {
    setPending(id)
    setError(null)
    const result = await revokeApiKey({ data: { id, csrfToken: viewer.csrfToken } })
    setPending(null)
    if (isSurfaceFailure(result)) {
      setError(result.message)
      return
    }
    if (minted !== null) setMinted(null)
    await router.invalidate()
  }

  const active = keys.filter((key) => key.revokedAt === null)
  const revoked = keys.filter((key) => key.revokedAt !== null)

  return (
    <AppShell viewer={viewer} subtitle="CLI setup">
      <PageHeader
        kicker="Command line"
        title="CLI keys"
        description={
          viewer.publisher
            ? `A key publishes into ${viewer.workspaceSlug} as you. It is shown once, stored as a hash, and can be revoked at any time.`
            : 'Keys are bound to a workspace at minting time, so only its members can create one.'
        }
      />

      {!viewer.publisher ? (
        <div className="rounded-xl border border-warning-400/25 bg-warning-400/8 px-5 py-6">
          <span className="inline-flex size-9 items-center justify-center rounded-full border border-warning-400/30 bg-warning-400/10 text-warning-300">
            <ShieldAlert aria-hidden className="size-4" />
          </span>
          <h2 className="font-clash mt-4 text-lg font-semibold tracking-[-0.02em] text-neutral-100">
            Only members can mint keys
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-body text-neutral-400">
            You are signed in, but you are not a member of{' '}
            <span className="text-neutral-200">{viewer.workspaceSlug}</span>, so
            you cannot publish here. Ask a workspace admin to add your address to
            the allowlist and sign in again.
          </p>
        </div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
          <section className="min-w-0 lg:col-span-7">
            <SectionLabel>Generate</SectionLabel>

            <div className="rounded-xl border border-border bg-card px-4 py-4 sm:px-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="grid flex-1 gap-1.5">
                  <Label htmlFor="key-name">Key name</Label>
                  <Input
                    id="key-name"
                    value={name}
                    maxLength={64}
                    placeholder="Laptop · claude-code"
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <Button type="button" onClick={mint} disabled={pending !== null}>
                  <Sparkles aria-hidden />
                  {pending === 'mint' ? 'Generating…' : 'Generate key'}
                </Button>
              </div>
              <p className="mt-2.5 text-xs leading-ui text-neutral-600">
                Leave the name blank and it is named after today’s date.
              </p>
            </div>

            {error ? (
              <StatusMessage tone="error" className="mt-4">
                {error}
              </StatusMessage>
            ) : null}

            {minted ? (
              <div className="mt-4 rounded-xl border border-brand-300/35 bg-brand-300/[0.06] px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge>
                    <KeyRound aria-hidden />
                    Shown once
                  </Badge>
                  <span className="text-micro-lg text-neutral-400">{minted.name}</span>
                </div>
                <p className="mt-3 text-sm leading-body text-neutral-300">
                  Copy this now. dossier stores only its SHA-256 hash, so it
                  cannot be shown again — losing it means generating another.
                </p>
                <CopyField
                  className="mt-3"
                  value={minted.token}
                  label="Copy the API key"
                />
                <p className="text-micro-lg mt-4 mb-1.5 text-neutral-500">
                  Then, on that machine
                </p>
                <CopyField
                  value={`dossier auth set ${minted.token}`}
                  label="Copy the auth command"
                  prefix="$"
                />
              </div>
            ) : null}

            <SectionLabel className="mt-8" aside={
              <span data-numeric className="text-micro-lg text-neutral-500">
                {active.length} active
              </span>
            }>
              Keys
            </SectionLabel>

            {keys.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-8 text-center text-sm text-neutral-500">
                No keys yet. Generate one above to publish from this workspace.
              </p>
            ) : (
              <ul className="grid gap-2">
                {[...active, ...revoked].map((key) => (
                  <li
                    key={key.id}
                    className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium text-neutral-100">
                        <span className="truncate">{key.name}</span>
                        {key.revokedAt ? (
                          <Badge variant="muted">Revoked</Badge>
                        ) : null}
                      </p>
                      <p className="text-micro-lg mt-1.5 text-neutral-500">
                        <span title={absoluteDateTime(key.createdAt)}>
                          created {relativeTime(key.createdAt, viewer.now)}
                        </span>
                        <span className="text-neutral-700"> / </span>
                        {key.lastUsedAt ? (
                          <span title={absoluteDateTime(key.lastUsedAt)}>
                            used {relativeTime(key.lastUsedAt, viewer.now)}
                          </span>
                        ) : (
                          'never used'
                        )}
                      </p>
                    </div>
                    {key.revokedAt ? null : (
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => revoke(key.id)}
                        disabled={pending !== null}
                        className="self-start sm:self-auto"
                      >
                        <Trash2 aria-hidden />
                        {pending === key.id ? 'Revoking…' : 'Revoke'}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <aside className="min-w-0 lg:col-span-5">
            <SectionLabel>Set up</SectionLabel>
            <ol className="grid gap-4">
              {STEPS.map((step) => (
                <li key={step.n} className="flex gap-3">
                  <span data-numeric className="text-micro-lg mt-[5px] text-neutral-600">
                    {step.n}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-neutral-200">{step.title}</p>
                    <p className="mt-1 text-sm leading-body text-neutral-500">
                      {step.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-6 grid gap-2.5">
              <CopyField
                value="bunx @agent964/dossier auth set"
                label="Copy the auth command"
                prefix="$"
              />
              <CopyField
                value="bunx @agent964/dossier whoami"
                label="Copy the whoami command"
                prefix="$"
              />
            </div>

            <p className="text-micro-lg mt-6 text-neutral-600">
              Node 22+ or Bun · nothing to install
            </p>
          </aside>
        </div>
      )}
    </AppShell>
  )
}
