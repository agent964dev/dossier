import { cn } from '@/lib/utils'

/**
 * One cyan glow as the emotional centre, one warm counter-glow, and a cyan
 * hairline along the top edge (DESIGN.md sections 1 and 4). Background only:
 * nothing stacks on it, so no glass tiers are mixed.
 */
export function Atmosphere({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 -z-10 overflow-hidden',
        className,
      )}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-300/45 to-transparent" />
      <div className="absolute -top-[30rem] left-1/2 h-[34rem] w-[46rem] -translate-x-1/2 rounded-full bg-brand-500/20 blur-[130px] sm:w-[64rem]" />
      <div className="absolute right-[-14rem] bottom-[-20rem] h-[26rem] w-[26rem] rounded-full bg-complement-400/[0.05] blur-[130px]" />
    </div>
  )
}
