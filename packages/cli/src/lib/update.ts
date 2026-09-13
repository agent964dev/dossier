import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, posix, resolve, win32 } from 'node:path'
import { CliError } from './errors.js'

const PACKAGE_NAME = '@agent964/dossier'
const LATEST_PACKAGE_SPEC = `${PACKAGE_NAME}@latest`
const numericPart = '(0|[1-9]\\d*)'
const prereleasePart = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const buildPart = '[0-9A-Za-z-]+'
const SEMVER_PATTERN = new RegExp(
  `^${numericPart}\\.${numericPart}\\.${numericPart}` +
    `(?:-(${prereleasePart}(?:\\.${prereleasePart})*))?` +
    `(?:\\+(${buildPart}(?:\\.${buildPart})*))?$`,
)

export interface ParsedSemver {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
  readonly build: readonly string[]
}

export function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER_PATTERN.exec(value)
  if (!match) return null
  const numbers = match.slice(1, 4).map(Number)
  if (numbers.some((part) => !Number.isSafeInteger(part))) return null
  return {
    major: numbers[0]!,
    minor: numbers[1]!,
    patch: numbers[2]!,
    prerelease: match[4]?.split('.') ?? [],
    build: match[5]?.split('.') ?? [],
  }
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1
    return left === right ? 0 : left < right ? -1 : 1
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

export function compareSemver(leftValue: string, rightValue: string): number {
  const left = parseSemver(leftValue)
  const right = parseSemver(rightValue)
  if (!left) throw new TypeError(`invalid semantic version: ${leftValue}`)
  if (!right) throw new TypeError(`invalid semantic version: ${rightValue}`)

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1
    }
    const compared = compareIdentifier(leftPart, rightPart)
    if (compared !== 0) return compared
  }
  return 0
}

export type InstallMethod =
  | 'npm'
  | 'bun'
  | 'pnpm'
  | 'yarn'
  | 'npx'
  | 'bunx'
  | 'checkout'
  | 'unknown'

export interface InstallDetection {
  readonly method: InstallMethod
  readonly upgradeCommand?: [string, string[]]
}

