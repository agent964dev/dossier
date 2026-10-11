import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef } from 'react'

/** "agent964 ▾": the person's workspaces; choosing one sets `?w=`. */
export function WorkspaceMenu({
  current,
  workspaces,
}: {
  current: string
  workspaces: readonly { readonly name: string }[]
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
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [])

  return (
    <details ref={ref} className="group relative min-w-0">
      <summary
        aria-label={`Workspace ${current}. Switch workspace`}
        className="flex min-w-0 cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 font-mono text-sm text-neutral-100 outline-none transition-colors duration-200 ease-agent hover:bg-neutral-800/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
      >
        <span className="truncate">{current}</span>
        <ChevronDown
          aria-hidden
          className="size-3.5 shrink-0 text-neutral-400 transition-transform duration-200 ease-agent group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <ul className="absolute top-full left-0 z-20 mt-2 flex max-h-[60dvh] w-64 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-xl">
        {workspaces.map((workspace) => {
          const selected = workspace.name === current
          return (
            <li key={workspace.name}>
              <a
                href={`/?w=${encodeURIComponent(workspace.name)}`}
                aria-current={selected ? 'page' : undefined}
                className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 font-mono text-sm text-neutral-200 outline-none hover:bg-neutral-800/70 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="truncate">{workspace.name}</span>
                {selected ? (
                  <Check aria-hidden className="size-4 text-brand-300" />
                ) : null}
              </a>
            </li>
          )
        })}
      </ul>
    </details>
  )
}
