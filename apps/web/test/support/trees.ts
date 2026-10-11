// People, workspaces, keys and pushes for tree tests, written straight into
// D1 where a screen would make them, and pushed through the real Push.
import type {
  AgentKeyId,
  LinkRef,
  NodeId,
  Person,
  PersonId,
  PushId,
  Sha256,
  WorkspaceId,
} from '@dossier/contracts'
import { parseTarget } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'

import {
  Push,
  type Caller,
  type CommitResult,
  type CoreServices,
  type CurrentCaller,
  type StageResult,
} from '../../src/core/index.ts'
import { exec, rows } from './d1.ts'
import { fresh, runAs } from './people.ts'

const encoder = new TextEncoder()

export const sha256Of = async (text: string): Promise<Sha256> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('') as Sha256
}

/** A person as Google sign-in would leave them, without a browser. */
export const person = async (local = 'person'): Promise<Person> => {
  const { email } = fresh('example.com', local)
  const id = crypto.randomUUID().replaceAll('-', '') as PersonId
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values (?, ?, ?, 1, ?, ?)`,
    ).bind(id, local, email, now, now),
    env.DB.prepare(
      `insert into people (user_id, email_authority, first_sign_in_at, last_sign_in_at)
       values (?, 'google', ?, ?)`,
    ).bind(id, now, now),
  ])
  return { id, email, name: local, image: null }
}

export const superAdmin = (who: Person) =>
  exec(
    'insert into super_admins (user_id, added_by, created_at) values (?, null, ?)',
    who.id,
    Date.now(),
  )

/** A workspace with its first admin. */
export const workspace = async (
  admin: Person,
  name = fresh('x', 'ws').email.split('@')[0]!.toLowerCase(),
) => {
  const id = crypto.randomUUID() as WorkspaceId
  await env.DB.batch([
    env.DB.prepare(
      'insert into workspaces (id, name, created_by, created_at) values (?, ?, ?, ?)',
    ).bind(id, name, admin.id, Date.now()),
    env.DB.prepare(
      `insert into workspace_members (workspace_id, user_id, role, created_at)
       values (?, ?, 'admin', ?)`,
    ).bind(id, admin.id, Date.now()),
  ])
  return { id, name }
}

export const join = (
  ws: { readonly id: string },
  who: Person,
  role: 'admin' | 'member' = 'member',
) =>
  exec(
    `insert into workspace_members (workspace_id, user_id, role, created_at)
     values (?, ?, ?, ?)`,
    ws.id,
    who.id,
    role,
    Date.now(),
  )

/** An agent key of the person, and the caller a request with it becomes. */
export const agent = async (
  who: Person,
  options: { readonly scope?: NodeId | null; readonly readOnly?: boolean } = {},
): Promise<Caller> => {
  const keyId = crypto.randomUUID() as AgentKeyId
  await exec(
    `insert into agent_keys (id, user_id, name, hash_sha256, created_via, scope_node_id,
       read_only, created_at)
     values (?, ?, 'test', ?, 'settings', ?, ?, ?)`,
    keyId,
    who.id,
    crypto.randomUUID(),
    options.scope ?? null,
    options.readOnly === true ? 1 : 0,
    Date.now(),
  )
  return {
    person: who,
    via: {
      kind: 'agent',
      keyId,
      scope: options.scope ?? null,
      readOnly: options.readOnly === true,
    },
    requestId: 'test',
  }
}

export const visitorCaller = (): Caller => ({
  person: null,
  via: { kind: 'visitor', anonSessionId: null },
  requestId: 'test',
})

export const ref = (target: string): LinkRef => {
  const parsed = parseTarget(target, new URL(env.PUBLIC_ORIGIN))
  if (parsed === null) throw new Error(`not a target: ${target}`)
  return parsed
}

export type Files = Readonly<Record<string, string>>

const manifestOf = async (files: Files) =>
  Promise.all(
    Object.entries(files).map(async ([path, text]) => ({
      path,
      sha256: await sha256Of(text),
      size: encoder.encode(text).length,
    })),
  )

const streamOf = (text: string) =>
  new Blob([encoder.encode(text)]).stream() as ReadableStream<Uint8Array>

export interface PushOptions {
  readonly baseSeq?: number | null
  readonly baseTree?: string | null
  readonly force?: boolean
  readonly dryRun?: boolean
  readonly message?: string | null
}

export const stage = (
  caller: Caller,
  target: string,
  files: Files,
  options: PushOptions = {},
): Promise<StageResult> =>
  manifestOf(files).then((manifest) =>
    runAs(
      caller,
      Effect.flatMap(Push, (push) =>
        push.stage({
          target: ref(target),
          baseSeq: (options.baseSeq ?? null) as never,
          baseTree: (options.baseTree ?? null) as never,
          force: options.force ?? false,
          dryRun: options.dryRun ?? false,
          message: options.message ?? null,
          files: manifest,
        }),
      ),
    ),
  )

/** Uploads the files a staged push is missing. */
export const upload = async (
  caller: Caller,
  pushId: PushId,
  files: Files,
  missing: readonly Sha256[],
) => {
  for (const [, text] of Object.entries(files)) {
    const sha256 = await sha256Of(text)
    if (!missing.includes(sha256)) continue
    await runAs(
      caller,
      Effect.flatMap(Push, (push) =>
        push.putBlob({
          pushId,
          sha256,
          size: encoder.encode(text).length,
          body: streamOf(text),
        }),
      ),
    )
  }
}

export const commit = (caller: Caller, pushId: PushId): Promise<CommitResult> =>
  runAs(
    caller,
    Effect.flatMap(Push, (push) => push.commit(pushId)),
  )

/** Stage, upload what is missing, commit: one whole push. */
export const pushAll = async (
  caller: Caller,
  target: string,
  files: Files,
  options: PushOptions = {},
): Promise<CommitResult | StageResult> => {
  const staged = await stage(caller, target, files, options)
  if (staged.pushId === null) return staged
  await upload(caller, staged.pushId, files, staged.missing)
  return commit(caller, staged.pushId)
}

/** Runs as the caller and answers the failure, for refusals. */
export const failureAs = <A, E>(
  caller: Caller,
  effect: Effect.Effect<A, E, CoreServices | CurrentCaller>,
): Promise<E> => runAs(caller, Effect.flip(effect))

export const nodeAt = async (treeId: string, path: string) =>
  (
    await rows<{ id: NodeId; kind: string }>(
      'select id, kind from nodes where tree_id = ? and path = ? and deleted_at is null',
      treeId,
      path,
    )
  )[0]

export const treeOf = async (workspaceName: string, name: string) =>
  (
    await rows<{ id: string; authored_seq: number; push_count: number }>(
      `select t.id, t.authored_seq, t.push_count from trees t
       join workspaces w on w.id = t.workspace_id
       where w.name = ? and t.name = ? and t.deleted_at is null`,
      workspaceName,
      name,
    )
  )[0]

/** Shares a node directly, as the share dialog will. */
export const share = (
  treeId: string,
  nodeId: string,
  targetKind: 'email' | 'workspace' | 'anyone',
  target: string,
  role: 'read' | 'respond' | 'write',
  by: Person,
) =>
  exec(
    `insert into shares (id, tree_id, node_id, target_kind, target, role, created_by, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    treeId,
    nodeId,
    targetKind,
    target,
    role,
    by.id,
    Date.now(),
  )
