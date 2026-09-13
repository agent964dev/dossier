import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * agent964 Card (DESIGN.md section 4 — "Cards & containers").
 *
 * One elevation above the page: `card` (neutral-900) fill, 1px low-alpha
 * border, softly rounded corners, comfortable padding. Elevation is implied by
 * the 1-step-lighter surface and the border — never by a drop shadow.
 */
function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn(
        'flex flex-col gap-5 rounded-xl border border-border bg-card py-5 text-card-foreground',
        className,
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'grid auto-rows-min grid-cols-[1fr_auto] items-start gap-x-3 gap-y-1.5 px-5',
        className,
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        'col-start-1 text-[0.95rem] leading-ui font-semibold text-neutral-50',
        className,
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-description"
      className={cn(
        'col-start-1 text-sm leading-body text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

/** Top-right slot of the header — a badge, a menu trigger, a quiet action. */
function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start', className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-content"
      className={cn('px-5', className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center px-5', className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
}
