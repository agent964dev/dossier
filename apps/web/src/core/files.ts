import {
  dossierError,
  type AuthoredSeq,
  type DiffResponse,
  type DossierError,
  type EntryWire,
  type EventSeq,
  type LinkRef,
  type LogLine,
  type NodeId,
  type PushFile,
  type PushNumber,
  type Sha256,
  type TreeId,
} from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import { Access, type RoleSet } from './access.ts'
import type { Background } from './background.ts'
import type { BaseLayer } from './base-layer.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller } from './caller.ts'
import { ChangeFeed } from './change-feed.ts'
import { makeChanges } from './changes.ts'
import { Config } from './config.ts'
import { makeHistory } from './history.ts'
import {
  kitAt,
  lookupUnderscore,
  underscoreSplit,
  type KitItem,
} from './lookup.ts'
import type {
  MissingNode,
  NodeRow,
  PushRow,
  TreeRow,
  WorkspaceRow,
} from './rows.ts'
import { Data } from './data.ts'
import { Settings } from './settings.ts'
import { TreeStore, type Entry, type FileBody } from './tree-store.ts'

export interface Listing {
  readonly tree: TreeRow
  readonly workspace: WorkspaceRow
  readonly folder: NodeRow
  readonly seq: AuthoredSeq
  readonly roles: RoleSet
  readonly entries: readonly Entry[]
}

type ReadFailure = DossierError<
  'not_found' | 'sign_in_required' | 'unavailable'
>

/** Where a restore takes a file or folder back to. */
export type RestorePoint =
  | { readonly push: PushNumber }
  /** Epoch milliseconds: versions created at or before it. */
  | { readonly at: number }

export interface LogPage {
  /** The folder's or file's tree path. */
  readonly path: string
  readonly lines: readonly LogLine[]
  readonly next: string | null
  readonly retentionDays: number
}

export interface PushDetail {
  readonly push: PushRow
  /** As LogLine.by. */
  readonly by: string
  readonly files: readonly PushFile[]
}

export type DiffResult = DiffResponse

export interface ChangeResult {
  readonly path: string
  readonly link: string
  readonly seq: EventSeq
  /** Tree paths of the files the change touched. */
  readonly changed: readonly string[]
}

export interface MoveResult {
  /** '<workspace>/<tree>/<path>'. */
  readonly from: string
  readonly to: string
  readonly link: string
  readonly seq: EventSeq
  readonly rewritten: readonly string[]
  readonly revokedTeamShares: readonly string[]
}

type HistoryFail = DossierError<
  'not_found' | 'sign_in_required' | 'forbidden' | 'unavailable'
>

export interface FilesService {
  /** What a folder holds that the caller can open; `_` files for writers. */
  readonly ls: (i: {
    readonly ref: LinkRef
    readonly depth: 'one' | 'all'
  }) => Effect.Effect<Listing, ReadFailure, CurrentCaller>
  /**
   * A file's bytes. A `_` path is answered by the closest `_` file the
   * lookup reaches that the caller may read.
   */
  readonly content: (
    ref: LinkRef,
  ) => Effect.Effect<
    FileBody & { readonly name: string },
    ReadFailure,
    CurrentCaller
  >
  /** The `_` files reachable at a folder, closest first; write holders only. */
  readonly kit: (
    ref: LinkRef,
  ) => Effect.Effect<
    { readonly folder: string; readonly items: readonly KitItem[] },
    DossierError<
      'not_found' | 'sign_in_required' | 'forbidden' | 'unavailable'
    >,
    CurrentCaller
  >
  /**
   * Pushes, deletions, restores, moves and withdrawals at or below a folder,
   * or of a file, newest first, 50 a page. Write holders only.
   */
  readonly log: (i: {
    readonly ref: LinkRef
    readonly cursor: string | null
  }) => Effect.Effect<LogPage, HistoryFail, CurrentCaller>
  /** The files a push changed under the folder, with line counts for text. */
  readonly pushDetail: (i: {
    readonly ref: LinkRef
    readonly number: PushNumber
  }) => Effect.Effect<PushDetail, HistoryFail, CurrentCaller>
  /**
   * A file's two versions and their patch: `to` defaults to the current
   * version, `from` to the one before it. A folder needs both pushes.
   */
  readonly diff: (i: {
    readonly ref: LinkRef
    readonly from: PushNumber | null
    readonly to: PushNumber | null
  }) => Effect.Effect<
    DiffResult,
    HistoryFail | DossierError<'invalid'>,
    CurrentCaller
  >
  /** A file or folder made to match an earlier point; copies no bytes. */
  readonly restore: (i: {
    readonly ref: LinkRef
    readonly to: RestorePoint
  }) => Effect.Effect<
    ChangeResult,
    HistoryFail | DossierError<'invalid' | 'conflict' | 'blob_reclaiming'>,
    CurrentCaller | Background
  >
  /** A deletion: a change in history, restorable within the retention. */
  readonly rm: (i: {
    readonly ref: LinkRef
  }) => Effect.Effect<
    ChangeResult,
    HistoryFail | DossierError<'conflict'>,
    CurrentCaller | Background
  >
  /** A new path for a node in its tree, or a tree root in another workspace. */
  readonly mv: (i: {
    readonly from: LinkRef
    readonly to: LinkRef
  }) => Effect.Effect<
    MoveResult,
    | HistoryFail
    | DossierError<
        'invalid' | 'conflict' | 'policy_rejected' | 'blob_reclaiming'
      >,
    CurrentCaller | Background
  >
  readonly moveTree: (i: {
    readonly tree: LinkRef
    readonly to: { readonly workspace: string; readonly tree: string }
  }) => Effect.Effect<
    MoveResult,
    HistoryFail | DossierError<'conflict' | 'invalid'>,
    CurrentCaller | Background
  >
}

