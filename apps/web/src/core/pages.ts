import {
  contentOrigin,
  dossierError,
  isNodeName,
  MAX_DEPTH,
  type AuthoredSeq,
  type DossierError,
  type LinkRef,
  type PersonId,
  type SessionId,
  type Sha256,
  type TreeId,
  type ViewGrant,
} from '@dossier/contracts'
import type {
  PageBootstrap,
  RoleName,
  ShellBoot,
} from '@dossier/contracts/bridge'
import { bootstrapTags, compose } from '@dossier/html'
import { Clock, Context, Effect, Layer, Redacted } from 'effect'

import { Access, type RoleSet } from './access.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller, type Caller } from './caller.ts'
import { Config } from './config.ts'
import { hmacSha256, sha256Hex } from './ids.ts'
import type { MissingNode, TreeRow, VersionRow } from './rows.ts'
import {
  blobKey,
  linkPathOf,
  TreeStore,
  type Resolved,
  type TreeRef,
} from './tree-store.ts'

/** What a link or frame request is answered with; the edge renders it. */
export type Served =
  | { readonly kind: 'shell'; readonly boot: ShellBoot }
  | { readonly kind: 'listing'; readonly ref: LinkRef }
  | {
      readonly kind: 'redirect'
      /** Absolute on the main host; relative to the request in a frame. */
      readonly to: string
      readonly status: 301 | 302
    }
  | { readonly kind: 'framePage'; readonly html: string; readonly etag: string }
  | {
      readonly kind: 'file'
      readonly body: ReadableStream<Uint8Array>
      /** The whole file's size. */
      readonly size: number
      readonly etag: string
      readonly contentType: string
      readonly range: {
        readonly offset: number
        readonly length: number
      } | null
      readonly download: boolean
      readonly cache: 'pinned' | 'private'
    }
  | { readonly kind: 'notModified'; readonly etag: string }
  /** A range the file cannot satisfy. */
  | { readonly kind: 'unsatisfiable'; readonly size: number }

export interface SeenByRow {
  readonly email: string
  readonly name: string
  readonly lastSeenAt: number
  readonly withinHour: boolean
}

type Denied = DossierError<'not_found' | 'sign_in_required'>

export interface PagesService {
  readonly open: (i: {
    readonly ref: LinkRef
    readonly wantsAgent: boolean
  }) => Effect.Effect<
    Served,
    Denied | DossierError<'unavailable'>,
    CurrentCaller
  >
  readonly view: (i: {
    readonly treeId: TreeId
    /** The link's path inside the tree, encoded: '', 'questions/', 'plan'. */
    readonly path: string
  }) => Effect.Effect<
    ViewGrant,
    Denied | DossierError<'unavailable'>,
    CurrentCaller
  >
  /** The tree is the content host's; the caller comes from its handle. */
  readonly frame: (i: {
    readonly treeId: TreeId
    readonly seq: AuthoredSeq
    readonly path: string
    readonly folder: boolean
    readonly range: string | null
    readonly ifNoneMatch: string | null
  }) => Effect.Effect<
    Served,
    DossierError<'not_found' | 'unavailable'>,
    CurrentCaller
  >
  readonly seenBy: (
    ref: LinkRef,
  ) => Effect.Effect<
    readonly SeenByRow[],
    DossierError<
      'not_found' | 'sign_in_required' | 'forbidden' | 'unavailable'
    >,
    CurrentCaller
  >
  /** The edge's frame rule: null for an unknown, expired or other tree's handle. */
  readonly handleCaller: (
    handle: string,
    treeId: TreeId,
  ) => Effect.Effect<Caller | null, DossierError<'unavailable'>>
}

export class Pages extends Context.Tag('Pages')<Pages, PagesService>() {}

const HOUR = 60 * 60 * 1000
/** A handle lasts this long after its last renewal. */
const HANDLE_LIFE = 24 * HOUR
const HANDLE = /^[A-Za-z0-9_-]{43}$/

const notFound = (path: string | null = null) =>
  dossierError(
    'not_found',
    'Nothing is here, or you cannot open it.',
    'Check the path, or ask someone who can open it to share it with you.',
    path,
  )

