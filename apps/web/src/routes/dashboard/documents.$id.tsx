import { useState } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import {
  ArrowLeft,
  ChevronRight,
  Eye,
  EyeOff,
  ExternalLink,
  GitCompare,
  Home,
  RotateCcw,
} from 'lucide-react'

import { AccessPanel } from '../../components/access-panel'
import { AppShell } from '../../components/app-shell'
import { ArchiveDialog } from '../../components/archive-dialog'
import { CopyField } from '../../components/copy-field'
import { KindTag, VisibilityTag } from '../../components/document-list'
import {
  absoluteDateTime,
  fileSize,
  relativeTime,
  shortHash,
} from '../../components/format'
import { MoveDialog } from '../../components/move-dialog'
import { PageHeader, SectionLabel } from '../../components/page-header'
import { StatusMessage } from '../../components/status-message'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input, Label } from '../../components/ui/input'
import { useDocumentAction } from '../../components/use-document-action'
import { loadDocument } from '../../server/documents'
import { requireData, RouteError } from '../-lib/guard'

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

function DocumentDetailPage() {
  const {
    viewer,
    document,
    versions,
    shares,
    destinations,
    ancestors,
    childCount,
    archivePreview,
    restorable,
  } = Route.useLoaderData()
  const router = useRouter()
  const { pending, failure, run } = useDocumentAction(viewer.csrfToken)
  const [note, setNote] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  const archived = document.deletedAt !== null
  const canEdit = archived === false && viewer.publisher
  const archiveAction = (
    <ArchiveDialog
      document={document}
      csrfToken={viewer.csrfToken}
      disabled={pending !== null || !viewer.publisher}
      preview={archivePreview}
      onArchived={() => router.navigate({ to: '/dashboard/trash' })}
    />
  )

  async function act(action: 'disable' | 'enable' | 'restore') {
    setNote(null)
    const result = await run(action, {
      id: document.id,
      action,
      ...(action === 'disable' ? { reason: reason.trim() } : {}),
      ...(action === 'restore'
        ? { batchId: document.deletionBatchId ?? '' }
        : {}),
    })
    if (result === null) return
    setNote(
      action === 'disable'
        ? 'Disabled. The document now returns 404 to every reader, including you.'
        : action === 'enable'
          ? 'Enabled. The document resolves again.'
          : 'Restored, with everything else in its batch.',
    )
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

      {/* Where it is filed. Only readable ancestors appear; a hidden parent is
          simply absent, never a locked placeholder. */}
      <nav aria-label="Breadcrumb" className="pb-4">
        <ol className="text-micro-lg flex flex-wrap items-center gap-x-1.5 gap-y-1 text-neutral-500">
          <li className="flex items-center gap-1.5">
            <Home aria-hidden className="size-3" />
            {viewer.workspaceSlug}
          </li>
          {ancestors.map((ancestor) => (
            <li key={ancestor.id} className="flex min-w-0 items-center gap-1.5">
              <ChevronRight aria-hidden className="size-3 text-neutral-700" />
              {ancestor.editor ? (
                <Link
                  to="/dashboard/documents/$id"
                  params={{ id: ancestor.id }}
                  className="max-w-[12rem] truncate text-neutral-400 underline-offset-4 hover:text-brand-100 hover:underline"
                >
                  {ancestor.title}
                </Link>
              ) : (
                <a
                  href={ancestor.url}
                  target="_blank"
                  rel="noreferrer"
                  className="max-w-[12rem] truncate text-neutral-400 underline-offset-4 hover:text-brand-100 hover:underline"
                >
                  {ancestor.title}
                </a>
              )}
            </li>
          ))}
          <li className="flex min-w-0 items-center gap-1.5">
            <ChevronRight aria-hidden className="size-3 text-neutral-700" />
            <span
              aria-current="page"
              className="max-w-[14rem] truncate text-neutral-300"
            >
              {document.title}
            </span>
          </li>
        </ol>
      </nav>

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
          {childCount > 0 ? (
            <Badge variant="muted">
              {childCount === 1 ? '1 child' : `${childCount} children`}
            </Badge>
          ) : null}
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
          {document.deletedBy ? ` (by ${document.deletedBy})` : ''}
          {document.deletionRootTitle &&
          document.deletionRootTitle !== document.title
            ? ` as part of “${document.deletionRootTitle}”`
            : ''}
          . Its links return 404 until the batch is restored.
        </StatusMessage>
      ) : null}

      {failure ? (
        <StatusMessage tone="error" className="mb-6">
          {failure.message}{' '}
          <span className="text-micro-lg text-neutral-500">{failure.code}</span>
        </StatusMessage>
      ) : note ? (
        <StatusMessage tone="success" className="mb-6">
          {note}
        </StatusMessage>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
        <aside className="contents lg:order-2 lg:col-span-5 lg:block">
          <section className="order-1 min-w-0 lg:order-none">
            <SectionLabel>Access</SectionLabel>
            <AccessPanel
              document={document}
              shares={shares}
              csrfToken={viewer.csrfToken}
              workspaceSlug={viewer.workspaceSlug}
              canEdit={canEdit}
            />
          </section>

          <section className="order-3 min-w-0 lg:order-none">
            <SectionLabel className="lg:mt-8">Filing</SectionLabel>
            <div className="grid gap-3 rounded-xl border border-border bg-card px-4 py-4">
              <p className="text-sm leading-body text-neutral-400">
                {ancestors.length === 0
                  ? 'Filed at the workspace root.'
                  : `Filed under “${ancestors[ancestors.length - 1].title}”.`}
                {childCount > 0
                  ? ` ${childCount === 1 ? 'One document is' : `${childCount} documents are`} filed directly under this one and travel with it.`
                  : ''}
              </p>
              <MoveDialog
                document={document}
                destinations={destinations}
                csrfToken={viewer.csrfToken}
                disabled={!canEdit || pending !== null}
                onMoved={(message) => setNote(message)}
              />
            </div>
          </section>

          <section className="order-5 min-w-0 lg:order-none">
            <SectionLabel className="lg:mt-8">Links</SectionLabel>
            <div className="grid gap-2.5">
              <LinkRow
                label="Document"
                value={document.url}
                href={document.url}
              />
              <LinkRow
                label="Raw"
                value={document.rawUrl}
                href={document.rawUrl}
              />
              <LinkRow
                label="Hub"
                value={document.hubUrl}
                href={document.hubUrl}
              />
              <LinkRow label="Id" value={document.id} />
            </div>
          </section>

          <section className="order-4 min-w-0 lg:order-none">
            <SectionLabel className="lg:mt-8">Actions</SectionLabel>
            <div className="grid gap-3 rounded-xl border border-border bg-card px-4 py-4">
              {archived ? (
                restorable ? (
                  <>
                    <p className="text-sm leading-body text-neutral-400">
                      Restoring brings back every document archived in the same
                      batch, with its versions and links intact.
                    </p>
                    <Button
                      type="button"
                      onClick={() => act('restore')}
                      disabled={pending !== null || !viewer.publisher}
                    >
                      <RotateCcw aria-hidden />
                      {pending === 'restore'
                        ? 'Restoring…'
                        : 'Restore document'}
                    </Button>
                  </>
                ) : (
                  <p className="text-sm leading-body text-neutral-400">
                    This document was archived inside a larger batch, so it is
                    restored with that batch rather than on its own.
                    {document.deletedBy
                      ? ` Ask ${document.deletedBy}`
                      : ' Ask'}{' '}
                    or a workspace admin to restore “
                    {document.deletionRootTitle ?? 'the parent document'}”, then
                    move this one out.
                  </p>
                )
              ) : (
                <>
                  {document.disabled ? (
                    <>
                      <p className="text-sm leading-body text-neutral-400">
                        This document is disabled: it returns 404 to everyone,
                        while staying visible to you here.
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => act('enable')}
                          disabled={pending !== null || !viewer.publisher}
                        >
                          <Eye aria-hidden />
                          {pending === 'enable' ? 'Enabling…' : 'Enable'}
                        </Button>
                        {archiveAction}
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-sm leading-body text-neutral-400">
                        Disabling takes the document offline without deleting
                        it. Readers get a 404; nothing is lost.
                      </p>
                      <div className="grid gap-1.5">
                        <Label htmlFor="disable-reason">
                          Reason (optional)
                        </Label>
                        <Input
                          id="disable-reason"
                          value={reason}
                          maxLength={200}
                          placeholder="Superseded by the v2 plan"
                          onChange={(event) => setReason(event.target.value)}
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          variant="warn"
                          size="sm"
                          onClick={() => act('disable')}
                          disabled={pending !== null || !viewer.publisher}
                        >
                          <EyeOff aria-hidden />
                          {pending === 'disable' ? 'Disabling…' : 'Disable'}
                        </Button>
                        {archiveAction}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </section>

          <section className="order-6 min-w-0 lg:order-none">
            <SectionLabel className="lg:mt-8">Details</SectionLabel>
            <dl className="grid gap-2.5 text-sm">
              <DetailRow label="Author" value={document.authorName} />
              <DetailRow label="Workspace" value={document.workspaceSlug} />
              <DetailRow
                label="Access"
                value={
                  document.accessSource === 'own'
                    ? `${document.effectiveVisibility} (set here)`
                    : document.accessSource === 'inherited'
                      ? `${document.effectiveVisibility} (inherited)`
                      : `${document.effectiveVisibility} (default)`
                }
              />
              <DetailRow label="Revision" value={String(document.revision)} />
              <DetailRow
                label="Created"
                value={absoluteDateTime(document.createdAt)}
              />
              <DetailRow
                label="Updated"
                value={absoluteDateTime(document.updatedAt)}
              />
            </dl>
          </section>
        </aside>

        <section className="order-2 min-w-0 lg:order-1 lg:col-span-7">
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
              Version history is available to the document’s editors.
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
                      <span className="text-micro-lg text-brand-300/80">
                        Current
                      </span>
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
                    <span
                      data-numeric
                      className="text-micro-lg text-neutral-500"
                    >
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
                      {/*
                        Phase 4: every version row opens the diff page already
                        pointed at the comparison its reader wants — the current
                        version for an older row, the previous one for the
                        current row.
                      */}
                      {versions.length > 1 ? (
                        <Button asChild variant="ghost" size="sm">
                          <Link
                            to="/dashboard/documents/$id/diff"
                            params={{ id: document.id }}
                            search={
                              index === 0
                                ? {
                                    from: versions[1].versionNumber,
                                    to: version.versionNumber,
                                  }
                                : {
                                    from: version.versionNumber,
                                    to: versions[0].versionNumber,
                                  }
                            }
                            title={
                              index === 0
                                ? 'Compare with the previous version'
                                : 'Compare with the current version'
                            }
                            aria-label={
                              index === 0
                                ? `Compare v${version.versionNumber} with the previous version`
                                : `Compare v${version.versionNumber} with the current version`
                            }
                          >
                            <GitCompare aria-hidden />
                            Compare
                          </Link>
                        </Button>
                      ) : null}
                      <Button asChild variant="ghost" size="sm">
                        <a href={version.url} target="_blank" rel="noreferrer">
                          Open
                          <ExternalLink aria-hidden />
                        </a>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                        <a
                          href={version.rawUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
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
      </div>
    </AppShell>
  )
}

function LinkRow({
  label,
  value,
  href,
  hint,
}: {
  label: string
  value: string
  href?: string
  hint?: string
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <span className="text-micro-lg text-neutral-500">{label}</span>
      </div>
      <CopyField
        value={value}
        label={`Copy the ${label.toLowerCase()} link`}
        {...(href ? { href } : {})}
      />
      {hint ? (
        <p className="mt-1.5 text-xs leading-ui text-neutral-600">{hint}</p>
      ) : null}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 pb-2.5">
      <dt className="text-micro-lg shrink-0 text-neutral-600">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs text-neutral-300">
        {value}
      </dd>
    </div>
  )
}
