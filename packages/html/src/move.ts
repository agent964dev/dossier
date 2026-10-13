// A page's relative URLs rewritten for a move of one node in its tree, so
// they name the same files after the move as before.

import type { HtmlAnalysis, UrlRef } from './analyze.ts'
import { decodeCharacterReferences } from './inline-refs.ts'
import { joinPath, parentOf } from './paths.ts'
import { decodeSegment, isRewritable, srcsetUrls, trimUrl } from './urls.ts'

export interface MoveRewrite {
  /** The tree path of the HTML file before the move. */
  readonly filePathBefore: string
  /** After; the same when the file is outside the moved subtree. */
  readonly filePathAfter: string
  /** The moved node's tree path before the move. */
  readonly from: string
  /** And after. */
  readonly to: string
  /** What a tree path names in the tree before the move. */
  readonly kindAt: (path: string) => 'page' | 'file' | 'folder' | 'data' | null
}

/** One step of a link path: its name to compare, and its text to write. */
interface Step {
  readonly name: string
  readonly text: string
}

/** A link path: its steps, and whether it names a folder (a trailing slash). */
interface Link {
  readonly steps: readonly Step[]
  readonly folder: boolean
}

const fresh = (name: string): Step => ({
  name,
  text: encodeURIComponent(name),
})

const namesOf = (path: string): string[] => (path === '' ? [] : path.split('/'))

/**
 * A relative URL's path read from `folder` as the browser reads it. Null when
 * it climbs above the tree's root. A trailing slash, `.` or `..` names a
 * folder.
 */
const walk = (folder: string, path: string): Link | null => {
  const steps = namesOf(folder).map(fresh)
  const parts = path.split(/[\\/]/)
  let isFolder = true
  for (const [index, raw] of parts.entries()) {
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
    isFolder = index < parts.length - 1
  }
  return { steps, folder: isFolder }
}

const sameLink = (a: Link, b: Link): boolean =>
  a.folder === b.folder &&
  a.steps.length === b.steps.length &&
  a.steps.every((step, index) => step.name === b.steps[index]?.name)

/** Where a moved node's path, or a path below it, ends up. */
const mapPath = (path: string, from: string, to: string): string => {
  if (path === from) return to
  if (from !== '' && path.startsWith(`${from}/`)) {
    return `${to}${path.slice(from.length)}`
  }
  return path
}

/**
 * The link path of a page file: `a/index.html` is the folder `a/`, `a/b.html`
 * is `a/b`. A file without `.html` keeps its whole path.
 */
const pageLink = (path: string): { names: string[]; folder: boolean } => {
  if (path === 'index.html') return { names: [], folder: true }
  if (path.endsWith('/index.html')) {
    return { names: namesOf(parentOf(path)), folder: true }
  }
  if (path.endsWith('.html')) {
    return { names: namesOf(path.slice(0, -'.html'.length)), folder: false }
  }
  return { names: namesOf(path), folder: false }
}

/**
 * The node a link path names, as the link route reads it, and whether it is
 * written as the page's link (extensionless, or a folder for an index page)
 * rather than as the node's own path. A folder's link names its index page
 * when that page is the node that moves.
 */
const targetOf = (
  path: string,
  isFolder: boolean,
  move: MoveRewrite,
): { readonly path: string; readonly asPage: boolean } => {
  const indexMoves = (folder: string): boolean =>
    move.from === joinPath(folder, 'index.html') &&
    move.kindAt(move.from) === 'page'
  if (isFolder) {
    return indexMoves(path)
      ? { path: move.from, asPage: true }
      : { path, asPage: false }
  }
  if (move.kindAt(`${path}.html`) === 'page') {
    return { path: `${path}.html`, asPage: true }
  }
  if (move.kindAt(path) === 'folder' && indexMoves(path)) {
    return { path: move.from, asPage: true }
  }
  return { path, asPage: false }
}

/**
 * The link path a URL names after the move, read from the file's old folder.
 * The steps below the moved node keep their spelling as written. Null when
 * the URL leaves the tree.
 */
