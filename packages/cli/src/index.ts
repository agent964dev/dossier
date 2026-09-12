#!/usr/bin/env node

import { Args, Command, Options, ValidationError } from '@effect/cli'
import { DossierApi, type HealthzResponse } from '@dossier/contracts'
import { validateHtmlStatic } from '@dossier/policy'
import { FetchHttpClient, HttpApiClient } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Console as EffectConsole, Effect, Option } from 'effect'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { CliError, ExitCode, exitCodeFor } from './lib/errors.js'
import { dossierJson } from './lib/http.js'
import { parseRef } from './lib/ref.js'
import {
  mutateCredentials,
  readConfig,
  readCredentials,
  statePaths,
  writeConfig,
  type StatePaths,
} from './lib/state.js'

const VERSION = '0.0.0'
const DEFAULT_API_URL = 'https://dossier.agent964.com'

type GlobalOptions = {
  readonly apiUrl: Option.Option<string>
  readonly json: boolean
  readonly quiet: boolean
}

type JsonObject = Record<string, unknown>

interface RuntimeConfig {
  readonly apiUrl: string
  readonly apiOrigin: string
  readonly apiKey?: string
  readonly json: boolean
  readonly quiet: boolean
  readonly paths: StatePaths
}

function apiOrigin(apiUrl: string): string {
  try {
    const url = new URL(apiUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
    return url.origin
  } catch {
    throw new CliError(`invalid API URL: ${apiUrl}`, ExitCode.Usage)
  }
}

async function runtimeConfig(globals: GlobalOptions): Promise<RuntimeConfig> {
  const paths = statePaths()
  const config = await readConfig(paths)
  const explicitApiUrl = Option.getOrUndefined(globals.apiUrl)
  const apiUrl = explicitApiUrl ?? process.env.DOSSIER_API_URL ?? config.apiUrl ?? DEFAULT_API_URL
  const origin = apiOrigin(apiUrl)
  const credentials = await readCredentials(paths)
  const storedKey = credentials[origin]
  if (storedKey !== undefined && typeof storedKey !== 'string') {
    throw new CliError(
      `cannot read ${paths.credentials}: credential for ${origin} must be a string; repair or remove the file`,
    )
  }
  return {
    apiUrl: origin,
    apiOrigin: origin,
    apiKey: process.env.DOSSIER_API_KEY?.trim() || storedKey,
    json: globals.json,
    quiet: globals.quiet,
    paths,
  }
}

function printValue(value: unknown, runtime: Pick<RuntimeConfig, 'json' | 'quiet'>): void {
  if (runtime.json) {
    process.stdout.write(`${JSON.stringify(value)}\n`)
    return
  }
  if (runtime.quiet) return
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function notImplemented(): never {
  throw new CliError('not implemented in phase 0')
}

function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error
  return new CliError(error instanceof Error ? error.message : String(error))
}

function withGlobals(
  operation: (globals: GlobalOptions) => Promise<void>,
): Effect.Effect<void, CliError, Command.Command.Context<'dossier'>> {
  return rootCommand.pipe(
    Effect.flatMap((globals) =>
      Effect.tryPromise({
        try: () => operation(globals),
        catch: asCliError,
      }),
    ),
  )
}

async function readStdin(): Promise<string> {
  let value = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) value += chunk
  return value
}

async function validateUpload(file: string): Promise<void> {
  let html: string
  try {
    html = await readFile(file, 'utf8')
  } catch (error) {
    throw new CliError(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const result = validateHtmlStatic(html)
  if (!result.ok) {
    throw new CliError(
      `upload policy rejected ${file}: ${result.errors[0] ?? 'document did not pass static policy'}`,
    )
  }
}

async function fetchHealth(runtime: RuntimeConfig): Promise<HealthzResponse> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(DossierApi, {
        baseUrl: runtime.apiUrl,
      })
      return yield* client.system.healthz()
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.timeout('30 seconds'),
      Effect.mapError(asCliError),
    ),
  )
}

