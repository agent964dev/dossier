import { DossierApi } from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { SignIn } from '../../core/index.ts'

export const MeLive = HttpApiBuilder.group(DossierApi, 'me', (handlers) =>
  handlers
    .handle('me', () => Effect.flatMap(SignIn, (signIn) => signIn.me()))
    .handle('revokeCurrentKey', () =>
      Effect.flatMap(SignIn, (signIn) => signIn.revokeKey('current')),
    ),
)
