import { dossierError, parseTarget, type LinkRef } from '@dossier/contracts'
import { Effect } from 'effect'

import { Config } from '../../core/index.ts'

/** `workspace/tree[/path]`, or a link on this deployment. */
export const targetOf = (input: string) =>
  Effect.flatMap(Config, (config) => {
    const ref: LinkRef | null = parseTarget(input, config.origin)
    return ref === null
      ? Effect.fail(
          dossierError(
            'invalid',
            `"${input}" is not a path in a tree.`,
            'Give workspace/tree/path, or a link on this deployment.',
            'path',
          ),
        )
      : Effect.succeed(ref)
  })
