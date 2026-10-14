import { DossierApi } from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'

import { workspacePlace, workspacePlaces } from '../../core/index.ts'

/** `dossier ls` with no tree: where the caller can work. */
export const WorkspacesApiLive = HttpApiBuilder.group(
  DossierApi,
  'workspaces',
  (handlers) =>
    handlers
      .handle('list', () => workspacePlaces)
      .handle('get', ({ path }) => workspacePlace(path.name)),
)
