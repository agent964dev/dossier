import { DossierApi, linkFor, type SharesResponse } from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { Config, Shares, type NodeShares } from '../../core/index.ts'
import { targetOf } from './target.ts'

/** A node's shares on the wire: who, which role, on which node. */
export const sharesWire = (
  origin: URL,
  shares: NodeShares,
): SharesResponse => ({
  path: shares.node.path,
  link: linkOf(origin, shares),
  shares: shares.shares.map((share) => ({
    target: share.target,
    role: share.role,
    on: share.on.path,
    inherited: share.inherited,
    createdAt: new Date(share.createdAt).toISOString(),
  })),
  publicReach: shares.publicReach,
})

const linkOf = (origin: URL, shares: NodeShares): string => {
  const { node, tree, workspace } = shares
  const page = node.kind === 'file' && node.path.endsWith('.html')
  const kind = node.kind === 'folder' ? 'folder' : page ? 'page' : 'file'
  return linkFor(origin, {
    workspace: workspace.name,
    tree: tree.name,
    path: node.path,
    kind,
  })
}

/** `dossier share`: list a node's shares, or set one. */
export const SharesApiLive = HttpApiBuilder.group(
  DossierApi,
  'shares',
  (handlers) =>
    handlers
      .handle('list', ({ urlParams }) =>
        Effect.gen(function* () {
          const ref = yield* targetOf(urlParams.path)
          const config = yield* Config
          return sharesWire(config.origin, yield* (yield* Shares).list(ref))
        }),
      )
      .handle('set', ({ payload }) =>
        Effect.gen(function* () {
          const ref = yield* targetOf(payload.path)
          const config = yield* Config
          const shares = yield* (yield* Shares).set({
            ref,
            target: payload.target,
            role: payload.role,
          })
          return sharesWire(config.origin, shares)
        }),
      ),
)