export class Files extends Context.Tag('Files')<Files, FilesService>() {}

/** An entry as the API and reads give it. */
export const entryWire = (entry: Entry): EntryWire => ({
  name: entry.name,
  path: entry.path,
  kind: entry.kind,
  folder: entry.node.kind === 'folder',
  size: entry.size,
  sha256: entry.sha256,
  contentType: entry.contentType,
  title: entry.title,
  push:
    entry.push === null
      ? null
      : {
          number: entry.push.number,
          at: new Date(entry.push.at).toISOString(),
        },
})

const isUnder = (path: string, prefix: string): boolean =>
  prefix === '' || path === prefix || path.startsWith(`${prefix}/`)

/** Reading never asks for more than read, so forbidden cannot happen. */
const readOnly = <A, R>(
  effect: Effect.Effect<
    A,
    DossierError<
      'not_found' | 'sign_in_required' | 'forbidden' | 'unavailable'
    >,
    R
  >,
): Effect.Effect<A, ReadFailure, R> =>
  effect.pipe(
    Effect.catchIf(
      (error): error is DossierError<'forbidden'> => error.code === 'forbidden',
      (error) =>
        Effect.fail(dossierError('not_found', error.message, null, error.path)),
    ),
  ) as Effect.Effect<A, ReadFailure, R>

export const FilesLive: Layer.Layer<
  Files,
  never,
  | TreeStore
  | Access
  | Bindings
  | BaseLayer
  | Settings
  | Data
  | ChangeFeed
  | Config
