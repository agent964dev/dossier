// What a search field's text means, shared by the screens and the CLI.
// Plain TypeScript, so screens take it from the bridge without Effect.

/** Titles and paths, or the contents of pages. */
export type SearchMode = 'titles' | 'content'

/** Text starting with this searches page contents. */
export const CONTENT_PREFIX = 'in '

/** Results on one page of search. */
export const SEARCH_PAGE_SIZE = 20

/** The furthest page of results starts here. */
export const SEARCH_MAX_OFFSET = 180

/** The longest query, in characters. */
export const SEARCH_MAX_LENGTH = 200

/**
 * The mode and query a field's text asks for: `in budget` searches page
 * contents for `budget`; `in` alone, `inbox` and anything else search titles
 * and paths. Leading and trailing spaces are not part of the query.
 */
export const parseSearchInput = (
  text: string,
): { readonly mode: SearchMode; readonly query: string } => {
  const start = text.trimStart()
  return start.startsWith(CONTENT_PREFIX)
    ? { mode: 'content', query: start.slice(CONTENT_PREFIX.length).trim() }
    : { mode: 'titles', query: start.trim() }
}
