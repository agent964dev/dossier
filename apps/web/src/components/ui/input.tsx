import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * agent964 Input (DESIGN.md section 4 — "Inputs & forms"). Recessed
 * `neutral-800/80` surface, low-alpha border at rest, cyan ring on focus.
 * `text-base` on mobile is mandatory to stop iOS zooming the page on focus.
 */
function Input({
  className,
  type = 'text',
  ...props
}: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-10 w-full min-w-0 rounded-lg border border-border bg-input px-3 py-2',
        'text-base text-neutral-100 md:text-sm',
        'placeholder:text-muted-foreground',
        'transition-[color,border-color,box-shadow] duration-200 ease-agent',
        'outline-none focus-visible:border-brand-300/50 focus-visible:ring-[3px] focus-visible:ring-ring/40',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

function Select({
  className,
  wrapperClassName,
  children,
  ...props
}: React.ComponentProps<'select'> & { wrapperClassName?: string }) {
  return (
    <span
      data-slot="select-wrapper"
      className={cn('relative block w-full min-w-0', wrapperClassName)}
    >
      <select
        data-slot="select"
        className={cn(
          'h-10 w-full min-w-0 appearance-none rounded-lg border border-border bg-input py-2 pr-8 pl-3',
          'text-base text-neutral-100 md:text-sm',
          'transition-[color,border-color,box-shadow] duration-200 ease-agent',
          'outline-none focus-visible:border-brand-300/50 focus-visible:ring-[3px] focus-visible:ring-ring/40',
          'disabled:pointer-events-none disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      {/* The native arrow is unstyleable, so it is suppressed and redrawn. */}
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-neutral-500"
      />
    </span>
  )
}

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn('text-sm font-medium text-neutral-300', className)}
      {...props}
    />
  )
}

export { Input, Label, Select }
