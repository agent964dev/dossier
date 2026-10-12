import { Args, Command, Options } from '@effect/cli'
import {
  CONTENT_PREFIX,
  parseSearchInput,
  SEARCH_MAX_LENGTH,
  SEARCH_MAX_OFFSET,
  type SearchResponse,
} from '@dossier/contracts'
import { Effect, Option } from 'effect'

import { callApi } from '../client.ts'
import { currentDeployment } from '../deployment.ts'
import { Cli } from '../io.ts'
import { jsonOption, usage } from '../render.ts'
import { notSignedIn } from './whoami.ts'

/**
 * What `dossier search` prints: a line per result with its title and link,
 * in content mode the words around the match on the next line, and how to
 * see more.
 */
export const describeSearch = (
  response: SearchResponse,
  asked: string,
): string => {
  if (response.results.length === 0) {
    return `No pages match "${response.query}".`
  }
  const lines = response.results.flatMap((result) => {
    const snippet = (result.snippet ?? []).map((part) => part.text).join('')
    return [
      `${result.title}  ${result.link}`,
      ...(snippet.trim() === '' ? [] : [`  ${snippet.trim()}`]),
    ]
  })
  return [
    ...lines,
    ...(response.next === null
      ? []
      : [`More results: dossier search ${asked} --offset ${response.next}`]),
  ].join('\n')
}

export const search = Command.make(
  'search',
  {
    words: Args.text({ name: 'words' }).pipe(
      Args.atLeast(1),
      Args.withDescription(
        'What to look for in titles and paths, or after "in", in the ' +
          'contents of pages.',
      ),
    ),
    offset: Options.integer('offset').pipe(
      Options.withDescription(
        'Start at this result, as a previous page of results gives it.',
      ),
      Options.optional,
    ),
    json: jsonOption,
  },
  ({ words, offset }) =>
    Effect.gen(function* () {
      const { output } = yield* Cli
      const text = words.join(' ')
      // `dossier search in` alone asks for contents and names no words.
      const { mode, query } =
        text.trim() === CONTENT_PREFIX.trim()
          ? { mode: 'content' as const, query: '' }
          : parseSearchInput(text)
      if (query === '') {
        return yield* Effect.fail(
          usage(
            `Give the words to look for after "${CONTENT_PREFIX.trim()}".`,
            'Run dossier search in <words>, such as dossier search in budget.',
          ),
        )
      }
      if (query.length > SEARCH_MAX_LENGTH) {
        return yield* Effect.fail(
          usage(
            `A search is at most ${SEARCH_MAX_LENGTH} characters.`,
            'Search for fewer words.',
          ),
        )
      }
      const start = Option.getOrElse(offset, () => 0)
      if (start < 0 || start > SEARCH_MAX_OFFSET) {
        return yield* Effect.fail(
          usage(`--offset is from 0 to ${SEARCH_MAX_OFFSET}.`),
        )
      }
      const { deployment, key } = yield* currentDeployment()
      if (key === null) return yield* Effect.fail(notSignedIn(deployment))
      const response = yield* callApi(deployment, key, (c) =>
        c.search.search({
          urlParams: { q: query, mode, offset: start },
        }),
      )
      output.result(
        describeSearch(response, mode === 'content' ? `in ${query}` : query),
        response,
      )
    }),
).pipe(
  Command.withDescription(
    'Find pages, folders and files you can open by their titles and paths, ' +
      'or with "in" first, pages by their contents and their agent ' +
      'versions. 20 results a page; prints "No pages match" and exits 0 ' +
      'when nothing does.',
  ),
)
