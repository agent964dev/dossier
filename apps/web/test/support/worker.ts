// The test build's Worker entry: the real edge, served with the test runtime.
// Work after a commit finishes before each response, so tests see it.
import { serve } from '../../src/edge/dispatch.ts'
import { harness } from './harness.ts'

export { TreeHub } from '../../src/hub/tree-hub.ts'

export default {
  fetch: (request: Request, env: Env) => serve(request, env, harness.runtime()),
} satisfies ExportedHandler<Env>
