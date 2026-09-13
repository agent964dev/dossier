#!/usr/bin/env node

import { Args, Command, Options, ValidationError } from '@effect/cli'
import {
  AssetDeleteResponse,
  AssetExtension,
  AssetListResponse,
  AssetPushRequest,
  AssetPushResponse,
  DiffResponse as DiffResponseSchema,
  DossierApi,
  isDocumentEditor,
  type DiffResponse as DiffResponseType,
  type DocumentEditor,
  type DocumentListScope,
  type DocumentView,
  type HealthzResponse,
  type Me,
  type UploadRequest,
  type UploadResponse,
} from '@dossier/contracts'
import { validateCssStatic, validateHtmlStatic } from '@dossier/policy'
import {
  FetchHttpClient,
  HttpApiClient,
  HttpClient,
  HttpClientRequest,
} from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import {
  Console as EffectConsole,
  Effect,
  Either,
  Layer,
  Option,
  Schema,
} from 'effect'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { CliError, ExitCode, exitCodeFor } from './lib/errors.js'
import { formatUnifiedDiff } from './lib/diff.js'
import { dossierFetch, dossierJson, normalizeApiUrl } from './lib/http.js'
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

const VERSION = '0.1.0'
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
  const explicitApiUrl = Option.getOrUndefined(globals.apiUrl)
  const environmentApiUrl = process.env.DOSSIER_API_URL?.trim() || undefined
  const configuredApiUrl =
    explicitApiUrl === undefined && environmentApiUrl === undefined
      ? (await readConfig(paths)).apiUrl
      : undefined
  const origin = apiOrigin(
    explicitApiUrl ?? environmentApiUrl ?? configuredApiUrl ?? DEFAULT_API_URL,
  )
  const environmentApiKey = process.env.DOSSIER_API_KEY?.trim() || undefined
  let storedKey: string | undefined
  if (environmentApiKey === undefined) {
    const credentials = await readCredentials(paths)
    storedKey = credentials[origin]
    if (storedKey !== undefined && typeof storedKey !== 'string') {
      throw new CliError(
        `cannot read ${paths.credentials}: credential for ${origin} must be a string; repair or remove the file`,
      )
    }
  }
  return {
    apiUrl: origin,
    apiOrigin: origin,
    apiKey: environmentApiKey ?? storedKey,
    json: globals.json,
    quiet: globals.quiet,
    paths,
  }
}

function printJson(value: unknown): void {
  // JSON.stringify escapes C0; also escape DEL/C1 to neutralize terminal controls.
  const json = JSON.stringify(value)?.replace(/[\u007f-\u009f]/g, (control) =>
    `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
  process.stdout.write(`${json}\n`)
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
  publicOrigin: string,
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

  const result = validateHtmlStatic(html, { publicOrigin })
  if (!result.ok) {
    throw new CliError(
      formatPolicyRejection(
        absolutePath,
        result.errors,
        'Document did not pass the static policy.',
      ),
    )
  }
  return { absolutePath, html }
}

function formatPolicyRejection(
  absolutePath: string,
  errors: readonly string[],
  fallback: string,
): string {
  const reasons = errors.length > 0 ? errors : [fallback]
  return `policy rejected ${absolutePath}\n${reasons
    .map((reason) => `  - ${reason}`)
    .join('\n')}`
}

interface AssetFile {
  readonly absolutePath: string
  readonly ext: AssetExtension
  readonly bytes: Buffer
}

async function readAssetFile(
  file: string,
  publicOrigin: string,
): Promise<AssetFile> {
  const absolutePath = resolve(file)
  const extension = extname(absolutePath).toLowerCase()
  if (extension !== '.css' && extension !== '.woff2') {
    throw new CliError(
      `unsupported asset extension ${extension || '(none)'}; expected .css or .woff2`,
      ExitCode.Usage,
    )
  }

  let bytes: Buffer
  try {
    bytes = await readFile(absolutePath)
  } catch (error) {
    throw new CliError(
      `cannot read ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const ext: AssetExtension = extension.slice(1) as AssetExtension
  if (ext === 'css') {
    let css: string
    try {
      css = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new CliError(
        formatPolicyRejection(absolutePath, [], 'CSS must be valid UTF-8.'),
      )
    }
    const result = validateCssStatic(css, { publicOrigin })
    if (!result.ok) {
      throw new CliError(
        formatPolicyRejection(
          absolutePath,
          result.errors,
          'Stylesheet did not pass the static policy.',
        ),
      )
    }
  }

  return { absolutePath, ext, bytes }
}

function suggestedAssetSlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return normalized || 'shared-asset'
}

function validateAssetSlug(
  slug: string,
  source: 'explicit' | 'filename' = 'explicit',
): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    if (source === 'filename') {
      throw new CliError(
        `slug ${JSON.stringify(slug)} derived from the filename is not valid (lowercase letters, digits, and hyphens only); pass --slug ${suggestedAssetSlug(slug)}`,
        ExitCode.Usage,
      )
    }
    throw new CliError(
      `asset slug ${JSON.stringify(slug)} must start with a lowercase letter or digit and contain only lowercase letters, digits, or hyphens (maximum 64 characters)`,
      ExitCode.Usage,
    )
  }
  return slug
}

