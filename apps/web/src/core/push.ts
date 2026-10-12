import {
  dossierError,
  linkFor,
  type AuthoredSeq,
  type DossierError,
  type LinkRef,
  type PersonId,
  type PushId,
  type PushNumber,
  type Sha256,
  type SessionId,
  type ShareSpec,
  type TreeId,
} from '@dossier/contracts'
import {
  ANALYZER_VERSION as ANALYZER,
  checkPush,
  closesAt,
  componentPath,
  describeProblems,
  formKind,
  formSchema,
  isKitName,
  isPageFile,
  pathProblems,
  resolveFormAction,
  type HtmlAnalysis,
  type PushFile,
  type PushProblem,
  type PushWarning,
  type TreeView,
} from '@dossier/html'
import { sql } from 'drizzle-orm'
import { Clock, Context, Data, Effect, Layer, Random } from 'effect'

import { db, schema } from '../db/client.ts'

import type { Background } from './background.ts'
import { Access, type Granted } from './access.ts'
import { BaseLayer } from './base-layer.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller, type Caller } from './caller.ts'
import { Config } from './config.ts'
import { newId } from './ids.ts'
import { Limits } from './limits.ts'
import { pageNeedsOf, type PageNeed, type PageNeedRow } from './page-needs.ts'
import { Shares } from './shares.ts'
import { ancestorPaths, type TreeRow, type WorkspaceRow } from './rows.ts'
import { blobKey, TreeStore, type NewShare } from './tree-store.ts'

export interface ManifestFile {
  /** Inside the pushed folder. */
  readonly path: string
  readonly sha256: Sha256
  readonly size: number
}

export interface StageInput {
  readonly target: LinkRef
  readonly baseSeq: AuthoredSeq | null
  /** The tree `baseSeq` belongs to; a base from another tree is no base. */
  readonly baseTree: TreeId | null
  readonly force: boolean
  readonly dryRun: boolean
  readonly message: string | null
  readonly files: readonly ManifestFile[]
  /** Shares the commit grants on the pushed folder. */
  readonly share?: readonly ShareSpec[]
}

export interface PushPlan {
  readonly createsTree: boolean
  /** Paths inside the tree. */
  readonly added: readonly string[]
  readonly changed: readonly string[]
  readonly deleted: readonly string[]
  readonly unchanged: number
  readonly ignored: readonly {
    readonly path: string
    readonly reason: 'data_path'
  }[]
  readonly warnings: readonly PushWarning[]
}

export interface StageResult {
  readonly pushId: PushId | null
  readonly missing: readonly Sha256[]
  readonly plan: PushPlan
  readonly link: string
  readonly tree: {
    readonly id: TreeId
    readonly seq: AuthoredSeq
    readonly push: PushNumber | null
  } | null
}

export interface CommitResult {
  readonly number: PushNumber
  readonly link: string
  readonly seq: AuthoredSeq
  readonly treeId: TreeId
  readonly plan: PushPlan
}

export interface PushService {
  readonly stage: (
    i: StageInput,
  ) => Effect.Effect<
    StageResult,
    DossierError<
      | 'not_found'
      | 'sign_in_required'
      | 'forbidden'
      | 'stale_head'
      | 'policy_rejected'
      | 'too_large'
      | 'rate_limited'
      | 'invalid'
      | 'unavailable'
    >,
    CurrentCaller
  >
  readonly putBlob: (i: {
    readonly pushId: PushId
    readonly sha256: Sha256
    readonly size: number
    readonly body: ReadableStream<Uint8Array>
  }) => Effect.Effect<
    void,
    DossierError<
      | 'not_found'
      | 'sign_in_required'
      | 'forbidden'
      | 'invalid'
      | 'too_large'
      | 'blob_reclaiming'
      | 'unavailable'
    >,
    CurrentCaller
  >
  readonly commit: (
    pushId: PushId,
  ) => Effect.Effect<
    CommitResult,
    DossierError<
      | 'not_found'
      | 'sign_in_required'
      | 'forbidden'
      | 'invalid'
      | 'too_large'
      | 'stale_head'
      | 'policy_rejected'
      | 'conflict'
      | 'blob_reclaiming'
      | 'unavailable'
    >,
    CurrentCaller | Background
  >
}

export class Push extends Context.Tag('Push')<Push, PushService>() {}

const DAY = 24 * 60 * 60 * 1000
const MiB = 1024 * 1024
/** Rows a single INSERT … SELECT FROM json_each writes at most. */
const CHUNK = 400

const chunked = <T>(list: readonly T[]): T[][] => {
  const out: T[][] = []
  for (let at = 0; at < list.length; at += CHUNK) {
    out.push(list.slice(at, at + CHUNK))
  }
  return out
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  zip: 'application/zip',
}

/** A file's type from its extension. */
export const contentTypeOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0
    ? 'application/octet-stream'
    : (CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ??
        'application/octet-stream')
}

const join = (folder: string, path: string) =>
  folder === '' ? path : path === '' ? folder : `${folder}/${path}`

