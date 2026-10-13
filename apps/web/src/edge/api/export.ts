import { DossierApi } from '@dossier/contracts'
import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'

import { Pages } from '../../core/index.ts'
import { exportHeaders } from '../respond.ts'
import { targetOf } from './target.ts'

/** A page as one file, streamed as it is made. */
export const ExportLive = HttpApiBuilder.group(
  DossierApi,
  'export',
  (handlers) =>
    handlers.handleRaw('export', ({ urlParams }) =>
      Effect.gen(function* () {
        const ref = yield* targetOf(urlParams.link)
        const pages = yield* Pages
        const served = yield* pages.export({ ref })
        return HttpServerResponse.raw(served.html, {
          status: 200,
          headers: exportHeaders(served),
        })
      }),
    ),
)