function assetUpdatedDate(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf())
    ? value
    : parsed.toISOString().slice(0, 10)
}

function invalidAssetResponse(kind: string, error: unknown): CliError {
  return new CliError(
    `server returned an invalid ${kind} response`,
    ExitCode.Failure,
    error,
  )
}

function decodeAssetPushResponse(value: unknown): AssetPushResponse {
  try {
    return Schema.decodeUnknownSync(AssetPushResponse, {
      onExcessProperty: 'error',
    })(value)
  } catch (error) {
    throw invalidAssetResponse('asset push', error)
  }
}

function decodeAssetListResponse(value: unknown): AssetListResponse {
  try {
    return Schema.decodeUnknownSync(AssetListResponse, {
      onExcessProperty: 'error',
    })(value)
  } catch (error) {
    throw invalidAssetResponse('asset list', error)
  }
}

function decodeAssetDeleteResponse(value: unknown): AssetDeleteResponse {
  try {
    return Schema.decodeUnknownSync(AssetDeleteResponse, {
      onExcessProperty: 'error',
    })(value)
  } catch (error) {
    throw invalidAssetResponse('asset delete', error)
  }
}

async function pushAsset(
  runtime: RuntimeConfig,
  payload: AssetPushRequest,
): Promise<AssetPushResponse> {
  const checkedPayload = Schema.decodeUnknownSync(AssetPushRequest, {
    onExcessProperty: 'error',
  })(payload)
  const response = await dossierJson<unknown>(
    '/api/assets',
    { apiUrl: runtime.apiUrl, apiKey: runtime.apiKey },
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(checkedPayload),
    },
  )
  return decodeAssetPushResponse(response)
}

async function listAssets(runtime: RuntimeConfig): Promise<AssetListResponse> {
  const response = await dossierJson<unknown>('/api/assets', {
    apiUrl: runtime.apiUrl,
    apiKey: runtime.apiKey,
  })
  return decodeAssetListResponse(response)
}

async function deleteAsset(
  runtime: RuntimeConfig,
  slug: string,
): Promise<AssetDeleteResponse> {
  const response = await dossierFetch(
    `/api/assets/${encodeURIComponent(slug)}`,
    { apiUrl: runtime.apiUrl, apiKey: runtime.apiKey },
    { method: 'DELETE' },
  )
  if (response.status === 204) return { ok: true }
  try {
    return decodeAssetDeleteResponse(await response.json())
  } catch (error) {
    if (error instanceof CliError) throw error
    throw invalidAssetResponse('asset delete', error)
  }
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
  return parseRef(value, runtime.apiUrl).id
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

function parseEmails(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return value
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean)
}