const parentOf = (path: string) => {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

const depthOf = (path: string) => (path === '' ? 0 : path.split('/').length)

const isUnder = (path: string, folder: string) =>
  folder === '' || path === folder || path.startsWith(`${folder}/`)

/** A page, or a layout: the HTML files whose forms people answer. */
const holdsForms = (path: string) =>
  isPageFile(path) &&
  (path === '_layout.html' ||
    path.endsWith('/_layout.html') ||
    !path.split('/').some(isKitName))

/** The rows of `push_forms` for the pushed pages and layouts. */
const formRowsOf = (files: readonly PushFile[]) =>
  files.flatMap(({ path, analysis }) =>
    holdsForms(path)
      ? analysis.forms.flatMap((form) => {
          if (form.action === null) return []
          const found = resolveFormAction(path, form.action)
          if ('problem' in found) return []
          return [
            {
              path,
              target:
                found.kind === 'folder' ? `${found.target}/` : found.target,
              key: form.id ?? '',
              kind: formKind(form, found),
              closesAt: form.closes === null ? null : closesAt(form.closes),
              closed: form.closed ? 1 : 0,
              line: form.line,
              title: form.title,
              schema: JSON.stringify(formSchema(form)),
            },
          ]
        })
      : [],
  )

const bytes = (n: number) =>
  n >= MiB ? `${Math.round((n / MiB) * 10) / 10} MiB` : `${n} bytes`

const tooLarge = (message: string) =>
  dossierError('too_large', message, 'A super admin can raise it.')

const sizes = (count: number) => count.toLocaleString('en-US')

/** The full name of a path, as people type it: `agent964/acme/plans`. */
const displayPath = (workspace: string, tree: string, path: string) =>
  [workspace, tree, path].filter((part) => part !== '').join('/')

const policyRejected = (problems: readonly PushProblem[]) => {
  const { message, fix, path } = describeProblems(problems)
  return dossierError('policy_rejected', message, fix, path)
}

/**
 * Another push moved the tree while this one committed: check again.
 * `contention` marks a batch that lost to other pushes, as opposed to a
 * check that read a tree changing under it.
 */
class Retry extends Data.TaggedError('Retry')<{
  readonly error: DossierError
  readonly contention: boolean
}> {}

/** What a push's change can fail with. */
type PushChangeFailure = DossierError<
  'stale_head' | 'conflict' | 'blob_reclaiming' | 'too_large' | 'unavailable'
>

/** How often a commit checks again when other pushes keep landing. */
const COMMIT_TRIES = 8
/** The first wait before checking again; it doubles, with jitter. */
const BACKOFF_MS = 20
const BACKOFF_CAP_MS = 640
/**
 * How long a commit may keep trying, well inside the CLI's 30-second request
 * timeout: no new try starts unless the longest try so far still fits.
 */
const COMMIT_BUDGET_MS = 20_000

interface StagedPush {
  readonly id: PushId
  readonly workspace_id: string
  readonly workspace_name: string
  readonly tree_name: string
  readonly tree_id: TreeId | null
  readonly path: string
  readonly base_seq: number | null
  readonly force: number
  readonly expires_at: number
  /** The shares to grant, as NewShare JSON. */
  readonly shares_json: string | null
}

interface LiveFile {
  readonly path: string
  readonly kind: 'file' | 'folder'
  readonly origin: 'authored' | 'data'
  readonly sha256: string | null
}

export const PushLive: Layer.Layer<
  Push,
  never,
  TreeStore | Access | Limits | Bindings | Config | BaseLayer | Shares
> = Layer.effect(
  Push,
  Effect.gen(function* () {
    const store = yield* TreeStore
    const access = yield* Access
    const sharing = yield* Shares
    const baseLayer = yield* BaseLayer
    const limits = yield* Limits
    const config = yield* Config
    const { DB, BLOBS } = yield* Bindings

    const query = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (error) => {
          console.error('A push read failed', error)
          return dossierError('unavailable')
        },
      })

    const signedIn = Effect.flatMap(CurrentCaller, (caller) =>
      caller.person === null
        ? Effect.fail(
            dossierError(
              'sign_in_required',
              'Sign in to push.',
              'Run dossier login.',
            ),
          )
        : Effect.succeed({ caller, person: caller.person }),
    )

    /** Every live node under a path in the tree. */
    const liveUnder = (treeId: TreeId, path: string) =>
      query(() =>
        DB.prepare(
          `select n.path, n.kind, n.origin, v.blob_sha256 as sha256
           from nodes n left join node_versions v on v.id = n.current_version_id
           where n.tree_id = ?1 and n.deleted_at is null and n.depth > 0
             and (?2 = '' or n.path = ?2 or substr(n.path, 1, length(?2) + 1) = ?2 || '/')`,
        )
          .bind(treeId, path)
          .all<LiveFile>(),
      ).pipe(Effect.map((r) => r.results))

    /**
     * Where the push lands in an existing tree: the deepest live folder at or
     * above the path, which the caller must hold write on.
     */
    const anchorOf = (tree: TreeRow, path: string) =>
      Effect.gen(function* () {
        const paths = ancestorPaths(path)
        const found = yield* query(() =>
          DB.prepare(
            `select path, kind from nodes where tree_id = ? and deleted_at is null
               and path in (${paths.map(() => '?').join(', ')})`,
          )
            .bind(tree.id, ...paths)
            .all<{ path: string; kind: 'file' | 'folder' }>(),
        )
        const deepest = found.results
          .filter((n) => n.kind === 'folder')
          .map((n) => n.path)
          .reduce((a, b) => (depthOf(b) > depthOf(a) ? b : a), '')
        const file = found.results.find((n) => n.kind === 'file') ?? null
        return { deepest, file }
      })

    /**
     * Write on the deepest live folder at or above a path, through Access.
     * Only a caller who holds it learns that a file is in the way.
     */
    const writeOn = (workspace: WorkspaceRow, tree: TreeRow, path: string) =>
      Effect.gen(function* () {
        const { deepest, file } = yield* anchorOf(tree, path)
        const resolved = yield* store.locate({
          workspace: workspace.name,
          tree: tree.name,
          path: deepest,
          folder: true,
        })
        const granted = yield* access.require(
          'write',
          'missing' in resolved ? resolved : resolved.node,
        )
        if (file !== null) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `A file named ${file.path} is in the way of ${path}.`,
              'Push to another path, or remove that file first.',
              file.path,
            ),
          )
        }
        return granted
      })

    /** Files pushed under the path since the base, newest first. */
    const pushedSince = (treeId: TreeId, path: string, base: number) =>
      query(() =>
        DB.prepare(
          `select distinct n.path from node_versions v join nodes n on n.id = v.node_id
           where v.tree_id = ?1 and n.origin = 'authored' and v.authored_seq > ?3
             and (?2 = '' or n.path = ?2 or substr(n.path, 1, length(?2) + 1) = ?2 || '/')
           order by v.authored_seq desc limit 21`,
        )
          .bind(treeId, path, base)
          .all<{ path: string }>(),
      ).pipe(Effect.map((r) => r.results.map((row) => row.path)))

    const staleHead = (
      workspace: string,
      tree: string,
      path: string,
      changed: readonly string[],
    ) => {
      const where = displayPath(workspace, tree, path)
      const shown = changed.slice(0, 20)
      const more = changed.length > 20 ? ', and more' : ''
      return dossierError(
        'stale_head',
        `Someone pushed to ${where} since this folder last pulled or pushed it: ${shown.join(', ')}${more}.`,
        `Pull it with \`dossier pull ${where} <dir>\` and push from there, or push again with --force to replace what is there.`,
        where,
      )
    }

    /** What the push changes, by comparing hashes with the live tree. */
    const planOf = (
      live: readonly LiveFile[],
      manifest: ReadonlyMap<string, string>,
      createsTree: boolean,
    ): PushPlan => {
      const data = new Set(
        live.filter((n) => n.origin === 'data').map((n) => n.path),
      )
      const isData = (path: string) =>
        ancestorPaths(path).some((p) => data.has(p))
      const authored = new Map(
        live
          .filter((n) => n.origin === 'authored' && n.kind === 'file')
          .map((n) => [n.path, n.sha256]),
      )
      const added: string[] = []
      const changed: string[] = []
      const ignored: { path: string; reason: 'data_path' }[] = []
      let unchanged = 0
      for (const [path, sha] of manifest) {
        if (isData(path)) {
          ignored.push({ path, reason: 'data_path' })
          continue
        }
        const current = authored.get(path)
        if (current === undefined) added.push(path)
        else if (current !== sha) changed.push(path)
        else unchanged += 1
      }
      const deleted = [...authored.keys()].filter((p) => !manifest.has(p))
      const sort = (list: string[]) => list.sort()
      return {
        createsTree,
        added: sort(added),
        changed: sort(changed),
        deleted: sort(deleted),
        unchanged,
        ignored,
        warnings: [],
      }
    }

    const folderLink = (workspace: string, tree: string, path: string) =>
      linkFor(config.origin, { workspace, tree, path, kind: 'folder' })

    /** Releases the holds of the tree's staged pushes that have expired. */
    const expireStatements = (
      now: number,
      workspaceId: string,
      treeName: string,
      treeId: TreeId | null,
    ) => {
      const stale = `select id from pushes where state = 'staged' and expires_at <= ?
        and (tree_id = ? or (tree_id is null and workspace_id = ? and tree_name = ?))`
      const binds = [now, treeId, workspaceId, treeName]
      return [
        DB.prepare(
          `delete from blob_holds where holder_kind = 'push' and holder_id in (${stale})`,
        ).bind(...binds),
        DB.prepare(
          `update pushes set state = 'expired' where id in (${stale})`,
        ).bind(...binds),
      ]
    }

    const stage = (i: StageInput) =>
      Effect.gen(function* () {
        const { caller, person } = yield* signedIn
        yield* limits.take(
          'push',
          caller.via.kind === 'agent' ? caller.via.keyId : person.id,
        )
        const limit = yield* limits.current()
        if (i.files.length > limit.pushFiles) {
          return yield* Effect.fail(
            tooLarge(
              `This push has ${sizes(i.files.length)} files; a push may hold at most ${sizes(limit.pushFiles)} files.`,
            ),
          )
        }
        let total = 0
        const manifest = new Map<string, Sha256>()
        const sizeOf = new Map<string, number>()
        const problems: PushProblem[] = []
        for (const file of i.files) {
          if (file.size > limit.fileBytes) {
            return yield* Effect.fail(
              dossierError(
                'too_large',
                `${file.path} is ${bytes(file.size)}; one file in a push may be at most ${bytes(limit.fileBytes)}.`,
                'A super admin can raise it.',
                file.path,
              ),
            )
          }
          total += file.size
          const full = join(i.target.path, file.path)
          if (file.path === '' || manifest.has(full)) {
            return yield* Effect.fail(
              dossierError(
                'invalid',
                file.path === ''
                  ? 'A file in the push has no path.'
                  : `${file.path} is listed twice.`,
                'List each file once, with its path inside the folder.',
                file.path,
              ),
            )
          }
          problems.push(...pathProblems(full))
          manifest.set(full, file.sha256)
          sizeOf.set(full, file.size)
        }
        if (total > limit.pushBytes) {
          return yield* Effect.fail(
            tooLarge(
              `This push is ${bytes(total)}; a push may be at most ${bytes(limit.pushBytes)}.`,
            ),
          )
        }
        if (problems.length > 0) {
          return yield* Effect.fail(policyRejected(problems))
        }
        // One hash is one content, so it has one size.
        const sizeOfHash = new Map<string, number>()
        for (const file of i.files) {
          const seen = sizeOfHash.get(file.sha256)
          if (seen !== undefined && seen !== file.size) {
            return yield* Effect.fail(
              dossierError(
                'invalid',
                `${file.path} has the same content as another file in this push, but is listed as ${file.size} bytes instead of ${seen}.`,
                'List each file with its real size.',
                file.path,
              ),
            )
          }
          sizeOfHash.set(file.sha256, file.size)
        }
        // A path cannot be a file and a folder at once.
        for (const path of manifest.keys()) {
          const folder = ancestorPaths(parentOf(path)).find(
            (p) => p !== '' && manifest.has(p),
          )
          if (folder !== undefined) {
            return yield* Effect.fail(
              dossierError(
                'invalid',
                `${folder} is listed as a file and as the folder of ${path}.`,
                'Keep one of them: a path is either a file or a folder.',
                folder,
              ),
            )
          }
        }

        const { target } = i
        const workspace = yield* store.workspace(target.workspace)
        const tree =
          workspace === null ? null : yield* store.tree(workspace, target.tree)
        if (tree === null) {
          yield* access.member(workspace)
        } else {
          yield* writeOn(workspace as WorkspaceRow, tree, target.path)
        }
        const ws = workspace as WorkspaceRow
        const link = folderLink(ws.name, target.tree, target.path)
        // Who may push here may share what they push: write holds share.
        const shares = yield* sharing.toNewShares(ws, i.share ?? [])

        // A hash the tree already holds is not uploaded again, so its size
        // is the stored blob's, never the one the manifest claims.
        if (tree !== null) {
          const known = yield* query(() =>
            DB.prepare(
              `select b.sha256, b.size from blobs b
               where b.sha256 in (select value from json_each(?))
                 and exists (select 1 from node_versions v
                               where v.tree_id = ? and v.blob_sha256 = b.sha256)`,
            )
              .bind(JSON.stringify([...new Set(manifest.values())]), tree.id)
              .all<{ sha256: string; size: number }>(),
          )
          const stored = new Map(known.results.map((r) => [r.sha256, r.size]))
          for (const file of i.files) {
            const size = stored.get(file.sha256)
            if (size !== undefined && size !== file.size) {
              return yield* Effect.fail(
                dossierError(
                  'invalid',
                  `${file.path} is listed as ${file.size} bytes, but its content is ${size} bytes.`,
                  'List each file with its real size.',
                  file.path,
                ),
              )
            }
          }
        }

        const live = tree === null ? [] : yield* liveUnder(tree.id, target.path)
        if (tree !== null && !i.force) {
          const base = i.baseTree === tree.id ? (i.baseSeq ?? 0) : 0
          const since = yield* pushedSince(tree.id, target.path, base)
          if (since.length > 0) {
            return yield* Effect.fail(
              staleHead(ws.name, tree.name, target.path, since),
            )
          }
        }
        const plan = planOf(live, manifest, tree === null)
        const current =
          tree === null
            ? null
            : {
                id: tree.id as TreeId,
                seq: tree.authoredSeq as AuthoredSeq,
                push:
                  tree.pushCount === 0 ? null : (tree.pushCount as PushNumber),
              }
        const nothing =
          plan.added.length + plan.changed.length + plan.deleted.length === 0
        // New bytes count against the workspace's storage, history included.
        const growth = [...plan.added, ...plan.changed].reduce(
          (sum, path) => sum + (sizeOf.get(path) ?? 0),
          0,
        )
        if (growth > 0) yield* limits.requireStorage(ws.id, growth)
        if (i.dryRun || (tree !== null && nothing)) {
          return {
            pushId: null,
            missing: [],
            plan,
            link,
            tree: current,
          } satisfies StageResult
        }

        const ignored = new Set(plan.ignored.map((x) => x.path))
        const files = [...manifest]
          .filter(([path]) => !ignored.has(path))
          .map(([path, sha256]) => ({
            path,
            parent: parentOf(path),
            name: nameOf(path),
            depth: depthOf(path),
            sha256,
            size: sizeOf.get(path) ?? 0,
            type: contentTypeOf(path),
          }))
        const folderPaths = new Set<string>()
        for (const p of ancestorPaths(target.path)) {
          if (p !== '') folderPaths.add(p)
        }
        for (const file of files) {
          for (const p of ancestorPaths(file.parent)) {
            if (p !== '') folderPaths.add(p)
          }
        }
        const folders = [...folderPaths].map((path) => ({
          path,
          parent: parentOf(path),
          name: nameOf(path),
          depth: depthOf(path),
        }))
        const now = yield* Clock.currentTimeMillis
        const pushId = newId() as PushId
        const chunks = <T>(list: readonly T[]) => {
          const out: T[][] = []
          for (let at = 0; at < list.length; at += CHUNK) {
            out.push(list.slice(at, at + CHUNK))
          }
          return out
        }
        const statements = [
          ...expireStatements(now, ws.id, target.tree, tree?.id ?? null),
          DB.prepare(
            `insert into pushes (id, workspace_id, tree_name, tree_id, path, base_seq, number,
               message, force, author_id, key_id, state, file_count, byte_count, created_at,
               expires_at, committed_at, shares_json)
             values (?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, 'staged', ?, ?, ?, ?, null, ?)`,
          ).bind(
            pushId,
            ws.id,
            target.tree,
            tree?.id ?? null,
            target.path,
            i.force || tree === null || i.baseTree !== tree.id
              ? null
              : i.baseSeq,
            i.message,
            i.force ? 1 : 0,
            person.id,
            caller.via.kind === 'agent' ? caller.via.keyId : null,
            files.length,
            total,
            now,
            now + DAY,
            shares.length === 0 ? null : JSON.stringify(shares),
          ),
          ...chunks(files).map((chunk) =>
            DB.prepare(
              `insert into push_files (push_id, path, parent_path, name, depth, sha256, size, content_type)
               select ?1, json_extract(j.value, '$.path'), json_extract(j.value, '$.parent'),
                 json_extract(j.value, '$.name'), json_extract(j.value, '$.depth'),
                 json_extract(j.value, '$.sha256'), json_extract(j.value, '$.size'),
                 json_extract(j.value, '$.type')
               from json_each(?2) j`,
            ).bind(pushId, JSON.stringify(chunk)),
          ),
          ...chunks(folders).map((chunk) =>
            DB.prepare(
              `insert into push_folders (push_id, path, parent_path, name, depth)
               select ?1, json_extract(j.value, '$.path'), json_extract(j.value, '$.parent'),
                 json_extract(j.value, '$.name'), json_extract(j.value, '$.depth')
               from json_each(?2) j`,
            ).bind(pushId, JSON.stringify(chunk)),
          ),
          // Hashes this tree already references need no upload.
          ...(tree === null
            ? []
            : [
                DB.prepare(
                  `insert into blob_holds (holder_kind, holder_id, sha256, created_at)
                   select 'push', ?1, x.sha256, ?3
                   from (select distinct sha256 from push_files where push_id = ?1) x
                   where exists (select 1 from node_versions v where v.tree_id = ?2
                                   and v.blob_sha256 = x.sha256)
                     and exists (select 1 from blobs b where b.sha256 = x.sha256
                                   and b.state = 'live')
                   on conflict do nothing`,
                ).bind(pushId, tree.id, now),
              ]),
          DB.prepare(
            `select distinct f.sha256 from push_files f where f.push_id = ?1
               and not exists (select 1 from blob_holds h where h.holder_kind = 'push'
                                 and h.holder_id = ?1 and h.sha256 = f.sha256)`,
          ).bind(pushId),
        ]
        const results = yield* query(() => DB.batch(statements))
        const missing = (
          (results[results.length - 1]?.results ?? []) as { sha256: Sha256 }[]
        ).map((row) => row.sha256)
        return {
          pushId,
          missing,
          plan,
          link,
          tree: current,
        } satisfies StageResult
      })

    /** The caller's own staged push, through the key that staged it. */
    const stagedPush = (pushId: PushId) =>
      Effect.gen(function* () {
        const { caller, person } = yield* signedIn.pipe(
          Effect.catchAll(() =>
            Effect.fail(dossierError('not_found', 'No such push.')),
          ),
        )
        const now = yield* Clock.currentTimeMillis
        const row = yield* query(() =>
          DB.prepare(
            `select p.*, w.name as workspace_name from pushes p
             join workspaces w on w.id = p.workspace_id
             where p.id = ? and p.author_id = ? and p.key_id is ? and p.state = 'staged'`,
          )
            .bind(
              pushId,
              person.id,
              caller.via.kind === 'agent' ? caller.via.keyId : null,
            )
            .first<StagedPush>(),
        )
        if (row === null) {
          return yield* Effect.fail(
            dossierError(
              'not_found',
              'No staged push with this id.',
              'Push again.',
            ),
          )
        }
        if (row.expires_at <= now) {
          yield* query(() =>
            DB.batch(
              expireStatements(
                now,
                row.workspace_id,
                row.tree_name,
                row.tree_id,
              ),
            ),
          )
          return yield* Effect.fail(
            dossierError('not_found', 'This push expired.', 'Push again.'),
          )
        }
        return row
      })

    /**
     * What the caller holds for the push now: write on the folder it lands
     * in, or membership of the workspace for a new tree. Checked again on
     * every upload and at commit, so access that ends stops the push.
     */
    const authorize = (push: StagedPush) =>
      Effect.gen(function* () {
        const workspace = yield* store.workspace(push.workspace_name)
        const tree =
          workspace === null
            ? null
            : yield* store.tree(workspace, push.tree_name)
        if (tree === null) {
          const membership = yield* access.member(workspace)
          return {
            workspace: membership.workspace,
            tree: null,
            target: null,
            membership,
          }
        }
        const target = yield* writeOn(
          workspace as WorkspaceRow,
          tree,
          push.path,
        )
        return {
          workspace: workspace as WorkspaceRow,
          tree,
          target,
          membership: null,
        }
      }).pipe(
        Effect.catchIf(
          (error) => error.code === 'sign_in_required',
          () => Effect.fail(dossierError('not_found', 'No such push.')),
        ),
      )

    const putBlob = (i: {
      readonly pushId: PushId
      readonly sha256: Sha256
      readonly size: number
      readonly body: ReadableStream<Uint8Array>
    }) =>
      Effect.gen(function* () {
        const push = yield* stagedPush(i.pushId)
        yield* authorize(push)
        const listed = yield* query(() =>
          DB.prepare(
            'select path, size from push_files where push_id = ? and sha256 = ?',
          )
            .bind(push.id, i.sha256)
            .all<{ path: string; size: number }>(),
        )
        const first = listed.results[0]
        if (first === undefined) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'This file is not part of the push.',
              'Upload only the hashes the push asked for.',
            ),
          )
        }
        if (first.size !== i.size) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `${first.path} should be ${first.size} bytes, not ${i.size}.`,
              'Send the file as listed in the push.',
              first.path,
            ),
          )
        }
        const limit = yield* limits.current()
        if (i.size > limit.fileBytes) {
          return yield* Effect.fail(
            tooLarge(
              `${first.path} is ${bytes(i.size)}; one file in a push may be at most ${bytes(limit.fileBytes)}.`,
            ),
          )
        }
        const holder = { kind: 'push', id: push.id } as const
        // The hold comes first, so a purge never takes the blob while its
        // bytes are being written; it counts for the commit once verified.
        yield* store.holdBlob(holder, i.sha256, i.size)
        // The bytes are always written, so the answer never tells whether
        // they were stored before.
        yield* Effect.tryPromise({
          try: async () => {
            const sized = new FixedLengthStream(i.size)
            const piped = i.body.pipeTo(sized.writable)
            const [put] = await Promise.all([
              BLOBS.put(blobKey(i.sha256), sized.readable, {
                sha256: i.sha256,
              }),
              piped,
            ])
            return put
          },
          catch: (error) => {
            console.warn('An upload was refused', {
              sha256: i.sha256,
              error: String(error),
            })
            return dossierError(
              'invalid',
              `${first.path} does not match its size or SHA-256.`,
              'Upload the file again.',
              first.path,
            )
          },
        }).pipe(Effect.tapError(() => store.dropHold(holder, i.sha256)))
        if (listed.results.some((f) => isPageFile(f.path))) {
          yield* store.analysis(i.sha256)
        }
        // A page's generated agent version is made as it arrives; a failure
        // here only means the first read makes it.
        if (
          listed.results.some(
            (f) => isPageFile(f.path) && !f.path.split('/').some(isKitName),
          )
        ) {
          yield* store.markdown(i.sha256).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() =>
                console.warn('A page could not be converted to Markdown', {
                  sha256: i.sha256,
                  error: error.code,
                }),
              ),
            ),
          )
        }
        yield* store.confirmHold(holder, i.sha256, i.size)
      })

    /** Every HTML file the tree will hold after the push, with its analysis. */
    const pagesAfter = (
      push: StagedPush,
      tree: TreeRow | null,
      manifestRows: readonly {
        path: string
        sha256: Sha256
        json: string | null
      }[],
    ) =>
      Effect.gen(function* () {
        const outside =
          tree === null
            ? []
            : (yield* query(() =>
                DB.prepare(
                  `select n.path, v.blob_sha256 as sha256, a.json, v.author_id as author
                   from nodes n join node_versions v on v.id = n.current_version_id
                   left join analyses a on a.sha256 = v.blob_sha256
                     and a.analyzer = 'html' and a.version = ?3
                   where n.tree_id = ?1 and n.deleted_at is null and n.kind = 'file'
                     and n.origin = 'authored' and v.state = 'live'
                     and n.path like '%.html'
                     and not (?2 = '' or n.path = ?2
                       or substr(n.path, 1, length(?2) + 1) = ?2 || '/')`,
                )
                  .bind(tree.id, push.path, ANALYZER)
                  .all<{
                    path: string
                    sha256: Sha256
                    json: string | null
                    author: string
                  }>(),
              )).results
        const pages: (PushFile & {
          readonly sha256: Sha256
          /** Who pushed the version; null for this push. */
          readonly author: string | null
        })[] = []
        for (const row of [...manifestRows, ...outside]) {
          if (!isPageFile(row.path)) continue
          const analysis =
            row.json === null
              ? yield* store.analysis(row.sha256)
              : (JSON.parse(row.json) as HtmlAnalysis)
          if (analysis !== null) {
            pages.push({
              path: row.path,
              analysis,
              sha256: row.sha256,
              author: 'author' in row ? (row.author as string) : null,
            })
          }
        }
        return pages
      })

    /**
     * What the person who pushed each HTML file held at a path it names, as
     * the tree stands before this push: read (people's data only by a real
     * grant or as its writer) and respond. This push's caller also reads
     * what it pushes. A new tree is its creator's.
     */
    const heldByAuthors = (
      tree: TreeRow | null,
      pages: readonly {
        readonly path: string
        readonly author: string | null
      }[],
      manifest: ReadonlyMap<string, unknown>,
    ) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const pushed = new Set<string>()
        for (const path of manifest.keys()) {
          for (const at of ancestorPaths(path)) if (at !== '') pushed.add(at)
        }
        const callers = new Map<string | null, Caller | null>([[null, caller]])
        for (const author of new Set(pages.map((p) => p.author))) {
          if (author === null || callers.has(author)) continue
          const person = yield* query(() =>
            DB.prepare('select id, email, name, image from "user" where id = ?')
              .bind(author)
              .first<{
                id: PersonId
                email: string
                name: string
                image: string | null
              }>(),
          )
          callers.set(
            author,
            person === null
              ? null
              : {
                  person,
                  via: { kind: 'browser', sessionId: '' as SessionId },
                  requestId: caller.requestId,
                },
          )
        }
        const readableSets = new Map<string | null, ReadonlySet<string>>()
        const readableTo = (author: string | null, who: Caller) =>
          Effect.gen(function* () {
            const kept = readableSets.get(author)
            if (kept !== undefined) return kept
            const found = new Set<string>(author === null ? pushed : [])
            if (tree !== null) {
              const readable = yield* access.readable(tree.id as TreeId)
              const rows = yield* query(() =>
                db({ DB })
                  .select({ path: schema.nodes.path })
                  .from(schema.nodes)
                  .where(
                    sql`${schema.nodes.treeId} = ${tree.id} and ${schema.nodes.deletedAt} is null and ${readable.where}`,
                  )
                  .all(),
              )
              for (const row of rows) found.add(row.path)
            }
            readableSets.set(author, found)
            return found
          }).pipe(Effect.provideService(CurrentCaller, who))
        const held = new Map<string, { reads: boolean; responds: boolean }>()
        const authorOf = new Map(pages.map((p) => [p.path, p.author]))
        return (host: string, need: string, kind: PageNeed['kind']) =>
          Effect.gen(function* () {
            const author = authorOf.get(host) ?? null
            const who = callers.get(author) ?? null
            if (who === null) return { reads: false, responds: false }
            if (kind === 'render') {
              const reads = (yield* readableTo(author, who)).has(need)
              return { reads, responds: false }
            }
            // A new tree is wholly its creator's.
            if (tree === null) return { reads: true, responds: true }
            const key = `${author}\u0000${need}`
            const kept = held.get(key)
            if (kept !== undefined) return kept
            const node = yield* store
              .nearest(tree.id as TreeId, need)
              .pipe(Effect.orDie)
            let found = { reads: false, responds: false }
            if (node !== null) {
              const roles = yield* access
                .roleOn(node)
                .pipe(Effect.provideService(CurrentCaller, who))
              found = {
                // Through grants, or as the file's own writer: never
                // because a form names it.
                reads:
                  roles.privateCaps.has('read') ||
                  (node.path === need && roles.owns),
                responds: roles.caps.has('respond'),
              }
            }
            held.set(key, found)
            return found
          })
      })

    /** One try at committing; `Retry` when another push moved the tree. */
    const commitOnce = (pushId: PushId) =>
      Effect.gen(function* () {
        const push = yield* stagedPush(pushId)
        const {
          workspace: ws,
          tree,
          target,
          membership,
        } = yield* authorize(push)
        const shares = JSON.parse(push.shares_json ?? '[]') as NewShare[]
        const notHeld = yield* query(() =>
          DB.prepare(
            `select f.path from push_files f where f.push_id = ?1
               and not exists (select 1 from blob_holds h where h.holder_kind = 'push'
                                 and h.holder_id = ?1 and h.sha256 = f.sha256
                                 and h.verified = 1)
               and not exists (select 1 from node_versions v where v.tree_id = ?2
                                 and v.blob_sha256 = f.sha256)
             order by f.path limit 21`,
          )
            .bind(pushId, tree?.id ?? '')
            .all<{ path: string }>(),
        ).pipe(Effect.map((r) => r.results.map((row) => row.path)))
        if (notHeld.length > 0) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `These files were not uploaded: ${notHeld.slice(0, 20).join(', ')}.`,
              'Push again; the CLI uploads every file the push asks for.',
              notHeld[0] ?? null,
            ),
          )
        }

        // Every file's size is its verified bytes', and the limits count those.
        const verified = yield* query(() =>
          DB.prepare(
            `select f.path, f.size, b.size as stored from push_files f
             join blobs b on b.sha256 = f.sha256 where f.push_id = ?`,
          )
            .bind(pushId)
            .all<{ path: string; size: number; stored: number }>(),
        ).pipe(Effect.map((r) => r.results))
        const forged = verified.find((f) => f.size !== f.stored)
        if (forged !== undefined) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `${forged.path} is listed as ${forged.size} bytes, but its content is ${forged.stored} bytes.`,
              'Push again with each file at its real size.',
              forged.path,
            ),
          )
        }
        const limit = yield* limits.current()
        // The limits as they stand now, which may have changed since stage.
        if (verified.length > limit.pushFiles) {
          return yield* Effect.fail(
            tooLarge(
              `This push has ${sizes(verified.length)} files; a push may hold at most ${sizes(limit.pushFiles)} files.`,
            ),
          )
        }
        const total = verified.reduce((sum, f) => sum + f.stored, 0)
        const largest = verified.find((f) => f.stored > limit.fileBytes)
        if (largest !== undefined || total > limit.pushBytes) {
          return yield* Effect.fail(
            largest === undefined
              ? tooLarge(
                  `This push is ${bytes(total)}; a push may be at most ${bytes(limit.pushBytes)}.`,
                )
              : tooLarge(
                  `${largest.path} is ${bytes(largest.stored)}; one file in a push may be at most ${bytes(limit.fileBytes)}.`,
                ),
          )
        }
        // The verified bytes of files new at their paths, checked again
        // against the storage now.
        const growth = yield* query(() =>
          DB.prepare(
            `select coalesce(sum(b.size), 0) as bytes from push_files f
             join blobs b on b.sha256 = f.sha256
             where f.push_id = ?1 and not exists (
               select 1 from nodes n join node_versions v on v.id = n.current_version_id
               where n.tree_id = ?2 and n.path = f.path and n.deleted_at is null
                 and v.blob_sha256 = f.sha256)`,
          )
            .bind(pushId, tree?.id ?? '')
            .first<{ bytes: number }>(),
        )
        if ((growth?.bytes ?? 0) > 0) {
          yield* limits.requireStorage(ws.id, growth?.bytes ?? 0)
        }

        const manifestRows = yield* query(() =>
          DB.prepare(
            `select f.path, f.sha256, a.json from push_files f
             left join analyses a on a.sha256 = f.sha256 and a.analyzer = 'html' and a.version = ?2
             where f.push_id = ?1`,
          )
            .bind(pushId, ANALYZER)
            .all<{ path: string; sha256: Sha256; json: string | null }>(),
        )
        const manifest = new Map(
          manifestRows.results.map((r) => [r.path, r.sha256]),
        )
        const all =
          tree === null
            ? []
            : yield* query(() =>
                DB.prepare(
                  `select path, kind, origin from nodes
                   where tree_id = ? and deleted_at is null and depth > 0`,
                )
                  .bind(tree.id)
                  .all<{
                    path: string
                    kind: 'file' | 'folder'
                    origin: string
                  }>(),
              ).pipe(Effect.map((r) => r.results))
        const kinds = new Map<string, ReturnType<TreeView['kindAt']>>()
        for (const node of all) {
          if (isUnder(node.path, push.path) && node.origin !== 'data') continue
          kinds.set(
            node.path,
            node.origin === 'data'
              ? 'data'
              : node.kind === 'folder'
                ? 'folder'
                : isPageFile(node.path)
                  ? 'page'
                  : 'file',
          )
        }
        for (const path of manifest.keys()) {
          for (const folder of ancestorPaths(parentOf(path))) {
            if (folder !== '' && !kinds.has(folder)) kinds.set(folder, 'folder')
          }
          if (!kinds.has(path))
            kinds.set(path, isPageFile(path) ? 'page' : 'file')
        }
        // Every page of the tree as it will be, not only the pushed ones: a
        // push elsewhere can break a form that targets its path.
        const pages = yield* pagesAfter(push, tree, manifestRows.results)
        const live = tree === null ? [] : yield* liveUnder(tree.id, push.path)
        const changes = planOf(live, manifest, tree === null)
        const baseComponents = baseLayer.components()
        const check = checkPush(
          pages,
          {
            kindAt: (p) => kinds.get(p) ?? null,
            componentAt: (folder, tag) =>
              Object.hasOwn(baseComponents, tag) ||
              ancestorPaths(folder).some(
                (at) => kinds.get(componentPath(at, tag)) === 'file',
              ),
          },
          // Warnings name only the files this push adds or changes.
          { warnFor: new Set([...changes.added, ...changes.changed]) },
        )
        if (check.problems.length > 0) {
          // The reads above may straddle another push: refuse only what the
          // tree as it stands still shows, and check again otherwise.
          const error = policyRejected(
            yield* redacted(ws, tree, manifest, push.path, check.problems),
          )
          return yield* Effect.flatMap(treeMoved(push, tree), (moved) =>
            Effect.fail(
              moved ? new Retry({ error, contention: false }) : error,
            ),
          )
        }

        // What every page carries after this push, for page shares.
        // A page carries only what the people behind it held there.
        const heldBy = yield* heldByAuthors(tree, pages, manifest)
        const kept = new Map<string, PageNeedRow>()
        for (const need of pageNeedsOf(pages, (p) => kinds.get(p) ?? null)) {
          const held = yield* heldBy(need.host, need.need, need.kind)
          if (!held.reads && !held.responds) continue
          const key = `${need.page}\u0000${need.need}\u0000${need.kind}`
          const before = kept.get(key)
          kept.set(key, {
            page: need.page,
            need: need.need,
            kind: need.kind,
            reads: held.reads || (before?.reads ?? false),
            responds: held.responds || (before?.responds ?? false),
          })
        }
        const needs = [...kept.values()]
        // A push that takes from what a shared page carried closes the
        // sockets that may have watched it; the head guard below keeps
        // these rows the ones the change replaces.
        const narrowed =
          tree === null
            ? false
            : yield* query(() =>
                DB.prepare(
                  `select o.page_path as page, o.need_path as need, o.kind,
                     o.reads, o.responds
                   from page_needs o
                   where o.tree_id = ? and exists (select 1 from shares s
                     where s.tree_id = o.tree_id)`,
                )
                  .bind(tree.id)
                  .all<{
                    page: string
                    need: string
                    kind: string
                    reads: number
                    responds: number
                  }>(),
              ).pipe(
                Effect.map((rows) =>
                  rows.results.some((old) => {
                    const now = kept.get(
                      `${old.page}\u0000${old.need}\u0000${old.kind}`,
                    )
                    return (
                      now === undefined ||
                      (old.reads === 1 && !now.reads) ||
                      (old.responds === 1 && !now.responds)
                    )
                  }),
                ),
              )

        const baseSeq = push.base_seq ?? 0
        if (tree !== null && push.force === 0) {
          const since = yield* pushedSince(tree.id, push.path, baseSeq)
          if (since.length > 0) {
            return yield* Effect.fail(
              staleHead(ws.name, tree.name, push.path, since),
            )
          }
        }
        const plan = { ...changes, warnings: check.warnings }

        // Every form of the pushed pages and layouts, staged for the change
        // to record by the versions it leaves current.
        const pushed = new Set(manifest.keys())
        const formRows = formRowsOf(pages.filter((p) => pushed.has(p.path)))
        yield* query(() =>
          DB.batch([
            DB.prepare('delete from push_forms where push_id = ?').bind(pushId),
            ...chunked(formRows).map((chunk) =>
              DB.prepare(
                `insert into push_forms (push_id, path, target_path, form_key, kind,
                   closes_at, closed, line, title, schema_json)
                 select ?1, json_extract(j.value, '$.path'),
                   json_extract(j.value, '$.target'), json_extract(j.value, '$.key'),
                   json_extract(j.value, '$.kind'), json_extract(j.value, '$.closesAt'),
                   json_extract(j.value, '$.closed'), json_extract(j.value, '$.line'),
                   json_extract(j.value, '$.title'), json_extract(j.value, '$.schema')
                 from json_each(?2) j
                 where true on conflict do nothing`,
              ).bind(pushId, JSON.stringify(chunk)),
            ),
          ]),
        )

        const committed = yield* store
          .change(tree?.id ?? null, (cs) =>
            Effect.sync(() => {
              const root =
                membership === null
                  ? null
                  : cs.createTree(membership, push.tree_name)
              if (tree !== null) {
                // The tree the checks above read: any authored change since
                // fails the batch, and the commit checks again.
                cs.guardHead('', tree.authoredSeq as AuthoredSeq)
                if (push.force === 0) {
                  cs.guardHead(push.path, baseSeq as AuthoredSeq)
                }
              }
              const folder = cs.putStaged(
                root ?? (target as Granted<'write'>),
                pushId,
              )
              cs.putForms(pushId)
              cs.putPageNeeds(needs, narrowed)
              // A failed commit grants nothing: the shares are in its batch.
              for (const share of shares) cs.grant(folder, share)
              if (shares.length > 0) {
                cs.event({ type: 'share', path: push.path })
              }
              cs.event({ type: 'push', path: push.path, pushId })
              return {}
            }),
          )
          .pipe(
            Effect.catchAll(
              (error): Effect.Effect<never, PushChangeFailure | Retry> => {
                // A push merges no data.
                if (error.code === 'not_mergeable') return Effect.die(error)
                const failure = error as PushChangeFailure
                return failure.code === 'stale_head' ||
                  failure.code === 'conflict'
                  ? Effect.flatMap(
                      treeMoved(push, tree).pipe(Effect.orDie),
                      (
                        moved,
                      ): Effect.Effect<never, PushChangeFailure | Retry> =>
                        moved
                          ? Effect.fail(
                              new Retry({ error: failure, contention: true }),
                            )
                          : Effect.fail(failure),
                    )
                  : Effect.fail(failure)
              },
            ),
          )
        const number = yield* query(() =>
          DB.prepare('select number from pushes where id = ?')
            .bind(pushId)
            .first<{ number: number }>(),
        )
        return {
          number: (number?.number ?? 1) as PushNumber,
          link: folderLink(ws.name, push.tree_name, push.path),
          seq: committed.authoredSeq,
          treeId: committed.treeId,
          plan,
        } satisfies CommitResult
      })

    /**
     * The problems as the caller may see them: a page they cannot open is
     * never named, only that the push would break one.
     */
    const redacted = (
      ws: WorkspaceRow,
      tree: TreeRow | null,
      manifest: ReadonlyMap<string, string>,
      pushPath: string,
      problems: readonly PushProblem[],
    ) =>
      Effect.gen(function* () {
        const shown: PushProblem[] = []
        let hidden: PushProblem | null = null
        for (const problem of problems) {
          if (tree === null || manifest.has(problem.path)) {
            shown.push(problem)
            continue
          }
          const resolved = yield* store.resolve({
            workspace: ws.name,
            tree: tree.name,
            path: problem.path,
            folder: false,
          })
          // A `_` path names its own file here, not the lookup's choice.
          const node =
            'missing' in resolved
              ? resolved
              : resolved.kind === 'kit'
                ? (resolved.found.flatMap((found) =>
                    found.kind === 'tree' && found.node.path === problem.path
                      ? [found.node]
                      : [],
                  )[0] ?? {
                    missing: true as const,
                    treeId: tree.id,
                    path: problem.path,
                  })
                : resolved.node
          const readable = yield* access
            .require('read', node)
            .pipe(Effect.isSuccess)
          if (readable) {
            shown.push(problem)
          } else {
            hidden ??= {
              code: problem.code,
              path: pushPath,
              line: null,
              message: `This push would break a page you cannot open, so ${displayPath(ws.name, tree.name, pushPath)} cannot be pushed as it is.`,
              fix: 'Push to another path, or ask someone who can open the whole tree to push it.',
            }
          }
        }
        return hidden === null ? shown : [...shown, hidden]
      })

    /** Whether the tree changed since the commit read it, or came to be. */
    const treeMoved = (push: StagedPush, seen: TreeRow | null) =>
      Effect.gen(function* () {
        const workspace = yield* store.workspace(push.workspace_name)
        const now =
          workspace === null
            ? null
            : yield* store.tree(workspace, push.tree_name)
        return now?.id !== seen?.id || now?.authoredSeq !== seen?.authoredSeq
      })

    type CommitError = Exclude<
      Effect.Effect.Error<ReturnType<typeof commitOnce>>,
      Retry
    >

    /**
     * The answer when a commit stops trying: stale_head if the push's own
     * path moved since its base, read fresh now; otherwise conflict. A rule
     * refusal read from a tree that kept moving is never the answer.
     */
    const exhausted = (pushId: PushId) =>
      Effect.gen(function* () {
        const push = yield* stagedPush(pushId)
        const workspace = yield* store.workspace(push.workspace_name)
        const tree =
          workspace === null
            ? null
            : yield* store.tree(workspace, push.tree_name)
        if (tree !== null && push.force === 0) {
          const since = yield* pushedSince(
            tree.id,
            push.path,
            push.base_seq ?? 0,
          )
          if (since.length > 0) {
            return staleHead(
              push.workspace_name,
              tree.name,
              push.path,
              since,
            ) as CommitError
          }
        }
        return dossierError(
          'conflict',
          'Other pushes kept changing this tree, so nothing was applied.',
          'Push again.',
        ) as CommitError
      })

    /**
     * Commits, checking again with a jittered, doubling wait while other
     * pushes keep moving the tree, within a number of tries and a time
     * budget. Running out of either answers through `exhausted`.
     */
    const commit = (pushId: PushId) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis
        let longest = 0
        for (let tried = 0; ; tried += 1) {
          const begun = yield* Clock.currentTimeMillis
          const outcome = yield* Effect.either(commitOnce(pushId))
          const ended = yield* Clock.currentTimeMillis
          longest = Math.max(longest, ended - begun)
          if (outcome._tag === 'Right') return outcome.right
          const error = outcome.left
          if (!(error instanceof Retry)) return yield* Effect.fail(error)
          const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_MS * 2 ** tried)
          const wait = yield* Random.nextIntBetween(ceiling / 2, ceiling + 1)
          const outOfTime = ended - started + wait + longest > COMMIT_BUDGET_MS
          if (tried + 1 >= COMMIT_TRIES || outOfTime) {
            return yield* Effect.fail(yield* exhausted(pushId))
          }
          yield* Effect.sleep(wait)
        }
      }) as Effect.Effect<CommitResult, CommitError, CurrentCaller>

    return { stage, putBlob, commit }
  }),
)
