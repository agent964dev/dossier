import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import {
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import {
  AuthoredSeq,
  DossierError,
  dossierError,
  type EntryWire,
  isNodeName,
  isPageFile,
  type LinkRef,
  type LsResponse,
  type PushNumber,
  type PushPlanWire,
  type Sha256,
  type ShareSpec,
  TreeId,
} from '@dossier/contracts'
import {
  analyze,
  checkPush,
  companionOf,
  describeProblems,
  type HtmlAnalysis,
  pathProblems,
  type PushCheck,
  type PushFile,
  type TreeView,
} from '@dossier/html'
import { Context, Effect, Either, Layer, Schema } from 'effect'

import {
  type BaseKey,
  type BaseStore,
  baseStore,
  type Conflict,
  openConflicts,
} from './bases.ts'
import { callApi, rawCall } from './client.ts'
import { updateJsonFile } from './config.ts'
import { attempt, type Deployment } from './deployment.ts'
import { IGNORE_FILE, type IgnoreRule, ignoreRule } from './ignore.ts'
import { Cli, sleep } from './io.ts'
import { decide, mergeText, textOf, theirsPath } from './merge.ts'
import { type CliProblem, problem, unresolved, usage } from './render.ts'

export type SyncError = DossierError | CliProblem

export const MiB = 1024 * 1024

/** What one push may hold, checked here before any request. */
export const LIMITS = {
  fileBytes: 50 * MiB,
  files: 2_000,
  totalBytes: 500 * MiB,
} as const

/**
 * Downloads in flight at once: each waits mostly on the network, so more at
 * once finish a pull of many small files sooner.
 */
const IN_FLIGHT = 32
/**
 * Uploads in flight at once, and the bytes they hold between them (a larger
 * file takes all of them). Node's fetch sends them as streams of one HTTP/2
 * connection, and Cloudflare resets the streams in flight with
 * ENHANCE_YOUR_CALM when many request bodies arrive at once: a push of 229
 * media files met it within seconds at 32 or 8 at once, and rarely at 4.
 * `rawCall` tries a reset upload again.
 */
const UPLOADS_IN_FLIGHT = 4
const UPLOAD_BYTES_IN_FLIGHT = 16 * MiB
/** Uploads a purge holds are tried again this many times, waiting longer. */
const RECLAIM_TRIES = 5
const RECLAIM_WAIT_MS = 2_000

export interface LocalFile {
  /** Inside the pushed folder, with `/` between segments. */
  readonly path: string
  readonly abs: string
  readonly sha256: Sha256
  readonly size: number
  /** Every `.html` file's analysis; null for any other file. */
  readonly analysis: HtmlAnalysis | null
}

export interface LocalPlan {
  readonly files: readonly LocalFile[]
  /** Left out by the ignore rules; a folder ends in `/`. */
  readonly ignored: readonly string[]
  readonly bytes: number
  /** No problems, or the plan would have failed; warnings pass through. */
  readonly check: PushCheck
}

/** One folder on this machine, synced with one node of one tree. */
export interface HeadKey {
  readonly deployment: string
  readonly workspace: string
  readonly tree: string
  /** Inside the tree; '' is the root. */
  readonly path: string
  /** The local folder's absolute, real path. */
  readonly folder: string
}

/** The tree and its authored sequence this folder last pulled or pushed. */
export interface Head {
  readonly treeId: TreeId
  readonly seq: AuthoredSeq
}

export interface HeadStore {
  readonly get: (key: HeadKey) => Promise<Head | null>
  readonly set: (key: HeadKey, head: Head) => Promise<void>
}

export interface PushOutcome {
  /** The new push's number; the tree's latest when nothing changed. */
  readonly number: PushNumber | null
  readonly link: string
  readonly plan: PushPlanWire
  readonly dryRun: boolean
  /** False for a dry run and for a push with nothing to change. */
  readonly committed: boolean
  /** As the deployment sent them: a newer deployment may add codes. */
  readonly warnings: readonly PushPlanWire['warnings'][number][]
}

export interface PullOutcome {
  /** Inside the pulled folder, sorted. */
  readonly written: readonly string[]
  readonly unchanged: number
  readonly seq: AuthoredSeq
  /** The newest push among the pulled entries. */
  readonly push: PushNumber | null
  /** The local folder's absolute path. */
  readonly dir: string
}

/** One file a merge changed, kept or could not merge. */
export interface MergeFile {
  /** Inside the folder. */
  readonly path: string
  readonly result: 'taken' | 'kept' | 'merged' | 'conflict' | 'deleted'
  /** A conflict's kind; null for any other result. */
  readonly conflict: Conflict['kind'] | null
  /** A binary conflict: where theirs was written, inside the folder. */
  readonly theirs: string | null
  /** Kept: the folder deleted it, and it stays deleted. */
  readonly deletedHere: boolean
}

export interface MergeOutcome {
  /** Sorted by path; files both sides hold alike are not listed. */
  readonly files: readonly MergeFile[]
  /** Files both sides hold alike. */
  readonly unchanged: number
  readonly conflicts: number
  /** Whether the folder had a base copy; without one, every difference is a conflict. */
  readonly base: boolean
  readonly seq: AuthoredSeq
  /** The newest push among the merged entries. */
  readonly push: PushNumber | null
  /** The local folder's absolute path. */
  readonly dir: string
}

export interface SyncService {
  /**
   * `at` is the path inside the tree the folder is pushed to, so its pages'
   * forms are checked where they will live.
   */
  readonly plan: (
    dir: string,
    at?: string,
  ) => Effect.Effect<LocalPlan, SyncError>
  readonly push: (i: {
    readonly dir: string
    readonly target: LinkRef
    readonly message: string | null
    readonly dryRun: boolean
    readonly force: boolean
    /** Shares the push gives the node it lands on; the dry run checks them. */
    readonly share?: readonly ShareSpec[]
  }) => Effect.Effect<PushOutcome, SyncError>
  readonly pull: (i: {
    readonly target: LinkRef
    readonly dir: string
  }) => Effect.Effect<PullOutcome, SyncError>
  /**
   * Brings the tree's changes into the folder and keeps the folder's own:
   * a three-way merge per file against the base copy of the last sync.
   */
  readonly merge: (i: {
    readonly target: LinkRef
    readonly dir: string
  }) => Effect.Effect<MergeOutcome, SyncError>
}

/** The deployment Sync talks to, and the agent key it acts with there. */
export interface RemoteService {
  readonly deployment: Deployment
  readonly key: string
}
export class Remote extends Context.Tag('dossier/Remote')<
  Remote,
  RemoteService
>() {}

export class Sync extends Context.Tag('dossier/Sync')<Sync, SyncService>() {}

/** `workspace/tree[/path]`, as the API reads a target. */
export const targetString = (ref: LinkRef): string =>
  ref.path === ''
    ? `${ref.workspace}/${ref.tree}`
    : `${ref.workspace}/${ref.tree}/${ref.path}`

const joinPath = (folder: string, name: string): string =>
  folder === '' ? name : `${folder}/${name}`

const sha256Of = (bytes: Uint8Array): Sha256 =>
  createHash('sha256').update(bytes).digest('hex') as Sha256

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// ---------------------------------------------------------------- planning

/** `51 MiB`, or `50.1 MiB` just above a limit, never rounded down to it. */
export const formatMiB = (bytes: number): string => {
  const tenths = Math.ceil((bytes / MiB) * 10) / 10
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)} MiB`
}

const count = (n: number): string => n.toLocaleString('en-US')

const RAISE = 'A super admin can raise it.'

interface Found {
  readonly path: string
  readonly abs: string
  readonly size: number
}

/** Every file to push, sorted by path, and what the ignore rules left out. */
const walk = async (
  dir: string,
): Promise<{ files: Found[]; ignored: string[] }> => {
  const rule = await ignoreRule(dir)
  const files: Found[] = []
  const ignored: string[] = []
  const visit = async (abs: string, rel: string): Promise<void> => {
    const entries = await readdir(abs, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = joinPath(rel, entry.name)
      const entryAbs = join(abs, entry.name)
      let isFolder = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        // A link to a file is pushed as the file; a linked folder is not
        // followed, so a loop cannot run forever.
        const target = await stat(entryAbs).catch(() => null)
        isFile = target?.isFile() ?? false
        isFolder = false
        if (target?.isDirectory()) {
          ignored.push(`${path}/`)
          continue
        }
      }
      if (!isFolder && !isFile) continue
      if (rule(path, isFolder)) {
        ignored.push(isFolder ? `${path}/` : path)
        continue
      }
      if (isFolder) await visit(entryAbs, path)
      else
        files.push({ path, abs: entryAbs, size: (await stat(entryAbs)).size })
    }
  }
  await visit(dir, '')
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, ignored }
}

/** The local limits, before anything is read or sent. */
const checkLimits = (files: readonly Found[]): DossierError | null => {
  const big = files.find((file) => file.size > LIMITS.fileBytes)
  if (big !== undefined) {
    return dossierError(
      'too_large',
      `${big.path} is ${formatMiB(big.size)}; one file in a push may be at ` +
        `most ${formatMiB(LIMITS.fileBytes)}. ${RAISE}`,
      `Leave it out with a ${IGNORE_FILE}, or ask a super admin to raise ` +
        'the limit.',
      big.path,
    )
  }
  if (files.length > LIMITS.files) {
    return dossierError(
      'too_large',
      `This folder holds ${count(files.length)} files; a push may hold at ` +
        `most ${count(LIMITS.files)} files. ${RAISE}`,
      `List files to leave out in a ${IGNORE_FILE}, or push smaller folders ` +
        'to paths inside the tree.',
    )
  }
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > LIMITS.totalBytes) {
    return dossierError(
      'too_large',
      `This folder holds ${formatMiB(total)}; a push may hold at most ` +
        `${formatMiB(LIMITS.totalBytes)} in total. ${RAISE}`,
      `List files to leave out in a ${IGNORE_FILE}, or push smaller folders ` +
        'to paths inside the tree.',
    )
  }
  return null
}

/**
 * The pushed folder as the tree will see it: pages, other files and folders,
 * at `at` inside the tree. Paths outside it are unknown here; the deployment
 * checks them against the whole tree.
 */
const localTree = (paths: readonly string[], at: string): TreeView => {
  const kinds = new Map<string, 'page' | 'file' | 'folder'>([['', 'folder']])
  if (at !== '') {
    const parts = at.split('/')
    parts.forEach((_, i) =>
      kinds.set(parts.slice(0, i + 1).join('/'), 'folder'),
    )
  }
  for (const path of paths) {
    kinds.set(path, isPageFile(path) ? 'page' : 'file')
    let slash = path.lastIndexOf('/')
    while (slash > 0) {
      kinds.set(path.slice(0, slash), 'folder')
      slash = path.lastIndexOf('/', slash - 1)
    }
  }
  // The CLI cannot see the tree above the folder or the base layer, so every
  // component counts as found; the deployment's warnings are the ones shown.
  return {
    kindAt: (path) => kinds.get(path) ?? null,
    componentAt: () => true,
  }
}

const readLocal = (found: Found): Effect.Effect<LocalFile, CliProblem> =>
  Effect.gen(function* () {
    const bytes = yield* attempt(() => readFile(found.abs))
    const analysis = isPageFile(found.path)
      ? yield* Effect.try({
          try: () => analyze(new TextDecoder().decode(bytes)),
          catch: (error) =>
            problem(`${found.path} could not be read: ${messageOf(error)}`),
        })
      : null
    return {
      path: found.path,
      abs: found.abs,
      sha256: sha256Of(bytes),
      size: bytes.byteLength,
      analysis,
    }
  })

/**
 * Walks a folder, leaves out what the ignore rules name, checks the local
 * limits, hashes every file and checks its pages as a push would.
 */
export const planFolder = (
  dir: string,
  at = '',
): Effect.Effect<LocalPlan, SyncError> =>
  Effect.gen(function* () {
    const root = resolve(dir)
    const { files: found, ignored } = yield* attempt(() => walk(root))
    const limit = checkLimits(found)
    if (limit !== null) return yield* Effect.fail(limit)
    const files = yield* Effect.forEach(found, readLocal, { concurrency: 4 })
    const inTree = (path: string) => joinPath(at, path)
    const pages: PushFile[] = files.flatMap((file) =>
      file.analysis === null
        ? []
        : [{ path: inTree(file.path), analysis: file.analysis }],
    )
    const check = yield* Effect.try({
      try: () => {
        const result = checkPush(
          pages,
          localTree(
            files.map((file) => inTree(file.path)),
            at,
          ),
        )
        return {
          problems: [
            ...files.flatMap((file) => pathProblems(inTree(file.path))),
            ...result.problems,
          ],
          // A companion outside the folder may well be in the tree, which
          // only the deployment sees.
          warnings: result.warnings.filter((warning) => {
            if (warning.code !== 'companion_missing') return true
            const page = pages.find((p) => p.path === warning.path)
            const companion =
              page === undefined ? null : companionOf(page.path, page.analysis)
            return (
              companion !== null &&
              (at === '' || companion.startsWith(`${at}/`))
            )
          }),
        }
      },
      catch: (error) =>
        problem(`The pages could not be checked: ${messageOf(error)}`),
    })
    if (check.problems.length > 0) {
      const described = describeProblems(check.problems)
      return yield* Effect.fail(
        dossierError(
          'policy_rejected',
          described.message,
          described.fix,
          described.path,
        ),
      )
    }
    return {
      files,
      ignored,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      check,
    }
  })

// -------------------------------------------------------------- head store

const HeadSchema = Schema.Struct({ treeId: TreeId, seq: AuthoredSeq })
const Folders = Schema.Record({ key: Schema.String, value: HeadSchema })
const Nodes = Schema.Record({ key: Schema.String, value: Folders })
const HeadsFile = Schema.Struct({
  version: Schema.Literal(1),
  /** deployment → `workspace/tree[/path]` → local folder → head. */
  heads: Schema.Record({ key: Schema.String, value: Nodes }),
})
type HeadsFile = typeof HeadsFile.Type

const emptyHeads: HeadsFile = { version: 1, heads: {} }
const decodeHeads = Schema.decodeUnknownEither(Schema.parseJson(HeadsFile))

const readHeads = async (path: string): Promise<HeadsFile> => {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyHeads
    throw error
  }
  const decoded = decodeHeads(contents)
  if (Either.isLeft(decoded)) {
    throw problem(
      `The record of pulls and pushes ${path} cannot be read.`,
      'Remove it, then pull each folder again or push it with --force.',
    )
  }
  return decoded.right
}

const own = <V>(
  record: Readonly<Record<string, V>> | undefined,
  key: string,
) =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined

const nodeKey = (key: HeadKey): string => targetString({ ...key, folder: true })

/**
 * Heads in `heads.json` beside the config file, changed under the same lock
 * with the same temporary file, sync and rename, readable only by its owner.
 */
export const headStore = (configPath: string): HeadStore => {
  const path = join(dirname(configPath), 'heads.json')
  return {
    get: async (key) => {
      const file = await readHeads(path)
      const nodes = own(file.heads, key.deployment)
      return own(own(nodes, nodeKey(key)), key.folder) ?? null
    },
    set: async (key, head) => {
      await updateJsonFile(
        path,
        readHeads,
        (file) => {
          const nodes = own(file.heads, key.deployment) ?? {}
          const folders = own(nodes, nodeKey(key)) ?? {}
          return {
            ...file,
            heads: {
              ...file.heads,
              [key.deployment]: {
                ...nodes,
                [nodeKey(key)]: { ...folders, [key.folder]: head },
              },
            },
          }
        },
        {},
        'the record of pulls and pushes',
      )
    },
  }
}

// -------------------------------------------------------------------- push

const isCode = (error: unknown, code: DossierError['code']): boolean =>
  error instanceof DossierError && error.code === code

/** Uploads one file's bytes, waiting and trying again while a purge holds them. */
const upload = (
  remote: RemoteService,
  pushId: string,
  file: LocalFile,
): Effect.Effect<void, SyncError, Cli> =>
  Effect.gen(function* () {
    const { io } = yield* Cli
    const wait = io.sleep ?? sleep
    const bytes = yield* attempt(() => readFile(file.abs))
    if (sha256Of(bytes) !== file.sha256) {
      return yield* Effect.fail(
        problem(
          `${file.path} changed while it was being pushed.`,
          'Push again.',
        ),
      )
    }
    const path =
      `/_/api/pushes/${encodeURIComponent(pushId)}/blobs/` + file.sha256
    for (let tries = 1; ; tries += 1) {
      const answer = yield* Effect.either(
        rawCall(remote.deployment, remote.key, {
          method: 'PUT',
          path,
          body: bytes,
        }),
      )
      if (Either.isRight(answer)) {
        if (answer.right.status === 201) return
        return yield* Effect.fail(
          problem(
            `${remote.deployment.id} answered the upload of ${file.path} ` +
              `with HTTP ${answer.right.status}.`,
            'Run `dossier update` to get the CLI this deployment speaks.',
          ),
        )
      }
      if (!isCode(answer.left, 'blob_reclaiming') || tries >= RECLAIM_TRIES) {
        return yield* Effect.fail(answer.left)
      }
      yield* Effect.promise((signal) => wait(RECLAIM_WAIT_MS * tries, signal))
    }
  })

const saveHead = (heads: HeadStore, key: HeadKey, head: Head) =>
  Effect.tryPromise({
    try: () => heads.set(key, head),
    catch: (error) =>
      problem(
        'The tree is up to date with this folder, but this machine could ' +
          `not record it: ${messageOf(error)}`,
        'Pull the folder before its next push, or push it with --force.',
      ),
  })

const baseKeyOf = (key: HeadKey): BaseKey => ({
  deployment: key.deployment,
  node: nodeKey(key),
  folder: key.folder,
})

/**
 * Files a merge left in conflict and nobody resolved yet stop the next push
 * and the next merge, with or without --force.
 */
const refuseOpen = (
  bases: BaseStore,
  key: HeadKey,
  next: 'push' | 'merge',
): Effect.Effect<void, SyncError> =>
  Effect.gen(function* () {
    const copy = yield* attempt(() => bases.get(baseKeyOf(key)))
    const pending = yield* attempt(() =>
      openConflicts(key.folder, copy?.conflicts ?? []),
    )
    const [first] = pending
    if (first === undefined) return
    const files = pending.length === 1 ? 'A file' : `${pending.length} files`
    return yield* Effect.fail(
      unresolved(
        `${files} from dossier pull --merge ${pending.length === 1 ? 'is' : 'are'} ` +
          `not resolved: ${pending.map((o) => o.reason).join('; ')}.`,
        'In a text file, keep the right lines and remove the marker lines; ' +
          'for a binary file, keep one version and delete its .theirs file. ' +
          `Then ${next === 'push' ? 'push' : 'run dossier pull --merge'} again.`,
        first.conflict.path,
      ),
    )
  })

/**
 * Keeps the files as the base of the next merge: every hash, and the bytes
 * of the text files. `bytesOf` answers a file's bytes, or null when they
 * are not at hand.
 */
const saveBase = (
  bases: BaseStore,
  key: HeadKey,
  head: Head,
  files: ReadonlyMap<string, Sha256>,
  bytesOf: (path: string, sha256: Sha256) => Promise<Uint8Array | null>,
  conflicts: readonly Conflict[],
) =>
  Effect.tryPromise({
    try: async () => {
      const texts = new Map<Sha256, Uint8Array>()
      for (const [path, sha256] of files) {
        if (texts.has(sha256)) continue
        const bytes = await bytesOf(path, sha256)
        if (
          bytes !== null &&
          sha256Of(bytes) === sha256 &&
          textOf(bytes) !== null
        ) {
          texts.set(sha256, bytes)
        }
      }
      await bases.set(
        baseKeyOf(key),
        {
          treeId: head.treeId,
          seq: head.seq,
          files: Object.fromEntries(files),
          conflicts,
        },
        texts,
      )
    },
    catch: (error) =>
      problem(
        'The tree is up to date with this folder, but this machine could ' +
          `not keep the copy the next merge starts from: ${messageOf(error)}`,
        'The next dossier pull --merge treats every difference as a ' +
          'conflict. Pull or push the folder again to keep the copy.',
      ),
  })

/** Reads a file in the folder, or null when it is not there. */
const bytesAt = (abs: string) => readFile(abs).catch(() => null)

/** The pushed files as the base: all but those the tree keeps as data. */
const savePushed = (
  bases: BaseStore,
  key: HeadKey,
  head: Head,
  local: LocalPlan,
  plan: PushPlanWire,
) => {
  const prefix = key.path === '' ? '' : `${key.path}/`
  const data = new Set(
    plan.ignored.map((ignored) =>
      ignored.path.startsWith(prefix)
        ? ignored.path.slice(prefix.length)
        : ignored.path,
    ),
  )
  const kept = local.files.filter((file) => !data.has(file.path))
  const abs = new Map(kept.map((file) => [file.path, file.abs]))
  return saveBase(
    bases,
    key,
    head,
    new Map(kept.map((file) => [file.path, file.sha256])),
    (path) => bytesAt(abs.get(path) ?? ''),
    [],
  )
}

const pushWith = (
  remote: RemoteService,
  heads: HeadStore,
  bases: BaseStore,
  i: Parameters<SyncService['push']>[0],
): Effect.Effect<PushOutcome, SyncError, Cli> =>
  Effect.gen(function* () {
    const folder = yield* attempt(() => realpath(i.dir))
    const key: HeadKey = {
      deployment: remote.deployment.id,
      workspace: i.target.workspace,
      tree: i.target.tree,
      path: i.target.path,
      folder,
    }
    yield* refuseOpen(bases, key, 'push')
    const local = yield* planFolder(i.dir, i.target.path)
    const base = i.force ? null : yield* attempt(() => heads.get(key))
    const stage = yield* callApi(remote.deployment, remote.key, (client) =>
      client.pushes.stage({
        payload: {
          target: targetString(i.target),
          baseSeq: base?.seq ?? null,
          baseTree: base?.treeId ?? null,
          force: i.force,
          dryRun: i.dryRun,
          message: i.message,
          share: i.share ?? [],
          files: local.files.map((file) => ({
            path: file.path,
            sha256: file.sha256,
            size: file.size,
          })),
        },
      }),
    )
    // The local check runs on the folder alone; the deployment's runs on the
    // tree as it will be, so its warnings come first.
    const warningsOf = (
      plan: PushPlanWire,
    ): readonly PushPlanWire['warnings'][number][] =>
      plan.warnings.length > 0 ? plan.warnings : local.check.warnings
    if (i.dryRun) {
      return {
        number: null,
        link: stage.link,
        plan: stage.plan,
        dryRun: true,
        committed: false,
        warnings: warningsOf(stage.plan),
      }
    }
    if (stage.pushId === null) {
      if (stage.tree !== null) {
        const head = { treeId: stage.tree.id, seq: stage.tree.seq }
        yield* saveHead(heads, key, head)
        yield* savePushed(bases, key, head, local, stage.plan)
      }
      return {
        number: stage.tree?.push ?? null,
        link: stage.link,
        plan: stage.plan,
        dryRun: false,
        committed: false,
        warnings: warningsOf(stage.plan),
      }
    }
    const pushId = stage.pushId
    const byHash = new Map(local.files.map((file) => [file.sha256, file]))
    const missing = yield* Effect.forEach(stage.missing, (sha256) => {
      const file = byHash.get(sha256)
      return file === undefined
        ? Effect.fail(
            problem(
              `${remote.deployment.id} asked for a file this push does not hold.`,
              'Run `dossier update`, then push again.',
            ),
          )
        : Effect.succeed(file)
    })
    const bytesInFlight = yield* Effect.makeSemaphore(UPLOAD_BYTES_IN_FLIGHT)
    yield* Effect.forEach(
      missing,
      (file) =>
        bytesInFlight.withPermits(
          Math.max(1, Math.min(file.size, UPLOAD_BYTES_IN_FLIGHT)),
        )(upload(remote, pushId, file)),
      { concurrency: UPLOADS_IN_FLIGHT, discard: true },
    )
    const commit = yield* callApi(remote.deployment, remote.key, (client) =>
      client.pushes.commit({ path: { pushId } }),
    )
    const head = { treeId: commit.treeId, seq: commit.seq }
    yield* saveHead(heads, key, head)
    yield* savePushed(bases, key, head, local, commit.plan)
    return {
      number: commit.number,
      link: commit.link,
      plan: commit.plan,
      dryRun: false,
      committed: true,
      warnings: warningsOf(commit.plan),
    }
  })

// -------------------------------------------------------------------- pull

const NO_FOLLOW_CREATE =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_WRONLY |
  constants.O_NOFOLLOW

const throughLink = (root: string, rel: string) =>
  problem(
    `A folder on the way to ${rel} in ${root} is a symbolic link, so it is ` +
      'not pulled through it.',
    'Remove the link, or pull into another folder.',
  )

/**
 * The folder `rel` sits in, made folder by folder under `root`, and proved
 * to be that folder itself, not a link to somewhere else.
 */
const containedFolder = async (root: string, rel: string): Promise<string> => {
  const segments = rel.split('/').slice(0, -1)
  let at = root
  for (const segment of segments) {
    at = join(at, segment)
    await mkdir(at).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const info = await lstat(at)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw throughLink(root, rel)
    }
  }
  if ((await realpath(at)) !== at) throw throughLink(root, rel)
  return at
}

/**
 * Writes a file inside `root` without following any link: the folder is
 * checked just before the temporary file is opened with no-follow, and again
 * just before it is renamed over the path.
 */
const writeInside = async (
  root: string,
  rel: string,
  bytes: Uint8Array,
  readOnly: boolean,
): Promise<void> => {
  const folder = await containedFolder(root, rel)
  const name = basename(rel)
  const temporary = join(folder, `.${name}.${randomUUID()}.tmp`)
  try {
    const handle = await open(
      temporary,
      NO_FOLLOW_CREATE,
      readOnly ? 0o444 : 0o666,
    )
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (readOnly) await chmod(temporary, 0o444)
    if ((await realpath(folder)) !== folder) throw throughLink(root, rel)
    const existing = await lstat(join(folder, name)).catch(() => null)
    if (existing?.isSymbolicLink() === true) throw throughLink(root, rel)
    await rename(temporary, join(folder, name))
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Makes an unchanged file read only, inside `root` and through no link. */
const readOnlyInside = async (root: string, rel: string): Promise<void> => {
  const folder = await containedFolder(root, rel)
  const path = join(folder, basename(rel))
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw throughLink(root, rel)
  await chmod(path, 0o444)
}

/**
 * The first part of `rel` under `root`, folder by folder and the entry
 * itself, that is a symbolic link, or null.
 */
const linkOnTheWay = async (
  root: string,
  rel: string,
): Promise<string | null> => {
  const segments = rel.split('/')
  for (let i = 1; i <= segments.length; i += 1) {
    const part = segments.slice(0, i).join('/')
    const info = await lstat(join(root, part)).catch(() => null)
    if (info === null) return null
    if (info.isSymbolicLink()) return part
  }
  return null
}

/** Whether the local copy already holds these bytes. */
const sameLocal = async (path: string, entry: EntryWire): Promise<boolean> => {
  if (entry.sha256 === null) return false
  const info = await stat(path).catch(() => null)
  if (info === null || !info.isFile()) return false
  if (entry.size !== null && info.size !== entry.size) return false
  return sha256Of(await readFile(path)) === entry.sha256
}

/** A listed entry and where it lands inside the folder. */
interface Placed {
  readonly entry: EntryWire
  /** Inside the folder, with `/` between segments. */
  readonly rel: string
  readonly abs: string
}

/** Where each listed entry lands inside the folder, checked name by name. */
const placeAll = (
  remote: RemoteService,
  ls: LsResponse,
  folder: string,
): Effect.Effect<Placed[], CliProblem> => {
  const prefix = ls.path === '' ? '' : `${ls.path}/`
  return Effect.forEach(ls.entries, (entry) => {
    const inside =
      entry.path === ls.path
        ? entry.name
        : prefix === '' || entry.path.startsWith(prefix)
          ? entry.path.slice(prefix.length)
          : null
    const segments = inside === null ? [] : inside.split('/')
    if (segments.length === 0 || !segments.every(isNodeName)) {
      return Effect.fail(
        problem(
          `${remote.deployment.id} listed ${entry.path}, which is not ` +
            'inside the pulled folder.',
          'Run `dossier update`, then pull again.',
        ),
      )
    }
    return Effect.succeed({
      entry,
      rel: segments.join('/'),
      abs: join(folder, ...segments),
    })
  })
}

/**
 * Nothing is written through a link: every folder on the way to a path, and
 * the path itself, must not be a symbolic link.
 */
const noLinks = (
  folder: string,
  paths: readonly { readonly rel: string; readonly shown: string }[],
) =>
  Effect.forEach(
    paths,
    ({ rel, shown }) =>
      attempt(() => linkOnTheWay(folder, rel)).pipe(
        Effect.flatMap((link) =>
          link === null
            ? Effect.void
            : Effect.fail(
                problem(
                  `${link} in ${folder} is a symbolic link, so ${shown} ` +
                    'is not pulled through it.',
                  'Remove the link, or pull into another folder.',
                ),
              ),
        ),
      ),
    { discard: true },
  )

/** A listed file's bytes, checked against the hash the listing gave. */
const download = (remote: RemoteService, ls: LsResponse, entry: EntryWire) =>
  Effect.gen(function* () {
    const response = yield* rawCall(remote.deployment, remote.key, {
      method: 'GET',
      path:
        '/_/api/file?path=' +
        encodeURIComponent(
          `${ls.tree.workspace}/${ls.tree.name}/${entry.path}`,
        ),
      accept: '*/*',
    })
    const bytes = new Uint8Array(yield* attempt(() => response.arrayBuffer()))
    if (entry.sha256 !== null && sha256Of(bytes) !== entry.sha256) {
      return yield* Effect.fail(
        problem(
          `${entry.path} arrived different from what ` +
            `${remote.deployment.id} listed.`,
          'Pull again.',
        ),
      )
    }
    return bytes
  })

/** Whether a path in the folder is people's data in the tree, or below it. */
const dataTest = (placed: readonly Placed[]) => {
  const data = new Set(
    placed.filter(({ entry }) => entry.kind === 'data').map(({ rel }) => rel),
  )
  return (rel: string) => {
    const segments = rel.split('/')
    return segments.some((_, i) => data.has(segments.slice(0, i + 1).join('/')))
  }
}

/** Whether push leaves a path out: the path itself, or a folder above it. */
const ignoredBy = (rule: IgnoreRule) => (rel: string) => {
  const segments = rel.split('/')
  return segments.some((_, i) =>
    rule(segments.slice(0, i + 1).join('/'), i < segments.length - 1),
  )
}

const newestPush = (ls: LsResponse): PushNumber | null => {
  const pushes = ls.entries.flatMap((entry) =>
    entry.push === null ? [] : [entry.push.number],
  )
  return pushes.length === 0 ? null : (Math.max(...pushes) as PushNumber)
}

const headKeyOf = (
  remote: RemoteService,
  target: LinkRef,
  folder: string,
): HeadKey => ({
  deployment: remote.deployment.id,
  workspace: target.workspace,
  tree: target.tree,
  path: target.path,
  folder,
})

const pullWith = (
  remote: RemoteService,
  heads: HeadStore,
  bases: BaseStore,
  i: Parameters<SyncService['pull']>[0],
): Effect.Effect<PullOutcome, SyncError, Cli> =>
  Effect.gen(function* () {
    const target = targetString(i.target)
    const ls = yield* callApi(remote.deployment, remote.key, (client) =>
      client.files.ls({ urlParams: { path: target, depth: 'all' } }),
    )
    yield* attempt(() => mkdir(i.dir, { recursive: true }))
    const folder = yield* attempt(() => realpath(i.dir))
    const all = yield* placeAll(remote, ls, folder)
    yield* noLinks(
      folder,
      all.map(({ entry, rel }) => ({ rel, shown: entry.path })),
    )
    yield* Effect.forEach(
      all.filter(({ entry }) => entry.folder),
      ({ abs }) => attempt(() => mkdir(abs, { recursive: true })),
      { discard: true },
    )
    const files = all.filter(({ entry }) => !entry.folder)
    const fetched = yield* Effect.forEach(
      files,
      ({ entry, rel, abs }) =>
        Effect.gen(function* () {
          if (yield* attempt(() => sameLocal(abs, entry))) {
            // An unchanged data file is still read only.
            if (entry.kind === 'data') {
              yield* attempt(() => readOnlyInside(folder, rel))
            }
            return null
          }
          const bytes = yield* download(remote, ls, entry)
          yield* attempt(() =>
            writeInside(folder, rel, bytes, entry.kind === 'data'),
          )
          return rel
        }),
      { concurrency: IN_FLIGHT },
    )
    const written = fetched
      .filter((rel): rel is string => rel !== null)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const key = headKeyOf(remote, i.target, folder)
    const head = { treeId: ls.tree.id, seq: ls.seq }
    yield* attempt(() => heads.set(key, head))
    // The authored files as pulled are the next merge's base; a conflict a
    // merge left that the pull did not settle stays open.
    const isData = dataTest(all)
    const authored = files.filter(
      ({ entry, rel }) => entry.sha256 !== null && !isData(rel),
    )
    const absOf = new Map(authored.map((p) => [p.rel, p.abs]))
    const previous = yield* attempt(() => bases.get(baseKeyOf(key)))
    const pending = yield* attempt(() =>
      openConflicts(folder, previous?.conflicts ?? []),
    )
    yield* saveBase(
      bases,
      key,
      head,
      new Map(authored.map(({ entry, rel }) => [rel, entry.sha256!])),
      (path) => bytesAt(absOf.get(path) ?? ''),
      pending.map((o) => o.conflict),
    )
    return {
      written,
      unchanged: files.length - written.length,
      seq: ls.seq,
      push: newestPush(ls),
      dir: folder,
    }
  })

// ------------------------------------------------------------------- merge

/** Whether anything, even a broken link, holds a path inside the folder. */
const existsInside = (root: string, rel: string): boolean => {
  try {
    lstatSync(join(root, rel))
    return true
  } catch {
    return false
  }
}

/** Deletes a file inside the folder, through no link. */
const removeInside = async (root: string, rel: string): Promise<void> => {
  if ((await linkOnTheWay(root, rel)) !== null) throw throughLink(root, rel)
  await rm(join(root, rel), { force: true })
}

const mergeWith = (
  remote: RemoteService,
  heads: HeadStore,
  bases: BaseStore,
  i: Parameters<SyncService['merge']>[0],
): Effect.Effect<MergeOutcome, SyncError, Cli> =>
  Effect.gen(function* () {
    const target = targetString(i.target)
    yield* attempt(() => mkdir(i.dir, { recursive: true }))
    const folder = yield* attempt(() => realpath(i.dir))
    const key = headKeyOf(remote, i.target, folder)
    const baseKey = baseKeyOf(key)
    yield* refuseOpen(bases, key, 'merge')
    const ls = yield* callApi(remote.deployment, remote.key, (client) =>
      client.files.ls({ urlParams: { path: target, depth: 'all' } }),
    )
    if (ls.entries.some((entry) => entry.path === ls.path && !entry.folder)) {
      return yield* Effect.fail(
        usage(
          `${target} is a file; dossier pull --merge merges a folder.`,
          'Give the folder it is in, as it is pushed.',
        ),
      )
    }
    const placed = yield* placeAll(remote, ls, folder)
    // People's data, and what push leaves out, are never merged.
    const isData = dataTest(placed)
    const isIgnored = ignoredBy(yield* attempt(() => ignoreRule(folder)))
    const merged = (rel: string) => !isData(rel) && !isIgnored(rel)
    const theirs = new Map(
      placed
        .filter(({ entry, rel }) => !entry.folder && merged(rel))
        .map((p) => [p.rel, p]),
    )
    const { files: found } = yield* attempt(() => walk(folder))
    const ours = new Map(
      yield* Effect.forEach(
        found.filter((file) => !isData(file.path)),
        (file) =>
          Effect.map(
            attempt(() => readFile(file.abs)),
            (bytes) =>
              [file.path, { abs: file.abs, sha: sha256Of(bytes) }] as const,
          ),
        { concurrency: 4 },
      ),
    )
    const copy = yield* attempt(() => bases.get(baseKey))
    const synced = yield* attempt(() => heads.get(key))
    // The copy counts only as the sync heads.json records: one older than
    // the last sync, or from another tree of the same name, is no base.
    const baseFiles =
      copy !== null &&
      synced !== null &&
      copy.treeId === ls.tree.id &&
      synced.treeId === copy.treeId &&
      synced.seq === copy.seq
        ? copy.files
        : null
    const baseOf = (rel: string): Sha256 | null | undefined =>
      baseFiles === null
        ? undefined
        : Object.hasOwn(baseFiles, rel)
          ? (baseFiles[rel] ?? null)
          : null
    // An authored file always has a hash.
    const theirSha = (rel: string) => theirs.get(rel)?.entry.sha256 ?? null
    const paths = [
      ...new Set([
        ...theirs.keys(),
        ...ours.keys(),
        ...Object.keys(baseFiles ?? {}).filter(merged),
      ]),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const steps = paths.map((rel) => ({
      rel,
      step: decide(baseOf(rel), ours.get(rel)?.sha ?? null, theirSha(rel)),
    }))
    const touched = steps.filter(({ step }) =>
      ['take', 'delete', 'merge', 'restore'].includes(step),
    )
    yield* noLinks(
      folder,
      touched.map(({ rel }) => ({ rel, shown: rel })),
    )
    // Where file names ignore letter case, a new path can be a file the
    // folder holds under another case. Only one this merge deletes first
    // may be replaced; anything else stops the merge before it changes a file.
    const deleting = new Set(
      steps.filter(({ step }) => step === 'delete').map(({ rel }) => rel),
    )
    for (const { rel, step } of steps) {
      if (step !== 'take' && step !== 'restore') continue
      // A file where the tree's path needs a folder stops it too, unless
      // this merge deletes that file first.
      const segments = rel.split('/')
      for (let n = 1; n < segments.length; n += 1) {
        const above = segments.slice(0, n).join('/')
        if (deleting.has(above) || !existsInside(folder, above)) continue
        if (!lstatSync(join(folder, above)).isDirectory()) {
          return yield* Effect.fail(
            problem(
              `${rel} in the tree needs a folder where ${folder} holds the ` +
                `file ${above}.`,
              'Move it out of the way, then run dossier pull --merge again.',
            ),
          )
        }
      }
      if (ours.has(rel) || !existsInside(folder, rel)) continue
      const alias = [...ours.keys()].find(
        (path) => path !== rel && path.toLowerCase() === rel.toLowerCase(),
      )
      if (alias === undefined) {
        return yield* Effect.fail(
          problem(
            `${rel} in the tree is where ${folder} holds a folder or a file ` +
              'the merge does not change.',
            'Move it out of the way, then run dossier pull --merge again.',
          ),
        )
      }
      if (!deleting.has(alias)) {
        return yield* Effect.fail(
          problem(
            `${rel} in the tree is the same file on this machine as ` +
              `${alias} in ${folder}: file names here ignore letter case.`,
            'Rename one so the names differ by more than letter case, then ' +
              'run dossier pull --merge again.',
          ),
        )
      }
    }
    const fetched = new Map(
      yield* Effect.forEach(
        touched.filter(({ step }) => step !== 'delete'),
        ({ rel }) =>
          Effect.map(
            download(remote, ls, theirs.get(rel)!.entry),
            (bytes) => [rel, bytes] as const,
          ),
        { concurrency: IN_FLIGHT },
      ),
    )
    const push = newestPush(ls)
    const label = push === null ? 'the tree' : `push ${push}`
    const files: MergeFile[] = []
    const conflicts: Conflict[] = []
    const reserved = new Set(paths)
    let unchanged = 0
    /**
     * A file is replaced or deleted only while it still holds what the
     * merge planned from: an edit made since stops the merge instead.
     */
    const unchangedSincePlan = (rel: string) =>
      Effect.gen(function* () {
        const now = yield* attempt(() => bytesAt(join(folder, rel)))
        const was = ours.get(rel)?.sha ?? null
        if ((now === null ? null : sha256Of(now)) === was) return
        return yield* Effect.fail(
          problem(
            `${rel} changed while dossier pull --merge ran, so the merge ` +
              'stopped before replacing it.',
            'Run dossier pull --merge again.',
          ),
        )
      })
    const write = (rel: string, bytes: Uint8Array) =>
      Effect.zipRight(
        unchangedSincePlan(rel),
        attempt(() => writeInside(folder, rel, bytes, false)),
      )
    const line = (
      rel: string,
      result: MergeFile['result'],
      more: Partial<MergeFile> = {},
    ) =>
      files.push({
        path: rel,
        result,
        conflict: null,
        theirs: null,
        deletedHere: false,
        ...more,
      })
    const conflict = (
      rel: string,
      kind: Conflict['kind'],
      at: string | null,
    ) => {
      conflicts.push({ path: rel, kind, theirs: at })
      line(rel, 'conflict', { conflict: kind, theirs: at })
    }
    // Deletions go first, so a file renamed only in letter case is written
    // after its old name is gone.
    const ordered = [
      ...steps.filter(({ step }) => step === 'delete'),
      ...steps.filter(({ step }) => step !== 'delete'),
    ]
    const apply = Effect.forEach(
      ordered,
      ({ rel, step }) =>
        Effect.gen(function* () {
          switch (step) {
            case 'nothing':
              unchanged += 1
              break
            case 'keep':
              line(rel, 'kept', { deletedHere: !ours.has(rel) })
              break
            case 'take':
              yield* write(rel, fetched.get(rel)!)
              line(rel, 'taken')
              break
            case 'delete':
              yield* unchangedSincePlan(rel)
              yield* attempt(() => removeInside(folder, rel))
              line(rel, 'deleted')
              break
            case 'restore':
              yield* write(rel, fetched.get(rel)!)
              conflict(rel, 'deleted-here', null)
              break
            case 'hold':
              conflict(rel, 'deleted-there', null)
              break
            case 'merge': {
              const theirBytes = fetched.get(rel)!
              yield* unchangedSincePlan(rel)
              const ourBytes = yield* attempt(() =>
                readFile(ours.get(rel)!.abs),
              )
              const ourText = textOf(ourBytes)
              const theirText = textOf(theirBytes)
              if (ourText !== null && theirText !== null) {
                // Without the base's text, as when the folder had no copy, the
                // two texts are one conflict, never a guess.
                const sha = baseOf(rel)
                const baseText =
                  sha === undefined || sha === null
                    ? null
                    : yield* attempt(() => bases.text(baseKey, sha))
                const result = mergeText(baseText, ourText, theirText, label)
                if (result.text !== ourText) {
                  yield* write(rel, new TextEncoder().encode(result.text))
                }
                if (result.conflicts === 0) line(rel, 'merged')
                else conflict(rel, 'text', null)
              } else {
                const at = theirsPath(
                  rel,
                  (path) => reserved.has(path) || existsInside(folder, path),
                )
                reserved.add(at)
                yield* attempt(() => writeInside(folder, at, theirBytes, false))
                conflict(rel, 'binary', at)
              }
              break
            }
          }
        }),
      { discard: true },
    )
    const head = { treeId: ls.tree.id, seq: ls.seq }
    // The tree as merged is the next merge's base.
    const save = saveBase(
      bases,
      key,
      head,
      new Map([...theirs].map(([rel, p]) => [rel, p.entry.sha256!])),
      async (rel, sha256) => {
        const got = fetched.get(rel)
        if (got !== undefined) return got
        const mine = ours.get(rel)
        if (mine?.sha === sha256) return bytesAt(mine.abs)
        const text = await bases.text(baseKey, sha256)
        return text === null ? null : new TextEncoder().encode(text)
      },
      conflicts,
    )
    // A merge that stops part way, or cannot keep its base, still keeps the
    // conflicts it wrote, so push waits for them.
    yield* Effect.zipRight(apply, save).pipe(
      Effect.catchAll((error) =>
        conflicts.length === 0
          ? Effect.fail(error)
          : attempt(() => bases.addConflicts(baseKey, conflicts, head)).pipe(
              Effect.zipRight(Effect.fail(error)),
              // When even that cannot be written, say which files hold
              // conflicts: push cannot know of them.
              Effect.catchTag('CliProblem', (unrecorded) =>
                unrecorded === error
                  ? Effect.fail(error)
                  : Effect.fail(
                      problem(
                        'The merge stopped, and this machine could not record ' +
                          'the conflicts it left in ' +
                          `${conflicts.map((c) => c.theirs ?? c.path).join(', ')}: ` +
                          `${unrecorded.message}`,
                        'Resolve those files before you push; push cannot see ' +
                          'these conflicts. Then run dossier pull --merge again.',
                      ),
                    ),
              ),
            ),
      ),
    )
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    yield* attempt(() => heads.set(key, head))
    return {
      files,
      unchanged,
      conflicts: conflicts.length,
      base: baseFiles !== null,
      seq: ls.seq,
      push,
      dir: folder,
    }
  })

// ------------------------------------------------------------------- layer

/** Sync for the deployment and key `Remote` names, with the running io. */
export const SyncLive: Layer.Layer<Sync, never, Cli | Remote> = Layer.effect(
  Sync,
  Effect.gen(function* () {
    const cli = yield* Cli
    const remote = yield* Remote
    const heads = headStore(cli.io.configPath)
    const bases = baseStore(cli.io.configPath)
    return {
      plan: planFolder,
      push: (i) =>
        pushWith(remote, heads, bases, i).pipe(Effect.provideService(Cli, cli)),
      pull: (i) =>
        pullWith(remote, heads, bases, i).pipe(Effect.provideService(Cli, cli)),
      merge: (i) =>
        mergeWith(remote, heads, bases, i).pipe(
          Effect.provideService(Cli, cli),
        ),
    }
  }),
)
