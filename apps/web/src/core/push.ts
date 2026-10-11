import {
  dossierError,
  linkFor,
  type AuthoredSeq,
  type DossierError,
  type LinkRef,
  type PushId,
  type PushNumber,
  type Sha256,
  type TreeId,
} from '@dossier/contracts'
import {
  ANALYZER_VERSION as ANALYZER,
  checkPush,
  describeProblems,
  isPageFile,
  pathProblems,
  type HtmlAnalysis,
  type PushFile,
  type PushProblem,
  type PushWarning,
  type TreeView,
} from '@dossier/html'
import { Clock, Context, Effect, Layer } from 'effect'

import { Access, type Granted, type Membership } from './access.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller } from './caller.ts'
import { Config } from './config.ts'
import { newId } from './ids.ts'
import { Limits } from './limits.ts'
import { ancestorPaths, type TreeRow, type WorkspaceRow } from './rows.ts'
import { blobKey, TreeStore } from './tree-store.ts'

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
      'not_found' | 'invalid' | 'too_large' | 'blob_reclaiming' | 'unavailable'
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
      | 'stale_head'
      | 'policy_rejected'
      | 'conflict'
      | 'blob_reclaiming'
      | 'unavailable'
    >,
    CurrentCaller
  >
}

export class Push extends Context.Tag('Push')<Push, PushService>() {}

const DAY = 24 * 60 * 60 * 1000
const MiB = 1024 * 1024
/** Rows a single INSERT … SELECT FROM json_each writes at most. */
const CHUNK = 400

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

interface LiveFile {
  readonly path: string
  readonly kind: 'file' | 'folder'
  readonly origin: 'authored' | 'data'
  readonly sha256: string | null
}

export const PushLive: Layer.Layer<
  Push,
  never,
  TreeStore | Access | Limits | Bindings | Config
> = Layer.effect(
  Push,
  Effect.gen(function* () {
    const store = yield* TreeStore
    const access = yield* Access
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
        const file = found.results.find((n) => n.kind === 'file')
        if (file !== undefined) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `A file named ${file.path} is in the way of ${path}.`,
              'Push to another path, or remove that file first.',
              file.path,
            ),
          )
        }
        const deepest = found.results
          .map((n) => n.path)
          .reduce((a, b) => (depthOf(b) > depthOf(a) ? b : a), '')
        return deepest
      })

    /** The live folder node at a path, through Access. */
    const writeOn = (workspace: WorkspaceRow, tree: TreeRow, path: string) =>
      Effect.gen(function* () {
        const deepest = yield* anchorOf(tree, path)
        const resolved = yield* store.resolve({
          workspace: workspace.name,
          tree: tree.name,
          path: deepest,
          folder: true,
        })
        return yield* access.require(
          'write',
          'missing' in resolved ? resolved : resolved.node,
        )
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
            size: i.files.find((f) => join(target.path, f.path) === path)?.size,
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
               expires_at, committed_at)
             values (?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, 'staged', ?, ?, ?, ?, null)`,
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

    /** The caller's own staged push. */
    const stagedPush = (pushId: PushId) =>
      Effect.gen(function* () {
        const { person } = yield* signedIn.pipe(
          Effect.catchAll(() =>
            Effect.fail(dossierError('not_found', 'No such push.')),
          ),
        )
        const now = yield* Clock.currentTimeMillis
        const row = yield* query(() =>
          DB.prepare(
            `select p.*, w.name as workspace_name from pushes p
             join workspaces w on w.id = p.workspace_id
             where p.id = ? and p.author_id = ? and p.state = 'staged'`,
          )
            .bind(pushId, person.id)
            .first<{
              id: PushId
              workspace_id: string
              workspace_name: string
              tree_name: string
              tree_id: TreeId | null
              path: string
              base_seq: number | null
              force: number
              expires_at: number
            }>(),
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

    const putBlob = (i: {
      readonly pushId: PushId
      readonly sha256: Sha256
      readonly size: number
      readonly body: ReadableStream<Uint8Array>
    }) =>
      Effect.gen(function* () {
        const push = yield* stagedPush(i.pushId)
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
        const now = yield* Clock.currentTimeMillis
        const state = yield* query(() =>
          DB.batch([
            DB.prepare(
              `insert into blobs (sha256, size, ref_count, state, first_seen_at)
               values (?, ?, 0, 'live', ?) on conflict do nothing`,
            ).bind(i.sha256, i.size, now),
            DB.prepare('select state from blobs where sha256 = ?').bind(
              i.sha256,
            ),
          ]),
        ).pipe(
          Effect.map(
            (r) => (r[1]?.results[0] as { state?: string } | undefined)?.state,
          ),
        )
        if (state !== 'live') {
          return yield* Effect.fail(
            dossierError(
              'blob_reclaiming',
              'This file is being cleaned up. Upload it again shortly.',
              'Push again in a minute.',
            ),
          )
        }
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
        })
        if (listed.results.some((f) => isPageFile(f.path))) {
          yield* store.analysis(i.sha256)
        }
        yield* store.holdBlob({ kind: 'push', id: push.id }, i.sha256, i.size)
      })

    const commit = (pushId: PushId) =>
      Effect.gen(function* () {
        const push = yield* stagedPush(pushId)
        const workspace = yield* store.workspace(push.workspace_name)
        const tree =
          workspace === null
            ? null
            : yield* store.tree(workspace, push.tree_name)
        const notHeld = yield* query(() =>
          DB.prepare(
            `select f.path from push_files f where f.push_id = ?1
               and not exists (select 1 from blob_holds h where h.holder_kind = 'push'
                                 and h.holder_id = ?1 and h.sha256 = f.sha256)
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

        let target: Granted<'write'> | null = null
        let membership: Membership | null = null
        if (tree === null) {
          membership = yield* access.member(workspace)
        } else {
          target = yield* writeOn(workspace as WorkspaceRow, tree, push.path)
        }
        const ws = workspace as WorkspaceRow

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
        const pages: PushFile[] = []
        for (const row of manifestRows.results) {
          if (!isPageFile(row.path)) continue
          const analysis =
            row.json === null
              ? yield* store.analysis(row.sha256)
              : (JSON.parse(row.json) as HtmlAnalysis)
          if (analysis !== null) pages.push({ path: row.path, analysis })
        }
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
        const check = checkPush(pages, { kindAt: (p) => kinds.get(p) ?? null })
        if (check.problems.length > 0) {
          return yield* Effect.fail(policyRejected(check.problems))
        }

        const live = tree === null ? [] : yield* liveUnder(tree.id, push.path)
        const base = push.base_seq ?? 0
        if (tree !== null && push.force === 0) {
          const since = yield* pushedSince(tree.id, push.path, base)
          if (since.length > 0) {
            return yield* Effect.fail(
              staleHead(ws.name, tree.name, push.path, since),
            )
          }
        }
        const plan = {
          ...planOf(live, manifest, tree === null),
          warnings: check.warnings,
        }

        const committed = yield* store.change(tree?.id ?? null, (cs) =>
          Effect.sync(() => {
            const root =
              membership === null
                ? null
                : cs.createTree(membership, push.tree_name)
            if (tree !== null && push.force === 0) {
              cs.guardHead(push.path, base as AuthoredSeq)
            }
            cs.putStaged(root ?? (target as Granted<'write'>), pushId)
            cs.event({ type: 'push', path: push.path, pushId })
            return {}
          }),
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

    return { stage, putBlob, commit }
  }),
)
