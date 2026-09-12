import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * agent964 Badge (DESIGN.md section 4 — "Micro-labels").
 *
 * The canonical micro-label pill: Geist Mono, uppercase, 10px, 0.2em tracking
 * — all baked in via `.text-micro-lg`, so callers never hand-roll
 * "uppercase tracking-widest text-[10px] font-mono". Pair with a 4-6px status
 * dot when the label describes a live state.
 *
 * Corners are softly rounded, not pill-shaped: the language is
 * rectangular-with-softened-corners (`rounded-full` is for dots and avatars).
 */
const badgeVariants = cva(
  [
    'text-micro-lg inline-flex w-fit shrink-0 items-center gap-1.5',
    'rounded-md border px-2 py-[3px] font-medium whitespace-nowrap',
    'transition-colors duration-200 ease-agent',
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-2.5",
  ],
  {
    variants: {
      variant: {
        default: 'border-brand-300/30 bg-brand-300/10 text-brand-200',
        solid: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-neutral-300',
        outline: 'border-border bg-transparent text-neutral-400',
        muted: 'border-transparent bg-neutral-800/70 text-muted-foreground',
        success: 'border-success-500/25 bg-success-500/10 text-success-300',
        warn: 'border-warning-400/25 bg-warning-400/10 text-warning-300',
        accent:
          'border-complement-400/30 bg-complement-400/10 text-complement-400',
        destructive: 'border-destructive/30 bg-destructive/12 text-error-300',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export type BadgeProps = React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean
  }

function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot : 'span'

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
