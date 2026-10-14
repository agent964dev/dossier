import { Command, Options, ValidationError } from '@effect/cli'
import { NodeContext } from '@effect/platform-node'
import type { ExitCode } from '@dossier/contracts'
import { Cause, Console, Effect } from 'effect'

import { verbs } from './commands/index.ts'
import { guide, guideMarkdown } from './guide.ts'
import { Cli, type CliIo, VERSION } from './io.ts'
import {
  failureFrom,
  jsonOption,
  jsonRequested,
  makeOutput,
  type Output,
} from './render.ts'

export type { CliIo } from './io.ts'

const agentInfo = Options.boolean('agent-info').pipe(
  Options.withDescription(
    'Print the guide for agents: every verb, its flags and the exit codes.',
  ),
)

export const dossier = Command.make(
  'dossier',
  { json: jsonOption, agentInfo },
  ({
    agentInfo: wanted,
  }): Effect.Effect<void, ValidationError.ValidationError, Cli> =>
    Effect.gen(function* () {
      if (!wanted) {
        return yield* Effect.fail(
          ValidationError.helpRequested(dossier.descriptor),
        )
      }
      const { output } = yield* Cli
      const data = guide()
      output.result(guideMarkdown(data), data)
    }),
).pipe(
  Command.withDescription(
    'Sign in to a Dossier deployment and act there with an agent key. ' +
      'Run dossier ls to see your workspaces, their trees, what you may do ' +
      'in each, and what is shared with you.',
  ),
  Command.withSubcommands(verbs),
)

/** Help, version and parse errors from @effect/cli go through the io too. */
const consoleFor = (base: Console.Console, io: CliIo): Console.Console => {
  const write =
    (to: (text: string) => void) =>
    (...args: ReadonlyArray<unknown>) =>
      Effect.sync(() => {
        const text = args.map(String).join(' ')
        to(text.endsWith('\n') ? text : `${text}\n`)
      })
  return {
    ...base,
    log: write(io.stdout),
    info: write(io.stdout),
    warn: write(io.stderr),
    error: write(io.stderr),
  }
}

const exitFor = (output: Output, io: CliIo, error: unknown): ExitCode => {
  const failure = failureFrom(error)
  // @effect/cli has already printed what was wrong with the command line.
  if (ValidationError.isValidationError(error) && !output.json) {
    if (failure.fix !== null) io.stderr(`${failure.fix}\n`)
    return failure.exit
  }
  return output.fail(failure)
}

/** Runs one command line against the given io and answers its exit code. */
export const runCli = (
  argv: readonly string[],
  io: CliIo,
): Promise<ExitCode> => {
  const output = makeOutput(io, jsonRequested(argv, io.env))
  const run = Command.run(dossier, { name: 'dossier', version: VERSION })
  const program = Console.consoleWith((base) =>
    run(['node', 'dossier', ...argv]).pipe(
      Effect.map((): ExitCode => output.exitCode()),
      Effect.catchAllCause((cause) =>
        Effect.sync(() => exitFor(output, io, Cause.squash(cause))),
      ),
      Console.withConsole(consoleFor(base, io)),
    ),
  ).pipe(
    Effect.provideService(Cli, { io, output }),
    Effect.provide(NodeContext.layer),
  )
  return Effect.runPromise(program)
}
