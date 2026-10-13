// Sharing: who a node is shared with, setting and removing a share, and what
// others shared with the person. The share dialog, `dossier share` and
// `push --share` all come here.
import {
  dossierError,
  linkFor,
  type DossierError,
  type LinkRef,
  type ShareId,
  type ShareSpec,
  type ShareTarget,
  type TeamId,
} from '@dossier/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { Clock, Context, Effect, Layer } from 'effect'

import { db, schema } from '../db/client.ts'

import { Access, type Granted, type Role } from './access.ts'
import type { Background } from './background.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller } from './caller.ts'
import { Config } from './config.ts'
import { underscoreSplit } from './lookup.ts'
import { mentionedAt, unseenMentions } from './mentions.ts'
import { People } from './people.ts'
import {
  ancestorPaths,
  type NodeRow,
  type TreeRow,
  type WorkspaceRow,
} from './rows.ts'
import { TreeStore, type NewShare } from './tree-store.ts'

export interface ShareView {
  readonly id: ShareId
  readonly target: ShareTarget
  /** "sara@acme.com", "Team Design", "Everyone in agent964", "Anyone with the link". */
  readonly label: string
  readonly role: Role
  /** The node the share sits on: this one, or a folder above. */
  readonly on: NodeRow
  readonly inherited: boolean
  readonly createdAt: number
}

export interface NodeShares {
  readonly node: NodeRow
  readonly tree: TreeRow
  readonly workspace: WorkspaceRow
  /** Shares on the node, then shares on the folders above, closest first. */
  readonly shares: readonly ShareView[]
  /** Tree paths of the `_` files above that are public with the node. */
  readonly publicReach: readonly string[]
}

export interface SharedRow {
  readonly node: NodeRow
  readonly tree: TreeRow
  readonly workspace: WorkspaceRow
  readonly title: string
  readonly kind: 'folder' | 'page' | 'file'
  /** 'acme/questions': the tree and the folder the node sits in. */
  readonly place: string
  readonly link: string
  readonly roles: ReadonlySet<Role>
  readonly sharedAt: number
  /** An open form at or below the node has nothing of the person's yet. */
  readonly waiting: boolean
  /** A mention of the person waits unseen on a page at or below it. */
  readonly mentioned: boolean
}

type ListError = DossierError<'not_found' | 'sign_in_required' | 'forbidden'>

export interface SharesService {
  readonly list: (
    ref: LinkRef,
  ) => Effect.Effect<NodeShares, ListError, CurrentCaller>
  /** A role of null removes the target's share on the node. */
  readonly set: (i: {
    readonly ref: LinkRef
    readonly target: ShareTarget
    readonly role: Role | null
  }) => Effect.Effect<
    NodeShares,
    ListError | DossierError<'invalid' | 'conflict' | 'unavailable'>,
    CurrentCaller | Background
  >
  /** Push's --share: each spec as the share a commit grants. */
  readonly toNewShares: (
    workspace: WorkspaceRow,
    specs: readonly ShareSpec[],
  ) => Effect.Effect<
    readonly NewShare[],
    DossierError<'invalid'>,
    CurrentCaller
  >
  readonly publicReach: (
    node: Granted<'share'>,
  ) => Effect.Effect<readonly string[]>
  /** One line for listings: "Private to you", "Public", … */
  readonly sharingLabel: (
    node: NodeRow,
  ) => Effect.Effect<string, never, CurrentCaller>
  readonly sharedWithMe: () => Effect.Effect<
    readonly SharedRow[],
    DossierError<'sign_in_required'>,
    CurrentCaller
  >
}

export class Shares extends Context.Tag('Shares')<Shares, SharesService>() {}

interface ShareRowRaw {
  readonly id: ShareId
  readonly nodeId: string
  readonly targetKind: 'email' | 'team' | 'workspace' | 'anyone'
  readonly target: string
  readonly role: Role
  readonly createdAt: number
}

/** One line on who else a node is shared with. */
export const sharingLine = (
  shares: readonly { readonly targetKind: string; readonly target: string }[],
  me: string,
): string => {
  if (shares.some((s) => s.targetKind === 'anyone')) return 'Public'
  if (shares.some((s) => s.targetKind === 'workspace')) {
    return 'Shared with the workspace'
  }
  const others = [
    ...new Set(
      shares
        .filter((s) => s.targetKind === 'email' && s.target !== me)
        .map((s) => s.target),
    ),
  ]
  const teams = new Set(
    shares.filter((s) => s.targetKind === 'team').map((s) => s.target),
  ).size
  const count = others.length + teams
  if (count === 0) return 'Private to you'
  const first = others[0] ?? 'a team'
  if (count === 1) return `Shared with ${first}`
  return `Shared with ${first} and ${count - 1} ${count === 2 ? 'other' : 'others'}`
}

