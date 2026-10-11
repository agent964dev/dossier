import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { Either, Schema } from 'effect'

import { problem } from './render.ts'

const SavedKey = Schema.Struct({
  key: Schema.String,
  keyName: Schema.String,
  /** The email of the person the key acts as. */
  person: Schema.String,
  savedAt: Schema.String,
})

const CliConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  /** The deployment of the latest login. */
  default: Schema.NullOr(Schema.String),
  deployments: Schema.Record({ key: Schema.String, value: SavedKey }),
})

export type SavedKey = typeof SavedKey.Type
export type CliConfig = typeof CliConfigSchema.Type

export const emptyConfig: CliConfig = {
  version: 1,
  default: null,
  deployments: {},
}

/** Under `$XDG_CONFIG_HOME`, else `~/.config`: `dossier/config.json`. */
export const defaultConfigPath = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string => {
  const xdg = env.XDG_CONFIG_HOME?.trim()
  return join(xdg ? xdg : join(home, '.config'), 'dossier', 'config.json')
}

const decodeConfig = Schema.decodeUnknownEither(
  Schema.parseJson(CliConfigSchema),
)

export const readConfig = async (path: string): Promise<CliConfig> => {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig
    throw error
  }
  const decoded = decodeConfig(contents)
  if (Either.isLeft(decoded)) {
    throw problem(
      `The config file ${path} cannot be read.`,
      'Repair it, or remove it and run `dossier login` again.',
    )
  }
  return decoded.right
}

export interface LockOptions {
  readonly timeoutMs?: number
  readonly retryMs?: number
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

const ensureDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

/** Takes the lock beside the file; another dossier process waits for it. */
const acquireLock = async (
  path: string,
  options: LockOptions,
  what: string,
): Promise<() => Promise<void>> => {
  const lockPath = `${path}.lock`
  const deadline = Date.now() + (options.timeoutMs ?? 5_000)
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
        throw problem(
          `Another dossier process is changing ${what}.`,
          `Try again when it is done. If none is running, remove ${lockPath}.`,
        )
      }
      await wait(options.retryMs ?? 25)
    }
  }
}

/** Writes a temporary file, syncs it, then renames it over the file. */
const writeAtomically = async (path: string, value: unknown): Promise<void> => {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/**
 * Changes the config file under its lock: read, change, write a temporary
 * file with mode 0600, sync it, and rename it into place.
 */
export const updateConfig = (
  path: string,
  change: (config: CliConfig) => CliConfig,
  options: LockOptions = {},
): Promise<CliConfig> =>
  updateJsonFile(path, readConfig, change, options, 'the config file')

/**
 * Changes a JSON file of this CLI's under its lock, the way the config file
 * changes: read, change, write a temporary file with mode 0600, sync it, and
 * rename it into place.
 */
export const updateJsonFile = async <T>(
  path: string,
  read: (path: string) => Promise<T>,
  change: (value: T) => T,
  options: LockOptions,
  what: string,
): Promise<T> => {
  await ensureDirectory(dirname(path))
  const release = await acquireLock(path, options, what)
  try {
    const next = change(await read(path))
    await writeAtomically(path, next)
    return next
  } finally {
    await release()
  }
}
