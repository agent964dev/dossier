import { dossierError, parseTarget } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import { Config, Pages, type SeenBy } from '../core/index.ts'
import { listingModel, type ListingView } from './listing-model.ts'
import { runScreen, type ScreenFailure } from './run.ts'

export type { SeenBy, SeenByRow } from '../core/index.ts'
export type { ListingView } from './listing-model.ts'

const notFound = () =>
  dossierError('not_found', 'Nothing is here, or you cannot open it.')

export const listingView = createServerFn({ method: 'GET' })
  .validator(
    (input: {
      readonly workspace: string
      readonly tree: string
      readonly path: string
    }) => ({
      workspace: String(input.workspace),
      tree: String(input.tree),
      path: String(input.path ?? '').replace(/^\/+|\/+$/g, ''),
    }),
  )
  .handler(({ data }): Promise<ListingView | ScreenFailure> =>
    runScreen(listingModel(data)),
  )

export const seenBy = createServerFn({ method: 'GET' })
  .validator((input: { readonly link: string }) => ({
    link: String(input.link),
  }))
  .handler(({ data }): Promise<SeenBy | ScreenFailure> =>
    runScreen(
      Effect.gen(function* () {
        const config = yield* Config
        const ref = parseTarget(data.link, config.origin)
        if (ref === null) return yield* Effect.fail(notFound())
        return yield* (yield* Pages).seenBy(ref)
      }),
    ),
  )
