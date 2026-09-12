import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * A native `<dialog>`, opened from an effect.
 *
 * The platform already implements the hard parts — focus containment, Escape,
 * inert background, backdrop — so this is a styled shell rather than a
 * hand-rolled overlay. The trigger lives with the caller; the dialog is
 * rendered closed on the server, so nothing about it depends on hydration
 * order.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        // A click that lands on the dialog element itself is a click on the
        // backdrop: the content sits in the child below.
        if (event.target === ref.current) onClose()
      }}
      className={cn(
        'dossier-modal mt-auto mr-0 mb-0 ml-0 w-full max-h-[min(85dvh,44rem)] overflow-visible',
        'rounded-t-2xl rounded-b-none border border-border bg-card p-0 text-neutral-100',
        'sm:m-auto sm:w-[min(34rem,calc(100vw-1.5rem))] sm:rounded-xl',
        'backdrop:bg-neutral-950/75 backdrop:backdrop-blur-[2px]',
        className,
      )}
    >
      <div className="flex max-h-[min(85dvh,44rem)] flex-col pb-[var(--safe-area-bottom)] sm:pb-0">
        <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2
              id={titleId}
              className="font-clash text-[1.0625rem] font-semibold tracking-[-0.02em] text-neutral-50"
            >
              {title}
            </h2>
            {description ? (
              <p className="mt-1.5 text-sm leading-body text-neutral-400">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cn(
              'inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-500',
              'transition-colors duration-200 ease-agent',
              'hover:bg-neutral-800/70 hover:text-neutral-100',
              'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
            )}
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {children}
        </div>

        {footer ? (
          <div className="flex flex-col gap-2 border-t border-border/70 px-4 py-3.5 sm:flex-row sm:justify-end sm:px-5">
            {footer}
          </div>
        ) : null}
      </div>
    </dialog>
  )
}
