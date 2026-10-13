import { DossierApi } from '@dossier/contracts'
import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'

import { entryWire, Files } from '../../core/index.ts'
import { targetOf } from './target.ts'

/** RFC 6266's filename*, so any name survives the header. */
const attachment = (name: string) =>
  `attachment; filename*=UTF-8''${encodeURIComponent(name)}`

/**
 * Raster images keep their type, so a link preview's image shows; they run
 * nothing. Everything else is bytes.
 */
const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export const FilesLive = HttpApiBuilder.group(DossierApi, 'files', (handlers) =>
  handlers
    .handle('ls', ({ urlParams }) =>
      Effect.gen(function* () {
        const ref = yield* targetOf(urlParams.path)
        const files = yield* Files
        const listing = yield* files.ls({ ref, depth: urlParams.depth })
        return {
          tree: {
            id: listing.tree.id,
            workspace: listing.workspace.name,
            name: listing.tree.name,
          },
          path: listing.folder.path,
          seq: listing.seq,
          entries: listing.entries.map(entryWire),
        }
      }),
    )
    // Always a download: author content never runs on the main host.
    .handleRaw('file', ({ urlParams }) =>
      Effect.gen(function* () {
        const ref = yield* targetOf(urlParams.path)
        const files = yield* Files
        const file = yield* files.content(ref)
        return HttpServerResponse.raw(file.body, {
          status: 200,
          headers: {
            'content-type': RASTER.has(file.version.contentType ?? '')
              ? (file.version.contentType as string)
              : 'application/octet-stream',
            'content-length': String(file.size),
            'content-disposition': attachment(file.name),
            'x-content-type-options': 'nosniff',
            'content-security-policy': 'sandbox',
            etag: `"${file.etag}"`,
          },
        })
      }),
    )
    .handle('rm', ({ payload }) =>
      Effect.gen(function* () {
        const ref = yield* targetOf(payload.path)
        return yield* (yield* Files).rm({ ref })
      }),
    )
    .handle('mv', ({ payload }) =>
      Effect.gen(function* () {
        const from = yield* targetOf(payload.from)
        const to = yield* targetOf(payload.to)
        return yield* (yield* Files).mv({ from, to })
      }),
    ),
)
