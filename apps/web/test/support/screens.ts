// Stands in for TanStack Start's server entry, which needs Vite's virtual
// modules. Each screen reads D1 and the caller through the real runScreen, as
// a loader does, so the edge's screen scope and failure rules run as written.
import { dossierError } from '@dossier/contracts'
import { Effect } from 'effect'

import { Bindings, CurrentCaller } from '../../src/core/index.ts'
import { isScreenFailure, runScreen } from '../../src/server/run.ts'

/** The path on which this stand-in throws, as an unexpected bug would. */
export const CRASHING_SCREEN = '/_/crash'

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === CRASHING_SCREEN) {
      throw new Error('stack trace that must not reach the browser')
    }
    const result = await runScreen(
      Effect.gen(function* () {
        const { DB } = yield* Bindings
        yield* Effect.tryPromise({
          try: () => DB.prepare('select 1').first(),
          catch: () => dossierError('unavailable'),
        })
        const { person } = yield* CurrentCaller
        return person?.email ?? 'visitor'
      }),
    )
    if (isScreenFailure(result)) {
      return new Response(`<p>Failed: ${result.error.code}</p>`, {
        status: 500,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    return new Response(
      `<p data-screen="${pathname}">Signed in as ${result}</p>`,
      {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      },
    )
  },
}
