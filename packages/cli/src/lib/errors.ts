export const ExitCode = {
  Ok: 0,
  Failure: 1,
  Usage: 2,
  Auth: 4,
} as const

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

export class CliError extends Error {
  readonly exitCode: ExitCode
  readonly details?: unknown

  constructor(message: string, exitCode: ExitCode = ExitCode.Failure, details?: unknown) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.details = details
  }
}

export function exitCodeFor(error: unknown): ExitCode {
  if (error instanceof CliError) return error.exitCode
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === 401
  ) {
    return ExitCode.Auth
  }
  return ExitCode.Failure
}
