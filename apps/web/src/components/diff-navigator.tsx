import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

import { Button } from './ui/button'

/**
 * Hunk navigation: `n` and `p` on a keyboard, two buttons everywhere else.
 * The hunk headers are the anchors — each is focusable, so moving to one also
 * moves the caret and announces the change to a screen reader. This is the
 * only stateful piece of the page; everything else is server-rendered.
 */
export function DiffNavigator({ count }: { count: number }) {
  const [position, setPosition] = useState(0)

  const jump = useCallback(
    (delta: 1 | -1) => {
      if (count === 0) return
      setPosition((current) => {
        const next =
          current === 0
            ? delta === 1
              ? 1
              : count
            : Math.min(count, Math.max(1, current + delta))
        const target = [
          ...document.querySelectorAll<HTMLElement>(
            `[data-diff-hunk="${next}"]`,
          ),
        ].find((candidate) => candidate.getClientRects().length > 0)
        if (target) {
          target.focus({ preventScroll: true })
          target.scrollIntoView({
            block: 'start',
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)')
              .matches
              ? 'auto'
              : 'smooth',
          })
        }
        return next
      })
    },
    [count],
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target !== null &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA')
      ) {
        return
      }
      const key = event.key.toLowerCase()
      if (key !== 'n' && key !== 'p') return
      event.preventDefault()
      jump(key === 'n' ? 1 : -1)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [jump])

  return (
    <div className="flex items-center gap-1.5">
      <span data-numeric className="text-micro-lg text-neutral-500">
        {position === 0
          ? `${count} ${count === 1 ? 'change' : 'changes'}`
          : `${position} / ${count}`}
      </span>
      <span className="flex items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => jump(-1)}
          title="Previous change (p)"
          aria-label="Previous change"
          className="size-9 sm:size-8"
        >
          <ChevronUp aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => jump(1)}
          title="Next change (n)"
          aria-label="Next change"
          className="size-9 sm:size-8"
        >
          <ChevronDown aria-hidden />
        </Button>
      </span>
      <span className="text-micro-lg hidden items-center gap-1 text-neutral-500 md:flex">
        <Kbd>n</Kbd>
        <Kbd>p</Kbd>
      </span>
    </div>
  )
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-border bg-neutral-900/80 px-1.5 py-px font-mono text-[0.625rem] text-neutral-400 lowercase">
      {children}
    </kbd>
  )
}
