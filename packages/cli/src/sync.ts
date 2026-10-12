import { createHash, randomUUID } from 'node:crypto'
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
  type PushNumber,
  type PushPlanWire,
  type Sha256,
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

import { callApi, rawCall } from './client.ts'
import { updateJsonFile } from './config.ts'
import { attempt, type Deployment } from './deployment.ts'
import { IGNORE_FILE, ignoreRule } from './ignore.ts'
import { Cli, sleep } from './io.ts'
import { type CliProblem, problem } from './render.ts'

export type SyncError = DossierError | CliProblem

export const MiB = 1024 * 1024

/** What one push may hold, checked here before any request. */
export const LIMITS = {
  fileBytes: 50 * MiB,
  files: 2_000,
  totalBytes: 500 * MiB,
} as const

/** Files in flight at once, up or down. */
const IN_FLIGHT = 6
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
  }) => Effect.Effect<PushOutcome, SyncError>
  readonly pull: (i: {
    readonly target: LinkRef
    readonly dir: string
  }) => Effect.Effect<PullOutcome, SyncError>
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
      yield* Effect.promise(() => wait(RECLAIM_WAIT_MS * tries))
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

const pushWith = (
  remote: RemoteService,
  heads: HeadStore,
  i: Parameters<SyncService['push']>[0],
): Effect.Effect<PushOutcome, SyncError, Cli> =>
  Effect.gen(function* () {
    const local = yield* planFolder(i.dir, i.target.path)
    const folder = yield* attempt(() => realpath(i.dir))
    const key: HeadKey = {
      deployment: remote.deployment.id,
      workspace: i.target.workspace,
      tree: i.target.tree,
      path: i.target.path,
      folder,
    }
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
        yield* saveHead(heads, key, {
          treeId: stage.tree.id,
          seq: stage.tree.seq,
        })
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
    yield* Effect.forEach(missing, (file) => upload(remote, pushId, file), {
      concurrency: IN_FLIGHT,
      discard: true,
    })
    const commit = yield* callApi(remote.deployment, remote.key, (client) =>
      client.pushes.commit({ path: { pushId } }),
    )
    yield* saveHead(heads, key, { treeId: commit.treeId, seq: commit.seq })
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

const pullWith = (
  remote: RemoteService,
  heads: HeadStore,
  i: Parameters<SyncService['pull']>[0],
): Effect.Effect<PullOutcome, SyncError, Cli> =>
  Effect.gen(function* () {
    const target = targetString(i.target)
    const ls = yield* callApi(remote.deployment, remote.key, (client) =>
      client.files.ls({ urlParams: { path: target, depth: 'all' } }),
    )
    yield* attempt(() => mkdir(i.dir, { recursive: true }))
    const folder = yield* attempt(() => realpath(i.dir))
    const prefix = ls.path === '' ? '' : `${ls.path}/`

    /** Where an entry lands inside the pulled folder, checked name by name. */
    const placed = (entry: EntryWire) => {
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
    }
    const all = yield* Effect.forEach(ls.entries, placed)
    // Nothing is written through a link: every folder on the way to an
    // entry, and the entry itself, must not be a symbolic link.
    yield* Effect.forEach(
      all,
      ({ entry, rel }) =>
        attempt(() => linkOnTheWay(folder, rel)).pipe(
          Effect.flatMap((link) =>
            link === null
              ? Effect.void
              : Effect.fail(
                  problem(
                    `${link} in ${folder} is a symbolic link, so ${entry.path} ` +
                      'is not pulled through it.',
                    'Remove the link, or pull into another folder.',
                  ),
                ),
          ),
        ),
      { discard: true },
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
          const response = yield* rawCall(remote.deployment, remote.key, {
            method: 'GET',
            path:
              '/_/api/file?path=' +
              encodeURIComponent(
                `${ls.tree.workspace}/${ls.tree.name}/${entry.path}`,
              ),
            accept: '*/*',
          })
          const bytes = new Uint8Array(
            yield* attempt(() => response.arrayBuffer()),
          )
          if (entry.sha256 !== null && sha256Of(bytes) !== entry.sha256) {
            return yield* Effect.fail(
              problem(
                `${entry.path} arrived different from what ` +
                  `${remote.deployment.id} listed.`,
                'Pull again.',
              ),
            )
          }
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
    yield* attempt(() =>
      heads.set(
        {
          deployment: remote.deployment.id,
          workspace: i.target.workspace,
          tree: i.target.tree,
          path: i.target.path,
          folder,
        },
        { treeId: ls.tree.id, seq: ls.seq },
      ),
    )
    const pushes = ls.entries.flatMap((entry) =>
      entry.push === null ? [] : [entry.push.number],
    )
    return {
      written,
      unchanged: files.length - written.length,
      seq: ls.seq,
      push: pushes.length === 0 ? null : (Math.max(...pushes) as PushNumber),
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
    return {
      plan: planFolder,
      push: (i) =>
        pushWith(remote, heads, i).pipe(Effect.provideService(Cli, cli)),
      pull: (i) =>
        pullWith(remote, heads, i).pipe(Effect.provideService(Cli, cli)),
    }
  }),
)
