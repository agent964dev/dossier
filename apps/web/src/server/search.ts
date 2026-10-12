import { createServerFn } from '@tanstack/react-start'

import { runScreen } from './run.ts'
import { searchModel } from './search-model.ts'

// Types only: a value from the model would bring the core into the screens'
// client bundle.
export type { SearchView, SearchViewResult } from './search-model.ts'

export const searchView = createServerFn({ method: 'GET' })
  .validator(
    (input: { readonly q?: string; readonly offset?: number } | undefined) => ({
      q: typeof input?.q === 'string' ? input.q : '',
      offset:
        typeof input?.offset === 'number' && Number.isFinite(input.offset)
          ? input.offset
          : 0,
    }),
  )
  .handler(({ data }) => runScreen(searchModel(data)))
