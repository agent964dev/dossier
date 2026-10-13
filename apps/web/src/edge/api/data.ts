import { dossierError, DossierApi, type AuthoredSeq } from '@dossier/contracts'
import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'

import { Data } from '../../core/index.ts'

/** The body of a request, as the Worker received it. */
const bodyOf = (source: unknown) =>
  source instanceof Request && source.body !== null
    ? Effect.succeed(source.body)
    : Effect.fail(
        dossierError('invalid', 'The file has no body.', 'Send its bytes.'),
      )

/** Form sends, uploads, withdrawals and data reads, as the viewer. */
export const DataApiLive = HttpApiBuilder.group(
  DossierApi,
  'data',
  (handlers) =>
    handlers
      .handle('send', ({ payload }) =>
        Effect.flatMap(Data, (data) =>
          data.send({
            treeId: payload.tree,
            page: payload.page,
            seq: payload.seq,
            form: payload.form,
            entries: payload.entries,
            submitter: payload.submitter,
            entry: payload.entry,
            opId: payload.opId,
            as: payload.as ?? null,
          }),
        ),
      )
      // Streams the bytes to R2 as they arrive.
      .handleRaw('upload', ({ urlParams, request }) =>
        Effect.gen(function* () {
          const body = yield* bodyOf(request.source)
          if (!Number.isSafeInteger(urlParams.size) || urlParams.size < 0) {
            return yield* Effect.fail(
              dossierError('invalid', 'The size is not a number of bytes.'),
            )
          }
          const form =
            urlParams.host === undefined || urlParams.target === undefined
              ? null
              : {
                  host: urlParams.host,
                  target: urlParams.target,
                  id: urlParams.id ?? null,
                }
          const data = yield* Data
          const stored = yield* data.upload({
            treeId: urlParams.tree,
            page: urlParams.page,
            seq: urlParams.seq as AuthoredSeq,
            form,
            field: urlParams.field ?? null,
            name: urlParams.name,
            type: urlParams.type,
            size: urlParams.size,
            sha256: urlParams.sha256,
            body,
            opId: urlParams.opId,
            as: urlParams.as ?? null,
          })
          return HttpServerResponse.unsafeJson(stored, { status: 201 })
        }),
      )
      .handle('withdraw', ({ payload }) =>
        Effect.flatMap(Data, (data) =>
          data.withdraw({
            treeId: payload.tree,
            path: payload.path,
            opId: payload.opId,
            as: payload.as ?? null,
          }),
        ),
      )
      .handle('read', ({ urlParams }) =>
        Effect.flatMap(Data, (data) =>
          data.read({ treeId: urlParams.tree, path: urlParams.path }),
        ),
      )
      .handle('write', ({ payload }) =>
        Effect.flatMap(Data, (data) => data.write(payload)),
      ),
)