const ROLE_ORDER: readonly Role[] = ['write', 'respond', 'read']

const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

export const SharesLive: Layer.Layer<
  Shares,
  never,
  Bindings | Access | TreeStore | People | Config
> = Layer.effect(
  Shares,
  Effect.gen(function* () {
    const { DB } = yield* Bindings
    const access = yield* Access
    const store = yield* TreeStore
    const people = yield* People
    const config = yield* Config

    const query = <A>(run: () => Promise<A>) =>
      Effect.tryPromise(run).pipe(
        Effect.tapError((error) =>
          Effect.logError('A sharing read failed', error),
        ),
        Effect.orDie,
      )

    const nodeById = (id: string) =>
      query(() =>
        db({ DB })
          .select()
          .from(schema.nodes)
          .where(eq(schema.nodes.id, id))
          .limit(1)
          .all(),
      ).pipe(Effect.map((rows) => (rows[0] as NodeRow | undefined) ?? null))

    /** The node a path names for sharing: a folder, a file, or path.html. */
    const nodeAt = (ref: LinkRef) =>
      Effect.gen(function* () {
        const located = yield* store
          .locate(ref)
          .pipe(Effect.orElseSucceed(() => null))
        if (located === null || 'missing' in located) {
          return yield* access
            .require('share', {
              missing: true,
              treeId: located?.treeId ?? null,
              path: ref.path,
            })
            .pipe(Effect.zipRight(Effect.die(new Error('missing granted'))))
        }
        const node = yield* access.require('share', located.node)
        const found = yield* store
          .treeById(located.tree.id)
          .pipe(Effect.orElseSucceed(() => null))
        if (found === null) {
          return yield* Effect.fail(
            dossierError('not_found', undefined, null, ref.path),
          )
        }
        return { node, tree: found.tree, workspace: found.workspace }
      })

    const teamNames = (workspace: WorkspaceRow) =>
      query(() =>
        DB.prepare('select id, name from teams where workspace_id = ?')
          .bind(workspace.id)
          .all<{ id: TeamId; name: string }>(),
      ).pipe(
        Effect.map(
          (rows) => new Map(rows.results.map((row) => [row.id, row.name])),
        ),
      )

    const targetOf = (
      row: ShareRowRaw,
      teams: ReadonlyMap<string, string>,
    ): ShareTarget => {
      switch (row.targetKind) {
        case 'email':
          return { kind: 'email', email: row.target }
        case 'team':
          return { kind: 'team', team: teams.get(row.target) ?? 'a team' }
        case 'workspace':
          return { kind: 'workspace' }
        case 'anyone':
          return { kind: 'anyone' }
      }
    }

    const labelOf = (target: ShareTarget, workspace: WorkspaceRow): string => {
      switch (target.kind) {
        case 'email':
          return target.email
        case 'team':
          return `Team ${target.team}`
        case 'workspace':
          return `Everyone in ${workspace.name}`
        case 'anyone':
          return 'Anyone with the link'
      }
    }

    /** The shares on the node and on every folder above it, closest first. */
    const sharesOn = (node: NodeRow) =>
      Effect.gen(function* () {
        const paths = ancestorPaths(node.path)
        const rows = yield* query(() =>
          DB.prepare(
            `select s.id, s.node_id as nodeId, s.target_kind as targetKind, s.target,
               s.role, s.created_at as createdAt
             from shares s join nodes a on a.id = s.node_id and a.deleted_at is null
             where s.tree_id = ? and a.path in (${paths.map(() => '?').join(', ')})
             order by length(a.path) desc, s.created_at, s.target`,
          )
            .bind(node.treeId, ...paths)
            .all<ShareRowRaw>(),
        )
        return rows.results
      })

    const publicReach: SharesService['publicReach'] = (node) =>
      Effect.gen(function* () {
        // Every `_` file in the folders above: read on the node reaches all
        // of them, the ones a closer file hides included.
        const folder = node.kind === 'folder' ? node.path : parentOf(node.path)
        const above = ancestorPaths(folder).filter(
          (path) => node.kind !== 'folder' || path !== node.path,
        )
        if (above.length === 0) return []
        const rows = yield* query(() =>
          DB.prepare(
            `select path from nodes where tree_id = ? and deleted_at is null
               and kind = 'file' and origin = 'authored'
               and underscore_from in (select value from json_each(?))
             order by length(underscore_from) desc, path`,
          )
            .bind(node.treeId, JSON.stringify(above))
            .all<{ path: string }>(),
        )
        // Closest folder first; in each, its own files before its folders'.
        const depth = (path: string) =>
          (underscoreSplit(path)?.rest ?? path).split('/').length
        const from = (path: string) => underscoreSplit(path)?.from ?? ''
        return rows.results
          .map((row) => row.path)
          .sort(
            (a, b) =>
              from(b).length - from(a).length ||
              depth(a) - depth(b) ||
              (a < b ? -1 : a > b ? 1 : 0),
          )
      }).pipe(Effect.orElseSucceed((): readonly string[] => []))

    const view = (
      node: Granted<'share'>,
      tree: TreeRow,
      workspace: WorkspaceRow,
    ) =>
      Effect.gen(function* () {
        const rows = yield* sharesOn(node)
        const teams = yield* teamNames(workspace)
        const ids = [...new Set(rows.map((row) => row.nodeId))]
        const on = new Map<string, NodeRow>()
        for (const id of ids) {
          const found = yield* nodeById(id)
          if (found !== null) on.set(id, found)
        }
        const shares = rows.flatMap((row): ShareView[] => {
          const at = on.get(row.nodeId)
          if (at === undefined) return []
          const target = targetOf(row, teams)
          return [
            {
              id: row.id,
              target,
              label: labelOf(target, workspace),
              role: row.role,
              on: at,
              inherited: row.nodeId !== node.id,
              createdAt: row.createdAt,
            },
          ]
        })
        return {
          node,
          tree,
          workspace,
          shares,
          publicReach: yield* publicReach(node),
        } satisfies NodeShares
      })

    const list: SharesService['list'] = (ref) =>
      Effect.gen(function* () {
        const { node, tree, workspace } = yield* nodeAt(ref)
        return yield* view(node, tree, workspace)
      })

    /** A target as the shares table stores it, or invalid. */
    const stored = (workspace: WorkspaceRow, target: ShareTarget) =>
      Effect.gen(function* () {
        switch (target.kind) {
          case 'email':
            return {
              targetKind: 'email',
              target: target.email.trim().toLowerCase(),
            } as const
          case 'workspace':
            return { targetKind: 'workspace', target: workspace.id } as const
          case 'anyone':
            return { targetKind: 'anyone', target: '*' } as const
          case 'team': {
            const teams = yield* people.teamsForSharing(workspace)
            const wanted = target.team.trim().toLowerCase()
            const team = teams.find((t) => t.name.toLowerCase() === wanted)
            if (team === undefined) {
              const person = (yield* CurrentCaller).person
              const member =
                person === null
                  ? null
                  : yield* query(() =>
                      DB.prepare(
                        'select 1 as one from workspace_members where workspace_id = ? and user_id = ?',
                      )
                        .bind(workspace.id, person.id)
                        .first(),
                    )
              if (member === null) {
                return yield* Effect.fail(
                  dossierError(
                    'invalid',
                    `Only members of ${workspace.name} share with its teams.`,
                    'Share with people by email, or ask a member to share with the team.',
                    'target',
                  ),
                )
              }
              return yield* Effect.fail(
                dossierError(
                  'invalid',
                  `${workspace.name} has no team called ${target.team.trim()}.`,
                  'Check the team’s name in the workspace’s settings.',
                  'target',
                ),
              )
            }
            return { targetKind: 'team', target: team.id } as const
          }
        }
      })

    const set: SharesService['set'] = ({ ref, target, role }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const { node, tree, workspace } = yield* nodeAt(ref)
        const wanted = yield* stored(workspace, target)
        const existing = (yield* sharesOn(node)).find(
          (row) =>
            row.nodeId === node.id &&
            row.targetKind === wanted.targetKind &&
            row.target === wanted.target,
        )
        const same =
          (existing === undefined && role === null) || existing?.role === role
        if (!same) {
          yield* store
            .change(tree.id, (cs) =>
              Effect.sync(() => {
                // Whatever the target holds when the batch runs goes, so a
                // share another change made meanwhile never outlives this one.
                cs.revokeTarget(node, wanted)
                if (role !== null) {
                  cs.grant(node, { ...wanted, role })
                }
                cs.event({ type: 'share', path: node.path, node })
              }),
            )
            .pipe(
              // A share change holds no bytes and guards no head: any other
              // failure is the node or the grant moving meanwhile.
              Effect.mapError((error) =>
                error.code === 'unavailable' || error.code === 'conflict'
                  ? (error as DossierError<'unavailable' | 'conflict'>)
                  : dossierError(
                      'conflict',
                      'This node changed while it was being shared.',
                      'Try again.',
                      node.path,
                    ),
              ),
            )
          // Who shared what, with whom, on which node; no secrets.
          console.log(
            JSON.stringify({
              message: 'share',
              tree: tree.id,
              path: node.path,
              node: node.id,
              targetKind: wanted.targetKind,
              target: wanted.target,
              role,
              before: existing?.role ?? null,
              actor: caller.person?.id ?? null,
              key: caller.via.kind === 'agent' ? caller.via.keyId : null,
              requestId: caller.requestId,
            }),
          )
        }
        return yield* view(node, tree, workspace)
      })

    const toNewShares: SharesService['toNewShares'] = (workspace, specs) =>
      Effect.forEach(specs, (spec) =>
        Effect.map(stored(workspace, spec.target), (wanted): NewShare => ({
          ...wanted,
          role: spec.role,
        })),
      )

    const sharingLabel: SharesService['sharingLabel'] = (node) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const rows = yield* sharesOn(node)
        return sharingLine(rows, caller.person?.email.toLowerCase() ?? '')
      })

    const sharedWithMe: SharesService['sharedWithMe'] = () =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const person = caller.person
        if (person === null) {
          return yield* Effect.fail(
            dossierError('sign_in_required', 'Sign in to open this.'),
          )
        }
        const rows = yield* query(() =>
          DB.prepare(
            `select s.node_id as nodeId, s.role, s.created_at as createdAt,
               t.id as treeId, w.id as workspaceId
             from shares s
               join nodes n on n.id = s.node_id and n.deleted_at is null
               join trees t on t.id = s.tree_id and t.deleted_at is null
               join workspaces w on w.id = t.workspace_id
                 and w.deleted_at is null and w.suspended_at is null
             where s.created_by <> ?1 and (
               (s.target_kind = 'email' and s.target = lower(?2))
               or (s.target_kind = 'team' and exists (
                 select 1 from team_members tm join teams tt on tt.id = tm.team_id
                   join workspace_members m on m.workspace_id = tt.workspace_id
                     and m.user_id = tm.user_id
                 where tm.team_id = s.target and tm.user_id = ?1
                   and tt.workspace_id = t.workspace_id)))`,
          )
            .bind(person.id, person.email)
            .all<{
              nodeId: string
              role: Role
              createdAt: number
              treeId: string
              workspaceId: string
            }>(),
        )
        const byNode = new Map<
          string,
          { roles: Set<Role>; at: number; treeId: string }
        >()
        for (const row of rows.results) {
          const seen = byNode.get(row.nodeId) ?? {
            roles: new Set<Role>(),
            at: 0,
            treeId: row.treeId,
          }
          seen.roles.add(row.role)
          seen.at = Math.max(seen.at, row.createdAt)
          byNode.set(row.nodeId, seen)
        }
        const now = yield* Clock.currentTimeMillis
        const mentions = yield* unseenMentions(DB, person).pipe(Effect.orDie)
        const out: SharedRow[] = []
        for (const [nodeId, seen] of byNode) {
          const node = yield* nodeById(nodeId)
          const found = yield* store
            .treeById(seen.treeId as TreeRow['id'])
            .pipe(Effect.orElseSucceed(() => null))
          if (node === null || found === null) continue
          const { tree, workspace } = found
          const page = node.kind === 'file' && node.path.endsWith('.html')
          // A folder with a page of its own goes by that page's title.
          const index =
            node.kind === 'folder'
              ? yield* query(() =>
                  db({ DB })
                    .select()
                    .from(schema.nodes)
                    .where(
                      and(
                        eq(schema.nodes.treeId, node.treeId),
                        eq(
                          schema.nodes.path,
                          node.path === ''
                            ? 'index.html'
                            : `${node.path}/index.html`,
                        ),
                        isNull(schema.nodes.deletedAt),
                      ),
                    )
                    .limit(1)
                    .all(),
                ).pipe(
                  Effect.map(
                    (indexes) => (indexes[0] as NodeRow | undefined) ?? null,
                  ),
                )
              : null
          const title = page
            ? ((yield* titleOf(node)) ?? node.name)
            : node.kind === 'folder'
              ? ((index === null ? null : yield* titleOf(index)) ??
                `${node.path === '' ? tree.name : node.name}/`)
              : node.name
          const folder =
            node.kind === 'folder' ? node.path : parentOf(node.path)
          const responds = seen.roles.has('respond') || seen.roles.has('write')
          out.push({
            node,
            tree,
            workspace,
            title,
            kind: node.kind === 'folder' ? 'folder' : page ? 'page' : 'file',
            place: folder === '' ? tree.name : `${tree.name}/${folder}`,
            link: linkFor(config.origin, {
              workspace: workspace.name,
              tree: tree.name,
              path: node.path,
              kind: node.kind === 'folder' ? 'folder' : page ? 'page' : 'file',
            }),
            roles: seen.roles,
            sharedAt: seen.at,
            waiting: responds && (yield* waitingAt(node, person.id, now)),
            mentioned: mentionedAt(mentions, node),
          })
        }
        return out.sort(
          (a, b) =>
            b.sharedAt - a.sharedAt || a.title.localeCompare(b.title, 'en'),
        )
      })

    /** A page's `<title>`, from any analyzer's stored analysis. */
    const titleOf = (node: NodeRow) =>
      query(() =>
        DB.prepare(
          `select json_extract(a.json, '$.title') as title
           from node_versions v join analyses a on a.sha256 = v.blob_sha256
             and a.analyzer = 'html'
           where v.id = ? order by a.version desc limit 1`,
        )
          .bind(node.currentVersionId)
          .first<{ title: string | null }>(),
      ).pipe(Effect.map((row) => row?.title ?? null))

    /**
     * An open form on a page at or below the node, in its current version,
     * whose target holds nothing the person wrote.
     */
    const waitingAt = (node: NodeRow, personId: string, now: number) =>
      Effect.gen(function* () {
        const under =
          node.kind === 'folder'
            ? node.path === ''
              ? '1'
              : `(h.path = ?2 or substr(h.path, 1, length(?2) + 1) = ?2 || '/')`
            : 'h.path = ?2'
        const forms = yield* query(() =>
          DB.prepare(
            `select distinct f.target_path as target, f.kind
             from forms f join nodes h on h.id = f.host_node_id
               and h.current_version_id = f.host_version_id
             where f.tree_id = ?1 and h.deleted_at is null
               and h.underscore_from is null and ${under}
               and f.closed = 0 and (f.closes_at is null or f.closes_at > ?3)`,
          )
            .bind(node.treeId, node.path, now)
            .all<{ target: string; kind: 'person' | 'entries' | 'shared' }>(),
        )
        for (const form of forms.results) {
          const path = form.target.replace(/\/$/, '')
          const answered = yield* query(() =>
            form.kind === 'shared'
              ? DB.prepare(
                  `select 1 as one from nodes n join node_versions v on v.node_id = n.id
                   where n.tree_id = ? and n.path = ? and v.author_id = ? limit 1`,
                )
                  .bind(node.treeId, path, personId)
                  .first<{ one: number }>()
              : DB.prepare(
                  `select 1 as one from nodes n
                   where n.tree_id = ?1 and n.deleted_at is null and n.origin = 'data'
                     and n.owner_id = ?3
                     and (?2 = '' or substr(n.path, 1, length(?2) + 1) = ?2 || '/')
                   limit 1`,
                )
                  .bind(node.treeId, path, personId)
                  .first<{ one: number }>(),
          )
          if (answered === null) return true
        }
        return false
      })

    return {
      list,
      set,
      toNewShares,
      publicReach,
      sharingLabel,
      sharedWithMe,
    } satisfies SharesService
  }),
)

/** The strongest role, as a home row's action names it. */
export const strongest = (roles: ReadonlySet<Role>): Role =>
  ROLE_ORDER.find((role) => roles.has(role)) ?? 'read'
