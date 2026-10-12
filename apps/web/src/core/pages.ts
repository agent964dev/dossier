import {
  contentOrigin,
  dossierError,
  isNodeName,
  MAX_DEPTH,
  type AuthoredSeq,
  type DossierError,
  type ErrorCode,
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
import {
  ANALYZER_VERSION,
  bootstrapTags,
  compose,
  COMPOSER_VERSION,
  layoutsOf,
  relativeFrom,
  type HtmlAnalysis,
  type Source,
} from '@dossier/html'
import { sql } from 'drizzle-orm'
import { Clock, Context, Effect, Layer, Redacted } from 'effect'

import { db, schema } from '../db/client.ts'
import { Access, type RoleSet } from './access.ts'
import { BaseLayer } from './base-layer.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller, type Caller } from './caller.ts'
import { Config } from './config.ts'
import { hmacSha256, sha256Hex } from './ids.ts'
import { composedLayouts, kitAt, kitMap, type LayoutLink } from './lookup.ts'
import {
  composedKeyUrl as composedKeyText,
  PageCache,
  type ComposedKey,
} from './page-cache.ts'
import type { MissingNode, NodeRow, TreeRow, VersionRow } from './rows.ts'
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
    DossierError<'not_found' | 'sign_in_required' | 'unavailable'>,
    CurrentCaller
  >
  readonly view: (i: {
    readonly treeId: TreeId
    /** The link's path inside the tree, encoded: '', 'questions/', 'plan'. */
    readonly path: string
  }) => Effect.Effect<
    ViewGrant,
    DossierError<'not_found' | 'sign_in_required' | 'unavailable'>,
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
    /** The content host the edge matched, for the composed-page cache. */
    readonly host: string
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
/** How many of a page's own references a view looks up to issue. */
const MAX_LOADED = 200
/** How often a view reads again when another one changed the handle. */
const ISSUE_ATTEMPTS = 4

/** Whether these roles read the node: respond reads authored files only. */
const readsWith = (
  roles: RoleSet,
  node: { readonly origin: string },
): boolean =>
  roles.caps.has('read') ||
  (roles.caps.has('read-authored') && node.origin === 'authored')

/**
 * A denial names only the path that was asked, never the node it resolved
 * to, so it says nothing about what exists.
 */
const askedAs = <A, C extends ErrorCode, R>(
  path: string,
  effect: Effect.Effect<A, DossierError<C>, R>,
): Effect.Effect<A, DossierError<C>, R> =>
  Effect.mapError(effect, (error) =>
    error.code === 'unavailable'
      ? error
      : dossierError(error.code, error.message, error.fix, path),
  )

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
  TreeStore | Access | Bindings | Config | BaseLayer | PageCache
> = Layer.effect(
  Pages,
  Effect.gen(function* () {
    const store = yield* TreeStore
    const access = yield* Access
    const bindings = yield* Bindings
    const { DB, BLOBS } = bindings
    const config = yield* Config
    const base = yield* BaseLayer
    const cache = yield* PageCache
    const context = yield* Effect.context<Bindings | BaseLayer>()

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

    /** Whether the caller may read some live node at or below `folder`. */
    const readsBelow = (treeId: TreeId, folder: string) =>
      Effect.gen(function* () {
        const readable = yield* access.readable(treeId)
        const below =
          folder === ''
            ? sql`1`
            : sql`(${schema.nodes.path} = ${folder} or substr(${schema.nodes.path}, 1, length(${folder}) + 1) = ${`${folder}/`})`
        const rows = yield* query(() =>
          db(bindings)
            .select({ id: schema.nodes.id })
            .from(schema.nodes)
            .where(
              sql`${schema.nodes.treeId} = ${treeId} and ${schema.nodes.deletedAt} is null and ${below} and ${readable.where}`,
            )
            .limit(1)
            .all(),
        )
        return rows.length > 0
      })

    /**
     * The `_` file a request takes: the first tree candidate the caller may
     * read (or, with `write`, write), else the base layer's when the caller
     * reads something the lookup started from, else null.
     */
    const kitChoice = (
      kit: Extract<Resolved, { readonly kind: 'kit' }>,
      needs: 'read' | 'write',
    ) =>
      Effect.gen(function* () {
        for (const found of kit.found) {
          if (found.kind === 'base') {
            const reaches = yield* readsBelow(kit.tree.id, kit.folder)
            return reaches ? found : null
          }
          const granted = yield* access
            .require(needs, found.node)
            .pipe(Effect.isSuccess)
          if (granted) return found
        }
        return null
      })

    const open: PagesService['open'] = ({ ref }) =>
      askedAs(
        ref.path,
        Effect.gen(function* () {
          let resolved = yield* store.resolve(ref)
          if ('missing' in resolved) return yield* denied(resolved)
          if (resolved.kind === 'kit') {
            const chosen = yield* kitChoice(resolved, 'read')
            if (chosen === null) {
              return yield* denied({
                missing: true,
                treeId: resolved.tree.id,
                path: ref.path,
              })
            }
            if (chosen.kind === 'base') {
              return {
                kind: 'redirect',
                to: base.url(chosen.path),
                status: 302,
              } satisfies Served
            }
            // The frame looks the same `_` path up again, at the shell's push.
            resolved = {
              kind: 'file',
              node: { ...chosen.node, path: ref.path },
              version: chosen.version,
              tree: resolved.tree,
            }
          } else {
            yield* asDenied(access.require('read', resolved.node))
          }
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
        }),
      )

    /**
     * The node a reference names at a sequence, when the caller may read it
     * now: a page or file (one redirect followed), or the first tree
     * candidate of a `_` lookup. The base layer's files are not issued; they
     * are the same for everyone.
     */
    const issuable = (ref: TreeRef, seq: AuthoredSeq) =>
      Effect.gen(function* () {
        let found: Resolved | MissingNode = yield* store.resolve(ref, seq)
        if (!('missing' in found) && found.kind === 'redirect') {
          const next = treeRefOf(ref.treeId, found.to)
          found = next === null ? found : yield* store.resolve(next, seq)
        }
        if ('missing' in found) return null
        if (found.kind === 'kit') {
          for (const candidate of found.found) {
            if (candidate.kind === 'base') return null
            const reads = yield* access
              .require('read', candidate.node)
              .pipe(Effect.isSuccess)
            if (reads) return candidate.node
          }
          return null
        }
        if (found.kind !== 'page' && found.kind !== 'file') return null
        const roles = yield* access.roleOn(found.node)
        return readsWith(roles, found.node) ? found.node : null
      })

    /**
     * The nodes a view issues with a page, as the tree was at `seq`: the
     * page, the tree layouts composed into it, the files the page and those
     * layouts load (scripts, styles, images, media, frames), and the tree's
     * components the page may load, each only when the caller may read it
     * now. Links to other pages are not issued: following one is a view.
     */
    const loadedBy = (
      resolved: Extract<Resolved, { kind: 'page' | 'file' }>,
      seq: AuthoredSeq,
    ) =>
      Effect.gen(function* () {
        const ids = new Set<string>([resolved.node.id])
        const sha = resolved.version.blobSha256
        if (resolved.kind !== 'page' || sha === null) return [...ids]
        const analysis = yield* store.analysis(sha as Sha256)
        if (analysis === null) return [...ids]
        const treeId = resolved.tree.id
        const folder = folderOf(resolved.node.path)
        const chain = yield* composedLayouts({
          treeId,
          page: { node: resolved.node, version: resolved.version, analysis },
          at: seq,
        }).pipe(Effect.provide(context))
        for (const link of chain) ids.add(link.node.id)
        let looked = 0
        const references = [
          { folder, analysis },
          ...chain.map((link) => ({
            folder: link.folder,
            analysis: link.analysis,
          })),
        ]
        for (const source of references) {
          const from = `https://tree.invalid/${linkPathOf(source.folder, true)}`
          for (const url of source.analysis.urls) {
            const loads =
              url.relative &&
              (url.attr === 'src' ||
                url.attr === 'srcset' ||
                url.attr === 'poster' ||
                (url.attr === 'href' && url.inHead))
            if (!loads || looked >= MAX_LOADED) continue
            looked += 1
            let target: URL
            try {
              // What the browser requests: character references decoded.
              target = new URL(url.decoded, from)
            } catch {
              continue
            }
            if (target.origin !== 'https://tree.invalid') continue
            const ref = treeRefOf(treeId, target.pathname.slice(1))
            if (ref === null) continue
            const node = yield* issuable(ref, seq)
            if (node !== null) ids.add(node.id)
          }
        }
        // The components the page may load, by the kit map it is served with.
        const items = yield* kitAt({ treeId, folder, at: seq }).pipe(
          Effect.provide(context),
        )
        for (const found of Object.values(kitMap(items))) {
          if (found.from !== 'tree' || looked >= MAX_LOADED) continue
          looked += 1
          const ref = treeRefOf(treeId, linkPathOf(found.path, false))
          if (ref === null) continue
          const node = yield* issuable(ref, seq)
          if (node !== null) ids.add(node.id)
        }
        return [...ids]
      })

    /**
     * Renews this session's handle on the tree, or replaces a lapsed one with
     * the next generation, and issues the nodes at the sequence. Every write
     * is conditioned on the row it read, so an operation that read an older
     * state never undoes a newer generation; a lost race reads again.
     */
    const issue = (
      sessionId: SessionId,
      personId: string,
      tree: TreeRow,
      seq: AuthoredSeq,
      nodeIds: readonly string[],
      extra: readonly D1PreparedStatement[],
    ) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < ISSUE_ATTEMPTS; attempt += 1) {
          const now = yield* Clock.currentTimeMillis
          const row = yield* query(() =>
            DB.prepare(
              `select hash_sha256 as hash, generation, expires_at as expiresAt
               from view_handles where session_id = ? and tree_id = ?`,
            )
              .bind(sessionId, tree.id)
              .first<{ hash: string; generation: number; expiresAt: number }>(),
          )
          const live = row !== null && row.expiresAt > now
          const generation = live ? row.generation : (row?.generation ?? 0) + 1
          const handle = yield* Effect.promise(() =>
            hmacSha256(
              Redacted.value(config.handleSecret),
              `view:${sessionId}:${tree.id}:${generation}`,
            ),
          )
          const hash = yield* Effect.promise(() => sha256Hex(handle))
          const expiresAt = now + HANDLE_LIFE
          const statements: D1PreparedStatement[] = []
          if (live) {
            // Only a handle still live renews: a lapsed one never returns.
            statements.push(
              DB.prepare(
                `update view_handles set expires_at = max(expires_at, ?), renewed_at = ?
                 where hash_sha256 = ? and expires_at > ?`,
              ).bind(expiresAt, now, hash, now),
            )
          } else {
            if (row !== null) {
              // Drop only the lapsed row this read saw.
              statements.push(
                DB.prepare(
                  `delete from view_handle_nodes where handle_hash = ?1
                     and exists (select 1 from view_handles
                                 where hash_sha256 = ?1 and expires_at <= ?2)`,
                ).bind(row.hash, now),
                DB.prepare(
                  'delete from view_handles where hash_sha256 = ? and expires_at <= ?',
                ).bind(row.hash, now),
              )
            }
            statements.push(
              DB.prepare(
                `insert into view_handles (hash_sha256, generation, user_id, session_id,
                   anon_session_id, tree_id, expires_at, renewed_at, created_at)
                 select ?1, ?2, ?3, ?4, null, ?5, ?6, ?7, ?7
                 where not exists (select 1 from view_handles
                                   where session_id = ?4 and tree_id = ?5)`,
              ).bind(
                hash,
                generation,
                personId,
                sessionId,
                tree.id,
                expiresAt,
                now,
              ),
            )
          }
          for (const nodeId of nodeIds) {
            statements.push(
              DB.prepare(
                `insert into view_handle_nodes (handle_hash, seq, node_id, created_at)
                 select ?1, ?2, ?3, ?4 where exists
                   (select 1 from view_handles where hash_sha256 = ?1 and expires_at > ?4)
                   and (select authored_seq from trees where id = ?5) = ?2
                 on conflict do nothing`,
              ).bind(hash, seq, nodeId, now, tree.id),
            )
          }
          statements.push(
            ...extra,
            DB.prepare(
              `select hash_sha256 as hash, expires_at as expiresAt,
                 (select authored_seq from trees where id = ?2) as seq
               from view_handles where session_id = ?1 and tree_id = ?2`,
            ).bind(sessionId, tree.id),
          )
          const results = yield* query(() => DB.batch(statements))
          const stands = results[results.length - 1]?.results[0] as
            | { hash: string; expiresAt: number; seq: number }
            | undefined
          if (stands?.hash === hash && stands.expiresAt > now) {
            // A push since the view read the tree: what it resolved may not
            // be the tree at `seq`, so nothing was issued and the view starts
            // again.
            return {
              handle,
              expiresAt: stands.expiresAt,
              moved: stands.seq !== seq,
            }
          }
        }
        console.error('A view handle kept changing while it was issued', {
          tree: tree.id,
        })
        return yield* Effect.fail(dossierError('unavailable'))
      })

    const view: PagesService['view'] = ({ treeId, path }) =>
      askedAs(
        path,
        Effect.gen(function* () {
          const caller = yield* CurrentCaller
          // Agent keys never get a handle: frames are for browsers.
          if (caller.via.kind === 'agent' || caller.via.kind === 'handle') {
            return yield* Effect.fail(notFound(path))
          }
          const ref = treeRefOf(treeId, path)
          const missing: MissingNode = { missing: true, treeId, path }
          if (ref === null) return yield* denied(missing)
          for (let attempt = 0; attempt < ISSUE_ATTEMPTS; attempt += 1) {
            let resolved: Resolved | MissingNode = yield* store.resolve(ref)
            if (!('missing' in resolved) && resolved.kind === 'redirect') {
              yield* asDenied(access.require('read', resolved.node))
              const next = treeRefOf(treeId, resolved.to)
              resolved = next === null ? missing : yield* store.resolve(next)
            }
            if ('missing' in resolved) return yield* denied(missing)
            if (resolved.kind === 'kit') {
              // A `_` file opens as the file its lookup gives this viewer.
              const chosen = yield* kitChoice(resolved, 'read')
              if (chosen === null || chosen.kind === 'base') {
                return yield* denied(missing)
              }
              resolved = {
                kind: 'file',
                node: chosen.node,
                version: chosen.version,
                tree: resolved.tree,
              }
            }
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
            const nodeIds = yield* loadedBy(resolved, seq)
            const now = yield* Clock.currentTimeMillis
            const seen =
              resolved.kind === 'page'
                ? [
                    // Seen by moves at most once an hour per person and page.
                    DB.prepare(
                      `insert into seen_by (node_id, user_id, last_seen_at) values (?, ?, ?)
                     on conflict (node_id, user_id) do update set last_seen_at = excluded.last_seen_at
                     where seen_by.last_seen_at < excluded.last_seen_at - ?`,
                    ).bind(resolved.node.id, person.id, now, HOUR),
                  ]
                : []
            const h = yield* issue(
              caller.via.sessionId,
              person.id,
              tree,
              seq,
              nodeIds,
              seen,
            )
            if (h.moved) continue
            return {
              handle: h.handle,
              expiresAt: new Date(h.expiresAt).toISOString(),
              seq,
              role: highest(roles),
            } satisfies ViewGrant
          }
          console.error('The tree kept moving while a view was issued', {
            tree: treeId,
          })
          return yield* Effect.fail(dossierError('unavailable'))
        }),
      )

    const pushNumberOf = (version: VersionRow) =>
      version.pushId === null
        ? Effect.succeed(0)
        : query(() =>
            DB.prepare('select number from pushes where id = ?')
              .bind(version.pushId)
              .first<{ number: number | null }>(),
          ).pipe(Effect.map((row) => row?.number ?? 0))

    /** A file's bytes at a pinned sequence, with ranges and ETags. */
    const serveFile = (
      path: string,
      version: VersionRow,
      i: { readonly range: string | null; readonly ifNoneMatch: string | null },
    ) =>
      Effect.gen(function* () {
        const sha = version.blobSha256
        if (sha === null) return yield* Effect.fail(notFound(path))
        if (etagMatches(i.ifNoneMatch, sha)) {
          return { kind: 'notModified', etag: sha } satisfies Served
        }
        const size = version.size ?? 0
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
          return yield* Effect.fail(notFound(path))
        }
        return {
          kind: 'file',
          body: object.body,
          size,
          etag: sha,
          contentType: version.contentType ?? 'application/octet-stream',
          range,
          download: false,
          cache: 'pinned',
        } satisfies Served
      })

    /** A blob's text from R2, or not found when its bytes are missing. */
    const textOf = (path: string, version: VersionRow) =>
      Effect.gen(function* () {
        const sha = version.blobSha256
        const object =
          sha === null ? null : yield* query(() => BLOBS.get(blobKey(sha)))
        if (object === null) {
          console.error('A blob is missing from R2', { sha256: sha })
          return yield* Effect.fail(notFound(path))
        }
        return yield* query(() => object.text())
      })

    /**
     * Whether the handle may open these nodes at a sequence (for a page: the
     * page and every tree layout composed into it there). Each must be one a
     * view issued to this handle at that sequence, or unchanged since then
     * (nothing replaced, so nothing recovered), or one the caller writes:
     * history is for write holders.
     */
    const opensAt = (
      handleHash: string,
      seq: AuthoredSeq,
      nodes: readonly {
        readonly node: NodeRow
        readonly version: VersionRow
      }[],
    ) =>
      Effect.gen(function* () {
        for (const { node, version } of nodes) {
          const issued = yield* query(() =>
            DB.prepare(
              `select 1 as issued from view_handle_nodes
               where handle_hash = ? and seq = ? and node_id = ?`,
            )
              .bind(handleHash, seq, node.id)
              .first<{ issued: number }>(),
          )
          if (issued !== null) continue
          const now = yield* query(() =>
            DB.prepare(
              `select v.blob_sha256 as sha from nodes n
                 join node_versions v on v.id = n.current_version_id
               where n.tree_id = ? and n.path = ? and n.deleted_at is null
                 and v.state = 'live'`,
            )
              .bind(node.treeId, node.path)
              .first<{ sha: string | null }>(),
          )
          if (now !== null && now.sha === version.blobSha256) continue
          const writes = yield* access
            .require('write', node)
            .pipe(Effect.isSuccess)
          if (!writes) return false
        }
        return true
      })

    /** A page or file at a sequence with what composes it there. */
    const composedAt = (
      target: Extract<Resolved, { kind: 'page' | 'file' }>,
      treeId: TreeId,
      seq: AuthoredSeq,
    ) =>
      Effect.gen(function* () {
        if (target.kind === 'file') {
          return { analysis: null, chain: [] as readonly LayoutLink[] }
        }
        const sha = target.version.blobSha256
        const analysis =
          sha === null ? null : yield* store.analysis(sha as Sha256)
        if (analysis === null) return null
        const chain = yield* composedLayouts({
          treeId,
          page: { node: target.node, version: target.version, analysis },
          at: seq,
        }).pipe(Effect.provide(context))
        return { analysis, chain }
      })

    /** The composed page: from the cache, or composed and stored. */
    const composedPage = (i: {
      readonly key: ComposedKey
      readonly tree: {
        readonly id: TreeId
        readonly workspace: string
        readonly name: string
      }
      readonly node: NodeRow
      readonly version: VersionRow
      readonly analysis: HtmlAnalysis
      readonly chain: readonly LayoutLink[]
      readonly linkPath: string
    }) =>
      Effect.gen(function* () {
        const hit = yield* cache.get(i.key)
        if (hit !== null) return hit
        const folder = folderOf(i.node.path)
        const page: Source = {
          source: yield* textOf(i.node.path, i.version),
          analysis: i.analysis,
          folder,
        }
        const tree: Source[] = []
        for (const link of i.chain) {
          tree.push({
            source: yield* textOf(i.node.path, link.version),
            analysis: link.analysis,
            folder: link.folder,
          })
        }
        const layouts = page.analysis.complete
          ? []
          : layoutsOf(page, [...tree].reverse(), yield* base.layout())
        const items = yield* kitAt({
          treeId: i.key.treeId,
          folder,
          at: i.key.seq,
        }).pipe(Effect.provide(context))
        const urls: Record<string, string> = {}
        for (const [tag, found] of Object.entries(kitMap(items))) {
          urls[tag] =
            found.from === 'tree'
              ? relativeFrom(folder, found.path)
              : base.url(found.path)
        }
        const push = yield* pushNumberOf(i.version)
        const html = compose({
          page,
          layouts,
          inject: ({ tags }) => {
            const used = tags.filter((tag) => Object.hasOwn(urls, tag))
            const bootstrap: PageBootstrap = {
              v: 1,
              origin: config.origin.origin,
              tree: i.tree,
              path: `/${i.node.path}`,
              link: linkOf(i.tree.workspace, i.tree.name, i.linkPath),
              push,
              seq: i.key.seq,
              base: base.version,
              kit: urls,
              used,
            }
            return bootstrapTags(
              JSON.stringify(bootstrap),
              base.url('client.js'),
              used.map((tag) => urls[tag]!),
            )
          },
        })
        yield* cache.put(i.key, html)
        return html
      })

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
        if (resolved.kind === 'kit') {
          // The first candidate the handle may open; the base layer's own
          // files are the same for everyone.
          for (const found of resolved.found) {
            if (found.kind === 'base') {
              return {
                kind: 'redirect',
                to: base.url(found.path),
                status: 302,
              } satisfies Served
            }
            const readable = yield* access
              .require('read', found.node)
              .pipe(Effect.isSuccess)
            if (!readable) continue
            if (
              !(yield* opensAt(via.handleHash, i.seq, [
                { node: found.node, version: found.version },
              ]))
            ) {
              continue
            }
            return yield* serveFile(i.path, found.version, i)
          }
          return yield* Effect.fail(notFound(i.path))
        }
        // A redirect is answered only once its target may be opened here.
        let target: Resolved | MissingNode = resolved
        if (resolved.kind === 'redirect') {
          const next = treeRefOf(i.treeId, resolved.to)
          target =
            next === null
              ? { missing: true, treeId: i.treeId, path: i.path }
              : yield* store.resolve(next, i.seq)
        }
        if (
          'missing' in target ||
          (target.kind !== 'page' && target.kind !== 'file')
        ) {
          return yield* Effect.fail(notFound(i.path))
        }
        const roles = yield* access.roleOn(target.node)
        if (!readsWith(roles, target.node)) {
          return yield* Effect.fail(notFound(i.path))
        }
        const parts = yield* composedAt(target, i.treeId, i.seq)
        if (parts === null) return yield* Effect.fail(notFound(i.path))
        const opens = yield* opensAt(via.handleHash, i.seq, [
          { node: target.node, version: target.version },
          ...parts.chain.map((link) => ({
            node: link.node,
            version: link.version,
          })),
        ])
        if (!opens) return yield* Effect.fail(notFound(i.path))
        if (resolved.kind === 'redirect') {
          return {
            kind: 'redirect',
            to: relativeTo(asked, resolved.to),
            status: 301,
          } satisfies Served
        }
        if (target.kind === 'file') {
          return yield* serveFile(i.path, target.version, i)
        }
        const analysis = parts.analysis!
        const chain = parts.chain
        const found = yield* store.treeById(i.treeId)
        if (found === null) return yield* Effect.fail(notFound(i.path))
        const key: ComposedKey = {
          host: i.host,
          treeId: i.treeId,
          seq: i.seq,
          path: target.node.path,
          composer: `${COMPOSER_VERSION}.${ANALYZER_VERSION}`,
          base: base.version,
        }
        // One ETag per key: the composed page is the same for every viewer.
        const etag = `c-${yield* Effect.promise(() => sha256Hex(composedKeyText(key)))}`
        if (etagMatches(i.ifNoneMatch, etag)) {
          return { kind: 'notModified', etag } satisfies Served
        }
        const html = yield* composedPage({
          key,
          tree: {
            id: found.tree.id,
            workspace: found.workspace.name,
            name: found.tree.name,
          },
          node: target.node,
          version: target.version,
          analysis,
          chain,
          linkPath: target.linkPath,
        })
        return { kind: 'framePage', html, etag } satisfies Served
      })

    const seenBy: PagesService['seenBy'] = (ref) =>
      askedAs(
        ref.path,
        Effect.gen(function* () {
          const resolved = yield* store.resolve(ref)
          if ('missing' in resolved) return yield* denied(resolved)
          if (resolved.kind !== 'page') {
            if (resolved.kind !== 'kit') {
              yield* asDenied(access.require('read', resolved.node))
            } else if ((yield* kitChoice(resolved, 'read')) === null) {
              return yield* denied({
                missing: true,
                treeId: resolved.tree.id,
                path: ref.path,
              })
            }
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
        }),
      )

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