async function listDocuments(
  runtime: RuntimeConfig,
  scope: DocumentListScope,
  parent?: string | null,
): Promise<DocumentView[]> {
  const documents: DocumentView[] = []
  let cursor: string | undefined
  do {
    const page = await apiCall(runtime, (client) =>
      client.documents.list({
        urlParams: {
          scope,
          ...(parent === undefined
            ? {}
            : { parent: parent === null ? 'root' : parent }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      }),
    )
    documents.push(...page.documents)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return documents
}

type DocumentTreeNode = DocumentView & {
  readonly children: DocumentTreeNode[]
}

function documentForest(
  documents: readonly DocumentView[],
  parent?: string | null,
): DocumentTreeNode[] {
  const nodes = new Map<string, DocumentTreeNode>()
  for (const document of documents) {
    nodes.set(document.id, { ...document, children: [] })
  }
  for (const node of nodes.values()) {
    if (node.parentId !== null) nodes.get(node.parentId)?.children.push(node)
  }
  if (parent !== undefined) {
    return [...nodes.values()].filter((node) => node.parentId === parent)
  }
  return [...nodes.values()].filter(
    (node) => node.parentId === null || !nodes.has(node.parentId),
  )
}

function printTreeNodes(
  nodes: readonly DocumentTreeNode[],
  depth = 0,
): void {
  for (const node of nodes) {
    const indent = '  '.repeat(depth)
    process.stdout.write(
      `${indent}- ${node.title} (${node.id}) · ${node.kind ?? 'document'} · ${node.authorName}\n`,
    )
    printTreeNodes(node.children, depth + 1)
  }
}

function hasChildrenMessage(error: unknown): string | undefined {
  if (errorCode(error) !== 'has_children') return undefined
  const candidate = error instanceof CliError ? error.details : error
  const details = objectValue(candidate, 'details')
  const count = objectValue(details, 'count')
  const authors = objectValue(details, 'authors')
  if (typeof count !== 'number' || !Array.isArray(authors)) {
    return 'this also archives descendant documents; rerun with --force'
  }
  const otherPeople = Math.max(0, authors.length - 1)
  return `this also archives ${count} document${count === 1 ? '' : 's'} by ${otherPeople} other ${otherPeople === 1 ? 'person' : 'people'}; rerun with --force`
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function decodeDiffResponse(value: unknown): DiffResponseType {
  try {
    return Schema.decodeUnknownSync(DiffResponseSchema, {
      onExcessProperty: 'error',
    })(value)
  } catch (error) {
    throw new CliError(
      'server returned an invalid diff response',
      ExitCode.Failure,
      error,
    )
  }
}

interface WorkspaceMember {
  readonly accountId: string
  readonly name: string
  readonly email: string | null
  readonly role: 'admin' | 'member'
  readonly kind?: string
  readonly disabled?: boolean
}

interface WorkspaceAllowlistEntry {
  readonly id: string
  readonly kind: 'email' | 'domain'
  readonly value: string
  readonly role: 'admin' | 'member'
}

interface WorkspaceResponse {
  readonly members: readonly WorkspaceMember[]
  readonly allowlist: readonly WorkspaceAllowlistEntry[]
  readonly [key: string]: unknown
}

function decodeWorkspaceResponse(value: unknown): WorkspaceResponse {
  const candidate = record(value)
  if (!candidate || !Array.isArray(candidate.members) || !Array.isArray(candidate.allowlist)) {
    throw new CliError('server returned an invalid workspace response')
  }
  for (const rawMember of candidate.members) {
    const member = record(rawMember)
    if (
      typeof member?.accountId !== 'string' ||
      typeof member.name !== 'string' ||
      (member.email !== null && typeof member.email !== 'string') ||
      (member.role !== 'admin' && member.role !== 'member')
    ) {
      throw new CliError('server returned an invalid workspace response')
    }
  }
  for (const rawEntry of candidate.allowlist) {
    const entry = record(rawEntry)
    if (
      typeof entry?.id !== 'string' ||
      (entry.kind !== 'email' && entry.kind !== 'domain') ||
      typeof entry.value !== 'string' ||
      (entry.role !== 'admin' && entry.role !== 'member')
    ) {
      throw new CliError('server returned an invalid workspace response')
    }
  }
  return candidate as unknown as WorkspaceResponse
}

function allowlistValue(raw: string): {
  readonly kind: 'email' | 'domain'
  readonly value: string
} {
  const normalized = raw.trim().toLowerCase()
  const kind = normalized.startsWith('@') ? 'domain' : 'email'
  const value = kind === 'domain' ? normalized.slice(1) : normalized
  const domain = kind === 'domain' ? value : value.slice(value.lastIndexOf('@') + 1)
  if (
    normalized.length === 0 ||
    normalized.length > 254 ||
    /\s/.test(normalized) ||
    (kind === 'email' &&
      (normalized.indexOf('@') <= 0 ||
        normalized.indexOf('@') !== normalized.lastIndexOf('@'))) ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
      domain,
    )
  ) {
    throw new CliError(
      'expected one email address or @ followed by a domain',
      ExitCode.Usage,
    )
  }
  return { kind, value }
}

async function workspaceData(runtime: RuntimeConfig): Promise<WorkspaceResponse> {
  return decodeWorkspaceResponse(
    await dossierJson<unknown>('/api/workspace', {
      apiUrl: runtime.apiUrl,
      apiKey: runtime.apiKey,
    }),
  )
}

async function workspaceMutation(
  runtime: RuntimeConfig,
  path: string,
  method: 'POST' | 'DELETE',
  payload?: unknown,
): Promise<Record<string, unknown>> {
  const response = await dossierFetch(
    path,
    { apiUrl: runtime.apiUrl, apiKey: runtime.apiKey },
    {
      method,
      ...(payload === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
    },
  )
  if (response.status === 204) return { ok: true }
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw new CliError('server returned an invalid workspace response')
  }
  const decoded = record(value)
  if (!decoded) throw new CliError('server returned an invalid workspace response')
  return decoded
}

function printWorkspaceMutation(
  result: Record<string, unknown>,
  runtime: RuntimeConfig,
): void {
  if (runtime.json) printJson(result)
  else if (!runtime.quiet) {
    const message = result.message
    printValue(typeof message === 'string' ? message : result, runtime)
  }
}

function printWorkspace(
  workspace: WorkspaceResponse,
  runtime: RuntimeConfig,
  membersOnly = false,
): void {
  if (runtime.json) {
    printJson(membersOnly ? workspace.members : workspace)
    return
  }
  if (runtime.quiet) return
  process.stdout.write('Members:\n')
  if (workspace.members.length === 0) process.stdout.write('  None\n')
  for (const member of workspace.members) {
    process.stdout.write(
      `  ${member.name}${member.email ? ` <${member.email}>` : ''} · ${member.role}${member.disabled ? ' · disabled' : ''}\n`,
    )
  }
  if (membersOnly) return
  process.stdout.write('Allowlist:\n')
  if (workspace.allowlist.length === 0) process.stdout.write('  None\n')
  for (const entry of workspace.allowlist) {
    const value = entry.kind === 'domain' ? `@${entry.value}` : entry.value
    process.stdout.write(`  ${value} · ${entry.role}\n`)
  }
}

function findWorkspaceMember(
  workspace: WorkspaceResponse,
  email: string,
): WorkspaceMember {
  const normalized = email.trim().toLowerCase()
  const member = workspace.members.find(
    (candidate) => candidate.email?.toLowerCase() === normalized,
  )
  if (!member) {
    throw new CliError(`${normalized} is not a member of this workspace`)
  }
  return member
}

function tryOpenBrowser(url: string): boolean {
  const configured = process.env.BROWSER?.trim()
  const command: readonly [string, readonly string[]] = configured
    ? [configured, [url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    execFileSync(command[0], command[1], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
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
    const authUrl = `${runtime.apiUrl}/cli/auth`
    const opened = tryOpenBrowser(authUrl)
    process.stdout.write(
      `${opened ? 'Opened' : 'Open'} this in your browser (any device):\n\n  ${authUrl}\n\nSign in, generate a key, then paste it below.\n\n`,
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
      const { absolutePath, html } = await readUpload(file, runtime.apiUrl)
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
      const requestedParent = parentValue
        ? parentValue === 'root'
          ? null
          : parseDocumentId(parentValue, runtime)
        : undefined
      // Reader DTOs virtualise an unreadable physical parent to `null`, so the
      // client cannot safely compare placement. Forward an explicitly supplied
      // parent unchanged; the upload service compares it with the stored parent
      // and returns the authoritative move hint on a mismatch.
      const uploadParent = requestedParent
      const visibilityValue = Option.getOrUndefined(visibility)
      const shareValue = Option.getOrUndefined(share)
      const payload: UploadRequest = {
        html,
        filename: basename(absolutePath),
        idempotencyKey: randomUUID(),
        metadata: collectMetadata(dirname(absolutePath)),
        ...(target ? { documentId: target } : {}),
        ...(uploadParent !== undefined ? { parentId: uploadParent } : {}),
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
          target &&
          requestedParent !== undefined &&
          errorCode(error) === 'conflict'
        ) {
          throw new CliError(
            `re-upload cannot change parent; use dossier move ${target} --parent ${requestedParent ?? 'root'}`,
          )
        }
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
        `${created ? 'Created' : 'Updated'}\nURL: ${receipt.document.url}\nRaw: ${receipt.document.rawUrl}\nHub: ${receipt.document.hubUrl}\nID: ${receipt.document.id}\nVersion: ${receipt.versionNumber}\nParent: ${receipt.document.parentId ?? 'root'}\nVisibility: ${configuredVisibility(receipt.document)}\n`,
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

const diffCommand = Command.make(
  'diff',
  {
    from: Options.integer('from').pipe(
      Options.optional,
      Options.withDescription('Older version number (default: the version before --to)'),
    ),
    to: Options.integer('to').pipe(
      Options.optional,
      Options.withDescription('Newer version number (default: latest; a pinned id@n reference also sets it)'),
    ),
    text: Options.boolean('text').pipe(
      Options.withDescription('Compare visible text instead of HTML source'),
    ),
    ref: Args.text({ name: 'id' }).pipe(
      Args.withDescription('Document ID, id@n, or dossier URL'),
    ),
  },
  ({ from, to, text, ref }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const parsed = parseRef(ref, runtime.apiUrl)
      const fromVersion = Option.getOrUndefined(from)
      const explicitToVersion = Option.getOrUndefined(to)
      if (fromVersion !== undefined && fromVersion < 1) {
        throw new CliError('--from must be a positive integer', ExitCode.Usage)
      }
      if (explicitToVersion !== undefined && explicitToVersion < 1) {
        throw new CliError('--to must be a positive integer', ExitCode.Usage)
      }
      if (
        parsed.version !== undefined &&
        explicitToVersion !== undefined &&
        parsed.version !== explicitToVersion
      ) {
        throw new CliError(
          'reference version conflicts with --to',
          ExitCode.Usage,
        )
      }
      const toVersion = explicitToVersion ?? parsed.version
      const query = new URLSearchParams()
      if (fromVersion !== undefined) query.set('from', String(fromVersion))
      if (toVersion !== undefined) query.set('to', String(toVersion))
      if (text) query.set('mode', 'text')
      const suffix = query.size === 0 ? '' : `?${query}`

      let response: DiffResponseType
      try {
        response = decodeDiffResponse(
          await dossierJson<unknown>(
            `/api/documents/${parsed.id}/diff${suffix}`,
            { apiUrl: runtime.apiUrl, apiKey: runtime.apiKey },
          ),
        )
      } catch (error) {
        if (errorStatus(error instanceof CliError ? error.details : error) === 413) {
          throw new CliError(
            `diff is too large; fetch both versions with dossier fetch ${parsed.id}@<version> -o <file> and compare them locally`,
            ExitCode.Failure,
            error,
          )
        }
        throw error
      }
      if (response.documentId !== parsed.id) {
        throw new CliError('server returned a diff for the wrong document')
      }
      if (runtime.json) {
        printJson(response)
      } else if (!runtime.quiet) {
        const terminal = Boolean(process.stdout.isTTY)
        process.stdout.write(
          formatUnifiedDiff(
            response,
            terminal && !Object.hasOwn(process.env, 'NO_COLOR'),
            terminal,
          ),
        )
        if (response.hunks.length === 0) {
          process.stderr.write(
            `dossier: v${response.from.versionNumber} and v${response.to.versionNumber} are identical\n`,
          )
        }
      }
    }),
).pipe(
  Command.withDescription(
    'Print a unified diff (defaults to the previous and latest versions)',
  ),
)

const listCommand = Command.make(
  'list',
  {
    all: Options.boolean('all'),
    tree: Options.boolean('tree'),
    parent: Options.text('parent').pipe(Options.optional),
    trash: Options.boolean('trash'),
  },
  ({ all, tree, parent, trash }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      await requireMe(runtime)
      const parentValue = Option.getOrUndefined(parent)
      if (trash && (all || tree || parentValue !== undefined)) {
        throw new CliError(
          '--trash cannot be combined with --all, --tree, or --parent',
          ExitCode.Usage,
        )
      }
      const parentId = parentValue
        ? parentValue === 'root'
          ? null
          : parseDocumentId(parentValue, runtime)
        : undefined
      const scope: DocumentListScope = trash
        ? 'trash'
        : all
          ? 'readable'
          : 'mine'
      if (tree && parentId !== undefined) {
        await listDocuments(runtime, scope, parentId)
      }
      const documents = await listDocuments(
        runtime,
        scope,
        tree ? undefined : parentId,
      )
      if (tree) {
        const forest = documentForest(documents, parentId)
        if (runtime.json) printJson(forest)
        else if (!runtime.quiet) {
          if (forest.length === 0) process.stdout.write('No documents yet.\n')
          else printTreeNodes(forest)
        }
        return
      }
      if (runtime.json) {
        printJson(documents)
        return
      }
      if (runtime.quiet) return
      if (documents.length === 0) {
        process.stdout.write(trash ? 'Trash is empty.\n' : 'No documents yet.\n')
        return
      }
      for (const document of documents) {
        const visibility = isDocumentEditor(document)
          ? configuredVisibility(document)
          : document.effectiveVisibility
        process.stdout.write(
          `${document.title}\n  ${document.id} · v${document.latestVersionNumber} · ${visibility}${document.disabled ? ' · disabled' : ''}\n  ${document.url}\n${document.description ? `  ${document.description}\n` : ''}`,
        )
      }
    }),
).pipe(Command.withDescription('List documents, optionally as a nested tree'))

const treeCommand = Command.make(
  'tree',
  { ref: Args.text({ name: 'id' }) },
  ({ ref }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const id = parseDocumentId(ref, runtime)
      const tree = await apiCall(runtime, (client) =>
        client.documents.tree({ path: { id } }),
      )
      if (runtime.json) {
        printJson(tree)
        return
      }
      if (runtime.quiet) return
      process.stdout.write(
        `Breadcrumb: ${tree.breadcrumb.map((document) => document.title).join(' / ') || '(root)'}\nDocument: ${tree.document.title} (${tree.document.id}) · ${tree.document.kind ?? 'document'} · ${tree.document.authorName}\n`,
      )
      process.stdout.write('Siblings:\n')
      if (tree.siblings.length === 0) process.stdout.write('  None\n')
      else
        for (const document of tree.siblings)
          process.stdout.write(
            `  - ${document.title} (${document.id}) · ${document.authorName}\n`,
          )
      process.stdout.write('Children:\n')
      if (tree.children.length === 0) process.stdout.write('  None\n')
      else
        for (const document of tree.children)
          process.stdout.write(
            `  - ${document.title} (${document.id}) · ${document.authorName}\n`,
          )
    }),
).pipe(Command.withDescription('Show a document breadcrumb, siblings, and children'))

const moveCommand = Command.make(
  'move',
  {
    parent: Options.text('parent'),
    ref: Args.text({ name: 'id' }),
  },
  ({ parent, ref }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const id = parseDocumentId(ref, runtime)
      const parentId =
        parent === 'root' ? null : parseDocumentId(parent, runtime)
      const result = await apiCall(runtime, (client) =>
        client.documents.patch({ path: { id }, payload: { parentId } }),
      )
      if (runtime.json) printJson(result.document)
      else if (!runtime.quiet)
        process.stdout.write(
          `Moved\nID: ${result.document.id}\nParent: ${result.document.parentId ?? 'root'}\n`,
        )
    }),
).pipe(Command.withDescription('Move a document and its subtree'))

const visibilityCommand = Command.make(
  'visibility',
  {
    ref: Args.text({ name: 'id' }),
    visibility: Args.choice(
      [
        ['public', 'public' as const],
        ['team', 'team' as const],
        ['private', 'private' as const],
        ['inherit', 'inherit' as const],
      ],
      { name: 'visibility' },
    ),
  },
  ({ visibility, ref }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const id = parseDocumentId(ref, runtime)
      const result = await apiCall(runtime, (client) =>
        client.documents.patch({
          path: { id },
          payload: { visibility: visibility === 'inherit' ? null : visibility },
        }),
      )
      if (runtime.json) printJson(result.document)
      else if (!runtime.quiet)
        process.stdout.write(
          `Visibility: ${configuredVisibility(result.document)}\nID: ${result.document.id}\n`,
        )
    }),
).pipe(Command.withDescription('Set or inherit document visibility'))

const shareCommand = Command.make(
  'share',
  {
    add: Options.text('add').pipe(Options.optional),
    remove: Options.text('remove').pipe(Options.optional),
    ref: Args.text({ name: 'id' }),
  },
  ({ add, remove, ref }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const id = parseDocumentId(ref, runtime)
      const addEmails = parseEmails(Option.getOrUndefined(add))
      const removeEmails = parseEmails(Option.getOrUndefined(remove))
      if (addEmails === undefined && removeEmails === undefined) {
        throw new CliError(
          'share requires --add and/or --remove',
          ExitCode.Usage,
        )
      }
      const result = await apiCall(runtime, (client) =>
        client.documents.sharesDelta({
          path: { id },
          payload: {
            ...(addEmails === undefined ? {} : { add: addEmails }),
            ...(removeEmails === undefined ? {} : { remove: removeEmails }),
          },
        }),
      )
      if (runtime.json) printJson(result)
      else if (!runtime.quiet)
        process.stdout.write(
          `Configured: ${result.configured.join(', ') || 'none'}\nEffective: ${result.effective.join(', ') || 'none'}\nAccess source: ${result.accessSource}\n`,
        )
    }),
).pipe(Command.withDescription('Add or remove document share emails'))

const trashCommand = Command.make('trash', {}, () =>
  withGlobals(async (globals) => {
    const runtime = await runtimeConfig(globals)
    await requireMe(runtime)
    const documents = (await listDocuments(runtime, 'trash')).filter(
      isDocumentEditor,
    )
    if (runtime.json) {
      printJson(documents)
      return
    }
    if (runtime.quiet) return
    if (documents.length === 0) {
      process.stdout.write('Trash is empty.\n')
      return
    }
    const batches = new Map<string, DocumentEditor[]>()
    for (const document of documents) {
      const batchId = document.deletionBatchId ?? `document:${document.id}`
      const batch = batches.get(batchId) ?? []
      batch.push(document)
      batches.set(batchId, batch)
    }
    for (const [batchId, batch] of batches) {
      const rootTitle =
        batch.find((document) => document.deletionRootTitle)?.deletionRootTitle ??
        batch[0]!.title
      const root =
        batch.find((document) => document.title === rootTitle) ?? batch[0]!
      const authors = [...new Set(batch.map((document) => document.authorName))]
      process.stdout.write(
        `${rootTitle}\n  ${root.id} · batch ${batchId}\n  Authors: ${authors.join(', ')}\n`,
      )
    }
  }),
).pipe(Command.withDescription('List restorable deletion batches'))

const deleteCommand = Command.make(
  'delete',
  { force: Options.boolean('force'), ref: Args.text({ name: 'id' }) },
  ({ force, ref }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const id = parseDocumentId(ref, runtime)
      let result
      try {
        result = await apiCall(runtime, (client) =>
          client.documents.delete({
            path: { id },
            urlParams: force ? { force: '1' } : {},
          }),
        )
      } catch (error) {
        const message = hasChildrenMessage(error)
        if (message) throw new CliError(message, ExitCode.Failure, error)
        throw error
      }
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
        batchId = isDocumentEditor(detail.document)
          ? detail.document.deletionBatchId ?? undefined
          : undefined
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

const workspaceMembersCommand = Command.make('members', {}, () =>
  withGlobals(async (globals) => {
    const runtime = await runtimeConfig(globals)
    printWorkspace(await workspaceData(runtime), runtime, true)
  }),
).pipe(Command.withDescription('List workspace members'))

const workspaceAllowCommand = Command.make(
  'allow',
  {
    role: Options.choice('role', ['admin', 'member']).pipe(Options.optional),
    value: Args.text({ name: 'email-or-domain' }),
  },
  ({ role, value }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const parsed = allowlistValue(value)
      const result = await workspaceMutation(
        runtime,
        '/api/workspace/allowlist',
        'POST',
        {
          ...parsed,
          role: Option.getOrUndefined(role) ?? 'member',
        },
      )
      printWorkspaceMutation(result, runtime)
    }),
).pipe(Command.withDescription('Allow an email address or @domain to sign in'))

const workspaceDisallowCommand = Command.make(
  'disallow',
  { value: Args.text({ name: 'email-or-domain' }) },
  ({ value }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const parsed = allowlistValue(value)
      const workspace = await workspaceData(runtime)
      const entry = workspace.allowlist.find(
        (candidate) =>
          candidate.kind === parsed.kind && candidate.value === parsed.value,
      )
      if (!entry) {
        throw new CliError(
          `${parsed.kind === 'domain' ? '@' : ''}${parsed.value} is not in this workspace's allowlist`,
        )
      }
      const result = await workspaceMutation(
        runtime,
        `/api/workspace/allowlist/${encodeURIComponent(entry.id)}`,
        'DELETE',
      )
      printWorkspaceMutation(result, runtime)
    }),
).pipe(Command.withDescription('Remove an email address or @domain from the allowlist'))

const workspacePromoteCommand = Command.make(
  'promote',
  { email: Args.text({ name: 'email' }) },
  ({ email }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const member = findWorkspaceMember(await workspaceData(runtime), email)
      const result = await workspaceMutation(
        runtime,
        `/api/workspace/members/${encodeURIComponent(member.accountId)}`,
        'POST',
        { role: 'admin' },
      )
      printWorkspaceMutation(result, runtime)
    }),
).pipe(Command.withDescription('Promote a workspace member to admin'))

const workspaceRemoveCommand = Command.make(
  'remove',
  { email: Args.text({ name: 'email' }) },
  ({ email }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const member = findWorkspaceMember(await workspaceData(runtime), email)
      const result = await workspaceMutation(
        runtime,
        `/api/workspace/members/${encodeURIComponent(member.accountId)}`,
        'DELETE',
      )
      printWorkspaceMutation(result, runtime)
    }),
).pipe(Command.withDescription('Remove a member from the workspace'))

