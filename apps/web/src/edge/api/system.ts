import { DossierApi, fail, PROTOCOL } from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { Bindings, Config } from '../../core/index.ts'

export const SystemLive = HttpApiBuilder.group(
  DossierApi,
  'system',
  (handlers) =>
    handlers.handle('health', () =>
      Effect.gen(function* () {
        const config = yield* Config
        const { DB } = yield* Bindings
        yield* Effect.tryPromise(() => DB.prepare('select 1').first()).pipe(
          Effect.catchAll((error) =>
            Effect.logError('Health check: D1 failed', error).pipe(
              Effect.zipRight(fail('unavailable')),
            ),
          ),
        )
        return {
          ok: true as const,
          service: 'dossier' as const,
          version: config.buildVersion,
          protocol: PROTOCOL,
          deployment: config.deploymentName,
          db: 'ok' as const,
        }
      }),
    ),
)
