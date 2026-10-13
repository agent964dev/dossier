import { Info } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { isScreenFailure } from '../server/failure'
import { Button } from './ui/button'
import { Modal } from './ui/modal'

/** The rounded card the settings screens group their rows in. */
export function RowList({
  children,
  heads,
  label,
}: {
  children: ReactNode
  /** Column heads, shown on wider screens. */
  heads?: ReactNode
  label?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card">
      {heads}
      <ul aria-label={label} className="divide-y divide-border/80">
        {children}
      </ul>
    </div>
  )
}

export const ROW = 'flex min-h-14 items-center gap-3 px-3.5 py-2.5'

/** A person's initial in a round tile, as the member rows show them. */
export function Initial({ of, className }: { of: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full bg-neutral-700 text-xs font-semibold text-neutral-100 uppercase',
        className,
      )}
    >
      {of.charAt(0)}
    </span>
  )
}

/** A quiet line of explanation under a control. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 text-sm text-neutral-400">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-neutral-500" />
      <span>{children}</span>
    </p>
  )
}

/** The message of a refused action, or null when it went through. */
export const refusalOf = (result: unknown): string | null =>
  isScreenFailure(result) ? result.error.message : null

/** What a refused action said, read out when it appears. */
export function Refusal({ message }: { message: string | null }) {
  return message === null ? null : (
    <p role="alert" className="text-sm text-error-300">
      {message}
    </p>
  )
}

/**
 * Asks again before a consequential action; a refusal stays in the dialog
 * so the person reads why.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  action,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean
  title: string
  description?: ReactNode
  /** The confirming button's label, such as "Delete". */
  action: string
  /** Resolves to the refusal's message, or null when it went through. */
  onConfirm: () => Promise<string | null>
  onClose: () => void
  children?: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const close = () => {
    setRefused(null)
    onClose()
  }
  const confirm = async () => {
    setBusy(true)
    setRefused(null)
    const message = await onConfirm()
    setBusy(false)
    if (message === null) close()
    else setRefused(message)
  }
  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            type="button"
            disabled={busy}
            onClick={confirm}
          >
            {action}
          </Button>
        </>
      }
    >
      {children === undefined && refused === null ? null : (
        <>
          {children}
          <Refusal message={refused} />
        </>
      )}
    </Modal>
  )
}
