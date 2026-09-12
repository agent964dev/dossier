import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

type Health =
  | { readonly state: 'checking' }
  | { readonly state: 'online'; readonly version: string }
  | { readonly state: 'offline' }

const TONE: Record<Health['state'], { dot: string; label: string }> = {
  checking: { dot: 'text-neutral-500', label: 'text-neutral-500' },
  online: { dot: 'text-brand-300', label: 'text-neutral-300' },
  offline: { dot: 'text-error-400', label: 'text-error-300' },
}

/**
 * Reads /api/healthz from the browser and reports it as a micro-label with a
 * pulsing status dot — the terminal-chrome idiom from DESIGN.md section 4.
 * Renders `checking` on the server so hydration matches.
 */
export function HealthStatus({ className }: { className?: string }) {
  const [health, setHealth] = useState<Health>({ state: 'checking' })

  useEffect(() => {
    const controller = new AbortController()

    async function check() {
      try {
        const response = await fetch('/api/healthz', {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`status ${response.status}`)
        const body = (await response.json()) as {
          ok?: boolean
          version?: string
        }
        if (body.ok !== true) throw new Error('not ok')
        setHealth({ state: 'online', version: body.version ?? 'unknown' })
      } catch {
        if (controller.signal.aborted) return
        setHealth({ state: 'offline' })
      }
    }

    void check()
    return () => controller.abort()
  }, [])

  const tone = TONE[health.state]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-md border border-border bg-card/70 py-1 pr-2.5 pl-2',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <span className={cn('relative flex size-1.5 items-center', tone.dot)}>
        <span
          className={cn(
            'size-1.5 rounded-full bg-current',
            health.state !== 'offline' && 'status-pulse',
          )}
        />
      </span>
      <span className={cn('text-micro-lg', tone.label)}>
        {health.state === 'checking' && 'Checking api'}
        {health.state === 'offline' && 'Api unreachable'}
        {health.state === 'online' && (
          <>
            Api online
            <span className="text-neutral-600"> / </span>
            <span data-numeric className="text-neutral-400">
              v{health.version}
            </span>
          </>
        )}
      </span>
    </span>
  )
}
