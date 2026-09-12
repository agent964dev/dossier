import { cn } from '@/lib/utils'

/**
 * The dossier mark: a filed document with a turned corner, drawn in
 * currentColor so it inherits the cyan lockup color. Bare SVG, no chip
 * wrapper (DESIGN.md section 4 — "Brand lockup inside SurfaceHeader").
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('size-6', className)}
    >
      <path d="M8 2.75h6l5 5V18a2.5 2.5 0 0 1-2.5 2.5H8A2.5 2.5 0 0 1 5.5 18V5.25A2.5 2.5 0 0 1 8 2.75Z" />
      <path d="M13.75 3v3.75a1.5 1.5 0 0 0 1.5 1.5h3.5" />
      <path d="M9.25 13h6" opacity="0.55" />
      <path d="M9.25 16.25h3.5" opacity="0.55" />
    </svg>
  )
}
