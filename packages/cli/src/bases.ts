import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { AuthoredSeq, Sha256, TreeId } from '@dossier/contracts'
import { Either, Schema } from 'effect'

import { updateJsonFile } from './config.ts'
import { hasMarkers } from './merge.ts'

/**
 * A file `dossier pull --merge` could not merge, kept until it is resolved:
 * `text` holds conflict markers, `binary` has theirs at `theirs`, and
 * `deleted-here` and `deleted-there` were changed on one side and deleted on
 * the other.
 */
export const ConflictSchema = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literal('text', 'binary', 'deleted-here', 'deleted-there'),
  theirs: Schema.NullOr(Schema.String),
})
export type Conflict = typeof ConflictSchema.Type

const BaseList = Schema.Struct({
  version: Schema.Literal(1),
  /** The node, as heads.json keys it, and the folder: for a person reading. */
  node: Schema.String,
  folder: Schema.String,
  treeId: TreeId,
  seq: AuthoredSeq,
  /** Every authored file at the base, inside the folder → its hash. */
  files: Schema.Record({ key: Schema.String, value: Sha256 }),
  conflicts: Schema.Array(ConflictSchema),
})
type BaseList = typeof BaseList.Type

/**
 * The tree as this folder last pulled, pushed or merged it: the base of the
 * next merge. Only one is kept per folder, never a history.
 */
export interface BaseCopy {
  readonly treeId: TreeId
  readonly seq: AuthoredSeq
  readonly files: Readonly<Record<string, Sha256>>
  readonly conflicts: readonly Conflict[]
}

/** One folder synced with one node, as heads.json keys it. */
export interface BaseKey {
  readonly deployment: string
  /** `workspace/tree[/path]`. */
  readonly node: string
  /** The local folder's absolute, real path. */
  readonly folder: string
}

export interface BaseStore {
  readonly get: (key: BaseKey) => Promise<BaseCopy | null>
  /** A text file's content at the base, by its hash; null when not kept. */
  readonly text: (key: BaseKey, sha256: Sha256) => Promise<string | null>
  /**
   * Replaces the base. `texts` holds the bytes of the text files among
   * `copy.files`; a binary file is kept by its hash alone.
   */
  readonly set: (
    key: BaseKey,
    copy: BaseCopy,
    texts: ReadonlyMap<Sha256, Uint8Array>,
  ) => Promise<void>
  /**
   * Adds conflicts to the copy as it is, for a merge that stopped part way:
   * the files it already wrote stay blocked until they are resolved. With no
   * copy yet, one with no files is made at `fallback`.
   */
  readonly addConflicts: (
    key: BaseKey,
    conflicts: readonly Conflict[],
    fallback: { readonly treeId: TreeId; readonly seq: AuthoredSeq },
  ) => Promise<void>
}

const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

const decodeList = Schema.decodeUnknownEither(Schema.parseJson(BaseList))

/**
 * Base copies under `bases/` beside the config file, one folder each:
 * `list.json` with every file's hash and the open conflicts, and `blobs/`
 * with the text files by their hash. Readable only by their owner.
 */
export const baseStore = (configPath: string): BaseStore => {
  const root = join(dirname(configPath), 'bases')
  const folderOf = (key: BaseKey) =>
    join(
      root,
      createHash('sha256')
        .update(`${key.deployment}\n${key.node}\n${key.folder}`)
        .digest('hex')
        .slice(0, 32),
    )
  const read = async (key: BaseKey): Promise<BaseList | null> => {
    let contents: string
    try {
      contents = await readFile(join(folderOf(key), 'list.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    // A copy that cannot be read is no copy: the next merge runs without one.
    const decoded = decodeList(contents)
    return Either.isRight(decoded) ? decoded.right : null
  }
  /** A blob's bytes when they still hash to its name, else null. */
  const blobAt = async (path: string, sha256: string) => {
    const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    return bytes !== null && sha256Of(bytes) === sha256 ? bytes : null
  }
  const writeList = (key: BaseKey, next: BaseList) =>
    updateJsonFile<BaseList | null>(
      join(folderOf(key), 'list.json'),
      async () => null,
      () => next,
      {},
      `the base copy of ${key.folder}`,
    )
  return {
    get: async (key) => {
      const list = await read(key)
      return list === null
        ? null
        : {
            treeId: list.treeId,
            seq: list.seq,
            files: list.files,
            conflicts: list.conflicts,
          }
    },
    text: async (key, sha256) => {
      const bytes = await blobAt(join(folderOf(key), 'blobs', sha256), sha256)
      return bytes === null ? null : bytes.toString('utf8')
    },
    set: async (key, copy, texts) => {
      const folder = folderOf(key)
      const blobs = join(folder, 'blobs')
      await mkdir(blobs, { recursive: true, mode: 0o700 })
      await chmod(folder, 0o700)
      for (const [sha256, bytes] of texts) {
        const path = join(blobs, sha256)
        if ((await blobAt(path, sha256)) !== null) continue
        // Written whole under a temporary name, then renamed into place, so
        // a blob is never half there.
        const temporary = join(blobs, `.${sha256}.${randomUUID()}.tmp`)
        try {
          const handle = await open(
            temporary,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
          )
          try {
            await handle.writeFile(bytes)
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      await writeList(key, {
        version: 1,
        node: key.node,
        folder: key.folder,
        treeId: copy.treeId,
        seq: copy.seq,
        files: copy.files,
        conflicts: copy.conflicts,
      })
      // Blobs the new list does not name belong to an older base.
      const kept = new Set(texts.keys())
      for (const name of await readdir(blobs)) {
        if (!kept.has(name as Sha256)) {
          await rm(join(blobs, name), { force: true })
        }
      }
    },
    addConflicts: async (key, conflicts, fallback) => {
      const list = await read(key)
      await mkdir(folderOf(key), { recursive: true, mode: 0o700 })
      await writeList(
        key,
        list === null
          ? {
              version: 1,
              node: key.node,
              folder: key.folder,
              treeId: fallback.treeId,
              seq: fallback.seq,
              files: {},
              conflicts,
            }
          : { ...list, conflicts: [...list.conflicts, ...conflicts] },
      )
    },
  }
}

/** Why a conflict is not resolved yet, or null once it is. */
const openReason = async (
  folder: string,
  conflict: Conflict,
): Promise<string | null> => {
  switch (conflict.kind) {
    case 'text': {
      const text = await readFile(join(folder, conflict.path), 'utf8').catch(
        () => null,
      )
      return text !== null && hasMarkers(text)
        ? `${conflict.path} still has conflict markers`
        : null
    }
    case 'binary': {
      if (conflict.theirs === null) return null
      const there = await lstat(join(folder, conflict.theirs)).catch(() => null)
      return there === null ? null : `${conflict.theirs} is still in the folder`
    }
    // Keeping the file or deleting it both resolve it; push sends either.
    case 'deleted-here':
    case 'deleted-there':
      return null
  }
}

/** The conflicts still open in a folder, each with why. */
export const openConflicts = async (
  folder: string,
  conflicts: readonly Conflict[],
): Promise<{ readonly conflict: Conflict; readonly reason: string }[]> => {
  const pending: { conflict: Conflict; reason: string }[] = []
  for (const conflict of conflicts) {
    const reason = await openReason(folder, conflict)
    if (reason !== null) pending.push({ conflict, reason })
  }
  return pending
}