const globalOptions = {
  apiUrl: Options.text('api-url').pipe(
    Options.optional,
    Options.withDescription('Dossier API base URL'),
  ),
  json: Options.boolean('json').pipe(Options.withDescription('Print one JSON value on stdout')),
  quiet: Options.boolean('quiet').pipe(
    Options.withAlias('q'),
    Options.withDescription('Suppress successful output'),
  ),
}

const rootCommand = Command.make('dossier', globalOptions).pipe(
  Command.withDescription('Publish and retrieve dossier documents'),
)

const authLogin = Command.make('login', {}, () => withGlobals(async () => notImplemented())).pipe(
  Command.withDescription('Sign in through the browser'),
)

const authSet = Command.make(
  'set',
  { key: Args.text({ name: 'key' }).pipe(Args.optional) },
  ({ key }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const supplied = Option.getOrUndefined(key) ?? (await readStdin())
      const apiKey = supplied.trim()
      if (apiKey === '') throw new CliError('API key is empty', ExitCode.Usage)

      await mutateCredentials((credentials) => {
        credentials[runtime.apiOrigin] = apiKey
      }, runtime.paths)
      if (Option.isSome(globals.apiUrl)) {
        await writeConfig({ apiUrl: runtime.apiOrigin }, runtime.paths)
      }
      printValue({ ok: true, origin: runtime.apiOrigin }, runtime)
    }),
).pipe(Command.withDescription('Store an API key (reads stdin when omitted)'))

const authLogout = Command.make('logout', {}, () =>
  withGlobals(async (globals) => {
    const runtime = await runtimeConfig(globals)
    const existed = await mutateCredentials((credentials) => {
      const hadCredential = Object.hasOwn(credentials, runtime.apiOrigin)
      delete credentials[runtime.apiOrigin]
      return hadCredential
    }, runtime.paths)
    printValue({ ok: true, origin: runtime.apiOrigin, removed: existed }, runtime)
  }),
).pipe(Command.withDescription('Remove the API key for the configured origin'))

const authCommand = Command.make('auth').pipe(
  Command.withDescription('Manage authentication'),
  Command.withSubcommands([authLogin, authSet, authLogout]),
)

const whoamiCommand = Command.make('whoami', {}, () =>
  withGlobals(async (globals) => {
    const runtime = await runtimeConfig(globals)
    if (!runtime.apiKey) {
      throw new CliError('not authenticated; run dossier auth set <key>', ExitCode.Auth)
    }
    const me = await dossierJson<JsonObject>('/api/me', {
      apiUrl: runtime.apiUrl,
      apiKey: runtime.apiKey,
    })
    printValue(me, runtime)
  }),
).pipe(Command.withDescription('Show the current account and workspace'))

const uploadCommand = Command.make(
  'upload',
  {
    parent: Options.text('parent').pipe(Options.optional),
    kind: Options.text('kind').pipe(Options.optional),
    visibility: Options.choice('visibility', ['public', 'team', 'private', 'inherit']).pipe(
      Options.optional,
    ),
    share: Options.text('share').pipe(Options.optional),
    description: Options.text('description').pipe(Options.optional),
    newDocument: Options.boolean('new'),
    document: Options.text('doc').pipe(Options.optional),
    file: Args.text({ name: 'file' }),
  },
  ({ file }) =>
    withGlobals(async () => {
      await validateUpload(file)
      notImplemented()
    }),
).pipe(Command.withDescription('Validate and upload an HTML document'))

const fetchCommand = Command.make(
  'fetch',
  {
    version: Options.integer('version').pipe(Options.optional),
    output: Options.text('output').pipe(Options.withAlias('o'), Options.optional),
    ref: Args.text({ name: 'ref' }),
  },
  ({ ref }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      parseRef(ref, runtime.apiUrl)
      notImplemented()
    }),
).pipe(Command.withDescription('Fetch a document'))

const listCommand = Command.make(
  'list',
  {
    all: Options.boolean('all'),
    tree: Options.boolean('tree'),
    parent: Options.text('parent').pipe(Options.optional),
  },
  () => withGlobals(async () => notImplemented()),
).pipe(Command.withDescription('List documents'))

const dossierCommand = rootCommand.pipe(
  Command.withSubcommands([authCommand, whoamiCommand, uploadCommand, fetchCommand, listCommand]),
)

