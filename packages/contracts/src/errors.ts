import { Effect, Schema } from 'effect'

import { defaultMessage, ERROR_CODES, type ErrorCode } from './codes.ts'

export const ErrorCodeSchema: Schema.Schema<ErrorCode> = Schema.Literal(
  ...ERROR_CODES,
)

/** The one error every Dossier contract fails with. */
export class DossierError<
  C extends ErrorCode = ErrorCode,
> extends Schema.TaggedError<DossierError>()('DossierError', {
  code: ErrorCodeSchema,
  message: Schema.String,
  fix: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
}) {
  declare readonly code: C
}

export const dossierError = <C extends ErrorCode>(
  code: C,
  message?: string,
  fix: string | null = null,
  path: string | null = null,
): DossierError<C> =>
  new DossierError({
    code,
    message: message ?? defaultMessage(code),
    fix,
    path,
  }) as DossierError<C>

/** Fails with a `DossierError`; the message defaults to the table's. */
export const fail = <C extends ErrorCode>(
  code: C,
  message?: string,
  fix?: string | null,
  path?: string | null,
): Effect.Effect<never, DossierError<C>> =>
  Effect.fail(dossierError(code, message, fix, path))

export const isDossierError = (value: unknown): value is DossierError =>
  value instanceof DossierError

/** The body every API error and every CLI `--json` error uses. */
export const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: ErrorCodeSchema,
    message: Schema.String,
    fix: Schema.NullOr(Schema.String),
    path: Schema.NullOr(Schema.String),
  }),
})
export type ErrorBody = typeof ErrorBody.Type
