import { Trash2 } from 'lucide-react'
import { useState } from 'react'

import { isScreenFailure } from '../server/failure'
import { deleteNode } from '../server/listing'
import { Button } from './ui/button'
import { Modal } from './ui/modal'

/** A row the listing's Delete asks about. */
export interface Deleting {
  /** As the listing names it: 'plan.html', 'questions/'. */
  readonly name: string
  /** '<workspace>/<tree>/<path>'. */
  readonly target: string
}

/**
 * The listing's Delete, confirmed: "Delete plan.html? It stays restorable
 * from history for 30 days." A deletion is a change in history.
 */
export function DeleteDialog({
  deleting,
  retentionDays,
  onClose,
  onDeleted,
}: {
  deleting: Deleting | null
  retentionDays: number
  onClose: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  // Each row's question starts afresh.
  const [askedAbout, setAskedAbout] = useState(deleting)
  if (askedAbout !== deleting) {
    setAskedAbout(deleting)
    setBusy(false)
    setRefused(null)
  }
  const send = async () => {
    if (deleting === null) return
    setBusy(true)
    setRefused(null)
    try {
      const result = await deleteNode({ data: { target: deleting.target } })
      if (isScreenFailure(result)) {
        setBusy(false)
        setRefused(result.error.message)
        return
      }
      onDeleted()
    } catch {
      setBusy(false)
      setRefused('Something went wrong. Try again.')
    }
  }
  return (
    <Modal
      open={deleting !== null}
      onClose={onClose}
      title={deleting === null ? 'Delete' : `Delete ${deleting.name}?`}
      description={
        deleting === null
          ? undefined
          : `It stays restorable from history for ${retentionDays === 1 ? '1 day' : `${retentionDays} days`}.`
      }
      handle
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive-solid"
            type="button"
            disabled={busy}
            onClick={() => void send()}
          >
            <Trash2 aria-hidden />
            Delete
          </Button>
        </>
      }
    >
      {refused === null ? null : (
        <p role="alert" className="text-sm text-error-300">
          {refused}
        </p>
      )}
    </Modal>
  )
}
