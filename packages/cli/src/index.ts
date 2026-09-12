#!/usr/bin/env node

import { Args, Command, Options, ValidationError } from '@effect/cli'
import {
  DossierApi,
  type DocumentEditor,
  type HealthzResponse,
  type Me,
  type UploadRequest,
  type UploadResponse,
} from '@dossier/contracts'
import { validateHtmlStatic } from '@dossier/policy'
import {
  FetchHttpClient,
  HttpApiClient,
  HttpClient,
  HttpClientRequest,
} from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Console as EffectConsole, Effect, Either, Layer, Option } from 'effect'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { CliError, ExitCode, exitCodeFor } from './lib/errors.js'
import { dossierFetch, normalizeApiUrl } from './lib/http.js'
import { parseRef } from './lib/ref.js'
import {
  mutateCredentials,
  mutateDocuments,
  readConfig,
  readCredentials,
  readDocuments,
  statePaths,
  writeConfig,
  type DocumentMapping,
  type StatePaths,
} from './lib/state.js'

const VERSION = '0.0.0'
const DEFAULT_API_URL = 'https://dossier.agent964.com'
const FetchClientLive = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, { redirect: 'manual' }),
)

type GlobalOptions = {
  readonly apiUrl: Option.Option<string>
  readonly json: boolean
  readonly quiet: boolean
}

interface RuntimeConfig {
  readonly apiUrl: string
  readonly apiOrigin: string
  readonly apiKey?: string
  readonly json: boolean
  readonly quiet: boolean
  readonly paths: StatePaths
}

function apiOrigin(apiUrl: string): string {
  return normalizeApiUrl(apiUrl).origin
}

