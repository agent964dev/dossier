import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * An empty list is a teaching moment, not a dead end: say what would be here,
 * then show the exact command that puts something here.
 */
export function EmptyState({
  title,
  body,
  command,
  children,
  className,
}: {
  title: string
  body: string
  command?: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-dashed border-border bg-card/40 px-5 py-10 text-center sm:py-14',
        className,
      )}
    >
      <p className="font-clash text-lg font-semibold tracking-[-0.02em] text-neutral-200">
        {title}
      </p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-body text-neutral-500">
        {body}
      </p>
      {command ? (
        <pre className="mx-auto mt-5 w-fit max-w-full overflow-x-auto rounded-lg border border-border bg-neutral-950/70 px-3.5 py-2.5 text-left font-mono text-xs text-neutral-300">
          <code>
            <span aria-hidden className="pr-1.5 text-neutral-600 select-none">
              $
            </span>
            {command}
          </code>
        </pre>
      ) : null}
      {children ? (
        <div className="mt-5 flex justify-center">{children}</div>
      ) : null}
    </div>
  )
}
