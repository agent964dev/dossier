import { CopyButton } from './copy-button'
import { cn } from '@/lib/utils'

/**
 * A value you are meant to take somewhere else: a URL, an id, a command.
 * Monospace, selectable, always paired with a copy control — never a link, so
 * the click target for "copy" and "open" can never be confused.
 */
export function CopyField({
  value,
  label,
  href,
  prefix,
  muted = false,
  className,
}: {
  value: string
  label: string
  href?: string
  prefix?: string
  muted?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-lg border border-border bg-neutral-950/60 p-1 pl-2.5',
        'transition-colors duration-200 ease-agent focus-within:border-brand-300/40',
        className,
      )}
    >
      {prefix ? (
        <span aria-hidden className="font-mono text-xs text-neutral-600 select-none">
          {prefix}
        </span>
      ) : null}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={cn(
            'min-w-0 flex-1 truncate py-1.5 font-mono text-xs underline-offset-4 hover:underline',
            muted ? 'text-neutral-500' : 'text-neutral-200 hover:text-brand-100',
          )}
          title={value}
        >
          {value}
        </a>
      ) : (
        <span
          className={cn(
            'min-w-0 flex-1 truncate py-1.5 font-mono text-xs',
            muted ? 'text-neutral-500' : 'text-neutral-200',
          )}
          title={value}
        >
          {value}
        </span>
      )}
      <CopyButton value={value} label={label} />
    </div>
  )
}