const workspaceCommand = Command.make('workspace', {}, () =>
  withGlobals(async (globals) => {
    const runtime = await runtimeConfig(globals)
    printWorkspace(await workspaceData(runtime), runtime)
  }),
).pipe(
  Command.withDescription('Manage workspace members and the sign-in allowlist'),
  Command.withSubcommands([
    workspaceMembersCommand,
    workspaceAllowCommand,
    workspaceDisallowCommand,
    workspacePromoteCommand,
    workspaceRemoveCommand,
  ]),
)

const setupCommand = Command.make('setup', {}, () =>
  withGlobals(async (globals) => {
    const runtime = await runtimeConfig(globals)
    const pipedKey =
      runtime.apiKey || process.stdin.isTTY ? undefined : (await readStdin()).trim()
    const bootstrapKey =
      process.env.BOOTSTRAP_API_KEY?.trim() || runtime.apiKey || pipedKey
    if (!bootstrapKey) {
      throw new CliError(
        'bootstrap key is required through BOOTSTRAP_API_KEY, DOSSIER_API_KEY, stored credentials, or stdin',
        ExitCode.Auth,
      )
    }
    const result = await dossierJson<Record<string, unknown>>(
      '/api/setup',
      { apiUrl: runtime.apiUrl, apiKey: bootstrapKey },
      { method: 'POST' },
    )
    if (runtime.json) printJson(result)
    else if (!runtime.quiet) {
      const workspaceSlug = result.workspaceSlug
      process.stdout.write(
        typeof workspaceSlug === 'string'
          ? `Seeded workspace ${workspaceSlug}.\n`
          : 'Deployment setup complete.\n',
      )
    }
  }),
).pipe(
  Command.withDescription(
    'Call the protected deployment bootstrap endpoint (operators only)',
  ),
)

