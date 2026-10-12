// Which of a tree's events the caller may see, and at which paths: the one
// rule the events route and the watch hints both follow.
import type { TreeId } from '@dossier/contracts'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { Effect } from 'effect'

import { db, schema } from '../db/client.ts'
import type { AccessService } from './access.ts'
import type { CurrentCaller } from './caller.ts'
import { ancestorPaths, type NodeRow } from './rows.ts'

/** An event as it is stored. */
export interface EventRef {
  readonly seq: number
  readonly type: string
  readonly path: string
  readonly nodeId: string | null
  readonly pushId: string | null
}

const parentPath = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

/**
 * Each event the caller may see, with the paths it concerns for them: its
 * own node's path when they may read that node, and for a push every node it
 * changed that they may read. A push of a folder above what they read is
 * seen through what it changed there. An event with no node is seen by
 * read on the folder its path lies in.
 */
export const visibleEvents = (
  DB: D1Database,
  access: AccessService,
  treeId: TreeId,
  events: readonly EventRef[],
): Effect.Effect<
  ReadonlyMap<number, readonly string[]>,
  never,
  CurrentCaller
> =>
  Effect.gen(function* () {
    const out = new Map<number, string[]>()
    if (events.length === 0) return out
    const database = db({ DB } as Env)
    const readable = yield* access.readable(treeId)
    const read = <A>(run: () => Promise<A>) =>
      Effect.tryPromise(run).pipe(Effect.orDie)
    const nodeIds = [
      ...new Set(events.flatMap((e) => (e.nodeId === null ? [] : [e.nodeId]))),
    ]
    const seenNodes = new Set<string>()
    for (let i = 0; i < nodeIds.length; i += 90) {
      const rows = yield* read(() =>
        database
          .select({ id: schema.nodes.id })
          .from(schema.nodes)
          .where(
            and(
              inArray(schema.nodes.id, nodeIds.slice(i, i + 90)),
              readable.where,
            ),
          )
          .all(),
      )
      for (const row of rows) seenNodes.add(row.id)
    }
    const pushIds = [
      ...new Set(
        events.flatMap((e) =>
          e.type === 'push' && e.pushId !== null ? [e.pushId] : [],
        ),
      ),
    ]
    const changed = new Map<string, string[]>()
    for (let i = 0; i < pushIds.length; i += 90) {
      const rows = yield* read(() =>
        database
          .selectDistinct({
            pushId: schema.nodeVersions.pushId,
            path: schema.nodes.path,
          })
          .from(schema.nodeVersions)
          .innerJoin(
            schema.nodes,
            eq(schema.nodes.id, schema.nodeVersions.nodeId),
          )
          .where(
            and(
              inArray(schema.nodeVersions.pushId, pushIds.slice(i, i + 90)),
              readable.where,
            ),
          )
          .all(),
      )
      for (const row of rows) {
        if (row.pushId === null) continue
        const list = changed.get(row.pushId) ?? []
        list.push(row.path)
        changed.set(row.pushId, list)
      }
    }
    for (const e of events) {
      const paths: string[] = []
      if (e.nodeId !== null) {
        if (seenNodes.has(e.nodeId)) paths.push(e.path)
      } else {
        // No node: the folder the path lies in decides.
        const folder = yield* nearestNode(database, treeId, parentPath(e.path))
        if (
          folder !== null &&
          (yield* access.require('read', folder).pipe(Effect.isSuccess))
        ) {
          paths.push(e.path)
        }
      }
      if (e.pushId !== null) paths.push(...(changed.get(e.pushId) ?? []))
      if (paths.length > 0) out.set(e.seq, [...new Set(paths)])
    }
    return out
  })

/** The deepest live node at or above a tree path. */
const nearestNode = (
  database: ReturnType<typeof db>,
  treeId: TreeId,
  path: string,
) =>
  Effect.tryPromise(() =>
    database
      .select()
      .from(schema.nodes)
      .where(
        and(
          eq(schema.nodes.treeId, treeId),
          isNull(schema.nodes.deletedAt),
          inArray(schema.nodes.path, [...ancestorPaths(path)]),
        ),
      )
      .orderBy(sql`${schema.nodes.depth} desc`)
      .limit(1)
      .get(),
  ).pipe(
    Effect.orDie,
    Effect.map((row) => (row ?? null) as NodeRow | null),
  )