const movedLink = (path: string, move: MoveRewrite): Link | null => {
  const before = walk(parentOf(move.filePathBefore), path)
  if (before === null) return null
  const linkPath = before.steps.map((step) => step.name).join('/')
  const target = targetOf(linkPath, before.folder, move)
  const mapped = mapPath(target.path, move.from, move.to)
  if (mapped === target.path) return before
  const { names, folder } = target.asPage
    ? pageLink(mapped)
    : { names: namesOf(mapped), folder: before.folder }
  // Below the moved node the names are the author's, so is their spelling.
  const kept = Math.max(0, before.steps.length - namesOf(move.from).length)
  const steps = names.map((name, index) => {
    const fromEnd = names.length - index
    const old = before.steps[before.steps.length - fromEnd]
    return fromEnd <= kept && old?.name === name ? old : fresh(name)
  })
  return { steps, folder }
}

/**
 * From the folder `here` to a link, as a relative URL's path. The first step
 * written never starts with `_`, which would leave the URL to lookup: it
 * climbs to a common folder that does not. Null when no such path exists.
 */
const relativeTo = (here: string, link: Link): string | null => {
  const at = namesOf(here)
  let common = 0
  while (
    common < at.length &&
    common < link.steps.length &&
    at[common] === link.steps[common]?.name
  ) {
    common++
  }
  while (common > 0 && link.steps[common]?.name.startsWith('_')) common--
  if (link.steps[common]?.name.startsWith('_')) return null
  const up = '../'.repeat(at.length - common)
  const down = link.steps
    .slice(common)
    .map((step) => step.text)
    .join('/')
  if (down === '') return up === '' ? './' : up
  // A first step holding a colon would read as a scheme.
  const lead = up === '' && /^[^/]*:/.test(down) ? './' : up
  return `${lead}${down}${link.folder ? '/' : ''}`
}

/**
 * A URL's path rewritten for the move, or null when it reads the same from
 * the file's new folder as before.
 */
const rewritePath = (path: string, move: MoveRewrite): string | null => {
  const link = movedLink(path, move)
  if (link === null) return null
  const here = parentOf(move.filePathAfter)
  const after = walk(here, path)
  if (after !== null && sameLink(after, link)) return null
  const next = relativeTo(here, link)
  // A path the author started with `./` and a name keeps the `./` when it
  // still goes down.
  return next !== null && /^\.[\\/]./.test(path) && !next.startsWith('.')
    ? `./${next}`
    : next
}

