// Counts the round trips a request makes to D1 and R2: every statement run
// alone, every batch and every bucket call is one trip. A trip's step is one
// more than the deepest trip that had finished when it started, so `steps`
// is the longest chain of trips a request waits for one after another.

export interface Trip {
  readonly kind: 'd1' | 'batch' | 'r2'
  /** The statement's SQL (first line), the batch's size, or the R2 call. */
  readonly what: string
  readonly step: number
}

export interface TripCounter {
  readonly env: { readonly DB: D1Database; readonly BLOBS: R2Bucket }
  readonly trips: () => readonly Trip[]
  readonly steps: () => number
  readonly reset: () => void
}

const STATEMENT_CALLS = new Set(['first', 'all', 'run', 'raw'])
const BUCKET_CALLS = new Set([
  'get',
  'put',
  'head',
  'list',
  'delete',
  'createMultipartUpload',
])

const firstLine = (sql: string) => sql.trim().split('\n')[0]!.slice(0, 120)

export const tripCounting = (
  db: D1Database,
  blobs: R2Bucket,
  /** Statements of other work sharing the bindings, left uncounted. */
  ignore: (sql: string) => boolean = () => false,
): TripCounter => {
  let trips: Trip[] = []
  let finished = 0
  let steps = 0
  const timed = async <A>(
    kind: Trip['kind'],
    what: string,
    call: () => Promise<A>,
  ): Promise<A> => {
    const step = finished + 1
    steps = Math.max(steps, step)
    trips.push({ kind, what, step })
    try {
      return await call()
    } finally {
      finished = Math.max(finished, step)
    }
  }
  const real = new WeakMap<object, D1PreparedStatement>()
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrap(target.bind(...values), sql)
        }
        const value = Reflect.get(target, property, target) as unknown
        if (
          STATEMENT_CALLS.has(String(property)) &&
          typeof value === 'function' &&
          !ignore(sql)
        ) {
          return (...args: unknown[]) =>
            timed('d1', firstLine(sql), () =>
              (value as (...a: unknown[]) => Promise<unknown>).apply(
                target,
                args,
              ),
            )
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    real.set(proxy, statement)
    return proxy
  }
  const DB = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => wrap(target.prepare(query), query)
      }
      if (property === 'batch') {
        return (statements: D1PreparedStatement[]) =>
          timed('batch', `${statements.length} statements`, () =>
            target.batch(statements.map((s) => real.get(s) ?? s)),
          )
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const BLOBS = new Proxy(blobs, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown
      if (BUCKET_CALLS.has(String(property)) && typeof value === 'function') {
        return (...args: unknown[]) =>
          timed(
            'r2',
            `${String(property)} ${typeof args[0] === 'string' ? args[0].split('/')[0] : ''}`,
            () =>
              (value as (...a: unknown[]) => Promise<unknown>).apply(
                target,
                args,
              ),
          )
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    env: { DB, BLOBS },
    trips: () => trips,
    steps: () => steps,
    reset: () => {
      trips = []
      steps = 0
      finished = 0
    },
  }
}

/** One line per trip, numbered by step, for a test's report. */
export const tripReport = (counter: TripCounter): string =>
  counter
    .trips()
    .map((t) => `${String(t.step).padStart(3)} ${t.kind.padEnd(5)} ${t.what}`)
    .join('\n')
