// The test build's Worker entry: the real edge, served with the test runtime.
import { serve } from '../../src/edge/dispatch.ts'
import { harness } from './harness.ts'

export default {
  fetch: (request: Request, env: Env) => serve(request, env, harness.runtime()),
} satisfies ExportedHandler<Env>
