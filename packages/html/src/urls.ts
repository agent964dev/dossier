// How a URL written in a page reads: relative or not, and whether it leads
// into a `_` file or folder.

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const ASCII_SPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g

/** Browsers strip ASCII whitespace around a URL before reading it. */
export const trimUrl = (value: string): string => value.replace(ASCII_SPACE, '')

/** `%5F` reads as `_`; a malformed escape stays as written. */
export const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * No scheme (`https:`, `mailto:`, `data:`), not `//host`, not rooted at `/`,
 * not a `#fragment`, not empty. A backslash counts as a slash, as browsers
 * read it.
 */
export const isRelativeUrl = (value: string): boolean => {
  const url = trimUrl(value)
  return (
    url !== '' &&
    !SCHEME.test(url) &&
    !url.startsWith('/') &&
    !url.startsWith('\\') &&
    !url.startsWith('#')
  )
}

/**
 * The first segment of a relative URL's path that names a folder or file,
 * skipping `.` and `..`, starts with `_`: `_theme.css`, `./_kit/a.js`,
 * `../_logo.svg`, but not `team/_theme.css`.
 */
export const isUnderscoreUrl = (value: string): boolean => {
  if (!isRelativeUrl(value)) return false
  const path = trimUrl(value).split(/[?#]/, 1)[0] ?? ''
  for (const raw of path.split(/[\\/]/)) {
    const segment = decodeSegment(raw)
    if (segment === '' || segment === '.' || segment === '..') continue
    return segment.startsWith('_')
  }
  return false
}

const isSpace = (char: string): boolean =>
  char === ' ' ||
  char === '\t' ||
  char === '\n' ||
  char === '\r' ||
  char === '\f'

/**
 * The URL of each candidate in a `srcset` value, with its offsets inside the
 * value, following the HTML standard's candidate splitting: a URL is a run
 * without whitespace, commas at its end separate it from the next candidate,
 * and descriptors run to the next comma outside parentheses.
 */
export const srcsetUrls = (
  value: string,
): readonly { readonly start: number; readonly end: number }[] => {
  const found: { start: number; end: number }[] = []
  let at = 0
  while (at < value.length) {
    while (at < value.length && (isSpace(value[at]) || value[at] === ',')) {
      at++
    }
    if (at >= value.length) break
    const start = at
    while (at < value.length && !isSpace(value[at])) at++
    let end = at
    if (value[end - 1] === ',') {
      while (end > start && value[end - 1] === ',') end--
      if (end > start) found.push({ start, end })
      continue
    }
    found.push({ start, end })
    let inParens = false
    while (at < value.length) {
      const char = value[at]
      at++
      if (char === '(') inParens = true
      else if (char === ')') inParens = false
      else if (char === ',' && !inParens) break
    }
  }
  return found
}
