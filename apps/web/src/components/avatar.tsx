import { initials } from './format'
import { cn } from '@/lib/utils'

/**
 * A picture when shoo gave us one, initials otherwise. Never a broken image:
 * the fallback letters sit underneath, so a dead URL degrades silently.
 */
export function Avatar({
  name,
  src,
  className,
}: {
  name: string
  src?: string | null
  className?: string
}) {
  return (
    <span
      className={cn(
        'relative inline-flex size-7 shrink-0 items-center justify-center overflow-hidden',
        'rounded-full border border-border bg-neutral-800 text-[0.625rem] font-semibold',
        'text-neutral-300 select-none',
        className,
      )}
      aria-hidden
    >
      {initials(name)}
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="absolute inset-0 size-full object-cover"
        />
      ) : null}
    </span>
  )
}
