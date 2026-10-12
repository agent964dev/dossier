import { Check, ChevronDown, Ellipsis } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

const ITEM =
  'flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-neutral-200 outline-none transition-colors duration-200 ease-agent hover:bg-neutral-800/70 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset'

/** A link in a row menu; `document` loads it as a whole page. */
export function MenuLink({
  href,
  children,
  download,
}: {
  href: string
  children: ReactNode
  download?: boolean
}) {
  return (
    <li>
      <a
        href={href}
        download={download === true ? '' : undefined}
        className={ITEM}
      >
        {children}
      </a>
    </li>
  )
}

export function MenuButton({
  onSelect,
  children,
  chosen,
  destructive = false,
}: {
  onSelect: () => void
  children: ReactNode
  /** For a choice among several, such as a role: whether it is the current one. */
  chosen?: boolean
  destructive?: boolean
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={chosen}
        className={cn(
          ITEM,
          'justify-between gap-2',
          destructive && 'text-error-300 hover:text-error-200',
        )}
      >
        {children}
        {chosen === true ? (
          <Check aria-hidden className="size-4 shrink-0 text-brand-300" />
        ) : null}
      </button>
    </li>
  )
}

/**
 * The ⋯ menu at the end of a listing row; with `trigger`, a menu that names
 * its current choice, such as "Member ▾".
 */
export function RowMenu({
  label,
  children,
  trigger,
}: {
  label: string
  children: ReactNode
  trigger?: ReactNode
}) {
  const ref = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    const menu = ref.current
    if (!menu) return
    const outside = (event: PointerEvent) => {
      if (menu.open && !menu.contains(event.target as Node)) menu.open = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu.open) {
        menu.open = false
        menu.querySelector('summary')?.focus()
      }
    }
    // A choice closes the menu.
    const chosen = (event: MouseEvent) => {
      if ((event.target as Element).closest('li') !== null) menu.open = false
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    menu.addEventListener('click', chosen)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      menu.removeEventListener('click', chosen)
    }
  }, [])

  return (
    <details ref={ref} className="relative shrink-0">
      {trigger === undefined ? (
        <summary
          aria-label={label}
          className="flex size-8 cursor-pointer list-none items-center justify-center rounded-lg text-neutral-400 outline-none transition-colors duration-200 ease-agent hover:bg-neutral-800/70 hover:text-neutral-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
        >
          <Ellipsis aria-hidden className="size-4" />
        </summary>
      ) : (
        <summary
          aria-label={label}
          className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-border bg-input py-1 pr-2 pl-3 text-sm text-neutral-100 outline-none transition-colors duration-200 ease-agent hover:border-brand-300/45 focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
        >
          {trigger}
          <ChevronDown aria-hidden className="size-3.5 text-neutral-500" />
        </summary>
      )}
      <ul className="absolute top-full right-0 z-20 mt-1 flex w-44 flex-col rounded-xl border border-border bg-card p-1 shadow-xl">
        {children}
      </ul>
    </details>
  )
}
