import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { Effect } from 'effect'

import { runSurface } from './runtime'
import { resolveWeb } from './viewer'

export type SessionPeek =
  | { readonly signedIn: true; readonly workspaceSlug: string }
  | { readonly signedIn: false }

/**
 * "Is anybody signed in?" — the cheapest question the sign-in page can ask, so
 * a returning reader lands on their dashboard instead of a sign-in wall.
 * Any failure (no cookie, disabled account, stale workspace) reads as signed out.
 */
export const peekSession = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SessionPeek> => {
    const request = getRequest()
    const result = await runSurface(
      Effect.map(resolveWeb(request), (session) => ({
        signedIn: true as const,
        workspaceSlug: session.viewer.workspaceSlug,
      })),
    )
    return 'signedIn' in result ? result : { signedIn: false }
  },
)
