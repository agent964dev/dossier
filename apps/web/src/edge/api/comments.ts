import { commentFragment, DossierApi, linkFor } from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { Config, Data } from '../../core/index.ts'
import { targetOf } from './target.ts'

/**
 * `dossier comment`: the comment component's write, from the command line.
 * Written with an agent key, the comment is an agent's.
 */
export const CommentsApiLive = HttpApiBuilder.group(
  DossierApi,
  'comments',
  (handlers) =>
    handlers.handle('comment', ({ payload }) =>
      Effect.gen(function* () {
        const ref = yield* targetOf(payload.path)
        const written = yield* (yield* Data).comment({
          ref,
          text: payload.text,
          anchor: payload.on ?? null,
          replyTo: payload.replyTo ?? null,
          stance: payload.stance ?? null,
          opId: payload.opId,
        })
        const config = yield* Config
        const data = written.doc.data as { anchor?: unknown } | null
        const anchor = typeof data?.anchor === 'string' ? data.anchor : null
        return {
          comment: written.comment,
          page: written.page,
          link: `${linkFor(config.origin, {
            workspace: ref.workspace,
            tree: ref.tree,
            path: written.page,
            kind: 'page',
          })}${commentFragment(written.comment, anchor)}`,
          doc: written.doc,
        }
      }),
    ),
)
