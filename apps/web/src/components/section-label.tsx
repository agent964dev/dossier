import type { ReactNode } from 'react'

/** A mono micro-label with a hairline, as the settings and home group rows. */
export function SectionLabel({
  children,
  count,
  id,
}: {
  children: ReactNode
  count?: number
  id?: string
}) {
  return (
    <div className="flex items-center gap-3">
      <h2
        id={id}
        className="font-mono text-[0.6875rem] tracking-[0.2em] text-neutral-400 uppercase"
      >
        {children}
        {count === undefined ? null : (
          <span className="ml-2 text-neutral-500">{count}</span>
        )}
      </h2>
      <span aria-hidden className="h-px flex-1 bg-border/80" />
    </div>
  )
}