export interface DetectInstallOptions {
  readonly argv1RealPath: string
  readonly platform: NodeJS.Platform
  readonly npmRootGlobal?: string
  readonly bunGlobalDir?: string
  readonly pnpmRootGlobal?: string
  readonly yarnGlobalDir?: string
  readonly home: string
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix
  const normalized = path.resolve(value)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithin(
  file: string,
  root: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (!root?.trim()) return false
  const path = platform === 'win32' ? win32 : posix
  const relative = path.relative(
    normalizedPath(root, platform),
    normalizedPath(file, platform),
  )
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

export function detectInstall(options: DetectInstallOptions): InstallDetection {
  const normalized = normalizedPath(
    options.argv1RealPath,
    options.platform,
  ).replaceAll('\\', '/')
  const path = options.platform === 'win32' ? win32 : posix
  const bunGlobalDir =
    options.bunGlobalDir ?? path.join(options.home, '.bun', 'install', 'global')

  if (/(^|\/)_npx(\/|$)/.test(normalized)) {
    return { method: 'npx' }
  }
  if (
    /(^|\/)bunx(\/|$)/.test(normalized) ||
    /(^|\/)\.bun\/install\/cache(\/|$)/.test(normalized)
  ) {
    return { method: 'bunx' }
  }
  if (/\/packages\/cli\/dist(\/|$)/.test(normalized)) {
    return { method: 'checkout' }
  }
  if (
    isWithin(options.argv1RealPath, options.npmRootGlobal, options.platform)
  ) {
    return {
      method: 'npm',
      upgradeCommand: ['npm', ['install', '-g', LATEST_PACKAGE_SPEC]],
    }
  }
  if (isWithin(options.argv1RealPath, bunGlobalDir, options.platform)) {
    return {
      method: 'bun',
      upgradeCommand: ['bun', ['add', '-g', LATEST_PACKAGE_SPEC]],
    }
  }
  if (
    isWithin(options.argv1RealPath, options.pnpmRootGlobal, options.platform)
  ) {
    return {
      method: 'pnpm',
      upgradeCommand: ['pnpm', ['add', '-g', LATEST_PACKAGE_SPEC]],
    }
  }
  if (
    isWithin(options.argv1RealPath, options.yarnGlobalDir, options.platform)
  ) {
    return {
      method: 'yarn',
      upgradeCommand: ['yarn', ['global', 'add', LATEST_PACKAGE_SPEC]],
    }
  }
  return { method: 'unknown' }
}

export interface FetchLatestVersionOptions {
  readonly registryUrl: string
  readonly fetch: typeof globalThis.fetch
  readonly timeoutMs?: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function fetchLatestVersion({
  registryUrl,
  fetch,
  timeoutMs = 5_000,
}: FetchLatestVersionOptions): Promise<string> {
  const controller = new AbortController()
  const timeout = Symbol('registry timeout')
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(timeout)
    }, timeoutMs)
  })
  const baseUrl = registryUrl.replace(/\/+$/, '')
  const request = async (): Promise<string> => {
    const response = await fetch(`${baseUrl}/@agent964%2Fdossier/latest`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new CliError(
        `npm registry returned HTTP ${response.status} while checking updates`,
      )
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new CliError(
        'npm registry returned malformed JSON',
        undefined,
        error,
      )
    }
    const version =
      typeof payload === 'object' && payload !== null && 'version' in payload
        ? (payload as { readonly version?: unknown }).version
        : undefined
    if (typeof version !== 'string' || parseSemver(version) === null) {
      throw new CliError('npm registry returned a malformed latest version')
    }
    return version
  }

  try {
    return await Promise.race([request(), deadline])
  } catch (error) {
    if (error === timeout) {
      throw new CliError(`npm registry request timed out after ${timeoutMs}ms`)
    }
    if (error instanceof CliError) throw error
    throw new CliError(
      `failed to check npm registry: ${messageOf(error)}`,
      undefined,
      error,
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export type UpdateExecFile = (
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptions,
) => string | Buffer

export interface UpdateResult {
  readonly ok: true
  readonly currentVersion: string
  readonly latestVersion: string
  readonly installMethod: InstallMethod
  readonly updateAvailable: boolean
  readonly checked: boolean
  readonly updated: boolean
}

export interface RunUpdateOptions extends DetectInstallOptions {
  readonly argv1Path?: string
  readonly currentVersion: string
  readonly check: boolean
  readonly json: boolean
  readonly registryUrl: string
  readonly fetch: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly execFile?: UpdateExecFile
  readonly onStatus?: (message: string) => void
  readonly readInstalledVersion?: () => string
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptions,
): string | Buffer {
  return execFileSync(file, args, options)
}

function canonicalRoot(root: string | undefined): string | undefined {
  if (!root) return undefined
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}

function probeRoot(
  execFile: UpdateExecFile,
  file: string,
  args: readonly string[],
): string | undefined {
  try {
    const output = execFile(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const value = String(output).trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

function commandText(command: readonly [string, readonly string[]]): string {
  return [command[0], ...command[1]].join(' ')
}

function exactUpgradeCommand(
  command: readonly [string, readonly string[]],
  version: string,
): [string, string[]] {
  const exactPackageSpec = `${PACKAGE_NAME}@${version}`
  return [
    command[0],
    command[1].map((argument) =>
      argument === LATEST_PACKAGE_SPEC ? exactPackageSpec : argument,
    ),
  ]
}

function refusalMessage(method: InstallMethod): string {
  switch (method) {
    case 'npx':
      return `dossier is running through npx; run \`npx ${LATEST_PACKAGE_SPEC}\``
    case 'bunx':
      return `dossier is running through bunx; run \`bunx ${LATEST_PACKAGE_SPEC}\``
    case 'checkout':
      return 'dossier is running from a checkout; update the checkout instead'
    default:
      return (
        'could not detect how dossier was installed; run ' +
        `\`npm install -g ${LATEST_PACKAGE_SPEC}\``
      )
  }
}

function installedVersionAt(argv1Path: string): string {
  const argv1RealPath = realpathSync(argv1Path)
  const manifestPath = resolve(dirname(argv1RealPath), '..', 'package.json')
  const payload: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const version =
    typeof payload === 'object' && payload !== null && 'version' in payload
      ? (payload as { readonly version?: unknown }).version
      : undefined
  if (typeof version !== 'string' || parseSemver(version) === null) {
    throw new Error(`invalid version in ${manifestPath}`)
  }
  return version
}

function objectField(error: unknown, field: string): unknown {
  return typeof error === 'object' && error !== null && field in error
    ? (error as Record<string, unknown>)[field]
    : undefined
}

export async function runUpdate(
  options: RunUpdateOptions,
): Promise<UpdateResult> {
  if (parseSemver(options.currentVersion) === null) {
    throw new CliError(`invalid current CLI version: ${options.currentVersion}`)
  }

  const execFile = options.execFile ?? defaultExecFile
  const npmRootGlobal =
    options.npmRootGlobal ?? probeRoot(execFile, 'npm', ['root', '-g'])
  const pnpmRootGlobal =
    options.pnpmRootGlobal ?? probeRoot(execFile, 'pnpm', ['root', '-g'])
  const yarnGlobalDir =
    options.yarnGlobalDir ?? probeRoot(execFile, 'yarn', ['global', 'dir'])
  const detected = detectInstall({
    ...options,
    npmRootGlobal: canonicalRoot(npmRootGlobal),
    bunGlobalDir: canonicalRoot(options.bunGlobalDir),
    pnpmRootGlobal: canonicalRoot(pnpmRootGlobal),
    yarnGlobalDir: canonicalRoot(yarnGlobalDir),
  })
  const latestVersion = await fetchLatestVersion({
    registryUrl: options.registryUrl,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  })
  const updateAvailable =
    compareSemver(latestVersion, options.currentVersion) > 0
  const result = (version: string, updated: boolean): UpdateResult => ({
    ok: true,
    currentVersion: options.currentVersion,
    latestVersion: version,
    installMethod: detected.method,
    updateAvailable,
    checked: options.check,
    updated,
  })

  if (!updateAvailable || options.check) return result(latestVersion, false)
  if (options.platform === 'win32') {
    throw new CliError(
      'automatic updates are not supported on Windows; run ' +
        `\`npm install -g ${LATEST_PACKAGE_SPEC}\` with elevated rights`,
    )
  }
  if (!detected.upgradeCommand) {
    throw new CliError(refusalMessage(detected.method))
  }

  const command = exactUpgradeCommand(detected.upgradeCommand, latestVersion)
  const renderedCommand = commandText(command)
  options.onStatus?.(
    `Updating dossier ${options.currentVersion} → ${latestVersion} ` +
      `with ${detected.method}…`,
  )
  try {
    execFile(command[0], command[1], {
      stdio: options.json ? ['ignore', process.stderr, 'inherit'] : 'inherit',
    })
  } catch (error) {
    if (objectField(error, 'code') === 'EACCES') {
      throw new CliError(
        `permission denied; rerun \`${renderedCommand}\` with elevated rights`,
        undefined,
        error,
      )
    }
    const status = objectField(error, 'status')
    const detail = typeof status === 'number' ? ` with exit code ${status}` : ''
    throw new CliError(
      `${detected.method} update failed${detail}: ${messageOf(error)}. ` +
        `Run \`${renderedCommand}\` manually; if it reports a permission ` +
        'error, rerun it with elevated rights',
      undefined,
      error,
    )
  }

  let installedVersion: string
  try {
    installedVersion =
      options.readInstalledVersion?.() ??
      installedVersionAt(options.argv1Path ?? options.argv1RealPath)
  } catch (error) {
    throw new CliError(
      'update completed but the installed version could not be read: ' +
        messageOf(error),
      undefined,
      error,
    )
  }
  if (parseSemver(installedVersion) === null) {
    throw new CliError(
      `update completed but installed version ${installedVersion} is invalid`,
    )
  }
  if (compareSemver(installedVersion, latestVersion) !== 0) {
    throw new CliError(
      `update completed with dossier ${installedVersion}; expected ` +
        latestVersion,
    )
  }
  options.onStatus?.(`Updated dossier to ${installedVersion}.`)
  return result(installedVersion, true)
}
