import { DossierApi, type EntryWire } from '@dossier/contracts'
import { HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'

import { Files, type Entry } from '../../core/index.ts'
import { targetOf } from './target.ts'

const toWire = (entry: Entry): EntryWire => ({
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

/** RFC 6266's filename*, so any name survives the header. */
const attachment = (name: string) =>
  `attachment; filename*=UTF-8''${encodeURIComponent(name)}`

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
          entries: listing.entries.map(toWire),
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
            'content-type': 'application/octet-stream',
            'content-length': String(file.size),
            'content-disposition': attachment(file.name),
            'x-content-type-options': 'nosniff',
            'content-security-policy': 'sandbox',
            etag: `"${file.etag}"`,
          },
        })
      }),
    ),
)
