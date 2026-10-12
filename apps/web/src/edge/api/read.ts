import { DossierApi } from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { Pages } from '../../core/index.ts'
import { targetOf } from './target.ts'

/** `dossier read`: the same answer a link gives an agent. */
export const ReadLive = HttpApiBuilder.group(DossierApi, 'read', (handlers) =>
  handlers.handle('read', ({ urlParams }) =>
    Effect.gen(function* () {
      const ref = yield* targetOf(urlParams.path)
      const pages = yield* Pages
      return yield* pages.read(ref)
    }),
  ),
)