const assetsPushCommand = Command.make(
  'push',
  {
    slug: Options.text('slug').pipe(Options.optional),
    file: Args.text({ name: 'file' }),
  },
  ({ slug, file }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const asset = await readAssetFile(file, runtime.apiUrl)
      const requestedSlug = Option.getOrUndefined(slug)
      const selectedSlug = validateAssetSlug(
        requestedSlug ??
          basename(asset.absolutePath, extname(asset.absolutePath)),
        requestedSlug === undefined ? 'filename' : 'explicit',
      )
      await requireMe(runtime)
      const result = await pushAsset(runtime, {
        slug: selectedSlug,
        ext: asset.ext,
        contentBase64: asset.bytes.toString('base64'),
      })

      if (runtime.json) {
        printJson(result)
      } else if (runtime.quiet) {
        process.stdout.write(`${result.url}\n`)
      } else {
        process.stdout.write(
          `${result.versionNumber === 1 ? 'Created' : 'Updated'}\nSlug: ${result.slug}\nVersion: ${result.versionNumber}\nURL: ${result.url}\nPinned URL: ${result.pinnedUrl}\n`,
        )
      }
    }),
).pipe(Command.withDescription('Validate and upload a shared CSS or WOFF2 asset'))

const assetsListCommand = Command.make('list', {}, () =>
  withGlobals(async (globals) => {
    const runtime = await runtimeConfig(globals)
    await requireMe(runtime)
    const result = await listAssets(runtime)
    if (runtime.json) {
      printJson(result.assets)
      return
    }
    if (runtime.quiet) return
    if (result.assets.length === 0) {
      process.stdout.write('No shared assets yet.\n')
      return
    }
    for (const asset of result.assets) {
      process.stdout.write(
        `${asset.slug}.${asset.ext}\n  v${asset.latestVersionNumber} · updated ${assetUpdatedDate(asset.updatedAt)}\n  ${asset.url}\n  pinned ${asset.pinnedUrl}\n`,
      )
    }
  }),
).pipe(Command.withDescription('List shared assets'))

