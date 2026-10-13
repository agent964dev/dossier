// Stands in for TanStack Start's server entry, which needs Vite's virtual
// modules. It is not a TanStack screen: it reads D1 and the caller through the
// real runScreen, as a screen's loader does, so tests through it prove the
// edge's screen scope, caller rules and failure rules, not TanStack's
// rendering. (The built entry's failure path is checked by hand against
// `dev:https`.) A WebSocket upgrade gets a real 101 with an echoing socket.
import { dossierError } from '@dossier/contracts'
import { Effect } from 'effect'

import { Bindings, CurrentCaller } from '../../src/core/index.ts'
import { isScreenFailure, runScreen } from '../../src/server/run.ts'

/** The path on which this stand-in throws, as an unexpected bug would. */
export const CRASHING_SCREEN = '/_/crash'

/** The path on which this stand-in's read is refused, as a screen's can be. */
export const REFUSING_SCREEN = '/_/refuse'

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === CRASHING_SCREEN) {
      throw new Error('stack trace that must not reach the browser')
    }
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair()
      server.accept()
      server.addEventListener('message', (event) =>
        server.send(`echo ${String(event.data)}`),
      )
      return new Response(null, { status: 101, webSocket: client })
    }
    const result = await runScreen(
      Effect.gen(function* () {
        if (pathname === REFUSING_SCREEN) {
          return yield* Effect.fail(
            dossierError('forbidden', 'Not yours.', null, 'acme/plan.html'),
          )
        }
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
