import { DossierApi } from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { SignIn } from '../../core/index.ts'

export const DeviceLive = HttpApiBuilder.group(
  DossierApi,
  'device',
  (handlers) =>
    handlers.handle('token', ({ payload }) =>
      Effect.flatMap(SignIn, (signIn) =>
        signIn.redeemDevice(payload.deviceCode),
      ),
    ),
)
