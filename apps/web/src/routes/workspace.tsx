import { useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { AtSign, Mail, Plus, ShieldCheck, UserMinus } from 'lucide-react'

import { AppShell } from '../components/app-shell'
import { Avatar } from '../components/avatar'
import { absoluteDateTime, relativeTime } from '../components/format'
import { PageHeader, SectionLabel } from '../components/page-header'
import { StatusMessage } from '../components/status-message'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Input, Label, Select } from '../components/ui/input'
import {
  addAllowlistEntry,
  loadWorkspace,
  removeAllowlistEntry,
  removeMember,
  setMemberRole,
} from '../server/workspace'
import { isSurfaceFailure, requireData, RouteError } from './-lib/guard'

export const Route = createFileRoute('/workspace')({
  loader: async () => requireData(await loadWorkspace(), '/workspace'),
  head: () => ({ meta: [{ title: 'Workspace — dossier' }] }),
  component: WorkspacePage,
  errorComponent: RouteError,
})

type Feedback = { tone: 'success' | 'error'; message: string } | null

function WorkspacePage() {
  const { viewer, members, allowlist } = Route.useLoaderData()
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [value, setValue] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')

  async function run(
    key: string,
    call: () => Promise<
      { ok: true; message: string } | { ok: false; message: string }
    >,
  ) {
    setPending(key)
    setFeedback(null)
    const result = await call()
    setPending(null)
    if (isSurfaceFailure(result)) {
      setFeedback({ tone: 'error', message: result.message })
      return
    }
    setFeedback({ tone: 'success', message: result.message })
    await router.invalidate()
  }

  const admins = members.filter((member) => member.role === 'admin').length

  return (
    <AppShell viewer={viewer} subtitle="Workspace">
      <PageHeader
        kicker={
          viewer.workspaceKind === 'team'
            ? 'Team workspace'
            : 'Personal workspace'
        }
        title={viewer.workspaceName}
        description={
          viewer.admin
            ? 'Who publishes here, and who is allowed to sign in at all. Removing an allowlist entry closes the door to new sign-ins; it never removes an existing member.'
            : 'Who publishes in this workspace. Only admins can change members or the allowlist.'
        }
        actions={
          viewer.admin ? (
            <Badge>
              <ShieldCheck aria-hidden />
              Admin
            </Badge>
          ) : (
            <Badge variant="muted">{viewer.role ?? 'no access'}</Badge>
          )
        }
      />

      <dl className="grid grid-cols-2 gap-3 border-t border-border pt-5 sm:grid-cols-4">
        <Stat label="Slug" value={viewer.workspaceSlug} mono />
        <Stat label="Domain" value={viewer.workspaceDomain ?? '—'} mono />
        <Stat label="Members" value={String(members.length)} />
        <Stat label="Admins" value={String(admins)} />
      </dl>

      {feedback ? (
        <StatusMessage tone={feedback.tone} className="mt-6">
          {feedback.message}
        </StatusMessage>
      ) : null}

      <div className="mt-2 grid gap-8 lg:grid-cols-12 lg:gap-10">
        <section className="min-w-0 lg:col-span-7">
          <SectionLabel
            aside={
              <span data-numeric className="text-micro-lg text-neutral-500">
                {members.length}
              </span>
            }
          >
            Members
          </SectionLabel>

          <ul className="grid gap-2">
            {members.map((member) => (
              <li
                key={member.accountId}
                className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar
                    name={member.name}
                    src={member.pictureUrl}
                    className="size-8"
                  />
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-neutral-100">
                      <span className="truncate">{member.name}</span>
                      {member.accountId === viewer.accountId ? (
                        <span className="text-micro-lg text-neutral-600">
                          you
                        </span>
                      ) : null}
                      {member.kind === 'service' ? (
                        <Badge variant="muted">Service</Badge>
                      ) : null}
                      {member.disabled ? (
                        <Badge variant="destructive">Disabled</Badge>
                      ) : null}
                    </p>
                    <p className="text-micro-lg mt-1 truncate text-neutral-500">
                      {member.email ?? 'no verified email'}
                      {member.lastLoginAt ? (
                        <>
                          <span className="text-neutral-700"> / </span>
                          <span title={absoluteDateTime(member.lastLoginAt)}>
                            seen {relativeTime(member.lastLoginAt, viewer.now)}
                          </span>
                        </>
                      ) : null}
                    </p>
                  </div>
                </div>

                {viewer.admin ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <Select
                      aria-label={`Role for ${member.name}`}
                      value={member.role}
                      disabled={pending !== null}
                      className="h-8 text-[0.8rem]"
                      wrapperClassName="w-[6.75rem]"
                      onChange={(event) =>
                        run(`role:${member.accountId}`, () =>
                          setMemberRole({
                            data: {
                              accountId: member.accountId,
                              role: event.target.value as 'admin' | 'member',
                              csrfToken: viewer.csrfToken,
                            },
                          }),
                        )
                      }
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${member.name}`}
                      title={`Remove ${member.name}`}
                      disabled={
                        pending !== null ||
                        member.accountId === viewer.accountId
                      }
                      onClick={() =>
                        run(`remove:${member.accountId}`, () =>
                          removeMember({
                            data: {
                              accountId: member.accountId,
                              csrfToken: viewer.csrfToken,
                            },
                          }),
                        )
                      }
                    >
                      <UserMinus aria-hidden />
                    </Button>
                  </div>
                ) : (
                  <Badge
                    variant={member.role === 'admin' ? 'default' : 'muted'}
                  >
                    {member.role}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </section>

        <aside className="min-w-0 lg:col-span-5">
          <SectionLabel
            aside={
              viewer.admin ? (
                <span data-numeric className="text-micro-lg text-neutral-500">
                  {allowlist.length}
                </span>
              ) : null
            }
          >
            Allowlist
          </SectionLabel>

          {!viewer.admin ? (
            <p className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-8 text-center text-sm text-neutral-500">
              Only workspace admins can see who is allowed to sign in.
            </p>
          ) : (
            <>
              <form
                className="grid gap-3 rounded-xl border border-border bg-card px-4 py-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  void run('allow', async () => {
                    const result = await addAllowlistEntry({
                      data: { value, role, csrfToken: viewer.csrfToken },
                    })
                    if (!isSurfaceFailure(result)) setValue('')
                    return result
                  })
                }}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="allow-value">
                    Allow an address or domain
                  </Label>
                  <Input
                    id="allow-value"
                    value={value}
                    required
                    placeholder="name@example.com"
                    onChange={(event) => setValue(event.target.value)}
                  />
                </div>
                <div className="flex items-end gap-2">
                  <div className="grid flex-1 gap-1.5">
                    <Label htmlFor="allow-role">Joins as</Label>
                    <Select
                      id="allow-role"
                      value={role}
                      onChange={(event) =>
                        setRole(event.target.value as 'admin' | 'member')
                      }
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </Select>
                  </div>
                  <Button type="submit" disabled={pending !== null}>
                    <Plus aria-hidden />
                    {pending === 'allow' ? 'Adding…' : 'Allow'}
                  </Button>
                </div>
                <p className="text-xs leading-ui text-neutral-600">
                  One address, or{' '}
                  <span className="font-mono text-neutral-500">
                    @example.com
                  </span>{' '}
                  to allow a whole verified domain.
                </p>
              </form>

              <ul className="mt-3 grid gap-2">
                {allowlist.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        aria-hidden
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-400"
                      >
                        {entry.kind === 'domain' ? (
                          <AtSign className="size-3.5" />
                        ) : (
                          <Mail className="size-3.5" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs text-neutral-200">
                          {entry.kind === 'domain'
                            ? `@${entry.value}`
                            : entry.value}
                        </p>
                        <p className="text-micro-lg mt-1 text-neutral-600">
                          {entry.role}
                          <span className="text-neutral-700"> / </span>
                          {entry.lastUsedAt ? (
                            <span title={absoluteDateTime(entry.lastUsedAt)}>
                              used {relativeTime(entry.lastUsedAt, viewer.now)}
                            </span>
                          ) : (
                            'never used'
                          )}
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${entry.value}`}
                      title={`Remove ${entry.value}`}
                      disabled={pending !== null}
                      onClick={() =>
                        run(`disallow:${entry.id}`, () =>
                          removeAllowlistEntry({
                            data: { id: entry.id, csrfToken: viewer.csrfToken },
                          }),
                        )
                      }
                    >
                      <UserMinus aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </AppShell>
  )
}

function Stat({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-3">
      <dt className="text-micro-lg text-neutral-600">{label}</dt>
      <dd
        data-numeric
        className={
          mono
            ? 'mt-1.5 truncate font-mono text-sm text-neutral-200'
            : 'mt-1.5 truncate text-sm text-neutral-200'
        }
      >
        {value}
      </dd>
    </div>
  )
}
