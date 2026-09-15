import { useState } from 'react'
import type {
  DocumentEditor,
  SharesResponse,
  Visibility,
} from '@dossier/contracts'
import { Check, Mail, Plus, X } from 'lucide-react'

import { VisibilityTag } from './document-list'
import { StatusMessage } from './status-message'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input, Label } from './ui/input'
import { useDocumentAction } from './use-document-action'
import { cn } from '@/lib/utils'

/**
 * Who can read this document, and where that answer comes from.
 *
 * Widening access is deliberately two-step because the selected boundary
 * applies to every retained version, including pinned version URLs.
 */

type Level = Visibility | 'inherit'

const LEVELS: ReadonlyArray<{
  value: Level
  label: string
  hint: (workspaceSlug: string) => string
}> = [
  {
    value: 'public',
    label: 'Public',
    hint: () => 'Anyone with the link, signed in or not.',
  },
  {
    value: 'team',
    label: 'Team',
    hint: (slug) => `Every member of ${slug}.`,
  },
  {
    value: 'private',
    label: 'Private',
    hint: () => 'You, workspace admins, and the invited emails below.',
  },
  {
    value: 'inherit',
    label: 'Inherit',
    hint: () =>
      'Follow the nearest parent that sets a level; team when none does.',
  },
]

const ACCESS_RANK: Readonly<Record<Visibility, number>> = {
  private: 0,
  team: 1,
  public: 2,
}

function splitEmails(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
}

