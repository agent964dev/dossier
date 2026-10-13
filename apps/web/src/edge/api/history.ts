import {
  dossierError,
  DossierApi,
  type PushNumber,
  type RestoreTo,
} from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { Files, type RestorePoint } from '../../core/index.ts'
import { targetOf } from './target.ts'

/** A push number from the URL: a positive integer. */
const pushNumber = (value: number | undefined) =>
  value === undefined
    ? Effect.succeed(null)
    : Number.isSafeInteger(value) && value > 0
      ? Effect.succeed(value as PushNumber)
      : Effect.fail(
          dossierError(
            'invalid',
            `"${value}" is not a push number.`,
            'Give a push number from dossier log.',
          ),
        )

/** Where a restore goes: a push, or an ISO 8601 time. */
export const restorePointOf = (to: RestoreTo) => {
  if ('push' in to) return Effect.succeed({ push: to.push } as RestorePoint)
  const at = Date.parse(to.at)
  return Number.isNaN(at) || !/^\d{4}-\d{2}-\d{2}/.test(to.at)
    ? Effect.fail(
        dossierError(
          'invalid',
          `"${to.at}" is not a time.`,
          'Give a push number, or a time such as 2026-10-11T09:30:00Z.',
        ),
      )
    : Effect.succeed({ at } as RestorePoint)
}

/** `dossier log`, `diff` and `restore`, and the history screen's reads. */
export const HistoryLive = HttpApiBuilder.group(
  DossierApi,
  'history',
  (handlers) =>
    handlers
      .handle('log', ({ urlParams }) =>
        Effect.gen(function* () {
          const ref = yield* targetOf(urlParams.path)
          const page = yield* (yield* Files).log({
            ref,
            cursor: urlParams.cursor ?? null,
          })
          return {
            path: page.path,
            lines: page.lines,
            next: page.next,
            retentionDays: page.retentionDays,
          }
        }),
      )
      .handle('push', ({ urlParams }) =>
        Effect.gen(function* () {
          const ref = yield* targetOf(urlParams.path)
          const number = yield* pushNumber(urlParams.number)
          if (number === null) {
            return yield* Effect.fail(dossierError('invalid'))
          }
          const detail = yield* (yield* Files).pushDetail({ ref, number })
          return {
            number: detail.push.number as PushNumber,
            message: detail.push.message,
            at: new Date(
              detail.push.committedAt ?? detail.push.createdAt,
            ).toISOString(),
            by: detail.by,
            files: detail.files,
          }
        }),
      )
      .handle('diff', ({ urlParams }) =>
        Effect.gen(function* () {
          const ref = yield* targetOf(urlParams.path)
          const from = yield* pushNumber(urlParams.from)
          const to = yield* pushNumber(urlParams.to)
          return yield* (yield* Files).diff({ ref, from, to })
        }),
      )
      .handle('restore', ({ payload }) =>
        Effect.gen(function* () {
          const ref = yield* targetOf(payload.path)
          const to = yield* restorePointOf(payload.to)
          return yield* (yield* Files).restore({ ref, to })
        }),
      ),
)
