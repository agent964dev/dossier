import { constants } from 'node:fs'
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CliError } from './errors.js'

export interface DossierConfig {
  readonly apiUrl?: string
}

export type Credentials = Record<string, string>

export interface DocumentMapping {
  readonly documentId: string
  readonly url: string
  readonly rawUrl: string
  readonly updatedAt: string
}

export type Documents = Record<
  string,
  Record<string, Record<string, DocumentMapping>>
>

export interface StatePaths {
  readonly home: string
  readonly config: string
  readonly credentials: string
  readonly documents: string
  readonly lock: string
}

export interface LockOptions {
  readonly timeoutMs?: number
  readonly retryMs?: number
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

export function statePaths(env: NodeJS.ProcessEnv = process.env): StatePaths {
  const home = env.DOSSIER_HOME?.trim() || join(homedir(), '.dossier')
  return {
    home,
    config: join(home, 'config.json'),
    credentials: join(home, 'credentials.json'),
    documents: join(home, 'documents.json'),
    lock: join(home, '.state.lock'),
  }
}

export async function ensureStateDirectory(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700)
}

export async function acquireStateLock(
  home: string,
  options: LockOptions = {},
): Promise<() => Promise<void>> {
  await ensureStateDirectory(home)
  const lockPath = join(home, '.state.lock')
  const timeoutMs = options.timeoutMs ?? 5_000
  const retryMs = options.retryMs ?? 25
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      )
      await handle.writeFile(`${process.pid}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      let released = false
      return async () => {
        if (released) return
        released = true
        await rm(lockPath, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) {
        throw new CliError(
          `state is locked by another dossier process (${lockPath}); retry after it exits`,
        )
      }
      await sleep(retryMs)
    }
  }
}

export async function withStateLock<A>(
  home: string,
  operation: () => Promise<A>,
  options?: LockOptions,
): Promise<A> {
  const release = await acquireStateLock(home, options)
  try {
    return await operation()
  } finally {
    await release()
  }
}

export async function readJsonFile<A>(path: string, fallback: A): Promise<A> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }

  try {
    const value: unknown = JSON.parse(contents)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('expected a JSON object')
    }
    return value as A
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CliError(
      `cannot read ${path}: corrupted JSON (${reason}); repair it or remove the file and retry`,
    )
  }
}

async function writeJsonUnlocked(
  path: string,
  value: unknown,
  mode: number,
): Promise<void> {
  const directory = path.slice(0, path.lastIndexOf('/'))
  await ensureStateDirectory(directory)
  const temporary = join(
    directory,
    `.${path.slice(path.lastIndexOf('/') + 1)}.${randomUUID()}.tmp`,
  )
  let handle
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      mode,
    )
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await chmod(path, mode)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  mode = 0o600,
  lockOptions?: LockOptions,
): Promise<void> {
  const directory = path.slice(0, path.lastIndexOf('/'))
  await withStateLock(
    directory,
    () => writeJsonUnlocked(path, value, mode),
    lockOptions,
  )
}

export async function readConfig(
  paths: StatePaths = statePaths(),
): Promise<DossierConfig> {
  return readJsonFile(paths.config, {})
}

export async function writeConfig(
  config: DossierConfig,
  paths: StatePaths = statePaths(),
): Promise<void> {
  await writeJsonAtomic(paths.config, config)
}

export async function readCredentials(
  paths: StatePaths = statePaths(),
): Promise<Credentials> {
  return readJsonFile(paths.credentials, {})
}

export async function writeCredentials(
  credentials: Credentials,
  paths: StatePaths = statePaths(),
): Promise<void> {
  await writeJsonAtomic(paths.credentials, credentials)
}

export async function mutateCredentials<A>(
  mutation: (credentials: Credentials) => A | Promise<A>,
  paths: StatePaths = statePaths(),
  lockOptions?: LockOptions,
): Promise<A> {
  return withStateLock(
    paths.home,
    async () => {
      const credentials = await readCredentials(paths)
      const result = await mutation(credentials)
      await writeJsonUnlocked(paths.credentials, credentials, 0o600)
      return result
    },
    lockOptions,
  )
}

export async function readDocuments(
  paths: StatePaths = statePaths(),
): Promise<Documents> {
  return readJsonFile(paths.documents, {})
}

export async function mutateDocuments<A>(
  mutation: (documents: Documents) => A | Promise<A>,
  paths: StatePaths = statePaths(),
  lockOptions?: LockOptions,
): Promise<A> {
  return withStateLock(
    paths.home,
    async () => {
      const documents = await readDocuments(paths)
      const result = await mutation(documents)
      await writeJsonUnlocked(paths.documents, documents, 0o600)
      return result
    },
    lockOptions,
  )
}

export async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}