const assetsDeleteCommand = Command.make(
  'delete',
  { slug: Args.text({ name: 'slug' }) },
  ({ slug }) =>
    withGlobals(async (globals) => {
      const runtime = await runtimeConfig(globals)
      const selectedSlug = validateAssetSlug(slug)
      await requireMe(runtime)
      const existing = (await listAssets(runtime)).assets.find(
        (asset) => asset.slug === selectedSlug,
      )
      const result = await deleteAsset(runtime, selectedSlug)
      if (runtime.json) printJson(result)
      else if (!runtime.quiet) {
        const consequence = existing
          ? ` /a/${existing.slug}.${existing.ext} now returns 404; pinned /a/${existing.slug}@${existing.latestVersionNumber}.${existing.ext} keeps serving.`
          : ''
        process.stdout.write(`Deleted asset ${selectedSlug}.${consequence}\n`)
      }
    }),
).pipe(
  Command.withDescription(
    "Stop serving an asset's latest URL (pinned versions keep serving)",
  ),
)

const assetsCommand = Command.make('assets').pipe(
  Command.withDescription('Manage shared CSS and WOFF2 assets'),
  Command.withSubcommands([
    assetsPushCommand,
    assetsListCommand,
    assetsDeleteCommand,
  ]),
)

const dossierCommand = rootCommand.pipe(
  Command.withSubcommands([
    authCommand,
    whoamiCommand,
    uploadCommand,
    fetchCommand,
    diffCommand,
    listCommand,
    treeCommand,
    moveCommand,
    visibilityCommand,
    shareCommand,
    trashCommand,
    deleteCommand,
    restoreCommand,
    disableCommand,
    enableCommand,
    workspaceCommand,
    assetsCommand,
    setupCommand,
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

const nestedCommands: Readonly<Record<string, ReadonlySet<string>>> = {
  auth: new Set(['login', 'set', 'logout']),
  assets: new Set(['push', 'list', 'delete']),
  workspace: new Set(['members', 'allow', 'disallow', 'promote', 'remove']),
}

const valuedOptions: Readonly<Record<string, ReadonlySet<string>>> = {
  upload: new Set([
    '--parent',
    '--kind',
    '--visibility',
    '--share',
    '--description',
    '--doc',
  ]),
  fetch: new Set(['--version', '--output', '-o']),
  diff: new Set(['--from', '--to']),
  list: new Set(['--parent']),
  move: new Set(['--parent']),
  share: new Set(['--add', '--remove']),
  restore: new Set(['--batch']),
  'assets push': new Set(['--slug']),
  'workspace allow': new Set(['--role']),
}

const booleanOptions: Readonly<Record<string, ReadonlySet<string>>> = {
  upload: new Set(['--new']),
  diff: new Set(['--text']),
  list: new Set(['--all', '--tree', '--trash']),
  delete: new Set(['--force']),
}

function isGlobalBoolean(argument: string): boolean {
  return argument === '--json' || argument === '--quiet' || argument === '-q'
}

function detectCommand(rest: readonly string[]): string {
  let root: string | undefined
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!
    if (argument === '--') break
    if (argument === '--api-url') {
      index += 1
      continue
    }
    if (argument.startsWith('--api-url=') || isGlobalBoolean(argument)) {
      continue
    }
    if (argument.startsWith('-')) continue
    if (!root) {
      root = argument
      if (!nestedCommands[root]) return root
      continue
    }
    if (nestedCommands[root]?.has(argument)) return `${root} ${argument}`
    return root
  }
  return root ?? ''
}

function extractGlobals(
  rest: readonly string[],
  commandName: string,
): { readonly globals: string[]; readonly command: string[]; readonly json: boolean } {
  const globals: string[] = []
  const command: string[] = []
  const valued = valuedOptions[commandName]
  let json = false

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!
    if (argument === '--') {
      command.push(...rest.slice(index))
      break
    }
    const equalsName = argument.includes('=')
      ? argument.slice(0, argument.indexOf('='))
      : argument
    if (valued?.has(equalsName)) {
      command.push(argument)
      if (!argument.includes('=') && index + 1 < rest.length) {
        command.push(rest[++index]!)
      }
      continue
    }
    if (argument === '--api-url') {
      globals.push(argument)
      if (index + 1 < rest.length) globals.push(rest[++index]!)
      continue
    }
    if (argument.startsWith('--api-url=')) {
      globals.push(argument)
      continue
    }
    if (isGlobalBoolean(argument)) {
      globals.push(argument)
      if (argument === '--json') json = true
      continue
    }
    command.push(argument)
  }
  return { globals, command, json }
}

function optionsBeforeArguments(
  command: readonly string[],
  commandName: string,
): string[] {
  const prefixLength = commandName.includes(' ') ? 2 : commandName ? 1 : 0
  const commandPrefix = command.slice(0, prefixLength)
  const commandArguments = command.slice(prefixLength)
  const valued = valuedOptions[commandName]
  const boolean = booleanOptions[commandName]
  if (!valued && !boolean) return [...command]

  const options: string[] = []
  const arguments_: string[] = []
  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index]!
    if (argument === '--') {
      arguments_.push(...commandArguments.slice(index))
      break
    }
    const equalsName = argument.includes('=')
      ? argument.slice(0, argument.indexOf('='))
      : argument
    if (valued?.has(equalsName)) {
      options.push(argument)
      if (!argument.includes('=') && index + 1 < commandArguments.length) {
        options.push(commandArguments[++index]!)
      }
    } else if (boolean?.has(argument)) {
      options.push(argument)
    } else {
      arguments_.push(argument)
    }
  }
  return [...commandPrefix, ...options, ...arguments_]
}

export function normalizeGlobalOptions(
  argv: readonly string[],
): NormalizedArguments {
  const prefix = argv.slice(0, 2)
  const rest = argv.slice(2)
  const commandName = detectCommand(rest)
  const extracted = extractGlobals(rest, commandName)
  const orderedCommand = optionsBeforeArguments(extracted.command, commandName)
  return {
    args: [...prefix, ...extracted.globals, ...orderedCommand],
    json: extracted.json,
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
let entryUrl: string | undefined
if (entry) {
  try {
    entryUrl = pathToFileURL(await realpath(entry)).href
  } catch {
    entryUrl = pathToFileURL(resolve(entry)).href
  }
}
if (entryUrl === import.meta.url) {
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
