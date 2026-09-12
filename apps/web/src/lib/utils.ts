import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge otherwise reads `text-micro-lg` as a text *color* (it is not a
 * font size it knows about) and drops it the moment a real color class follows
 * it in the same `cn()` call — which silently killed the mono/uppercase/tracking
 * bundle on every badge and status pill. Registering the micro tier as font
 * sizes keeps `cn('text-micro-lg', 'text-neutral-300')` intact.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'micro-md', 'micro-lg'] }],
    },
  },
})

/**
 * shadcn's `cn` helper. It normally lives at `@/lib/utils`; this app has no
 * `@/*` path alias yet (that needs a `resolve.alias` entry in vite.config.ts),
 * so components import it relatively from here.
 */
export function cn(...inputs: Array<ClassValue>) {
  return twMerge(clsx(inputs))
}