> = Layer.effect(
  Files,
  Effect.gen(function* () {
    const store = yield* TreeStore
    const access = yield* Access
    const context = yield* Effect.context<Bindings | BaseLayer>()

    /** History is write holders': a reader is told it is not theirs. */
    const narrowHistory = (error: DossierError) => Effect.fail(error)

    /** Missing and unreadable answer alike. */
    const denied = (missing: MissingNode) =>
      access
        .require('read', missing)
        .pipe(
          Effect.zipRight(
            Effect.die(new Error('Access granted a missing node')),
          ),
        )

    const ls: FilesService['ls'] = ({ ref, depth }) =>
      readOnly(
        Effect.gen(function* () {
          const resolved = yield* store.locate(ref)
          if ('missing' in resolved) return yield* denied(resolved)
          const granted = yield* access.require('read', resolved.node)
          const roles = yield* access.roleOn(resolved.node)
          const workspace = yield* store.workspace(ref.workspace)
          if (workspace === null) {
            return yield* denied({
              missing: true,
              treeId: null,
              path: ref.path,
            })
          }
          const writer = roles.caps.has('write')
          const entries: readonly Entry[] =
            resolved.kind === 'folder'
              ? (yield* store.list(granted, depth)).filter(
                  (entry) => depth === 'all' || writer || entry.kind !== 'kit',
                )
              : [
                  {
                    name: resolved.node.name,
                    path: resolved.node.path,
                    kind: resolved.node.path
                      .split('/')
                      .some((s) => s.startsWith('_'))
                      ? 'kit'
                      : resolved.node.origin === 'data'
                        ? 'data'
                        : resolved.node.name.endsWith('.html')
                          ? 'page'
                          : 'attachment',
                    node: resolved.node,
                    size: resolved.version.size,
                    sha256: resolved.version.blobSha256 as Sha256 | null,
                    contentType: resolved.version.contentType,
                    title: null,
                    push: null,
                    pages: null,
                  },
                ]
          return {
            tree: resolved.tree,
            workspace,
            folder: resolved.node,
            seq: resolved.tree.authoredSeq as AuthoredSeq,
            roles,
            entries,
          } satisfies Listing
        }),
      )

    /** The closest `_` file at or above the path that the caller reads. */
    const kitContent = (ref: LinkRef, from: string, rest: string) =>
      Effect.gen(function* () {
        const missing = (treeId: TreeId | null): MissingNode => ({
          missing: true,
          treeId,
          path: ref.path,
        })
        const ws = yield* store.workspace(ref.workspace)
        const tree = ws === null ? null : yield* store.tree(ws, ref.tree)
        if (tree === null) return yield* denied(missing(null))
        const found = yield* lookupUnderscore({
          treeId: tree.id,
          folder: from,
          rest,
          at: tree.authoredSeq as AuthoredSeq,
        }).pipe(Effect.provide(context))
        for (const candidate of found) {
          if (candidate.kind !== 'tree') continue
          const granted = yield* access
            .require('read', candidate.node)
            .pipe(Effect.option)
          if (granted._tag === 'None') continue
          const body = yield* store.read(granted.value)
          return { ...body, name: candidate.node.name }
        }
        return yield* denied(missing(tree.id))
      })

    const content: FilesService['content'] = (ref) =>
      readOnly(
        Effect.gen(function* () {
          const split = ref.folder ? null : underscoreSplit(ref.path)
          if (split !== null) {
            return yield* kitContent(ref, split.from, split.rest)
          }
          const resolved = yield* store.locate(ref)
          if ('missing' in resolved || resolved.kind === 'folder') {
            return yield* denied(
              'missing' in resolved
                ? resolved
                : { missing: true, treeId: resolved.tree.id, path: ref.path },
            )
          }
          const granted = yield* access.require('read', resolved.node)
          const body = yield* store.read(granted)
          return { ...body, name: resolved.node.name }
        }),
      )

    const kit: FilesService['kit'] = (ref) =>
      Effect.gen(function* () {
        const resolved = yield* store.locate(ref)
        if ('missing' in resolved) return yield* denied(resolved)
        yield* access.require('read-history', resolved.node)
        const folder =
          resolved.kind === 'folder'
            ? resolved.node.path
            : resolved.node.path.includes('/')
              ? resolved.node.path.slice(0, resolved.node.path.lastIndexOf('/'))
              : ''
        const items = yield* kitAt({
          treeId: resolved.tree.id,
          folder,
        }).pipe(Effect.provide(context))
        return { folder, items }
      })

    const bindings = yield* Bindings
    const { DB, BLOBS } = bindings
    const settings = yield* Settings
    const config = yield* Config
    const history = makeHistory({ DB, BLOBS })
    const changes = makeChanges({
      DB,
      BLOBS,
      origin: config.origin,
      store,
      access,
      data: yield* Data,
      feed: yield* ChangeFeed,
      history,
      bindings,
    })

    /**
     * What history asks about: a folder, a file or a page by its link path,
     * live or deleted, read-history checked. History is for people: a
     * visitor is asked to sign in, whatever a share gives anyone.
     */
    const historyNode = (ref: LinkRef) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        if (caller.person === null) {
          return yield* Effect.fail(
            dossierError(
              'sign_in_required',
              'Sign in to see history.',
              'Sign in with Google, or run dossier login.',
              ref.path,
            ),
          )
        }
        const located = yield* store.locate(ref, { deleted: true })
        if ('missing' in located) return yield* denied(located)
        yield* access.require('read-history', located.node)
        return located
      })

    /**
     * What a history may show its caller. Every node a line or a file is
     * about is checked as itself, through its own line of folders, never by
     * the path it shares with another; every path a line records must be one
     * the caller sees now: the asked node or a folder above it, or a place
     * they read. A write holder of the whole tree sees it all.
     */
    const historyAccess = (located: {
      readonly node: NodeRow
      readonly tree: TreeRow
    }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const root = yield* store.nodeById(located.tree.rootNodeId as NodeId)
        const whole =
          root !== null &&
          (yield* access.require('read-history', root).pipe(Effect.isSuccess))
        const asked = located.node.path
        const scoped = caller.via.kind === 'agent' && caller.via.scope !== null
        const shared = whole
          ? new Set<string>()
          : new Set(
              (yield* Effect.promise(() =>
                DB.prepare(
                  'select distinct node_id as id from shares where tree_id = ?',
                )
                  .bind(located.tree.id)
                  .all<{ id: string }>(),
              )).results.map((r) => r.id),
            )
        const byKey = new Map<string, boolean>()
        const identity = (id: string) =>
          Effect.gen(function* () {
            if (whole) return true
            const node = yield* store.nodeById(id as NodeId).pipe(Effect.orDie)
            if (node === null) return false
            // Siblings without shares of their own answer alike.
            const key =
              scoped || shared.has(id)
                ? `node:${id}`
                : `in:${node.parentId}:${node.deletedAt === null}`
            const kept = byKey.get(key)
            if (kept !== undefined) return kept
            const ok = yield* access
              .require('read-history', node)
              .pipe(Effect.isSuccess)
            byKey.set(key, ok)
            return ok
          })
        const byPath = new Map<string, boolean>()
        const sees = (path: string) =>
          Effect.gen(function* () {
            if (whole || isUnder(asked, path)) return true
            const kept = byPath.get(path)
            if (kept !== undefined) return kept
            const near = yield* store
              .nearest(located.tree.id, path)
              .pipe(Effect.orDie)
            const ok =
              near !== null &&
              (yield* access.require('read', near).pipe(Effect.isSuccess))
            byPath.set(path, ok)
            return ok
          })
        // Asked as the caller, whoever runs them.
        return {
          identity: (id: string) =>
            identity(id).pipe(Effect.provideService(CurrentCaller, caller)),
          sees: (path: string) =>
            sees(path).pipe(Effect.provideService(CurrentCaller, caller)),
          whole,
        }
      })

    const retention = () =>
      Effect.map(settings.current(), (s) => s.retentionDays)

    const log: FilesService['log'] = ({ ref, cursor }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const located = yield* historyNode(ref)
        const retentionDays = yield* retention()
        const page = yield* history.log({
          caller,
          tree: located.tree,
          node: located.node,
          cursor,
          retentionDays,
        })
        const can = yield* historyAccess(located)
        const here = `${ref.workspace}/${located.tree.name}`
        // A place the tree went is seen by an admin of that workspace, who
        // read every tree in it while the tree was there.
        const adminAt = (place: string) =>
          Effect.gen(function* () {
            if (!can.whole) return false
            const name = place.slice(0, place.indexOf('/'))
            const workspace = yield* store.workspace(name)
            if (workspace === null) return false
            const membership = yield* Effect.option(access.member(workspace))
            return (
              membership._tag === 'Some' && membership.value.role === 'admin'
            )
          }).pipe(Effect.orElseSucceed(() => false))
        const lines: LogLine[] = []
        for (const [n, line] of page.lines.entries()) {
          const meta = page.meta[n]!
          if (line.kind === 'push') {
            // A push shows only through the files it wrote that the caller
            // may see, counted where they stood.
            if (meta.pushId === null || line.push === null) continue
            let files = 0
            for (const f of yield* history.pushFiles(
              meta.pushId,
              located.node,
            )) {
              if ((yield* can.identity(f.nodeId)) && (yield* can.sees(f.path)))
                files += 1
            }
            if (files === 0 && !isUnder(line.path, located.node.path)) continue
            if (!(yield* can.sees(line.path))) continue
            lines.push({ ...line, push: { ...line.push, files } })
            continue
          }
          if (meta.nodeId !== null && !(yield* can.identity(meta.nodeId))) {
            continue
          }
          if (!(yield* can.sees(line.path))) continue
          // A destination shows only where the caller sees it: a tree's as
          // the place it is now, or a workspace the caller runs.
          if (line.kind === 'move' && line.to !== null) {
            const shown =
              line.path === ''
                ? line.to === here || (yield* adminAt(line.to))
                : yield* can.sees(line.to)
            lines.push(shown ? line : { ...line, to: null })
            continue
          }
          if (line.kind === 'delete' && line.push !== null && !can.whole) {
            // What the deletion took is the caller's only as far as they see.
            lines.push({ ...line, push: null })
            continue
          }
          lines.push(line)
        }
        return {
          path: located.node.path,
          lines,
          next: page.next,
          retentionDays,
        }
      }).pipe(Effect.catchTag('DossierError', narrowHistory)) as ReturnType<
        FilesService['log']
      >

    const pushDetail: FilesService['pushDetail'] = ({ ref, number }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const located = yield* historyNode(ref)
        const missing = () =>
          dossierError(
            'not_found',
            `There is no push ${number} in this history.`,
            null,
            ref.path,
          )
        const push = yield* history.pushOf(located.tree.id, number)
        if (push === null) return yield* Effect.fail(missing())
        const can = yield* historyAccess(located)
        // Only the files the caller may see, where they stood; then only a
        // push in this history gives its message, author and time.
        const detail = yield* history.pushDetail({
          caller,
          tree: located.tree,
          node: located.node,
          push,
          keep: (nodeId, path) =>
            Effect.gen(function* () {
              return (yield* can.identity(nodeId)) && (yield* can.sees(path))
            }),
        })
        if (
          detail.files.length === 0 &&
          !(
            isUnder(push.path, located.node.path) &&
            (yield* can.sees(push.path))
          )
        ) {
          return yield* Effect.fail(missing())
        }
        return detail
      }).pipe(Effect.catchTag('DossierError', narrowHistory)) as ReturnType<
        FilesService['pushDetail']
      >

    const diff: FilesService['diff'] = ({ ref, from, to }) =>
      Effect.gen(function* () {
        const located = yield* historyNode(ref)
        const { node, tree } = located
        const seqOf = (number: PushNumber) =>
          Effect.gen(function* () {
            const push = yield* history.pushOf(tree.id, number)
            if (push === null) {
              return yield* Effect.fail(
                dossierError(
                  'invalid',
                  `There is no push ${number} in ${tree.name}.`,
                  `See the pushes with dossier log ${ref.workspace}/${tree.name}.`,
                ),
              )
            }
            return yield* history.seqOfPush(push)
          })
        if (node.kind === 'folder') {
          // Without pushes: what the latest push changed here.
          let fromSeq: number
          let toSeq: number | null
          if (from === null && to === null) {
            const number = yield* history.latestPushUnder(node)
            if (number === null) {
              return {
                path: node.path,
                from: null,
                to: null,
                binary: false,
                before: null,
                after: null,
                patch: '',
              }
            }
            toSeq = yield* seqOf(number)
            fromSeq = toSeq - 1
          } else if (from === null) {
            return yield* Effect.fail(
              dossierError(
                'invalid',
                'A folder’s diff needs the push to start from.',
                `Give two pushes: dossier diff ${ref.workspace}/${tree.name}/${node.path} 11 12.`,
              ),
            )
          } else {
            fromSeq = yield* seqOf(from)
            toSeq = to === null ? null : yield* seqOf(to)
          }
          const can = yield* historyAccess(located)
          const patch = yield* history.folderDiff({
            keep: can.identity,
            node,
            from: fromSeq,
            to: toSeq,
          })
          return {
            path: node.path,
            from: from === null ? null : `push ${from}`,
            to: to === null ? null : `push ${to}`,
            binary: false,
            before: null,
            after: null,
            patch,
          }
        }
        const toVersion =
          to === null
            ? yield* history.current(node)
            : yield* history.versionAtSeq(node.id, yield* seqOf(to))
        // Without a push to start from: the version before, the last one
        // with content when this one has some.
        const fromVersion =
          from === null
            ? toVersion === null
              ? null
              : yield* history.previousOf(toVersion, toVersion.state === 'live')
            : yield* history.versionAtSeq(node.id, yield* seqOf(from))
        return yield* history.fileDiff({
          node,
          from: fromVersion,
          to: toVersion,
        })
      }).pipe(Effect.catchTag('DossierError', narrowHistory)) as ReturnType<
        FilesService['diff']
      >

    return {
      ls,
      content,
      kit,
      log,
      pushDetail,
      diff,
      restore: changes.restore as FilesService['restore'],
      rm: changes.rm as FilesService['rm'],
      mv: changes.mv as FilesService['mv'],
      moveTree: changes.moveTree as FilesService['moveTree'],
    }
  }),
)
