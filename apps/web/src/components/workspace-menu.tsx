import { Check, ChevronDown, Settings } from 'lucide-react'
import { useEffect, useRef } from 'react'

/**
 * "agent964 ▾": the person's workspaces; choosing one sets `?w=`. Its admins
 * see "Settings" beside a workspace, and a suspended one says so.
 */
export function WorkspaceMenu({
  current,
  workspaces,
}: {
  current: string
  workspaces: readonly {
    readonly name: string
    readonly isAdmin?: boolean
    readonly suspended?: boolean
  }[]
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
    <details ref={ref} className="group relative min-w-0 max-sm:static">
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
      <ul className="absolute top-full z-20 mt-2 flex max-h-[60dvh] max-sm:inset-x-0 sm:left-0 sm:w-72 flex-col overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-xl">
        {workspaces.map((workspace) => {
          const selected = workspace.name === current
          return (
            <li key={workspace.name} className="flex items-center gap-1">
              <a
                href={`/?w=${encodeURIComponent(workspace.name)}`}
                aria-current={selected ? 'page' : undefined}
                className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-3 py-2 font-mono text-sm text-neutral-200 outline-none hover:bg-neutral-800/70 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span className="min-w-0">
                  <span className="block truncate">{workspace.name}</span>
                  {workspace.suspended === true ? (
                    <span className="block text-xs text-warning-300">
                      Suspended
                    </span>
                  ) : null}
                </span>
                {selected ? (
                  <Check
                    aria-hidden
                    className="size-4 shrink-0 text-brand-300"
                  />
                ) : null}
              </a>
              {workspace.isAdmin === true ? (
                <a
                  href={`/_/w/${encodeURIComponent(workspace.name)}/settings`}
                  aria-label={`Settings of ${workspace.name}`}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs text-neutral-400 outline-none hover:bg-neutral-800/70 hover:text-neutral-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <Settings aria-hidden className="size-3.5" />
                  Settings
                </a>
              ) : null}
            </li>
          )
        })}
      </ul>
    </details>
  )
}
