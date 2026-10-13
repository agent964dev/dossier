import { type LinkRef, parseTarget } from '@dossier/contracts'
import { Effect } from 'effect'

import { notSignedIn } from './commands/whoami.ts'
import { currentDeployment } from './deployment.ts'
import { usage } from './render.ts'
import type { RemoteService } from './sync.ts'

const isLink = (input: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim())

/**
 * A target on the command line: `workspace/tree[/path]` on the current
 * deployment, or a link that names its own deployment. Needs an agent key
 * for that deployment.
 */
export const resolveTarget = (input: string) =>
  Effect.gen(function* () {
    const { deployment, key } = yield* currentDeployment(
      isLink(input) ? input.trim() : undefined,
    )
    const ref: LinkRef | null = parseTarget(input, deployment.origin)
    if (ref === null) {
      return yield* Effect.fail(
        usage(
          `"${input}" is not a tree or a link on ${deployment.id}.`,
          'Give workspace/tree or workspace/tree/path, such as ' +
            'agent964/acme/plans, or a link on the deployment.',
        ),
      )
    }
    if (key === null) return yield* Effect.fail(notSignedIn(deployment))
    const remote: RemoteService = { deployment, key }
    return { remote, ref }
  })
