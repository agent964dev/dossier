import {
  dossierError,
  type AuthoredSeq,
  type DossierError,
  type LinkRef,
  type Sha256,
} from '@dossier/contracts'
import { Context, Effect, Layer } from 'effect'

import { Access, type RoleSet } from './access.ts'
import { CurrentCaller } from './caller.ts'
import type { MissingNode, NodeRow, TreeRow, WorkspaceRow } from './rows.ts'
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

export interface FilesService {
  /** What a folder holds that the caller can open; `_` files for writers. */
  readonly ls: (i: {
    readonly ref: LinkRef
    readonly depth: 'one' | 'all'
  }) => Effect.Effect<Listing, ReadFailure, CurrentCaller>
  readonly content: (
    ref: LinkRef,
  ) => Effect.Effect<
    FileBody & { readonly name: string },
    ReadFailure,
    CurrentCaller
  >
}

export class Files extends Context.Tag('Files')<Files, FilesService>() {}

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

export const FilesLive: Layer.Layer<Files, never, TreeStore | Access> =
  Layer.effect(
    Files,
    Effect.gen(function* () {
      const store = yield* TreeStore
      const access = yield* Access

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
                    (entry) =>
                      depth === 'all' || writer || entry.kind !== 'kit',
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

      const content: FilesService['content'] = (ref) =>
        readOnly(
          Effect.gen(function* () {
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

      return { ls, content }
    }),
  )
