import { DossierApi } from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { Search } from '../../core/index.ts'

/** `dossier search`, as the screen's search reads it. */
export const SearchApiLive = HttpApiBuilder.group(
  DossierApi,
  'search',
  (handlers) =>
    handlers.handle('search', ({ urlParams }) =>
      Effect.gen(function* () {
        const page = yield* (yield* Search).query({
          text: urlParams.q,
          mode: urlParams.mode,
          offset: urlParams.offset,
        })
        return {
          query: page.query,
          mode: page.mode,
          results: page.results.map((r) => ({
            kind: r.kind,
            title: r.title,
            workspace: r.workspace,
            tree: r.tree,
            path: r.node.path,
            link: r.link,
            snippet: r.snippet,
          })),
          next: page.next,
        }
      }),
    ),
)
