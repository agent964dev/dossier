import { drizzle } from 'drizzle-orm/d1'

import * as schema from './schema.ts'

export { schema }

/** Drizzle over the deployment's D1 database. */
export const db = (bindings: Pick<Env, 'DB'>) =>
  drizzle(bindings.DB, { schema })

export type Db = ReturnType<typeof db>