/** Reading never asks for more than read, so forbidden reads as not found. */
const asDenied = <A, R>(
  effect: Effect.Effect<
    A,
    DossierError<'not_found' | 'sign_in_required' | 'forbidden'>,
    R
  >,
): Effect.Effect<A, Denied, R> =>
  Effect.catchIf(
    effect,
    (error): error is DossierError<'forbidden'> => error.code === 'forbidden',
    (error) => Effect.fail(notFound(error.path)),
  ) as Effect.Effect<A, Denied, R>

/** The highest role the viewer holds, for the page client's `me.role`. */
const highest = (roles: RoleSet): RoleName =>
  roles.roles.has('write')
    ? 'write'
    : roles.roles.has('respond')
      ? 'respond'
      : 'read'

/** An encoded link path inside a tree as a tree reference, or null. */
export const treeRefOf = (treeId: TreeId, linkPath: string): TreeRef | null => {
  const folder = linkPath === '' || linkPath.endsWith('/')
  const bare = folder ? linkPath.slice(0, -1) : linkPath
  if (bare === '') return { treeId, path: '', folder: true }
  const names: string[] = []
  for (const segment of bare.split('/')) {
    let name: string
    try {
      name = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (!isNodeName(name)) return null
    names.push(name)
  }
  if (names.length > MAX_DEPTH) return null
  return { treeId, path: names.join('/'), folder }
}

/** The last segment of an encoded link path, kept with its trailing slash. */
const lastSegment = (linkPath: string): string => {
  const folder = linkPath.endsWith('/')
  const bare = folder ? linkPath.slice(0, -1) : linkPath
  const name = bare.slice(bare.lastIndexOf('/') + 1)
  return folder ? `${name}/` : name
}

/**
 * Where a frame redirect points, relative to the request, so the handle and
 * sequence in the frame's path stay as they are. Redirects inside a tree
 * stay in the folder they were asked in.
 */
const relativeTo = (asked: string, to: string): string => {
  const askedDir = asked.slice(0, asked.lastIndexOf('/') + 1)
  const rest = to.startsWith(askedDir) ? to.slice(askedDir.length) : to
  return rest === '' ? './' : `./${lastSegment(rest)}`
}

/** Whether an If-None-Match header names this ETag. */
const etagMatches = (header: string | null, etag: string): boolean => {
  if (header === null) return false
  return header
    .split(',')
    .map((part) => part.trim().replace(/^W\//, ''))
    .some((part) => part === '*' || part === `"${etag}"`)
}

/** One byte range of a file of `size` bytes, or 'unsatisfiable'. */
export const parseRange = (
  header: string | null,
  size: number,
):
  | { readonly offset: number; readonly length: number }
  | null
  | 'unsatisfiable' => {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  // A form Dossier does not serve (several ranges, other units): the whole file.
  if (match === null) return null
  const [, from = '', to = ''] = match
  if (from === '' && to === '') return null
  if (from === '') {
    const suffix = Number(to)
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    const length = Math.min(suffix, size)
    return { offset: size - length, length }
  }
  const offset = Number(from)
  if (offset >= size) return 'unsatisfiable'
  const last = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  if (last < offset) return 'unsatisfiable'
  return { offset, length: last - offset + 1 }
}

const folderOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

export const PagesLive: Layer.Layer<
  Pages,
  never,
  TreeStore | Access | Bindings | Config
> = Layer.effect(
  Pages,
  Effect.gen(function* () {
    const store = yield* TreeStore
    const access = yield* Access
    const { DB, BLOBS } = yield* Bindings
    const config = yield* Config

    const query = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (error) => {
          console.error('A page read failed', error)
          return dossierError('unavailable')
        },
      })

    /** Missing and unreadable answer alike. */
    const denied = (missing: MissingNode) =>
      asDenied(access.require('read', missing)).pipe(
        Effect.zipRight(Effect.die(new Error('Access granted a missing node'))),
      )

    const linkOf = (workspace: string, tree: string, linkPath: string) =>
      `${config.origin.origin}/${encodeURIComponent(workspace)}/${encodeURIComponent(tree)}/${linkPath}`

    const open: PagesService['open'] = ({ ref }) =>
      Effect.gen(function* () {
        const resolved = yield* store.resolve(ref)
        if ('missing' in resolved) return yield* denied(resolved)
        yield* asDenied(access.require('read', resolved.node))
        const caller = yield* CurrentCaller
        switch (resolved.kind) {
          case 'redirect':
            return {
              kind: 'redirect',
              to: `/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.tree)}/${resolved.to}`,
              status: 301,
            } satisfies Served
          case 'folder':
            return { kind: 'listing', ref } satisfies Served
          case 'page':
          case 'file': {
            const linkPath =
              resolved.kind === 'page'
                ? resolved.linkPath
                : linkPathOf(resolved.node.path, false)
            const person = caller.person
            return {
              kind: 'shell',
              boot: {
                v: 1,
                deployment: {
                  origin: config.origin.origin,
                  name: config.deploymentName,
                },
                tree: {
                  id: resolved.tree.id,
                  workspace: ref.workspace,
                  name: ref.tree,
                },
                contentOrigin: contentOrigin(
                  config.contentHost,
                  resolved.tree.id,
                ),
                path: resolved.node.path,
                link: linkOf(ref.workspace, ref.tree, linkPath),
                linkPath,
                seq: resolved.tree.authoredSeq as AuthoredSeq,
                base: config.baseVersion,
                me:
                  person === null
                    ? null
                    : { email: person.email, name: person.name },
              },
            } satisfies Served
          }
        }
      })

    /** The handle of this session on this tree, renewed or replaced. */
    const issue = (sessionId: SessionId, tree: TreeRow) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const row = yield* query(() =>
          DB.prepare(
            `select hash_sha256 as hash, generation, expires_at as expiresAt
             from view_handles where session_id = ? and tree_id = ?`,
          )
            .bind(sessionId, tree.id)
            .first<{ hash: string; generation: number; expiresAt: number }>(),
        )
        const generation =
          row !== null && row.expiresAt > now
            ? row.generation
            : (row?.generation ?? 0) + 1
        const handle = yield* Effect.promise(() =>
          hmacSha256(
            Redacted.value(config.handleSecret),
            `view:${sessionId}:${tree.id}:${generation}`,
          ),
        )
        const hash = yield* Effect.promise(() => sha256Hex(handle))
        const expiresAt = now + HANDLE_LIFE
        return { handle, hash, generation, now, expiresAt }
      })

    const view: PagesService['view'] = ({ treeId, path }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        // Agent keys never get a handle: frames are for browsers.
        if (caller.via.kind === 'agent' || caller.via.kind === 'handle') {
          return yield* Effect.fail(notFound(path))
        }
        const ref = treeRefOf(treeId, path)
        const missing: MissingNode = { missing: true, treeId, path }
        if (ref === null) return yield* denied(missing)
        let resolved: Resolved | MissingNode = yield* store.resolve(ref)
        if (!('missing' in resolved) && resolved.kind === 'redirect') {
          yield* asDenied(access.require('read', resolved.node))
          const next = treeRefOf(treeId, resolved.to)
          resolved = next === null ? missing : yield* store.resolve(next)
        }
        if ('missing' in resolved) return yield* denied(resolved)
        yield* asDenied(access.require('read', resolved.node))
        // A folder without index.html is a listing, which no frame shows.
        if (resolved.kind !== 'page' && resolved.kind !== 'file') {
          return yield* Effect.fail(notFound(path))
        }
        const person = caller.person
        if (person === null || caller.via.kind !== 'browser') {
          return yield* Effect.fail(
            dossierError(
              'sign_in_required',
              'Sign in to open this.',
              'Sign in with Google.',
              path,
            ),
          )
        }
        const roles = yield* access.roleOn(resolved.node)
        const tree = resolved.tree
        const seq = tree.authoredSeq as AuthoredSeq
        const h = yield* issue(caller.via.sessionId, tree)
        const statements = [
          // A new generation drops the old handle and the sequences it held.
          DB.prepare(
            `delete from view_handle_seqs where handle_hash in
               (select hash_sha256 from view_handles
                 where session_id = ? and tree_id = ? and hash_sha256 <> ?)`,
          ).bind(caller.via.sessionId, tree.id, h.hash),
          DB.prepare(
            `delete from view_handles
             where session_id = ? and tree_id = ? and hash_sha256 <> ?`,
          ).bind(caller.via.sessionId, tree.id, h.hash),
          DB.prepare(
            `insert into view_handles (hash_sha256, generation, user_id, session_id,
               anon_session_id, tree_id, expires_at, renewed_at, created_at)
             values (?, ?, ?, ?, null, ?, ?, ?, ?)
             on conflict (hash_sha256) do update set
               expires_at = excluded.expires_at, renewed_at = excluded.renewed_at`,
          ).bind(
            h.hash,
            h.generation,
            person.id,
            caller.via.sessionId,
            tree.id,
            h.expiresAt,
            h.now,
            h.now,
          ),
          DB.prepare(
            `insert into view_handle_seqs (handle_hash, seq, created_at)
             values (?, ?, ?) on conflict do nothing`,
          ).bind(h.hash, seq, h.now),
        ]
        if (resolved.kind === 'page') {
          // Seen by moves at most once an hour per person and page.
          statements.push(
            DB.prepare(
              `insert into seen_by (node_id, user_id, last_seen_at) values (?, ?, ?)
               on conflict (node_id, user_id) do update set last_seen_at = excluded.last_seen_at
               where seen_by.last_seen_at < excluded.last_seen_at - ?`,
            ).bind(resolved.node.id, person.id, h.now, HOUR),
          )
        }
        yield* query(() => DB.batch(statements))
        return {
          handle: h.handle,
          expiresAt: new Date(h.expiresAt).toISOString(),
          seq,
          role: highest(roles),
        } satisfies ViewGrant
      })

    const pushNumberOf = (version: VersionRow) =>
      version.pushId === null
        ? Effect.succeed(0)
        : query(() =>
            DB.prepare('select number from pushes where id = ?')
              .bind(version.pushId)
              .first<{ number: number | null }>(),
          ).pipe(Effect.map((row) => row?.number ?? 0))

    const frame: PagesService['frame'] = (i) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        if (caller.via.kind !== 'handle' || caller.via.treeId !== i.treeId) {
          return yield* Effect.fail(notFound(i.path))
        }
        const via = caller.via
        const asked = linkPathOf(i.path, i.folder)
        const resolved = yield* store.resolve(
          { treeId: i.treeId, path: i.path, folder: i.folder },
          i.seq,
        )
        if ('missing' in resolved || resolved.kind === 'folder') {
          return yield* Effect.fail(notFound(i.path))
        }
        const roles = yield* access.roleOn(resolved.node)
        const reads =
          roles.caps.has('read') ||
          (roles.caps.has('read-authored') &&
            resolved.node.origin === 'authored')
        if (!reads) return yield* Effect.fail(notFound(i.path))
        if (resolved.kind === 'redirect') {
          return {
            kind: 'redirect',
            to: relativeTo(asked, resolved.to),
            status: 301,
          } satisfies Served
        }
        // A sequence never issued to this handle opens only for write
        // holders: history is theirs.
        const issued = yield* query(() =>
          DB.prepare(
            'select 1 as issued from view_handle_seqs where handle_hash = ? and seq = ?',
          )
            .bind(via.handleHash, i.seq)
            .first<{ issued: number }>(),
        )
        if (issued === null && !roles.caps.has('write')) {
          return yield* Effect.fail(notFound(i.path))
        }
        const sha = resolved.version.blobSha256
        if (sha === null) return yield* Effect.fail(notFound(i.path))
        if (resolved.kind === 'page') {
          const object = yield* query(() => BLOBS.get(blobKey(sha)))
          if (object === null) {
            console.error('A blob is missing from R2', { sha256: sha })
            return yield* Effect.fail(notFound(i.path))
          }
          const source = yield* query(() => object.text())
          const analysis = yield* store.analysis(sha as Sha256)
          if (analysis === null) return yield* Effect.fail(notFound(i.path))
          const found = yield* store.treeById(i.treeId)
          if (found === null) return yield* Effect.fail(notFound(i.path))
          const bootstrap: PageBootstrap = {
            v: 1,
            origin: config.origin.origin,
            tree: {
              id: found.tree.id,
              workspace: found.workspace.name,
              name: found.tree.name,
            },
            path: `/${resolved.node.path}`,
            link: linkOf(
              found.workspace.name,
              found.tree.name,
              resolved.linkPath,
            ),
            push: yield* pushNumberOf(resolved.version),
            seq: i.seq,
            base: config.baseVersion,
            kit: {},
          }
          const html = compose({
            page: { source, analysis, folder: folderOf(resolved.node.path) },
            layouts: [],
            inject: bootstrapTags(
              JSON.stringify(bootstrap),
              `/_/base/${config.baseVersion}/client.js`,
            ),
          })
          const etag = yield* Effect.promise(() => sha256Hex(html))
          if (etagMatches(i.ifNoneMatch, etag)) {
            return { kind: 'notModified', etag } satisfies Served
          }
          return { kind: 'framePage', html, etag } satisfies Served
        }
        if (etagMatches(i.ifNoneMatch, sha)) {
          return { kind: 'notModified', etag: sha } satisfies Served
        }
        const size = resolved.version.size ?? 0
        const range = parseRange(i.range, size)
        if (range === 'unsatisfiable') {
          return { kind: 'unsatisfiable', size } satisfies Served
        }
        const object = yield* query(() =>
          BLOBS.get(
            blobKey(sha),
            range === null
              ? {}
              : { range: { offset: range.offset, length: range.length } },
          ),
        )
        if (object === null || !('body' in object)) {
          console.error('A blob is missing from R2', { sha256: sha })
          return yield* Effect.fail(notFound(i.path))
        }
        return {
          kind: 'file',
          body: object.body,
          size,
          etag: sha,
          contentType:
            resolved.version.contentType ?? 'application/octet-stream',
          range,
          download: false,
          cache: 'pinned',
        } satisfies Served
      })

    const seenBy: PagesService['seenBy'] = (ref) =>
      Effect.gen(function* () {
        const resolved = yield* store.resolve(ref)
        if ('missing' in resolved) return yield* denied(resolved)
        if (resolved.kind !== 'page') {
          yield* asDenied(access.require('read', resolved.node))
          return yield* Effect.fail(notFound(ref.path))
        }
        yield* access.require('read-history', resolved.node)
        const now = yield* Clock.currentTimeMillis
        const rows = yield* query(() =>
          DB.prepare(
            `select u.email, u.name, s.last_seen_at as lastSeenAt
             from seen_by s join "user" u on u.id = s.user_id
             where s.node_id = ? order by s.last_seen_at desc, u.email`,
          )
            .bind(resolved.node.id)
            .all<{ email: string; name: string; lastSeenAt: number }>(),
        )
        return rows.results.map((row) => ({
          ...row,
          withinHour: now - row.lastSeenAt < HOUR,
        }))
      })

    const handleCaller: PagesService['handleCaller'] = (handle, treeId) =>
      Effect.gen(function* () {
        if (!HANDLE.test(handle)) return null
        const hash = yield* Effect.promise(() => sha256Hex(handle))
        const now = yield* Clock.currentTimeMillis
        const row = yield* query(() =>
          DB.prepare(
            `select h.session_id as sessionId, u.id, u.email, u.name, u.image
             from view_handles h
               join "session" s on s.id = h.session_id
               join "user" u on u.id = s.user_id
             where h.hash_sha256 = ? and h.tree_id = ?
               and h.expires_at > ? and s.expires_at > ?`,
          )
            .bind(hash, treeId, now, now)
            .first<{
              sessionId: SessionId
              id: PersonId
              email: string
              name: string
              image: string | null
            }>(),
        )
        if (row === null) return null
        return {
          person: {
            id: row.id,
            email: row.email,
            name: row.name,
            image: row.image,
          },
          via: {
            kind: 'handle',
            treeId,
            sessionId: row.sessionId,
            anonSessionId: null,
            handleHash: hash,
          },
          requestId: '',
        } satisfies Caller
      })

    return { open, view, frame, seenBy, handleCaller } satisfies PagesService
  }),
)