const healthCommand = Command.make('health', globalOptions, (globals) =>
  Effect.tryPromise({
    try: async () => {
      const runtime = await runtimeConfig(globals)
      const health = await fetchHealth(runtime)
      printValue(health, runtime)
    },
    catch: asCliError,
  }),
)

interface NormalizedArguments {
  readonly args: string[]
  readonly json: boolean
  readonly health: boolean
}

function optionsBeforeArguments(command: readonly string[]): string[] {
  const [name, ...argumentsAndOptions] = command
  if (name !== 'upload' && name !== 'fetch') return [...command]

  const valued = new Set(
    name === 'upload'
      ? ['--parent', '--kind', '--visibility', '--share', '--description', '--doc']
      : ['--version', '--output', '-o'],
  )
  const boolean = new Set(name === 'upload' ? ['--new'] : [])
  const options: string[] = []
  const arguments_: string[] = []

  for (let index = 0; index < argumentsAndOptions.length; index += 1) {
    const argument = argumentsAndOptions[index]!
    const equalsName = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument
    if (valued.has(equalsName)) {
      options.push(argument)
      if (!argument.includes('=') && index + 1 < argumentsAndOptions.length) {
        options.push(argumentsAndOptions[++index]!)
      }
    } else if (boolean.has(argument)) {
      options.push(argument)
    } else {
      arguments_.push(argument)
    }
  }

  return [name, ...options, ...arguments_]
}

export function normalizeGlobalOptions(argv: readonly string[]): NormalizedArguments {
  const prefix = argv.slice(0, 2)
  const rest = argv.slice(2)
  const globals: string[] = []
  const command: string[] = []
  let json = false

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!
    if (argument === '--api-url') {
      globals.push(argument)
      if (index + 1 < rest.length) globals.push(rest[++index]!)
      continue
    }
    if (argument.startsWith('--api-url=')) {
      globals.push(argument)
      continue
    }
    if (argument === '--json') {
      globals.push(argument)
      json = true
      continue
    }
    if (argument === '--quiet' || argument === '-q') {
      globals.push(argument)
      continue
    }
    command.push(argument)
  }

  const orderedCommand = optionsBeforeArguments(command)
  return {
    args: [...prefix, ...globals, ...orderedCommand],
    json,
    health: orderedCommand[0] === 'health',
  }
}

function prefixedCliConsole(base: EffectConsole.Console): EffectConsole.Console {
  return {
    ...base,
    error: (...args: ReadonlyArray<unknown>) =>
      Effect.sync(() => {
        process.stderr.write(`dossier: ${args.map(String).join(' ')}\n`)
      }),
  }
}

export async function runCli(argv: readonly string[] = process.argv): Promise<ExitCode> {
  const normalized = normalizeGlobalOptions(argv)
  const runner = normalized.health
    ? Command.run(healthCommand, { name: 'dossier', version: VERSION })([
        ...normalized.args.slice(0, 2),
        ...normalized.args.slice(2).filter((argument) => argument !== 'health'),
      ])
    : Command.run(dossierCommand, { name: 'dossier', version: VERSION })(normalized.args)

  const program = EffectConsole.consoleWith((base) =>
    runner.pipe(
      Effect.as(ExitCode.Ok),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          const code = ValidationError.isValidationError(error)
            ? ExitCode.Usage
            : exitCodeFor(error)
          if (!ValidationError.isValidationError(error)) {
            const cliError = asCliError(error)
            process.stderr.write(`dossier: ${cliError.message}\n`)
            if (normalized.json) {
              process.stdout.write(
                `${JSON.stringify({ ok: false, error: cliError.message, exitCode: code })}\n`,
              )
            }
          } else if (normalized.json) {
            process.stdout.write(
              `${JSON.stringify({ ok: false, error: 'invalid command usage', exitCode: code })}\n`,
            )
          }
          return code
        }),
      ),
      EffectConsole.withConsole(prefixedCliConsole(base)),
    ),
  ).pipe(Effect.provide(NodeContext.layer))

  return Effect.runPromise(program)
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runCli().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`dossier: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = ExitCode.Failure
    },
  )
}