async function runtimeConfig(globals: GlobalOptions): Promise<RuntimeConfig> {
  const paths = statePaths()
  const config = await readConfig(paths)
  const explicitApiUrl = Option.getOrUndefined(globals.apiUrl)
  const apiUrl =
    explicitApiUrl ??
    process.env.DOSSIER_API_URL ??
    config.apiUrl ??
    DEFAULT_API_URL
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

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function printValue(
  value: unknown,
  runtime: Pick<RuntimeConfig, 'json' | 'quiet'>,
): void {
  if (runtime.json) {
    printJson(value)
    return
  }
  if (runtime.quiet) return
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function objectValue(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined
}

function errorStatus(error: unknown): number | undefined {
  const direct = objectValue(error, 'status')
  if (typeof direct === 'number') return direct
  const response = objectValue(error, 'response')
  const nested = objectValue(response, 'status')
  if (typeof nested === 'number') return nested
  return undefined
}

function errorCode(error: unknown): string | undefined {
  const code = objectValue(error, 'code')
  if (typeof code === 'string') return code
  if (error instanceof CliError) return errorCode(error.details)
  return undefined
}

function errorMessage(error: unknown): string {
  const message = objectValue(error, 'message')
  if (typeof message === 'string' && message.trim() !== '') return message
  const code = errorCode(error)
  if (code) return code.replaceAll('_', ' ')
  return error instanceof Error ? error.message : String(error)
}

function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error
  const status = errorStatus(error)
  const auth = status === 401 || errorCode(error) === 'unauthenticated'
  return new CliError(
    status !== undefined && status >= 300 && status < 400
      ? 'redirects are not allowed'
      : errorMessage(error),
    auth ? ExitCode.Auth : ExitCode.Failure,
    error,
  )
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

async function readUpload(
  file: string,
): Promise<{ absolutePath: string; html: string }> {
  const absolutePath = resolve(file)
  let html: string
  try {
    html = await readFile(absolutePath, 'utf8')
  } catch (error) {
    throw new CliError(
      `cannot read ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const result = validateHtmlStatic(html)
  if (!result.ok) {
    throw new CliError(
      `upload policy rejected ${absolutePath}: ${result.errors[0] ?? 'document did not pass static policy'}`,
    )
  }
  return { absolutePath, html }
}

async function createApiClient(
  runtime: RuntimeConfig,
  apiKey = runtime.apiKey,
) {
  return Effect.runPromise(
    HttpApiClient.make(DossierApi, {
      baseUrl: runtime.apiUrl,
      transformClient: (client) =>
        client.pipe(
          HttpClient.mapRequest((request) => {
            const identified = HttpClientRequest.setHeader(
              request,
              'user-agent',
              `dossier/${VERSION}`,
            )
            return apiKey
              ? HttpClientRequest.bearerToken(identified, apiKey)
              : identified
          }),
          HttpClient.transformResponse((responseEffect) =>
            Effect.map(responseEffect, (response) =>
              // Uploads create with 201, while the shared phase-one contract has one
              // success decoder at 200. Normalize only for decoding; the caller
              // knows create vs update from whether it supplied a document ID.
              response.status === 201
                ? new Proxy(response, {
                    get(target, property) {
                      return property === 'status'
                        ? 200
                        : Reflect.get(target, property, target)
                    },
                  })
                : response,
            ),
          ),
        ),
    }).pipe(Effect.provide(FetchClientLive)),
  )
}

type ApiClient = Awaited<ReturnType<typeof createApiClient>>

async function apiCall<A, E>(
  runtime: RuntimeConfig,
  operation: (client: ApiClient) => Effect.Effect<A, E>,
  apiKey = runtime.apiKey,
): Promise<A> {
  try {
    const client = await createApiClient(runtime, apiKey)
    const outcome = await Effect.runPromise(
      operation(client).pipe(Effect.timeout('30 seconds'), Effect.either),
    )
    if (Either.isLeft(outcome)) throw asCliError(outcome.left)
    return outcome.right
  } catch (error) {
    throw asCliError(error)
  }
}

async function requireMe(
  runtime: RuntimeConfig,
  apiKey = runtime.apiKey,
): Promise<Me> {
  if (!apiKey) {
    throw new CliError(
      'not authenticated; run dossier auth login or auth set <key>',
      ExitCode.Auth,
    )
  }
  return apiCall(runtime, (client) => client.me.get(), apiKey)
}

function parseDocumentId(value: string, runtime: RuntimeConfig): string {
  const parsed = parseRef(value, runtime.apiUrl)
  if (parsed.version !== undefined) {
    throw new CliError(
      'a document mutation cannot target a pinned version',
      ExitCode.Usage,
    )
  }
  return parsed.id
}

function git(args: readonly string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function collectMetadata(cwd: string): NonNullable<UploadRequest['metadata']> {
  const status = git(['status', '--porcelain'], cwd)
  const githubServer = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const githubRepo = process.env.GITHUB_REPOSITORY
  const githubRun = process.env.GITHUB_RUN_ID
  return {
    userAgent: `dossier/${VERSION}`,
    cliVersion: VERSION,
    gitBranch: git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    gitCommitSha: git(['rev-parse', 'HEAD'], cwd),
    gitCommitSubject: git(['log', '-1', '--format=%s'], cwd),
    gitDirty: status === null ? null : status.length > 0,
    ciRunUrl:
      process.env.GITHUB_ACTIONS === 'true' && githubRepo && githubRun
        ? `${githubServer}/${githubRepo}/actions/runs/${githubRun}`
        : null,
    ciActor: process.env.GITHUB_ACTOR ?? null,
  }
}

function isRetryable(error: unknown): boolean {
  const candidate = error instanceof CliError ? error.details : error
  const status = errorStatus(candidate)
  if (status !== undefined) return status >= 500
  const tag = objectValue(candidate, '_tag')
  return (
    tag === 'RequestError' ||
    tag === 'ResponseError' ||
    tag === 'TimeoutException'
  )
}

async function publishWithRetry(
  runtime: RuntimeConfig,
  payload: UploadRequest,
): Promise<UploadResponse> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await apiCall(runtime, (client) =>
        client.uploads.publish({ payload }),
      )
    } catch (error) {
      lastError = error
      if (attempt > 0 || !isRetryable(error)) throw error
    }
  }
  throw lastError
}

function configuredVisibility(document: DocumentEditor): string {
  return document.visibility === null
    ? `${document.effectiveVisibility} (inherited)`
    : document.visibility
}

function printDocumentMutation(
  action: string,
  document: DocumentEditor,
  runtime: RuntimeConfig,
): void {
  if (runtime.json) {
    printJson(document)
    return
  }
  if (runtime.quiet) return
  process.stdout.write(`${action}\nURL: ${document.url}\nID: ${document.id}\n`)
}

const globalOptions = {
  apiUrl: Options.text('api-url').pipe(
    Options.optional,
    Options.withDescription('Dossier API base URL'),
  ),
  json: Options.boolean('json').pipe(
    Options.withDescription('Print one JSON value on stdout'),
  ),
  quiet: Options.boolean('quiet').pipe(
    Options.withAlias('q'),
    Options.withDescription('Print only the document URL when applicable'),
  ),
}

const rootCommand = Command.make('dossier', globalOptions).pipe(
  Command.withDescription('Publish and retrieve dossier documents'),
)

const authLogin = Command.make('login', {}, () =>
  withGlobals(async (globals) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new CliError(
        'auth login requires an interactive TTY',
        ExitCode.Usage,
      )
    }
    const runtime = await runtimeConfig(globals)
    if (runtime.json || runtime.quiet) {
      throw new CliError(
        'auth login does not support --json or --quiet',
        ExitCode.Usage,
      )
    }
    process.stdout.write(
      `Open this in your browser (any device):\n\n  ${runtime.apiUrl}/cli/auth\n\nSign in, generate a key, then paste it below.\n\n`,
    )
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    let apiKey = ''
    try {
      apiKey = (
        await Promise.race([
          readline.question('Paste your API key: '),
          once(readline, 'close').then(() => ''),
        ])
      ).trim()
    } finally {
      readline.close()
    }
    if (!apiKey)
      throw new CliError('no key entered; nothing saved', ExitCode.Usage)

    let me: Me
    try {
      me = await requireMe(runtime, apiKey)
    } catch (error) {
      const cliError = asCliError(error)
      throw new CliError(
        'that key was rejected; nothing saved',
        cliError.exitCode,
        error,
      )
    }
    await mutateCredentials((credentials) => {
      credentials[runtime.apiOrigin] = apiKey
    }, runtime.paths)
    if (Option.isSome(globals.apiUrl)) {
      await writeConfig({ apiUrl: runtime.apiOrigin }, runtime.paths)
    }
    process.stdout.write(
      `\nLogged in as ${me.accountName} in ${me.workspace.slug} (${me.workspace.role ?? 'no role'}).\n`,
    )
  }),
).pipe(
  Command.withDescription(
    'Sign in through a browser and paste a generated key',
  ),
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
    printValue(
      { ok: true, origin: runtime.apiOrigin, removed: existed },
      runtime,
    )
  }),
).pipe(Command.withDescription('Remove the API key for the configured origin'))

const authCommand = Command.make('auth').pipe(
  Command.withDescription('Manage authentication'),
  Command.withSubcommands([authLogin, authSet, authLogout]),
)

const whoamiCommand = Command.make('whoami', {}, () =>
  withGlobals(async (globals) => {
    const runtime = await runtimeConfig(globals)
    const me = await requireMe(runtime)
    if (runtime.json) {
      printJson(me)
    } else if (!runtime.quiet) {
      process.stdout.write(
        `Account: ${me.accountName} (${me.accountId})\nWorkspace: ${me.workspace.slug} (${me.workspace.id})\nRole: ${me.workspace.role ?? 'none'}\nAPI key: ${me.apiKeyName ?? 'none'}${me.apiKeyId ? ` (${me.apiKeyId})` : ''}\n`,
      )
    }
  }),
).pipe(Command.withDescription('Show the current account, workspace, and role'))

const uploadCommand = Command.make(
  'upload',
  {
    parent: Options.text('parent').pipe(Options.optional),
    kind: Options.text('kind').pipe(Options.optional),
    visibility: Options.choice('visibility', [
      'public',
      'team',
      'private',
      'inherit',
    ]).pipe(Options.optional),
    share: Options.text('share').pipe(Options.optional),
    description: Options.text('description').pipe(Options.optional),
    newDocument: Options.boolean('new'),
    document: Options.text('doc').pipe(Options.optional),
    file: Args.text({ name: 'file' }),
  },
  ({
    file,
    parent,
    kind,
    visibility,
    share,
    description,
    newDocument,
    document,
  }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      if (newDocument && Option.isSome(document)) {
        throw new CliError(
          '--new and --doc cannot be used together',
          ExitCode.Usage,
        )
      }
      const { absolutePath, html } = await readUpload(file)
      const me = await requireMe(runtime)
      const documents = await readDocuments(runtime.paths)
      const known = documents[runtime.apiOrigin]?.[me.accountId]?.[absolutePath]
      const explicitDocument = Option.getOrUndefined(document)
      const mappedDocument =
        known && typeof known.documentId === 'string'
          ? known.documentId
          : undefined
      const target = newDocument
        ? undefined
        : explicitDocument
          ? parseDocumentId(explicitDocument, runtime)
          : mappedDocument
      const parentValue = Option.getOrUndefined(parent)
      const visibilityValue = Option.getOrUndefined(visibility)
      const shareValue = Option.getOrUndefined(share)
      const payload: UploadRequest = {
        html,
        filename: basename(absolutePath),
        idempotencyKey: randomUUID(),
        metadata: collectMetadata(dirname(absolutePath)),
        ...(target ? { documentId: target } : {}),
        ...(parentValue
          ? {
              parentId:
                parentValue === 'root'
                  ? null
                  : parseDocumentId(parentValue, runtime),
            }
          : {}),
        ...(Option.isSome(kind) ? { kind: Option.getOrUndefined(kind)! } : {}),
        ...(visibilityValue
          ? {
              visibility:
                visibilityValue === 'inherit' ? null : visibilityValue,
            }
          : {}),
        ...(Option.isSome(description)
          ? { description: Option.getOrUndefined(description)! }
          : {}),
        ...(shareValue
          ? {
              shares: shareValue
                .split(',')
                .map((email) => email.trim())
                .filter(Boolean),
            }
          : {}),
      }

      let receipt: UploadResponse
      try {
        receipt = await publishWithRetry(runtime, payload)
      } catch (error) {
        if (
          !explicitDocument &&
          mappedDocument &&
          errorCode(error) === 'not_found'
        ) {
          throw new CliError(
            `saved mapping for ${absolutePath} is stale; retry with --new to create a new document`,
          )
        }
        throw error
      }
      const created = target === undefined
      const mapping: DocumentMapping = {
        documentId: receipt.document.id,
        url: receipt.document.url,
        rawUrl: receipt.document.rawUrl,
        updatedAt: new Date().toISOString(),
      }
      await mutateDocuments((state) => {
        const byOrigin = (state[runtime.apiOrigin] ??= {})
        const byAccount = (byOrigin[me.accountId] ??= {})
        byAccount[absolutePath] = mapping
      }, runtime.paths)

      if (runtime.json) {
        printJson({
          ...receipt.document,
          versionNumber: receipt.versionNumber,
          created,
          warnings: receipt.warnings,
        })
        return
      }
      if (runtime.quiet) {
        process.stdout.write(`${receipt.document.url}\n`)
        return
      }
      process.stdout.write(
        `${created ? 'Created' : 'Updated'}\nURL: ${receipt.document.url}\nRaw: ${receipt.document.rawUrl}\nHub: ${receipt.document.hubUrl}\nID: ${receipt.document.id}\nVersion: ${receipt.versionNumber}\nVisibility: ${configuredVisibility(receipt.document)}\n`,
      )
      for (const warning of receipt.warnings)
        process.stderr.write(`Warning: ${warning}\n`)
    }),
).pipe(Command.withDescription('Validate and upload an HTML document'))

const fetchCommand = Command.make(
  'fetch',
  {
    version: Options.integer('version').pipe(Options.optional),
    output: Options.text('output').pipe(
      Options.withAlias('o'),
      Options.optional,
    ),
    ref: Args.text({ name: 'ref' }),
  },
  ({ ref, version, output }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const parsed = parseRef(ref, runtime.apiUrl)
      const requestedVersion = Option.getOrUndefined(version)
      if (requestedVersion !== undefined && requestedVersion < 1) {
        throw new CliError(
          '--version must be a positive integer',
          ExitCode.Usage,
        )
      }
      if (
        parsed.version !== undefined &&
        requestedVersion !== undefined &&
        parsed.version !== requestedVersion
      ) {
        throw new CliError(
          'reference version conflicts with --version',
          ExitCode.Usage,
        )
      }
      const selectedVersion = requestedVersion ?? parsed.version
      const path = selectedVersion
        ? `/d/${parsed.id}/v/${selectedVersion}/raw`
        : `/d/${parsed.id}/raw`
      let response: Response
      try {
        response = await dossierFetch(path, {
          apiUrl: runtime.apiUrl,
          apiKey: runtime.apiKey,
          accept: 'text/html',
        })
      } catch (error) {
        if (
          errorStatus(error instanceof CliError ? error.details : error) === 404
        ) {
          throw new CliError('not found or not readable with the current key')
        }
        throw error
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      const outputPath = Option.getOrUndefined(output)
      if (outputPath) {
        await writeFile(resolve(outputPath), bytes)
        if (!runtime.quiet && !runtime.json) {
          process.stdout.write(
            `Saved ${bytes.byteLength} bytes to ${resolve(outputPath)}\n`,
          )
        } else if (runtime.json) {
          printJson({
            ok: true,
            file: resolve(outputPath),
            bytes: bytes.byteLength,
          })
        }
      } else if (runtime.json) {
        printJson({
          ok: true,
          documentId: parsed.id,
          version: selectedVersion ?? null,
          bytes: bytes.byteLength,
          contentBase64: Buffer.from(bytes).toString('base64'),
        })
      } else {
        process.stdout.write(bytes)
      }
    }),
).pipe(Command.withDescription('Fetch a document without changing its bytes'))

const listCommand = Command.make(
  'list',
  { trash: Options.boolean('trash') },
  ({ trash }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      await requireMe(runtime)
      const documents: DocumentEditor[] = []
      let cursor: string | undefined
      do {
        const page = await apiCall(runtime, (client) =>
          client.documents.list({
            urlParams: {
              scope: trash ? 'trash' : 'mine',
              ...(cursor === undefined ? {} : { cursor }),
            },
          }),
        )
        documents.push(...page.documents)
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
      if (runtime.json) {
        printJson(documents)
        return
      }
      if (runtime.quiet) return
      if (documents.length === 0) {
        process.stdout.write(
          trash ? 'Trash is empty.\n' : 'No documents yet.\n',
        )
        return
      }
      for (const document of documents) {
        process.stdout.write(
          `${document.title}\n  ${document.id} · v${document.latestVersionNumber} · ${configuredVisibility(document)}${document.disabled ? ' · disabled' : ''}\n  ${document.url}\n${document.description ? `  ${document.description}\n` : ''}\n`,
        )
      }
    }),
).pipe(Command.withDescription('List your documents or trash'))

const deleteCommand = Command.make(
  'delete',
  { force: Options.boolean('force'), ref: Args.text({ name: 'id' }) },
  ({ force, ref }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const id = parseDocumentId(ref, runtime)
      const result = await apiCall(runtime, (client) =>
        client.documents.delete({
          path: { id },
          urlParams: force ? { force: '1' } : {},
        }),
      )
      if (runtime.json) printJson(result)
      else if (!runtime.quiet) {
        process.stdout.write(
          `Deleted ${result.deleted} document${result.deleted === 1 ? '' : 's'}\nBatch: ${result.batchId}\n`,
        )
      }
    }),
).pipe(Command.withDescription('Archive a document without prompting'))

const restoreCommand = Command.make(
  'restore',
  {
    batch: Options.text('batch').pipe(Options.optional),
    ref: Args.text({ name: 'id' }),
  },
  ({ batch, ref }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const id = parseDocumentId(ref, runtime)
      let batchId = Option.getOrUndefined(batch)
      if (!batchId) {
        const detail = await apiCall(runtime, (client) =>
          client.documents.get({ path: { id } }),
        )
        batchId = detail.document.deletionBatchId ?? undefined
      }
      if (!batchId) {
        throw new CliError(`document ${id} has no restorable deletion batch`)
      }
      const result = await apiCall(runtime, (client) =>
        client.documents.restore({ path: { id }, payload: { batchId } }),
      )
      printDocumentMutation('Restored', result.document, runtime)
    }),
).pipe(Command.withDescription('Restore an archived document'))

const disableCommand = Command.make(
  'disable',
  { ref: Args.text({ name: 'id' }) },
  ({ ref }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const id = parseDocumentId(ref, runtime)
      const result = await apiCall(runtime, (client) =>
        client.documents.disable({ path: { id }, payload: {} }),
      )
      printDocumentMutation('Disabled', result.document, runtime)
    }),
).pipe(Command.withDescription('Disable document serving'))

const enableCommand = Command.make(
  'enable',
  { ref: Args.text({ name: 'id' }) },
  ({ ref }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const id = parseDocumentId(ref, runtime)
      const result = await apiCall(runtime, (client) =>
        client.documents.enable({ path: { id } }),
      )
      printDocumentMutation('Enabled', result.document, runtime)
    }),
).pipe(Command.withDescription('Enable document serving'))

const dossierCommand = rootCommand.pipe(
  Command.withSubcommands([
    authCommand,
    whoamiCommand,
    uploadCommand,
    fetchCommand,
    listCommand,
    deleteCommand,
    restoreCommand,
    disableCommand,
    enableCommand,
  ]),
)

const healthCommand = Command.make('health', globalOptions, (globals) =>
  Effect.tryPromise({
    try: async () => {
      const runtime = await runtimeConfig(globals)
      const health: HealthzResponse = await apiCall(runtime, (client) =>
        client.system.healthz(),
      )
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
  const valuedByCommand: Record<string, ReadonlySet<string>> = {
    upload: new Set([
      '--parent',
      '--kind',
      '--visibility',
      '--share',
      '--description',
      '--doc',
    ]),
    fetch: new Set(['--version', '--output', '-o']),
    restore: new Set(['--batch']),
  }
  const booleanByCommand: Record<string, ReadonlySet<string>> = {
    upload: new Set(['--new']),
    delete: new Set(['--force']),
  }
  const valued = valuedByCommand[name ?? '']
  const boolean = booleanByCommand[name ?? '']
  if (!valued && !boolean) return [...command]

  const options: string[] = []
  const arguments_: string[] = []
  for (let index = 0; index < argumentsAndOptions.length; index += 1) {
    const argument = argumentsAndOptions[index]!
    const equalsName = argument.includes('=')
      ? argument.slice(0, argument.indexOf('='))
      : argument
    if (valued?.has(equalsName)) {
      options.push(argument)
      if (!argument.includes('=') && index + 1 < argumentsAndOptions.length) {
        options.push(argumentsAndOptions[++index]!)
      }
    } else if (boolean?.has(argument)) {
      options.push(argument)
    } else {
      arguments_.push(argument)
    }
  }
  return [name!, ...options, ...arguments_]
}

export function normalizeGlobalOptions(
  argv: readonly string[],
): NormalizedArguments {
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

function prefixedCliConsole(
  base: EffectConsole.Console,
): EffectConsole.Console {
  return {
    ...base,
    error: (...args: ReadonlyArray<unknown>) =>
      Effect.sync(() => {
        process.stderr.write(`dossier: ${args.map(String).join(' ')}\n`)
      }),
  }
}

export async function runCli(
  argv: readonly string[] = process.argv,
): Promise<ExitCode> {
  const normalized = normalizeGlobalOptions(argv)
  const runner = normalized.health
    ? Command.run(healthCommand, { name: 'dossier', version: VERSION })([
        ...normalized.args.slice(0, 2),
        ...normalized.args.slice(2).filter((argument) => argument !== 'health'),
      ])
    : Command.run(dossierCommand, { name: 'dossier', version: VERSION })(
        normalized.args,
      )

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
              printJson({ ok: false, error: cliError.message, exitCode: code })
            }
          } else if (normalized.json) {
            printJson({
              ok: false,
              error: 'invalid command usage',
              exitCode: code,
            })
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
      process.stderr.write(
        `dossier: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = ExitCode.Failure
    },
  )
}