export function AccessPanel({
  document,
  shares,
  csrfToken,
  workspaceSlug,
  canEdit,
}: {
  document: DocumentEditor
  shares: SharesResponse
  csrfToken: string
  workspaceSlug: string
  canEdit: boolean
}) {
  const { pending, failure, setFailure, run } = useDocumentAction(csrfToken)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Level | null>(null)

  const current: Level = document.visibility ?? 'inherit'
  const inForce = shares.effective
  const strayConfigured = shares.configured.filter(
    (email) => !inForce.includes(email),
  )
  /**
   * An invited email may also hold a saved-values grant. The two are separate
   * powers on separate rows, so each list badges what the other one adds: the
   * invite row says the email can save, the grant row says it is also invited.
   */
  const savers = new Set(
    shares.grants.filter((grant) => grant.canSave).map((grant) => grant.email),
  )
  const ownBoundary = shares.accessSource === 'own'
  const versions = `${document.versionCount} retained ${
    document.versionCount === 1 ? 'version' : 'versions'
  }`

  function needsConfirmation(level: Level): boolean {
    if (level === current || document.effectiveVisibility === 'public')
      return false
    if (level === 'inherit') return true
    return ACCESS_RANK[level] > ACCESS_RANK[document.effectiveVisibility]
  }

  function consequence(level: Level): string {
    if (level === 'public') {
      return `Makes all ${versions} readable by anyone with the link, including pinned version URLs.`
    }
    if (level === 'team') {
      return `Makes all ${versions} readable by every member of ${workspaceSlug}.`
    }
    return `Stops setting access here. The nearest parent may widen access to all ${versions}, including pinned version URLs.`
  }

  async function setLevel(level: Level) {
    setConfirmation(null)
    setNote(null)
    const result = await run(`level:${level}`, {
      id: document.id,
      action: 'visibility',
      visibility: level,
    })
    if (result === null) return
    setNote(
      level === 'inherit'
        ? 'Now inheriting. Any invites this document carried were dropped with the boundary.'
        : `Now ${level}.`,
    )
  }

  function chooseLevel(level: Level) {
    if (level === current) {
      setConfirmation(null)
      return
    }
    setNote(null)
    setFailure(null)
    if (needsConfirmation(level)) {
      setConfirmation(level)
      return
    }
    void setLevel(level)
  }

  async function addShares(event: React.FormEvent) {
    event.preventDefault()
    setNote(null)
    const emails = splitEmails(draft)
    if (emails.length === 0) {
      setFailure({ code: 'policy_rejected', message: 'Name an email first.' })
      return
    }
    const result = await run('add', {
      id: document.id,
      action: 'shares',
      add: emails,
    })
    if (result === null) return
    setDraft('')
    setNote(
      emails.length === 1
        ? `${emails[0]} can read this document.`
        : `${emails.length} emails can read this document.`,
    )
  }

  async function removeShare(email: string) {
    setNote(null)
    const result = await run(`remove:${email}`, {
      id: document.id,
      action: 'shares',
      remove: [email],
    })
    if (result === null) return
    setNote(`${email} no longer has access through an invite.`)
  }

  async function setSaver(email: string, canSave: boolean) {
    setNote(null)
    const result = await run(`saver:${email}`, {
      id: document.id,
      action: 'savers',
      ...(canSave ? { addSavers: [email] } : { removeSavers: [email] }),
    })
    if (result === null) return
    setNote(
      canSave
        ? `${email} can save this document's values.`
        : `${email} can still read, but can no longer save values.`,
    )
  }

  async function removeGrant(email: string) {
    setNote(null)
    const result = await run(`grant:${email}`, {
      id: document.id,
      action: 'savers',
      removeGrants: [email],
    })
    if (result === null) return
    setNote(`Removed the saved-values grant for ${email}.`)
  }

  const inviteForm = (
    <form onSubmit={addShares} className="grid gap-2">
      <Label htmlFor="share-email" className="text-xs text-neutral-500">
        Invite by email
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="share-email"
          name="share-email"
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          placeholder="ada@agent964.com, grace@agent964.com"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={pending !== null}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={pending !== null || draft.trim().length === 0}
          className="sm:w-auto"
        >
          <Plus aria-hidden />
          {pending === 'add' ? 'Inviting…' : 'Invite'}
        </Button>
      </div>
      {ownBoundary ? null : (
        <p className="text-xs leading-ui text-neutral-500">
          Adding or removing an invite copies the inherited level and invites
          onto this document first, so it stops following the parent.
        </p>
      )}
    </form>
  )

  return (
    <div className="grid gap-4 rounded-xl border border-border bg-card px-4 py-4 sm:px-5">
      <div>
        <div className="flex flex-wrap items-center gap-2.5">
          <VisibilityTag
            visibility={document.effectiveVisibility}
            inherited={shares.accessSource === 'inherited'}
          />
          <Badge variant={ownBoundary ? 'default' : 'muted'}>
            {shares.accessSource === 'own'
              ? 'set here'
              : shares.accessSource === 'inherited'
                ? 'inherited'
                : 'default'}
          </Badge>
        </div>
        <p className="mt-2 text-sm leading-body text-neutral-400">
          {shares.accessSource === 'own'
            ? 'Set on this document. It replaces what any parent says, invites included.'
            : shares.accessSource === 'inherited'
              ? 'Inherited whole from the nearest parent that sets a level — its invites come with it.'
              : `Nothing above sets a level, so team is the floor: every member of ${workspaceSlug} can read it.`}
        </p>
      </div>

      <fieldset
        disabled={!canEdit || pending !== null}
        className="min-w-0 border-t border-border/70 pt-4"
      >
        <legend className="sr-only">Visibility</legend>
        <div className="text-micro-lg pb-2 text-neutral-500">Level</div>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {LEVELS.map((level) => {
            const active = level.value === current
            const awaiting = level.value === confirmation
            return (
              <button
                key={level.value}
                type="button"
                aria-pressed={active}
                onClick={() => chooseLevel(level.value)}
                className={cn(
                  'rounded-lg border px-2 py-2 text-[0.8125rem] font-medium',
                  'transition-[border-color,background-color,color] duration-200 ease-agent',
                  'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  'disabled:pointer-events-none disabled:opacity-50',
                  active
                    ? 'border-brand-300/45 bg-brand-300/12 text-brand-100'
                    : awaiting
                      ? 'border-warning-400/55 bg-warning-400/10 text-warning-200'
                      : 'border-border bg-neutral-900/60 text-neutral-300 hover:border-brand-300/35 hover:text-neutral-50',
                )}
              >
                {pending === `level:${level.value}` ? 'Saving…' : level.label}
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-xs leading-ui text-neutral-500">
          {(LEVELS.find((level) => level.value === current) ?? LEVELS[1]).hint(
            workspaceSlug,
          )}
        </p>

        {confirmation ? (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-warning-400/35 bg-warning-400/[0.07] px-3 py-3"
          >
            <p className="text-sm leading-ui text-warning-100">
              {consequence(confirmation)}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="warn"
                onClick={() => setLevel(confirmation)}
              >
                Confirm{' '}
                {LEVELS.find((level) => level.value === confirmation)?.label}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirmation(null)}
              >
                Keep current access
              </Button>
            </div>
          </div>
        ) : null}
      </fieldset>

      <div className="border-t border-border/70 pt-4">
        <div className="flex items-center justify-between gap-3 pb-2">
          <span className="text-micro-lg text-neutral-500">Invited emails</span>
          <span data-numeric className="text-micro-lg text-neutral-500">
            {inForce.length} in force
          </span>
        </div>

        {inForce.length === 0 ? (
          <p className="text-sm leading-ui text-neutral-500">
            No invites.
            {document.effectiveVisibility === 'private'
              ? ' Only you and workspace admins can read this.'
              : ''}
          </p>
        ) : (
          <ul className="grid gap-1.5">
            {inForce.map((email) => (
              <li
                key={email}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-neutral-950/50 py-1.5 pr-1 pl-2.5"
              >
                <Mail
                  aria-hidden
                  className="size-3.5 shrink-0 text-neutral-500"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-200">
                  {email}
                </span>
                {ownBoundary ? null : (
                  <Badge variant="muted" className="shrink-0">
                    inherited
                  </Badge>
                )}
                {savers.has(email) ? (
                  <Badge variant="success" className="shrink-0">
                    can save
                  </Badge>
                ) : null}
                {canEdit ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${email}`}
                    title={`Remove ${email}`}
                    disabled={pending !== null}
                    onClick={() => removeShare(email)}
                  >
                    {pending === `remove:${email}` ? (
                      <span className="text-micro">…</span>
                    ) : (
                      <X aria-hidden />
                    )}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {strayConfigured.length > 0 ? (
          <p className="mt-2.5 text-xs leading-ui text-neutral-500">
            Configured here but not in force while the boundary sits above:{' '}
            <span className="font-mono">{strayConfigured.join(', ')}</span>
          </p>
        ) : null}

        {canEdit ? (
          document.effectiveVisibility === 'private' ? (
            <div className="mt-3">{inviteForm}</div>
          ) : (
            <details className="group/invites mt-3 rounded-lg border border-border/70 bg-neutral-950/30 px-3 py-2.5">
              <summary className="cursor-pointer text-xs leading-ui text-neutral-400 marker:text-neutral-600 hover:text-neutral-200">
                Add invites for when this becomes private
              </summary>
              <p className="mt-2 text-xs leading-ui text-neutral-500">
                Invites do not narrow {document.effectiveVisibility} access now,
                but they remain configured if you later choose Private.
              </p>
              <div className="mt-3 border-t border-border/70 pt-3">
                {inviteForm}
              </div>
            </details>
          )
        ) : null}
      </div>

      <div className="border-t border-border/70 pt-4">
        <div className="flex items-center justify-between gap-3 pb-2">
          <span className="text-micro-lg text-neutral-500">Saved values</span>
          <span data-numeric className="text-micro-lg text-neutral-500">
            {shares.grants.length}{' '}
            {shares.grants.length === 1 ? 'grant' : 'grants'}
          </span>
        </div>
        <p className="mb-2.5 text-xs leading-ui text-neutral-500">
          A grant lets a signed-in person save values on this document alone. It
          never reaches a child, and it never allows publishing or changing
          access.
        </p>

        {shares.grants.length === 0 ? (
          <p className="text-sm leading-ui text-neutral-500">
            No grants. Only people who can edit this document can save its
            values.
          </p>
        ) : (
          <ul className="grid gap-1.5">
            {shares.grants.map((grant) => (
              <li
                key={grant.email}
                className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-neutral-950/50 py-1.5 pr-1 pl-2.5"
              >
                <Mail
                  aria-hidden
                  className="size-3.5 shrink-0 text-neutral-500"
                />
                {/* The email keeps a readable width: when the badge and the
                    two controls stop fitting beside it, they wrap under it
                    instead of squeezing the address into an ellipsis. */}
                <span className="min-w-28 flex-1 truncate font-mono text-xs text-neutral-200">
                  {grant.email}
                </span>
                {inForce.includes(grant.email) ? (
                  <Badge variant="muted" className="shrink-0">
                    invited
                  </Badge>
                ) : null}
                {canEdit ? (
                  <>
                    {/* A toggle rather than a checkbox: the same pressed-state
                        button the level picker uses, so one keyboard and one
                        focus ring serve the whole panel. */}
                    <Button
                      type="button"
                      size="xs"
                      variant={grant.canSave ? 'success' : 'outline'}
                      aria-pressed={grant.canSave}
                      aria-label={`Can save: ${grant.email}`}
                      disabled={pending !== null}
                      onClick={() => void setSaver(grant.email, !grant.canSave)}
                    >
                      {grant.canSave ? (
                        <Check aria-hidden className="size-3" />
                      ) : null}
                      {pending === `saver:${grant.email}`
                        ? 'Saving…'
                        : 'Can save'}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label={`Remove the grant for ${grant.email}`}
                      disabled={pending !== null}
                      onClick={() => void removeGrant(grant.email)}
                    >
                      {pending === `grant:${grant.email}`
                        ? 'Removing…'
                        : 'Remove'}
                    </Button>
                  </>
                ) : (
                  <Badge
                    variant={grant.canSave ? 'success' : 'outline'}
                    className="shrink-0"
                  >
                    {grant.canSave ? 'can save' : 'read only'}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {failure ? (
        <StatusMessage tone="error">
          {failure.message}{' '}
          <span className="text-micro-lg text-neutral-500">{failure.code}</span>
        </StatusMessage>
      ) : note ? (
        <StatusMessage tone="success">{note}</StatusMessage>
      ) : null}

      {canEdit ? null : (
        <p className="text-xs leading-ui text-neutral-500">
          Access is read-only here: an archived document, or a workspace you are
          no longer a member of, cannot have its boundary changed.
        </p>
      )}
    </div>
  )
}
