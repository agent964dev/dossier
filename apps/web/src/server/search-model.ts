import {
  dossierError,
  parseSearchInput,
  SEARCH_MAX_OFFSET,
  type SearchMode,
} from '@dossier/contracts'
import { Effect } from 'effect'

import { CurrentCaller, Search, type SearchResult } from '../core/index.ts'

/** One result as the screen shows it. */
export type SearchViewResult = Omit<SearchResult, 'node'> & {
  /** The tree path, shown under the title as `tree/path`. */
  readonly path: string
}

export interface SearchView {
  /** As typed, with the "in " prefix when present. */
  readonly input: string
  readonly mode: SearchMode
  readonly results: readonly SearchViewResult[]
  readonly next: number | null
  /** 'No pages match "budget".', when a search found nothing. */
  readonly empty: string | null
  /** Why the search was refused, such as a query that is too long. */
  readonly problem: string | null
  readonly me: { readonly email: string }
}

/** The search screen's read model, as its server function runs it. */
export const searchModel = (data: {
  readonly q: string
  readonly offset: number
}) =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller
    const { mode, query } = parseSearchInput(data.q)
    const base = {
      input: data.q,
      mode,
      results: [],
      next: null,
      empty: null,
      problem: null,
    }
    // Visitors are asked to sign in before they see the field.
    if (caller.person === null) {
      return yield* Effect.fail(
        dossierError('sign_in_required', 'Sign in to search.', null, null),
      )
    }
    const me = { email: caller.person.email }
    if (query === '') return { ...base, me } satisfies SearchView
    const offset = Math.min(
      Math.max(0, Math.trunc(data.offset)),
      SEARCH_MAX_OFFSET,
    )
    const outcome = yield* (yield* Search)
      .query({ text: query, mode, offset })
      .pipe(Effect.either)
    if (outcome._tag === 'Left') {
      if (outcome.left.code !== 'invalid')
        return yield* Effect.fail(outcome.left)
      return {
        ...base,
        problem: outcome.left.message,
        me,
      } satisfies SearchView
    }
    const page = outcome.right
    return {
      ...base,
      results: page.results.map(({ node, ...rest }) => ({
        ...rest,
        path: node.path,
      })),
      next: page.next,
      empty:
        page.results.length === 0 && offset === 0
          ? `No pages match "${page.query}".`
          : null,
      me,
    } satisfies SearchView
  })
