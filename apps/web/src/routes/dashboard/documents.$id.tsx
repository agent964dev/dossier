import { useState } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import {
  ArrowLeft,
  Eye,
  EyeOff,
  ExternalLink,
  RotateCcw,
  Trash2,
} from 'lucide-react'

import { AppShell } from '../../components/app-shell'
import { CopyField } from '../../components/copy-field'
import { KindTag, VisibilityTag } from '../../components/document-list'
import {
  absoluteDateTime,
  fileSize,
  relativeTime,
  shortHash,
} from '../../components/format'
import { PageHeader, SectionLabel } from '../../components/page-header'
import { StatusMessage } from '../../components/status-message'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input, Label } from '../../components/ui/input'
import { documentAction, loadDocument } from '../../server/documents'
import { isSurfaceFailure, requireData, RouteError } from '../-lib/guard'

export const Route = createFileRoute('/dashboard/documents/$id')({
  loader: async ({ params }) =>
    requireData(
      await loadDocument({ data: { id: params.id } }),
      `/dashboard/documents/${params.id}`,
    ),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${loaderData.document.title} — dossier`
          : 'Document — dossier',
      },
    ],
  }),
  component: DocumentDetailPage,
  errorComponent: RouteError,
})

type Feedback = { tone: 'success' | 'error'; message: string } | null

function DocumentDetailPage() {
  const { viewer, document, versions } = Route.useLoaderData()
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [reason, setReason] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const archived = document.deletedAt !== null

  async function act(
    action: 'disable' | 'enable' | 'delete' | 'restore',
    extra: { reason?: string; batchId?: string; force?: boolean } = {},
  ) {
    setPending(action)
    setFeedback(null)
    const result = await documentAction({
      data: { id: document.id, action, csrfToken: viewer.csrfToken, ...extra },
    })
    setPending(null)
    if (isSurfaceFailure(result)) {
      setFeedback({ tone: 'error', message: result.message })
      return
    }
    setConfirmingDelete(false)
    if (result.action === 'deleted') {
      await router.navigate({ to: '/dashboard/trash' })
      return
    }
    setFeedback({
      tone: 'success',
      message:
        action === 'disable'
          ? 'Disabled. The document now returns 404 to every reader, including you.'
          : action === 'enable'
            ? 'Enabled. The document resolves again.'
            : 'Restored.',
    })
    await router.invalidate()
  }

  return (
    <AppShell viewer={viewer} subtitle="Document">
      <PageHeader
        kicker={document.kind ?? 'Document'}
        title={document.title}
        description={document.description}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/dashboard">
              <ArrowLeft aria-hidden />
              Documents
            </Link>
          </Button>
        }
      />

      {/* Tags first, provenance second: each line holds one kind of fact, so a
          wrap on a phone never strands a separator. */}
      <div className="flex flex-col gap-2.5 pb-6 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <KindTag kind={document.kind} />
          <VisibilityTag
            visibility={document.effectiveVisibility}
            inherited={document.accessSource === 'inherited'}
          />
          <span data-numeric className="text-micro-lg text-neutral-300">
            v{document.latestVersionNumber}
          </span>
          {document.disabled ? (
            <Badge variant="warn">
              <EyeOff aria-hidden />
              Disabled
            </Badge>
          ) : null}
          {archived ? <Badge variant="destructive">Archived</Badge> : null}
        </div>
        <div className="text-micro-lg flex min-w-0 items-center gap-1.5 text-neutral-500">
          <span className="truncate">{document.authorName}</span>
          <span aria-hidden className="text-neutral-700">
            ·
          </span>
          <span
            className="shrink-0"
            title={absoluteDateTime(document.updatedAt)}
          >
            updated {relativeTime(document.updatedAt, viewer.now)}
          </span>
        </div>
      </div>

      {archived ? (
        <StatusMessage tone="error" className="mb-6">
          This document is archived
          {document.deletedBy ? ` (by ${document.deletedBy})` : ''}. Its links
          return 404 until it is restored from the trash.
        </StatusMessage>
      ) : null}

      {feedback ? (
        <StatusMessage tone={feedback.tone} className="mb-6">
          {feedback.message}
        </StatusMessage>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
        <section className="min-w-0 lg:col-span-7">
          <SectionLabel
            aside={
              <span data-numeric className="text-micro-lg text-neutral-500">
                {versions.length} kept
              </span>
            }
          >
            Versions
          </SectionLabel>

          {versions.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-8 text-center text-sm text-neutral-500">
              Version history is visible to the document’s author.
            </p>
          ) : (
            <ul className="grid gap-2">
              {versions.map((version, index) => (
                <li
                  key={version.id}
                  className="min-w-0 rounded-xl border border-border bg-card px-4 py-3"
                >
                  {/*
                    One line per version: identity on the left, the two ways to
                    read it on the right. Everything else about a version is
                    provenance, so it stays at micro size beside the number.
                  */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Badge variant={index === 0 ? 'default' : 'muted'}>
                      v{version.versionNumber}
                    </Badge>
                    {index === 0 ? (
                      <span className="text-micro-lg text-brand-300/80">Current</span>
                    ) : null}
                    <span
                      className="text-micro-lg text-neutral-500"
                      title={absoluteDateTime(version.createdAt)}
                    >
                      {relativeTime(version.createdAt, viewer.now)}
                    </span>
                    <span aria-hidden className="text-neutral-700">
                      ·
                    </span>
                    <span data-numeric className="text-micro-lg text-neutral-500">
                      {fileSize(version.fileSize)}
                    </span>
                    <span
                      className="hidden font-mono text-xs text-neutral-600 sm:inline"
                      title={`sha256 ${version.contentHash}`}
                    >
                      {shortHash(version.contentHash)}
                    </span>
                    {version.originalFilename ? (
                      <span className="hidden min-w-0 truncate font-mono text-xs text-neutral-600 md:inline">
                        {version.originalFilename}
                      </span>
                    ) : null}

                    <span className="ml-auto flex items-center gap-1">
                      <Button asChild variant="ghost" size="sm">
                        <a href={version.url} target="_blank" rel="noreferrer">
                          Open
                          <ExternalLink aria-hidden />
                        </a>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                        <a href={version.rawUrl} target="_blank" rel="noreferrer">
                          Raw
                        </a>
                      </Button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="min-w-0 lg:col-span-5">
          <SectionLabel>Links</SectionLabel>
          <div className="grid gap-2.5">
            <LinkRow label="Document" value={document.url} href={document.url} />
            <LinkRow label="Raw" value={document.rawUrl} href={document.rawUrl} />
            <LinkRow
              label="Hub"
              value={document.hubUrl}
              hint="The tree view arrives with parents and children in phase 2."
              muted
            />
            <LinkRow label="Id" value={document.id} />
          </div>

          <SectionLabel className="mt-8">Actions</SectionLabel>
          <div className="grid gap-3 rounded-xl border border-border bg-card px-4 py-4">
            {archived ? (
              <>
                <p className="text-sm leading-body text-neutral-400">
                  Restoring brings back every document archived in the same
                  batch, with its versions and links intact.
                </p>
                <Button
                  type="button"
                  onClick={() =>
                    act('restore', { batchId: document.deletionBatchId ?? '' })
                  }
                  disabled={pending !== null}
                >
                  <RotateCcw aria-hidden />
                  {pending === 'restore' ? 'Restoring…' : 'Restore document'}
                </Button>
              </>
            ) : (
              <>
                {document.disabled ? (
                  <>
                    <p className="text-sm leading-body text-neutral-400">
                      This document is disabled: it returns 404 to everyone,
                      while staying visible to you here.
                    </p>
                    <Button
                      type="button"
                      onClick={() => act('enable')}
                      disabled={pending !== null}
                    >
                      <Eye aria-hidden />
                      {pending === 'enable' ? 'Enabling…' : 'Enable'}
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-sm leading-body text-neutral-400">
                      Disabling takes the document offline without deleting it.
                      Readers get a 404; nothing is lost.
                    </p>
                    <div className="grid gap-1.5">
                      <Label htmlFor="disable-reason">Reason (optional)</Label>
                      <Input
                        id="disable-reason"
                        value={reason}
                        maxLength={200}
                        placeholder="Superseded by the v2 plan"
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="warn"
                      onClick={() => act('disable', { reason: reason.trim() })}
                      disabled={pending !== null}
                    >
                      <EyeOff aria-hidden />
                      {pending === 'disable' ? 'Disabling…' : 'Disable'}
                    </Button>
                  </>
                )}

                <div className="mt-1 border-t border-border/70 pt-3">
                  {confirmingDelete ? (
                    <div className="grid gap-2.5">
                      <p className="text-sm leading-body text-error-300">
                        Archive “{document.title}”? It moves to the trash with
                        every document beneath it, and can be restored as one
                        batch.
                      </p>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Button
                          type="button"
                          variant="destructive-solid"
                          onClick={() => act('delete', { force: true })}
                          disabled={pending !== null}
                        >
                          <Trash2 aria-hidden />
                          {pending === 'delete' ? 'Archiving…' : 'Yes, archive it'}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setConfirmingDelete(false)}
                          disabled={pending !== null}
                        >
                          Keep it
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="destructive"
                      className="w-full"
                      onClick={() => setConfirmingDelete(true)}
                      disabled={pending !== null}
                    >
                      <Trash2 aria-hidden />
                      Archive document
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>

          <SectionLabel className="mt-8">Details</SectionLabel>
          <dl className="grid gap-2.5 text-sm">
            <DetailRow label="Author" value={document.authorName} />
            <DetailRow label="Workspace" value={document.workspaceSlug} />
            <DetailRow
              label="Access"
              value={
                document.accessSource === 'inherited'
                  ? `${document.effectiveVisibility} (inherited)`
                  : document.effectiveVisibility
              }
            />
            <DetailRow label="Revision" value={String(document.revision)} />
            <DetailRow label="Created" value={absoluteDateTime(document.createdAt)} />
            <DetailRow label="Updated" value={absoluteDateTime(document.updatedAt)} />
          </dl>
        </aside>
      </div>
    </AppShell>
  )
}

function LinkRow({
  label,
  value,
  href,
  hint,
  muted,
}: {
  label: string
  value: string
  href?: string
  hint?: string
  muted?: boolean
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <span className="text-micro-lg text-neutral-500">{label}</span>
        {muted ? (
          <span className="text-micro-lg text-neutral-600">Phase 2</span>
        ) : null}
      </div>
      <CopyField
        value={value}
        label={`Copy the ${label.toLowerCase()} link`}
        {...(href ? { href } : {})}
        {...(muted ? { muted: true } : {})}
      />
      {hint ? <p className="mt-1.5 text-xs leading-ui text-neutral-600">{hint}</p> : null}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 pb-2.5">
      <dt className="text-micro-lg shrink-0 text-neutral-600">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs text-neutral-300">{value}</dd>
    </div>
  )
}
