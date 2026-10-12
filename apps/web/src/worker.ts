import { dispatch } from './edge/dispatch.ts'

export { TreeHub } from './hub/tree-hub.ts'

// The edge imports the auth module statically (through core/compose.ts), so
// Better Auth loads with the Worker and never inside a first request: an
// aborted request that first builds Better Auth can leave the isolate hanging.
export default {
  fetch: dispatch,
} satisfies ExportedHandler<Env>
