// The URLs a stylesheet loads, for exporting a page as one file: each
// `@import` and `url()` with the range it is written at, so the export can
// put the file it names in its place.
import { cssRefs as found } from './inline-refs.ts'

import type { Range } from './analyze.ts'

export interface CssRef {
  /** As the browser requests it: CSS escapes decoded. */
  readonly url: string
  /** The URL as written, inside any quotes or `url(`. */
  readonly range: Range
  /** An `@import`'s string or `url()`, or any other `url()` (or image-set string). */
  readonly kind: 'import' | 'url'
}

/**
 * Every `@import` and `url()` in a stylesheet, in every quoting form, and the
 * strings of an `image-set()`. Nothing inside a comment counts.
 */
export const cssRefs = (css: string): readonly CssRef[] =>
  found(css).map((ref) => ({
    url: ref.url,
    range: { start: ref.start, end: ref.end },
    kind: ref.kind === 'css-import' ? 'import' : 'url',
  }))
