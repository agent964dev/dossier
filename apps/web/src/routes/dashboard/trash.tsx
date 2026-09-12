import { useState } from 'react'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { ArrowLeft, RotateCcw } from 'lucide-react'

import { AppShell } from '../../components/app-shell'
import { EmptyState } from '../../components/empty-state'
import { absoluteDateTime, relativeTime } from '../../components/format'
import { PageHeader } from '../../components/page-header'
import { StatusMessage } from '../../components/status-message'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { KindTag } from '../../components/document-list'
import { documentAction, loadTrash, type TrashBatch } from '../../server/documents'
import type { Viewer } from '../../server/viewer'
import { isSurfaceFailure, requireData, RouteError } from '../-lib/guard'

export const Route = createFileRoute('/dashboard/trash')({
  loader: async () => requireData(await loadTrash(), '/dashboard/trash'),
  head: () => ({ meta: [{ title: 'Trash — dossier' }] }),
  component: TrashPage,
  errorComponent: RouteError,
})

function TrashPage() {
  const { viewer, batches } = Route.useLoaderData()

  return (
    <AppShell viewer={viewer} subtitle="Trash">
      <PageHeader
        kicker="Archived"
        title="Trash"
        description="Deleting archives a document and everything under it as one batch. The bytes are kept, the links stop resolving, and restoring brings the whole batch back."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/dashboard">
              <ArrowLeft aria-hidden />
              Documents
            </Link>
          </Button>
        }
      />

      {batches.length === 0 ? (
        <EmptyState
          title="Nothing archived"
          body="Documents you delete land here until you restore them. Nothing is ever purged in this version."
        />
      ) : (
        <ul className="grid gap-3">
          {batches.map((batch) => (
            <TrashBatchCard
              key={batch.batchId ?? batch.documents[0].id}
              batch={batch}
              viewer={viewer}
            />
          ))}
        </ul>
      )}
    </AppShell>
  )
}

function TrashBatchCard({ batch, viewer }: { batch: TrashBatch; viewer: Viewer }) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const root = batch.documents[0]

  async function restore() {
    setPending(true)
    setError(null)
    const result = await documentAction({
      data: {
        id: root.id,
        action: 'restore',
        batchId: batch.batchId ?? '',
        csrfToken: viewer.csrfToken,
      },
    })
    setPending(false)
    if (isSurfaceFailure(result)) {
      setError(result.message)
      return
    }
    await router.invalidate()
  }

  return (
    <li className="min-w-0 rounded-xl border border-border bg-card px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <KindTag kind={root.kind} />
            <Badge variant="muted">
              {batch.deletedCount === 1 ? '1 document' : `${batch.deletedCount} documents`}
            </Badge>
          </div>
          <p className="mt-2.5 truncate text-[0.9375rem] font-medium text-neutral-100">
            {batch.rootTitle}
          </p>
          <p className="mt-1.5 text-sm leading-ui text-neutral-500">
            Archived{batch.deletedBy ? ` by ${batch.deletedBy}` : ''}
            {batch.deletedAt ? (
              <>
                {', '}
                <span title={absoluteDateTime(batch.deletedAt)}>
                  {relativeTime(batch.deletedAt, viewer.now)}
                </span>
              </>
            ) : null}
            {batch.deletedCount > 1
              ? '. Restoring brings the whole batch back.'
              : '.'}
          </p>
          {batch.batchId ? (
            <p className="mt-2 flex items-center gap-1.5">
              <span className="text-micro-lg text-neutral-600">Batch</span>
              <span className="font-mono text-xs text-neutral-600">
                {batch.batchId}
              </span>
            </p>
          ) : null}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={restore}
          disabled={pending || batch.batchId === null}
          className="shrink-0"
        >
          <RotateCcw aria-hidden />
          {pending ? 'Restoring…' : 'Restore'}
        </Button>
      </div>

      {batch.documents.length > 1 ? (
        <ul className="mt-4 grid gap-1.5 border-t border-border/70 pt-3.5">
          {batch.documents.slice(1).map((document) => (
            <li
              key={document.id}
              className="flex items-center justify-between gap-3 text-sm text-neutral-400"
            >
              <span className="truncate">{document.title}</span>
              <span className="text-micro-lg shrink-0 text-neutral-600">
                {document.authorName}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <StatusMessage tone="error" className="mt-4">
          {error}
        </StatusMessage>
      ) : null}
    </li>
  )
}
