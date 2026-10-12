import { env } from 'cloudflare:workers'

export const count = async (
  table: string,
  where = '1 = 1',
  ...binds: unknown[]
): Promise<number> => {
  const row = await env.DB.prepare(
    `select count(*) as n from "${table}" where ${where}`,
  )
    .bind(...binds)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export const rows = async <T>(
  query: string,
  ...binds: unknown[]
): Promise<T[]> =>
  (
    await env.DB.prepare(query)
      .bind(...binds)
      .all<T>()
  ).results

export const exec = (query: string, ...binds: unknown[]) =>
  env.DB.prepare(query)
    .bind(...binds)
    .run()

/** A database whose every call fails, as D1 does when it is down. */
export const brokenDatabase = (): D1Database => {
  const down = () => {
    throw new Error('D1 is unavailable')
  }
  return {
    prepare: down,
    batch: async () => down(),
    exec: async () => down(),
    dump: async () => down(),
    withSession: down,
  } as unknown as D1Database
}

/**
 * The real database, except that statements whose SQL matches fail, alone or
 * inside a batch.
 */
export const failingStatements = (
  database: D1Database,
  matches: (sql: string) => boolean,
): D1Database => {
  const real = new WeakMap<object, D1PreparedStatement>()
  const wrap = (
    statement: D1PreparedStatement,
    failing: boolean,
  ): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrap(target.bind(...values), failing)
        }
        if (
          failing &&
          ['run', 'all', 'first', 'raw'].includes(String(property))
        ) {
          return async () => {
            throw new Error('D1 refused the statement')
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    real.set(proxy, statement)
    if (failing) failingSet.add(proxy)
    return proxy
  }
  const failingSet = new WeakSet<object>()
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => wrap(target.prepare(query), matches(query))
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (statements.some((s) => failingSet.has(s))) {
            throw new Error('D1 refused the batch')
          }
          return target.batch(statements.map((s) => real.get(s) ?? s))
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * The real database, except that the first batch holding a statement whose
 * SQL matches waits for `before` to finish, then runs: a way to land another
 * request's write between a read and the batch that rests on it.
 */
export const beforeBatch = (
  database: D1Database,
  matches: (sql: string) => boolean,
  before: () => Promise<void>,
): D1Database => {
  const real = new WeakMap<object, D1PreparedStatement>()
  const matching = new WeakSet<object>()
  let armed = true
  const wrap = (
    statement: D1PreparedStatement,
    hit: boolean,
  ): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrap(target.bind(...values), hit)
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    real.set(proxy, statement)
    if (hit) matching.add(proxy)
    return proxy
  }
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => wrap(target.prepare(query), matches(query))
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (armed && statements.some((s) => matching.has(s))) {
            armed = false
            await before()
          }
          return target.batch(statements.map((s) => real.get(s) ?? s))
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * A database that runs `before` once, just ahead of the first read of a
 * statement whose SQL matches, to land a racing write between two reads.
 */
export const beforeRead = (
  database: D1Database,
  matches: (sql: string) => boolean,
  before: () => Promise<void>,
): D1Database => {
  let armed = true
  const wrap = (
    statement: D1PreparedStatement,
    hit: boolean,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrap(target.bind(...values), hit)
        }
        const value = Reflect.get(target, property, target) as unknown
        if (
          hit &&
          (property === 'first' || property === 'all' || property === 'raw') &&
          typeof value === 'function'
        ) {
          return async (...args: unknown[]) => {
            if (armed) {
              armed = false
              await before()
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => wrap(target.prepare(query), matches(query))
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
