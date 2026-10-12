// Which pages a change of a tree indexes again, and which it drops. A page
// is indexed with its companion's text, so a change to the companion alone
// indexes the page again.
import { namedCompanion, type TreeView } from './check-push.ts'
import { isKitName, isPageFile } from './paths.ts'
import { normalizeSearchText } from './search-text.ts'

export type SearchEntry =
  | {
      readonly path: string
      /** The path as searched. */
      readonly pathSearch: string
      /** The title shown when the page has none: its file name. */
      readonly fallbackTitle: string
      readonly fallbackTitleSearch: string
      /** The companion indexed with the page, if any. */
      readonly companion: string | null
    }
  | { readonly path: string; readonly drop: true }

/** A page after the change, with its `<link rel="alternate">` href. */
export interface PageFacts {
  readonly path: string
  readonly alternate: string | null
}

const hasKitSegment = (path: string): boolean => path.split('/').some(isKitName)

/** A page search holds: an HTML file outside every `_` folder. */
const indexed = (path: string): boolean =>
  isPageFile(path) && !hasKitSegment(path)

/**
 * What search reads of a page's path: the path without its `.html`, so
 * every page does not match the word "html".
 */
export const pathSearchOf = (path: string): string =>
  normalizeSearchText(path.replace(/\.html$/, ''))

/**
 * The places a page's companion may be, as the agent version looks: the
 * file its alternate link names, then the same-name `.md`.
 */
export const companionCandidates = (page: PageFacts): readonly string[] => {
  const named = namedCompanion(page.path, page.alternate)
  const same = page.path.replace(/\.html$/, '.md')
  return [named, same].filter(
    (path): path is string => path !== null && path !== page.path,
  )
}

/**
 * The entries a change gives the index: every page that is new, changed,
 * moved here, or whose companion is, with the companion it has now; and a
 * drop for every page the change took away. A companion is an authored
 * file outside every `_` folder: people's data is never indexed.
 */
export const searchEntries = (i: {
  readonly changed: readonly string[]
  readonly removed: readonly string[]
  readonly pages: readonly PageFacts[]
  readonly kindAt: TreeView['kindAt']
}): readonly SearchEntry[] => {
  const touched = new Set([...i.changed, ...i.removed])
  const out: SearchEntry[] = []
  const live = new Set<string>()
  for (const page of i.pages) {
    if (!indexed(page.path) || i.kindAt(page.path) !== 'page') continue
    if (live.has(page.path)) continue
    live.add(page.path)
    const candidates = companionCandidates(page)
    if (!touched.has(page.path) && !candidates.some((c) => touched.has(c))) {
      continue
    }
    const companion =
      candidates.find(
        (path) => i.kindAt(path) === 'file' && !hasKitSegment(path),
      ) ?? null
    const name = page.path.slice(page.path.lastIndexOf('/') + 1)
    out.push({
      path: page.path,
      pathSearch: pathSearchOf(page.path),
      fallbackTitle: name,
      fallbackTitleSearch: normalizeSearchText(name),
      companion,
    })
  }
  const dropped = new Set<string>()
  for (const path of i.removed) {
    if (!indexed(path) || live.has(path) || dropped.has(path)) continue
    dropped.add(path)
    out.push({ path, drop: true })
  }
  return out
}
