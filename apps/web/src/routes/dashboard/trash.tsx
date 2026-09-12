import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, RotateCcw, Users } from 'lucide-react'

import { AppShell } from '../../components/app-shell'
import { EmptyState } from '../../components/empty-state'
import { absoluteDateTime, relativeTime } from '../../components/format'
import { PageHeader, SectionLabel } from '../../components/page-header'
import { StatusMessage } from '../../components/status-message'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { KindTag } from '../../components/document-list'
import { useDocumentAction } from '../../components/use-document-action'
import { loadTrash, type TrashBatch } from '../../server/documents'
import type { Viewer } from '../../server/viewer'
import { requireData, RouteError } from '../-lib/guard'

export const Route = createFileRoute('/dashboard/trash')({
  loader: async () => requireData(await loadTrash(), '/dashboard/trash'),
  head: () => ({ meta: [{ title: 'Trash — dossier' }] }),
  component: TrashPage,
  errorComponent: RouteError,
})

function TrashPage() {
  const { viewer, batches, swept } = Route.useLoaderData()

  return (
    <AppShell viewer={viewer} subtitle="Trash">
      <PageHeader
        kicker="Archived"
        title="Trash"
        description="Archiving takes a document and everything filed under it as one batch, whoever wrote those documents. The bytes stay, the links stop resolving, and restoring brings the whole batch back at once."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/dashboard">
              <ArrowLeft aria-hidden />
              Documents
            </Link>
          </Button>
        }
      />

      {batches.length === 0 && swept.length === 0 ? (
        <EmptyState
          title="Nothing archived"
          body="Documents you archive land here until you restore them. Nothing is ever purged in this version."
        />
      ) : null}

      {batches.length > 0 ? (
        <ul className="grid gap-3">
          {batches.map((batch) => (
            <TrashBatchCard
              key={batch.batchId ?? batch.rootDocumentId}
              batch={batch}
              viewer={viewer}
            />
          ))}
        </ul>
      ) : null}

      {/* The other half of a multi-author batch: your document is here, but the
          batch is not yours to bring back. PLAN section 5.6. */}
      {swept.length > 0 ? (
        <section className="mt-10">
          <SectionLabel
            aside={
              <span data-numeric className="text-micro-lg text-neutral-500">
                {swept.length}
              </span>
            }
          >
            Swept into someone else’s batch
          </SectionLabel>
          <p className="pb-4 text-sm leading-body text-neutral-500">
            These are yours, archived as part of a larger document. Whoever
            archived that document — or a workspace admin — restores the batch;
            after that you can move your document out.
          </p>
          <ul className="grid gap-2">
            {swept.map((document) => (
              <li
                key={document.id}
                className="min-w-0 rounded-xl border border-border bg-card px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <KindTag kind={document.kind} />
                  <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-medium text-neutral-100">
                    {document.title}
                  </span>
                </div>
                <p className="mt-1.5 text-sm leading-ui text-neutral-500">
                  archived by{' '}
                  {document.deletedByAccountId === viewer.accountId
                    ? 'you'
                    : (document.deletedBy ?? 'someone')}{' '}
                  as part of “
                  {document.rootTitle}”
                  {document.deletedAt ? (
                    <>
                      {', '}
                      <span title={absoluteDateTime(document.deletedAt)}>
                        {relativeTime(document.deletedAt, viewer.now)}
                      </span>
                    </>
                  ) : null}
                  .
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppShell>
  )
}

function TrashBatchCard({ batch, viewer }: { batch: TrashBatch; viewer: Viewer }) {
  const { pending, failure, run } = useDocumentAction(viewer.csrfToken)
  const others = batch.deletedCount - 1

  async function restore() {
    await run('restore', {
      id: batch.rootDocumentId,
      action: 'restore',
      batchId: batch.batchId ?? '',
    })
  }

  return (
    <li
      className="min-w-0 rounded-xl border border-border bg-card px-4 py-4 sm:px-5"
      title={batch.batchId ? `Archive batch ${batch.batchId}` : undefined}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <KindTag kind={batch.rootKind} />
            <Badge variant="muted">
              {batch.deletedCount === 1
                ? '1 document'
                : `${batch.deletedCount} documents`}
            </Badge>
          </div>
          <p className="mt-2.5 truncate text-[0.9375rem] font-medium text-neutral-100">
            {batch.rootTitle}
          </p>
          <p className="mt-1.5 text-sm leading-ui text-neutral-500">
            Archived
            {batch.deletedByAccountId === viewer.accountId
              ? ' by you'
              : batch.deletedBy
                ? ` by ${batch.deletedBy}`
                : ''}
            {batch.deletedAt ? (
              <>
                {', '}
                <span title={absoluteDateTime(batch.deletedAt)}>
                  {relativeTime(batch.deletedAt, viewer.now)}
                </span>
              </>
            ) : null}
            {others > 0
              ? `. Restoring brings back ${
                  others === 1 ? 'the document' : `all ${others} documents`
                } filed under it too.`
              : '.'}
          </p>

          {batch.authors.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-micro-lg flex items-center gap-1.5 text-neutral-600">
                <Users aria-hidden className="size-3" />
                Authors
              </span>
              {batch.authors.map((author) => (
                <Badge
                  key={author.accountId}
                  variant={
                    author.accountId === viewer.accountId ? 'muted' : 'warn'
                  }
                >
                  {author.accountId === viewer.accountId ? 'You' : author.name}
                  <span data-numeric className="text-neutral-500">
                    {author.count}
                  </span>
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={restore}
          disabled={pending !== null || batch.batchId === null || !viewer.publisher}
          className="shrink-0"
        >
          <RotateCcw aria-hidden />
          {pending === 'restore' ? 'Restoring…' : 'Restore'}
        </Button>
      </div>

      {failure ? (
        <StatusMessage tone="error" className="mt-4">
          {failure.code === 'conflict'
            ? 'The parent this batch hung from is archived too. Restore that batch first.'
            : failure.message}{' '}
          <span className="text-micro-lg text-neutral-500">{failure.code}</span>
        </StatusMessage>
      ) : null}
    </li>
  )
}
