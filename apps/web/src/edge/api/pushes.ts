import { dossierError, DossierApi } from '@dossier/contracts'
import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'

import { Push } from '../../core/index.ts'
import { targetOf } from './target.ts'

/** The body of a request, as the Worker received it. */
const bodyOf = (source: unknown) =>
  source instanceof Request && source.body !== null
    ? Effect.succeed(source.body)
    : Effect.fail(
        dossierError('invalid', 'The file has no body.', 'Send its bytes.'),
      )

const lengthOf = (value: string | undefined) => {
  const length = Number(value)
  return value === undefined || !Number.isSafeInteger(length) || length < 0
    ? Effect.fail(
        dossierError(
          'invalid',
          'Content-Length is required.',
          "Send the file's size in Content-Length.",
        ),
      )
    : Effect.succeed(length)
}

export const PushesLive = HttpApiBuilder.group(
  DossierApi,
  'pushes',
  (handlers) =>
    handlers
      .handle('stage', ({ payload }) =>
        Effect.flatMap(targetOf(payload.target), (target) =>
          Effect.flatMap(Push, (push) => push.stage({ ...payload, target })),
        ),
      )
      // The one streaming handler: the bytes go to R2 as they arrive.
      .handleRaw('blob', ({ path, request }) =>
        Effect.gen(function* () {
          const size = yield* lengthOf(request.headers['content-length'])
          const body = yield* bodyOf(request.source)
          const push = yield* Push
          yield* push.putBlob({ ...path, size, body })
          return HttpServerResponse.empty({ status: 201 })
        }),
      )
      .handle('commit', ({ path }) =>
        Effect.flatMap(Push, (push) => push.commit(path.pushId)),
      ),
)
