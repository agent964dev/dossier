import { DossierApi } from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { TreeStore } from '../../core/index.ts'

/** What changed in a tree since a cursor, as far as the caller may read. */
export const EventsLive = HttpApiBuilder.group(
  DossierApi,
  'events',
  (handlers) =>
    handlers.handle('events', ({ urlParams }) =>
      Effect.flatMap(TreeStore, (store) =>
        store.events({
          tree: urlParams.tree,
          after: urlParams.after ?? null,
          path: urlParams.path ?? null,
        }),
      ),
    ),
)