const splitAt = (url: string): number => {
  const at = url.search(/[?#]/)
  return at < 0 ? url.length : at
}

const LEAD = /^[\t\n\f\r ]*/
const TRAIL = /[\t\n\f\r ]*$/

/**
 * A URL as the browser reads it, with its path rewritten for the move: its
 * path before and after, and the URL after with the whitespace around it,
 * its query and its fragment as they were. Null when nothing changes.
 */
const rewriteDecoded = (
  decoded: string,
  move: MoveRewrite,
): {
  readonly path: string
  readonly next: string
  readonly url: string
} | null => {
  if (!isRewritable(decoded)) return null
  const url = trimUrl(decoded)
  const path = url.slice(0, splitAt(url))
  const next = rewritePath(path, move)
  if (next === null) return null
  const lead = LEAD.exec(decoded)?.[0] ?? ''
  const trail = TRAIL.exec(decoded)?.[0] ?? ''
  return { path, next, url: `${lead}${next}${url.slice(path.length)}${trail}` }
}

/**
 * A URL as attribute text: every character that could end the value or read
 * as a character reference is written as one, and whitespace too unless the
 * value is quoted.
 */
const asAttributeText = (url: string, quoted: boolean): string =>
  url.replace(quoted ? /[&"'<>]/g : /[&"'<>\t\n\f\r ]/g, (char) =>
    char === '&' ? '&amp;' : `&#${char.codePointAt(0)};`,
  )

const plain = (written: string): string =>
  decodeCharacterReferences(written, 0, true).text

/**
 * One URL rewritten for the move, as attribute text. Only its path changes:
 * the whitespace around it, its query and its fragment keep the bytes they
 * were written with. Null when nothing changes.
 */
const rewriteUrl = (
  written: string,
  decoded: string,
  quoted: boolean,
  move: MoveRewrite,
): string | null => {
  const rewritten = rewriteDecoded(decoded, move)
  if (rewritten === null) return null
  const lead = LEAD.exec(written)?.[0] ?? ''
  const trail = TRAIL.exec(written)?.[0] ?? ''
  const core = written.slice(lead.length, written.length - trail.length)
  const cut = splitAt(core)
  const url = trimUrl(decoded)
  if (
    plain(core.slice(0, cut)) === rewritten.path &&
    plain(core.slice(cut)) === url.slice(rewritten.path.length)
  ) {
    const next = asAttributeText(rewritten.next, quoted)
    return `${lead}${next}${core.slice(cut)}${trail}`
  }
  // Whitespace, or the start of the query or fragment, is written as a
  // character reference, so the whole URL is written again.
  return asAttributeText(rewritten.url, quoted)
}

/**
 * A srcset whose separators are written as character references, as one
 * value: each of its candidates rewritten, and the whole value written again.
 */
const rewriteWholeSrcset = (
  decoded: string,
  quoted: boolean,
  move: MoveRewrite,
): string | null => {
  let out = ''
  let pos = 0
  let changed = false
  for (const candidate of srcsetUrls(decoded)) {
    const url = decoded.slice(candidate.start, candidate.end)
    const rewritten = rewriteDecoded(url, move)
    out += decoded.slice(pos, candidate.start) + (rewritten?.url ?? url)
    pos = candidate.end
    if (rewritten !== null) changed = true
  }
  return changed ? asAttributeText(out + decoded.slice(pos), quoted) : null
}

const isQuote = (char: string | undefined): boolean =>
  char === '"' || char === "'"

const rewriteRef = (
  source: string,
  ref: UrlRef,
  move: MoveRewrite,
): string | null => {
  if (!ref.relative) return null
  // A quoted value starts right after its quote.
  const quoted = isQuote(source[ref.range.start - 1])
  if (ref.attr !== 'srcset') {
    return rewriteUrl(ref.value, ref.decoded, quoted, move)
  }
  const read = plain(ref.value)
  const candidates = srcsetUrls(read)
  const single = candidates[0]
  if (
    candidates.length === 1 &&
    single !== undefined &&
    single.start === 0 &&
    single.end === read.length &&
    read === ref.decoded
  ) {
    // One candidate's URL: it holds no whitespace, so escaping any is safe.
    return rewriteUrl(ref.value, ref.decoded, false, move)
  }
  // The whole value, or a candidate with a separator or descriptor written
  // as a character reference: read as the browser reads it, written again.
  return rewriteWholeSrcset(read, quoted, move)
}

/**
 * The page's source with each relative URL in an `href`, `src`, `srcset`,
 * `poster` or `action` attribute rewritten for a move, so it names the same
 * node after the move as before, written relative to the file's new folder in
 * the form the author used: an extensionless page link stays extensionless,
 * a trailing slash stays, and the query and fragment stay as written. `_`
 * URLs, which lookup resolves, absolute and root-relative URLs and fragments
 * never change, nor does anything outside a URL. Null when nothing changes.
 */
export const rewriteForMove = (
  source: string,
  analysis: HtmlAnalysis,
  move: MoveRewrite,
): string | null => {
  const edits: { start: number; end: number; text: string }[] = []
  for (const ref of analysis.urls) {
    const text = rewriteRef(source, ref, move)
    if (
      text !== null &&
      text !== source.slice(ref.range.start, ref.range.end)
    ) {
      edits.push({ ...ref.range, text })
    }
  }
  if (edits.length === 0) return null
  edits.sort((a, b) => a.start - b.start)
  let out = ''
  let pos = 0
  for (const edit of edits) {
    out += source.slice(pos, edit.start) + edit.text
    pos = edit.end
  }
  out += source.slice(pos)
  return out === source ? null : out
}
