import { DossierApi } from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { Pages } from '../../core/index.ts'

/** The shell asks for a view handle before it frames a page. */
export const ViewLive = HttpApiBuilder.group(DossierApi, 'view', (handlers) =>
  handlers.handle('view', ({ payload }) =>
    Effect.flatMap(Pages, (pages) =>
      pages.view({
        treeId: payload.tree,
        path: payload.path,
        renewal: payload.renewal,
      }),
    ),
  ),
)
