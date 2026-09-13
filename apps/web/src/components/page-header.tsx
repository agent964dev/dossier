import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Every page opens the same way: a mono kicker naming the surface, a Clash
 * Display title, one line of orientation, and an optional action on the right.
 * Repeating the shape is what makes the pages feel like one product.
 */
export function PageHeader({
  kicker,
  title,
  description,
  actions,
  className,
}: {
  kicker: string
  title: string
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-4 pt-6 pb-7 sm:flex-row sm:items-end sm:justify-between sm:gap-6',
        className,
      )}
    >
      <div className="min-w-0">
        <p className="text-micro-lg text-brand-300/90">{kicker}</p>
        <h1 className="font-clash mt-2.5 text-[1.75rem] leading-[1.08] font-semibold tracking-[-0.032em] text-balance text-neutral-50 sm:text-[2.125rem]">
          {title}
        </h1>
        {description ? (
          <p className="mt-2.5 max-w-2xl text-sm leading-body text-neutral-400">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  )
}

/** A section rule with a mono label — the quiet divider between page blocks. */
export function SectionLabel({
  children,
  aside,
  className,
}: {
  children: ReactNode
  aside?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-t border-border pt-5 pb-4',
        className,
      )}
    >
      <h2 className="text-micro-lg text-neutral-400">{children}</h2>
      {aside ? <div className="flex items-center gap-2">{aside}</div> : null}
    </div>
  )
}
