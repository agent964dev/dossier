import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

export type StatusTone = 'success' | 'error' | 'info'

const TONE = {
  success: {
    frame: 'border-success-500/25 bg-success-500/8 text-success-300',
    Icon: CheckCircle2,
  },
  error: {
    frame: 'border-destructive/30 bg-destructive/10 text-error-300',
    Icon: AlertTriangle,
  },
  info: {
    frame: 'border-border bg-neutral-800/50 text-neutral-300',
    Icon: Info,
  },
} as const

/**
 * The single inline feedback element. Mutations never navigate away or open a
 * dialog to report an outcome — the answer appears next to the control that
 * caused it, and is announced politely for screen readers.
 */
export function StatusMessage({
  tone,
  children,
  className,
}: {
  tone: StatusTone
  children: React.ReactNode
  className?: string
}) {
  const { frame, Icon } = TONE[tone]
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm leading-ui',
        frame,
        className,
      )}
    >
      <Icon aria-hidden className="mt-[2px] size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}
