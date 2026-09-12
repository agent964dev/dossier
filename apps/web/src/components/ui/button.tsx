import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * agent964 Button (DESIGN.md section 4).
 *
 * - soft/solid tone model: each tone ships both flavours; the soft flavour is
 *   the default and you escalate to `-solid` only when that action is THE
 *   primary of the viewport. Primary cyan is always solid.
 * - every non-`link`, non-disabled button lifts 2px on hover, presses 1px on
 *   click. That tactility is the signature and is applied uniformly.
 * - neutral variants additionally get a cyan border-light on hover.
 * - focus-visible is a 3px cyan ring at 50% alpha.
 * - one primary per viewport: never place two solid fills side by side.
 */
const buttonVariants = cva(
  [
    'group/button relative inline-flex shrink-0 items-center justify-center gap-2',
    'rounded-lg border border-transparent font-semibold whitespace-nowrap',
    'transition-[transform,background-color,border-color,color,box-shadow,opacity]',
    'duration-200 ease-agent will-change-transform',
    'hover:-translate-y-[2px] active:translate-y-[1px]',
    'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-brand-200 hover:shadow-[0_8px_24px_-10px_var(--glow-cyan)]',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-neutral-700/55 hover:border-brand-300/35',
        outline:
          'border-border bg-transparent text-neutral-100 hover:bg-neutral-800/55 hover:border-brand-300/45 hover:text-brand-100',
        ghost:
          'bg-transparent text-neutral-300 hover:bg-neutral-800/65 hover:text-brand-100',
        link: 'text-primary underline-offset-4 hover:underline hover:translate-y-0 active:translate-y-0',
        success:
          'border-success-500/25 bg-success-500/12 text-success-300 hover:bg-success-500/20',
        'success-solid':
          'bg-success-500 text-neutral-950 hover:bg-success-400 hover:shadow-[0_8px_24px_-10px_var(--color-success-400)]',
        warn: 'border-warning-400/25 bg-warning-400/12 text-warning-300 hover:bg-warning-400/20',
        'warn-solid':
          'bg-warning-400 text-neutral-950 hover:bg-warning-300 hover:shadow-[0_8px_24px_-10px_var(--color-warning-400)]',
        destructive:
          'border-destructive/30 bg-destructive/12 text-error-300 hover:bg-destructive/20',
        'destructive-solid':
          'bg-destructive text-neutral-50 hover:bg-error-600 focus-visible:ring-destructive/50',
      },
      size: {
        xs: 'h-6 gap-1.5 px-2 text-xs',
        sm: 'h-8 px-3 text-[0.8rem]',
        default: 'h-9 px-3.5 text-sm',
        lg: 'h-10 px-4 text-sm',
        'icon-xs': 'size-6 p-0',
        'icon-sm': 'size-8 p-0',
        icon: 'size-9 p-0',
        'icon-lg': 'size-10 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a <button> (shadcn asChild). */
    asChild?: boolean
  }

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants }
