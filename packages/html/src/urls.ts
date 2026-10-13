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

/**
 * A URL a layout's rewrite moves: relative, not into a `_` file or folder,
 * not query-only or fragment-only. Everything else reads the same from every
 * folder, or must keep resolving from the page.
 */
export const isRewritable = (value: string): boolean => {
  const url = trimUrl(value)
  return isRelativeUrl(url) && !url.startsWith('?') && !isUnderscoreUrl(url)
}

/** A relative URL's path, and its query and fragment as written. */
const splitUrl = (url: string): { path: string; suffix: string } => {
  const at = url.search(/[?#]/)
  return at < 0
    ? { path: url, suffix: '' }
    : { path: url.slice(0, at), suffix: url.slice(at) }
}

/** One step of a path: its name to compare, and its text to write. */
interface Step {
  readonly name: string
  readonly text: string
}

const stepsOf = (folder: string): Step[] =>
  folder === ''
    ? []
    : folder
        .split('/')
        .map((name) => ({ name, text: encodeURIComponent(name) }))

/**
 * Walks a relative URL's path from a folder. Null when it climbs above the
 * tree root. `folder` says whether it names a folder (a trailing slash, `.`
 * or `..`).
 */
const walk = (
  folder: string,
  path: string,
): { readonly steps: Step[]; readonly folder: boolean } | null => {
  const steps = stepsOf(folder)
  const parts = path.split(/[\\/]/)
  let isFolder = true
  for (const [index, raw] of parts.entries()) {
    const last = index === parts.length - 1
    const name = decodeSegment(raw)
    if (name === '' || name === '.') {
      isFolder = true
      continue
    }
    if (name === '..') {
      if (steps.pop() === undefined) return null
      isFolder = true
      continue
    }
    steps.push({ name, text: raw })
    isFolder = !last
  }
  return { steps, folder: isFolder }
}

/**
 * The tree path a relative URL names from `folder`, with a trailing slash
 * when it names a folder ('' for the root). Null when it leaves the tree.
 */
export const resolveFrom = (folder: string, value: string): string | null => {
  const { path } = splitUrl(trimUrl(value))
  const walked = walk(folder, path)
  if (walked === null) return null
  const joined = walked.steps.map((step) => step.name).join('/')
  return walked.folder && joined !== '' ? `${joined}/` : joined
}

/** From the folder `from` to `steps`, as a relative URL's path. */
const relativeSteps = (
  from: string,
  steps: readonly Step[],
  isFolder: boolean,
): string => {
  const here = stepsOf(from)
  let common = 0
  while (
    common < here.length &&
    common < steps.length &&
    here[common]?.name === steps[common]?.name
  ) {
    common++
  }
  const up = '../'.repeat(here.length - common)
  const down = steps
    .slice(common)
    .map((step) => step.text)
    .join('/')
  if (down === '') return up === '' ? './' : up
  return `${up}${down}${isFolder ? '/' : ''}`
}

/**
 * The relative URL from `folder` to a tree path; a trailing slash names a
 * folder, and '' is the root.
 */
export const relativeFrom = (folder: string, target: string): string => {
  const isFolder = target === '' || target.endsWith('/')
  const bare = isFolder ? target.replace(/\/$/, '') : target
  return relativeSteps(folder, stepsOf(bare), isFolder)
}

const rewriteOne = (value: string, from: string, to: string): string => {
  if (from === to || !isRewritable(value)) return value
  const lead = /^[\t\n\f\r ]*/.exec(value)?.[0] ?? ''
  const trail = /[\t\n\f\r ]*$/.exec(value)?.[0] ?? ''
  const { path, suffix } = splitUrl(trimUrl(value))
  const walked = walk(from, path)
  if (walked === null) return value
  return `${lead}${relativeSteps(to, walked.steps, walked.folder)}${suffix}${trail}`
}

/**
 * A layout's URL as written, read from the layout's folder `from`, written
 * relative to the page's folder `to`. A `srcset` has each candidate rewritten
 * and its descriptor kept; the query and fragment are kept; a URL that is not
 * rewritable or would leave the tree is unchanged.
 */
export const rewriteLayoutUrl = (
  value: string,
  attr: 'href' | 'src' | 'srcset' | 'poster' | 'action',
  from: string,
  to: string,
): string => {
  if (attr !== 'srcset') return rewriteOne(value, from, to)
  let out = ''
  let pos = 0
  for (const candidate of srcsetUrls(value)) {
    out += value.slice(pos, candidate.start)
    out += rewriteOne(value.slice(candidate.start, candidate.end), from, to)
    pos = candidate.end
  }
  return out + value.slice(pos)
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
