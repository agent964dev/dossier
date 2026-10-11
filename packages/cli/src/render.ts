import { HelpDoc, Options, type Span, ValidationError } from '@effect/cli'
import {
  DossierError,
  exitCodeFor,
  type ErrorCode,
  type ExitCode,
} from '@dossier/contracts'
import { Data } from 'effect'

import type { CliIo } from './io.ts'

/** What every exit code means, in the order an agent reads them. */
export const EXIT_MEANINGS: Readonly<Record<ExitCode, string>> = {
  0: 'success',
  1: 'failure',
  2: 'usage',
  3: 'not found or no access',
  4: 'not signed in or key refused',
  5: 'conflict',
  6: 'refused by a rule or a limit',
}

/** Every verb takes it, so `whoami --json` and `--json whoami` agree. */
export const jsonOption = Options.boolean('json').pipe(
  Options.withDescription('Print one JSON value on stdout.'),
)

export interface CliFailure {
  readonly exit: ExitCode
  readonly code: ErrorCode | 'usage'
  readonly message: string
  readonly fix: string | null
  readonly path: string | null
}

/** A failure the CLI finds itself, before or around a request. */
export class CliProblem extends Data.TaggedError('CliProblem')<{
  readonly exit: 1 | 2
  readonly message: string
  readonly fix: string | null
}> {}

/** The command line asks for something that cannot work: exit 2. */
export const usage = (message: string, fix: string | null = null) =>
  new CliProblem({ exit: 2, message, fix })

/** Something went wrong on this side: exit 1. */
export const problem = (message: string, fix: string | null = null) =>
  new CliProblem({ exit: 1, message, fix })

export const spanText = (span: Span.Span): string => {
  switch (span._tag) {
    case 'Text':
    case 'URI':
      return span.value
    case 'Sequence':
      return spanText(span.left) + spanText(span.right)
    default:
      return spanText(span.value)
  }
}

/** Plain text of a help document, without colour. */
export const helpText = (doc: HelpDoc.HelpDoc): string => {
  switch (doc._tag) {
    case 'Empty':
      return ''
    case 'Header':
    case 'Paragraph':
      return spanText(doc.value)
    case 'DescriptionList':
      return doc.definitions
        .map(([term, body]) => `${spanText(term)} ${helpText(body)}`.trim())
        .join('\n')
    case 'Enumeration':
      return doc.elements.map(helpText).join('\n')
    case 'Sequence':
      return [helpText(doc.left), helpText(doc.right)]
        .filter((part) => part !== '')
        .join('\n')
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Where a failure lands: its exit code, and what to tell the person. */
export const failureFrom = (error: unknown): CliFailure => {
  if (error instanceof DossierError) {
    return {
      exit: exitCodeFor(error.code),
      code: error.code,
      message: error.message,
      fix: error.fix,
      path: error.path,
    }
  }
  if (error instanceof CliProblem) {
    return {
      exit: error.exit,
      code: error.exit === 2 ? 'usage' : 'unavailable',
      message: error.message,
      fix: error.fix,
      path: null,
    }
  }
  if (ValidationError.isValidationError(error)) {
    return {
      exit: 2,
      code: 'usage',
      message: helpText(error.error) || 'The command line is not valid.',
      fix: 'Run `dossier --help` to see the verbs and their flags.',
      path: null,
    }
  }
  return {
    exit: 1,
    code: 'unavailable',
    message: messageOf(error),
    fix: null,
    path: null,
  }
}

export interface Output {
  /** `--json`, or `DOSSIER_JSON=1`. */
  readonly json: boolean
  /** Text to stdout, or one JSON value to stdout. */
  readonly result: (text: string, json: unknown) => void
  /** Progress a person reads: stdout in text, stderr under `--json`. */
  readonly note: (text: string) => void
  /** Text to stderr, or `{ error: { code: exit, … } }` to stdout. */
  readonly fail: (failure: CliFailure) => ExitCode
}

const line = (text: string) => (text.endsWith('\n') ? text : `${text}\n`)

const truthy = (value: string | undefined) =>
  value !== undefined && ['1', 'true', 'yes'].includes(value.toLowerCase())

/** Whether this run answers in JSON, decided before the command line parses. */
export const jsonRequested = (
  argv: readonly string[],
  env: CliIo['env'],
): boolean => {
  const end = argv.indexOf('--')
  const flags = end < 0 ? argv : argv.slice(0, end)
  return flags.includes('--json') || truthy(env.DOSSIER_JSON)
}

export const makeOutput = (io: CliIo, json: boolean): Output => ({
  json,
  result: (text, value) =>
    json
      ? io.stdout(line(JSON.stringify(value, null, 2)))
      : io.stdout(line(text)),
  note: (text) => (json ? io.stderr(line(text)) : io.stdout(line(text))),
  fail: (failure) => {
    if (json) {
      io.stdout(
        line(
          JSON.stringify(
            {
              error: {
                code: failure.exit,
                message: failure.message,
                fix: failure.fix,
                path: failure.path,
              },
            },
            null,
            2,
          ),
        ),
      )
    } else {
      io.stderr(line(`dossier: ${failure.message}`))
      if (failure.fix !== null) io.stderr(line(failure.fix))
    }
    return failure.exit
  },
})
