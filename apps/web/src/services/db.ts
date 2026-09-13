import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { Context, Effect, Layer } from 'effect'

import * as schema from '../db/schema'
import { WorkerEnv } from './env'
import { PersistenceError } from './errors'

export interface DbService {
  readonly raw: D1Database
  readonly orm: DrizzleD1Database<typeof schema>
  readonly batch: (
    statements: readonly D1PreparedStatement[],
  ) => Effect.Effect<readonly D1Result[], PersistenceError>
}

export class Db extends Context.Tag('@dossier/web/Db')<Db, DbService>() {}

export function makeDb(database: D1Database): DbService {
  return {
    raw: database,
    orm: drizzle(database, { schema }),
    batch: (statements) =>
      Effect.tryPromise({
        try: () => database.batch([...statements]),
        catch: (cause) =>
          new PersistenceError({ operation: 'D1 batch', cause }),
      }),
  }
}

export const DbLive = Layer.effect(
  Db,
  Effect.map(WorkerEnv, (env) => makeDb(env.DB)),
)

export const DbLayer = (database: D1Database) =>
  Layer.succeed(Db, makeDb(database))
