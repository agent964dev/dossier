import { useState } from 'react'
import type { AuthorSummary, DocumentEditor } from '@dossier/contracts'
import { Trash2, Users } from 'lucide-react'

import { StatusMessage } from './status-message'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Modal } from './ui/modal'
import { useDocumentAction } from './use-document-action'

/**
 * Archiving is a subtree operation. The route loader supplies the current
 * descendant and author summary, so a known parent opens directly on the one
 * meaningful confirmation instead of leaking the CLI's force round trip.
 */
export function ArchiveDialog({
  document,
  csrfToken,
  disabled,
  preview,
  onArchived,
}: {
  document: DocumentEditor
  csrfToken: string
  disabled?: boolean
  preview: { count: number; authors: readonly AuthorSummary[] }
  onArchived: (batchId: string, deleted: number) => void
}) {
  const { pending, failure, setFailure, run } = useDocumentAction(csrfToken)
  const [open, setOpen] = useState(false)
  const [cascade, setCascade] = useState<{
    count: number
    authors: readonly AuthorSummary[]
  } | null>(null)

  function start() {
    setCascade(preview.count > 0 ? preview : null)
    setFailure(null)
    setOpen(true)
  }

  async function archive(force: boolean) {
    const result = await run(
      force ? 'force' : 'archive',
      {
        id: document.id,
        action: 'delete',
        ...(force ? { force: true } : {}),
      },
      // The page navigates to the trash on success, so there is nothing here
      // left to refresh.
      { refresh: false },
    )
    if (result === null) return
    if (result.ok === true && result.action === 'has_children') {
      setCascade({ count: result.count, authors: result.authors })
      return
    }
    if (result.ok === true && result.action === 'deleted') {
      setOpen(false)
      onArchived(result.batchId, result.deleted)
    }
  }

  const others = (cascade?.authors ?? []).filter(
    (author) => author.accountId !== document.authorAccountId,
  )

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={start}
        disabled={disabled}
      >
        <Trash2 aria-hidden />
        Archive document
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={cascade ? 'This archives more than one document' : 'Archive document'}
        description={
          cascade ? undefined : (
            <>
              “{document.title}” moves to the trash. Its links stop resolving;
              every version and every byte is kept, and restoring brings the
              whole batch back.
            </>
          )
        }
        footer={
          cascade ? (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={pending !== null}
              >
                Keep them
              </Button>
              <Button
                type="button"
                variant="destructive-solid"
                onClick={() => archive(true)}
                disabled={pending !== null}
              >
                <Trash2 aria-hidden />
                {pending === 'force'
                  ? 'Archiving…'
                  : `Archive all ${cascade.count + 1}`}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={pending !== null}
              >
                Keep it
              </Button>
              <Button
                type="button"
                variant="destructive-solid"
                onClick={() => archive(false)}
                disabled={pending !== null}
              >
                <Trash2 aria-hidden />
                {pending === 'archive' ? 'Archiving…' : 'Archive'}
              </Button>
            </>
          )
        }
      >
        {cascade ? (
          <div className="grid gap-3">
            <p className="text-sm leading-body text-neutral-300">
              <span data-numeric className="font-medium text-error-300">
                {cascade.count}
              </span>{' '}
              {cascade.count === 1 ? 'document' : 'documents'} filed under “
              {document.title}”{' '}
              {cascade.count === 1 ? 'goes' : 'go'} to the trash with it
              {others.length > 0
                ? `, including work by ${others.length} other ${
                    others.length === 1 ? 'person' : 'people'
                  }`
                : ''}
              . Restore brings the batch back as one.
            </p>

            <div>
              <div className="text-micro-lg flex items-center gap-1.5 pb-2 text-neutral-500">
                <Users aria-hidden className="size-3" />
                Authors in this batch
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {cascade.authors.map((author) => (
                  <li key={author.accountId}>
                    <Badge
                      variant={
                        author.accountId === document.authorAccountId
                          ? 'muted'
                          : 'warn'
                      }
                    >
                      {author.name}
                      <span data-numeric className="text-neutral-500">
                        {author.count}
                      </span>
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <p className="text-sm leading-body text-neutral-400">
            Nothing is purged in this version. This document has no live
            descendants in the latest page snapshot.
          </p>
        )}

        {failure ? (
          <StatusMessage tone="error" className="mt-3">
            {failure.message}{' '}
            <span className="text-micro-lg text-neutral-500">
              {failure.code}
            </span>
          </StatusMessage>
        ) : null}
      </Modal>
    </>
  )
}
