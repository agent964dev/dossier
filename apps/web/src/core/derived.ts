// What a push keeps beside a blob as its bytes arrive: the HTML analysis, a
// module's imports, the search texts and a page's generated agent version.
// They are made from the verified bytes in hand rather than read back from
// R2, and stored with the statements that confirm the upload. Each is what
// `analysisOf`, `jsAnalysisOf`, `searchTextOf` and `TreeStore.markdown` would
// make from the same bytes. Internal to the core.
import {
  analyze,
  ANALYZER_VERSION,
  analyzeJs,
  isKitName,
  isPageFile,
  JS_ANALYZER_VERSION,
  normalizeSearchText,
  SEARCH_TEXT_VERSION,
  searchText,
  toMarkdown,
  type HtmlAnalysis,
  type SearchText,
} from '@dossier/html'

import {
  SEARCH_ANALYZER,
  SEARCH_SOURCE_MAX_BYTES,
  searchKindOf,
  type SearchTextKind,
} from './search-index.ts'

/** What the paths a blob is pushed at ask to keep beside it. */
export interface DerivedNeeds {
  /** A page: its analysis. */
  readonly html: boolean
  /** A module: its imports, which exporting a page follows. */
  readonly js: boolean
  /** What search reads of a page or a companion outside the kit. */
  readonly search: readonly SearchTextKind[]
  /** A page outside the kit: its generated agent version. */
  readonly markdown: boolean
}

const inKit = (path: string) => path.split('/').some(isKitName)

export const derivedNeeds = (paths: readonly string[]): DerivedNeeds => {
  const kinds = new Set(
    paths.flatMap((path) => (inKit(path) ? [] : [searchKindOf(path)])),
  )
  return {
    html: paths.some(isPageFile),
    js: paths.some((path) => /\.m?js$/i.test(path)),
    search: (['html', 'text'] as const).filter((kind) => kinds.has(kind)),
    markdown: paths.some((path) => isPageFile(path) && !inKit(path)),
  }
}

/** Whether making what the paths ask for reads the file's text. */
export const needsText = (needs: DerivedNeeds, size: number): boolean =>
  needs.html ||
  needs.js ||
  needs.markdown ||
  needs.search.includes('html') ||
  (needs.search.includes('text') && size <= SEARCH_SOURCE_MAX_BYTES)

export interface Derived {
  /** Rows for `analyses`: analyzer, version and JSON. */
  readonly analyses: readonly {
    readonly analyzer: string
    readonly version: number
    readonly json: string
  }[]
  /** The page's agent version, or null when none is asked or it failed. */
  readonly markdown: string | null
}

/**
 * What the paths ask for, made from the file's text (null when none is
 * needed). A page that cannot be converted to Markdown is logged and left
 * for its first read to make.
 */
export const derivedOf = (
  sha256: string,
  needs: DerivedNeeds,
  size: number,
  text: string | null,
): Derived => {
  const analyses: { analyzer: string; version: number; json: string }[] = []
  let html: HtmlAnalysis | null = null
  const htmlAnalysis = () => (html ??= analyze(text ?? ''))
  if (needs.html) {
    analyses.push({
      analyzer: 'html',
      version: ANALYZER_VERSION,
      json: JSON.stringify(htmlAnalysis()),
    })
  }
  if (needs.js) {
    analyses.push({
      analyzer: 'js',
      version: JS_ANALYZER_VERSION,
      json: JSON.stringify(analyzeJs(text ?? '')),
    })
  }
  for (const kind of needs.search) {
    let result: SearchText
    if (size > SEARCH_SOURCE_MAX_BYTES) {
      // A large file keeps its page title and no text.
      const title = kind === 'html' ? htmlAnalysis().title : null
      const shown =
        title === null ? null : title.replace(/\s+/g, ' ').trim() || null
      result = {
        title: shown,
        titleSearch: shown === null ? null : normalizeSearchText(shown),
        body: '',
      }
    } else {
      result = searchText(text ?? '', kind)
    }
    analyses.push({
      analyzer: SEARCH_ANALYZER[kind],
      version: SEARCH_TEXT_VERSION,
      json: JSON.stringify(result),
    })
  }
  let markdown: string | null = null
  if (needs.markdown) {
    try {
      markdown = toMarkdown(text ?? '')
    } catch (error) {
      console.warn('A page could not be converted to Markdown', {
        sha256,
        error: String(error),
      })
    }
  }
  return { analyses, markdown }
}
