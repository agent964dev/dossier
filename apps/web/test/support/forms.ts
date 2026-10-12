// Trees with forms, and sends, uploads and withdrawals through the real Data.
import type {
  AuthoredSeq,
  OpId,
  Person,
  Sha256,
  TreeId,
} from '@dossier/contracts'
import type { FieldEntry } from '@dossier/html'
import { Effect } from 'effect'

import {
  Data,
  type Caller,
  type CommitResult,
  type StageResult,
} from '../../src/core/index.ts'
import { rows } from './d1.ts'
import { runAs } from './people.ts'
import {
  agent,
  failureAs,
  nodeAt,
  pushAll,
  sha256Of,
  treeOf,
  type Files,
} from './trees.ts'

export const committed = (result: CommitResult | StageResult): CommitResult => {
  if (!('number' in result)) throw new Error('the push did not commit')
  return result
}

/** A whole page with one form. */
export const pageWith = (form: string, title = 'Questions') =>
  `<!doctype html><html><head><title>${title}</title></head><body>${form}</body></html>`

export const QUESTIONS = pageWith(`<form action="answers/" method="post">
  <fieldset><legend>Delivery questions</legend>
  <label>Role <input name="role" required></label>
  <label>Trucks <input name="trucks" type="number" min="1" max="50"></label>
  <label>Start <input name="start" type="date"></label>
  <fieldset><legend>Regions</legend>
  <label><input type="checkbox" name="regions" value="Erbil"> Erbil</label>
  <label><input type="checkbox" name="regions" value="Basra"> Basra</label>
  </fieldset>
  <label>Size <select name="size"><option>Small</option><option>Large</option></select></label>
  <label>CV <input name="cv" type="file"></label>
  </fieldset>
  <button>Send</button>
</form>`)

export interface FormTree {
  readonly owner: Person
  readonly ownerAgent: Caller
  readonly ws: { readonly id: string; readonly name: string }
  readonly treeId: TreeId
  readonly name: string
}

/** Pushes `files` into a new tree and answers where it is. */
export const pushForms = async (
  owner: Person,
  ws: { readonly id: string; readonly name: string },
  files: Files,
  name = `f${crypto.randomUUID().slice(0, 8)}`,
): Promise<FormTree> => {
  const ownerAgent = await agent(owner)
  const result = committed(
    await pushAll(ownerAgent, `${ws.name}/${name}`, files),
  )
  return { owner, ownerAgent, ws, treeId: result.treeId, name }
}

/** Pushes again to the same tree, replacing it. */
export const repush = async (tree: FormTree, files: Files) =>
  committed(
    await pushAll(tree.ownerAgent, `${tree.ws.name}/${tree.name}`, files, {
      force: true,
    }),
  )

export const seqOf = async (tree: FormTree): Promise<AuthoredSeq> =>
  ((await treeOf(tree.ws.name, tree.name))?.authored_seq ?? 0) as AuthoredSeq

export const formRef = async (
  tree: FormTree,
  host: string,
  target: string,
  id: string | null = null,
) => {
  const node = await nodeAt(tree.treeId, host)
  if (node === undefined) throw new Error(`no node at ${host}`)
  return { host: node.id, target, id }
}

export interface Send {
  readonly page: string
  readonly form: { host: string; target: string; id: string | null }
  readonly entries: readonly FieldEntry[]
  readonly seq?: AuthoredSeq
  readonly submitter?: { name: string; value: string } | null
  readonly entry?: string | null
  readonly opId?: string
}

const inputOf = async (tree: FormTree, send: Send) => ({
  treeId: tree.treeId,
  page: send.page,
  seq: send.seq ?? (await seqOf(tree)),
  form: send.form as never,
  entries: send.entries,
  submitter: send.submitter ?? null,
  entry: send.entry ?? null,
  opId: (send.opId ?? crypto.randomUUID()) as OpId,
})

export const sendAs = async (caller: Caller, tree: FormTree, send: Send) => {
  const input = await inputOf(tree, send)
  return runAs(
    caller,
    Effect.flatMap(Data, (data) => data.send(input)),
  )
}

export const sendFailure = async (
  caller: Caller,
  tree: FormTree,
  send: Send,
) => {
  const input = await inputOf(tree, send)
  return failureAs(
    caller,
    Effect.flatMap(Data, (data) => data.send(input)),
  )
}

const encoder = new TextEncoder()

export interface Upload {
  readonly page: string
  readonly form: { host: string; target: string; id: string | null }
  readonly field: string
  readonly name: string
  readonly type?: string
  readonly bytes: string
  readonly size?: number
  readonly opId?: string
}

const uploadInput = async (tree: FormTree, u: Upload) => ({
  treeId: tree.treeId,
  page: u.page,
  seq: await seqOf(tree),
  form: u.form as never,
  field: u.field,
  name: u.name,
  type: u.type ?? 'application/pdf',
  size: u.size ?? encoder.encode(u.bytes).length,
  sha256: (await sha256Of(u.bytes)) as Sha256,
  body: new Blob([
    encoder.encode(u.bytes),
  ]).stream() as ReadableStream<Uint8Array>,
  opId: (u.opId ?? crypto.randomUUID()) as OpId,
})

export const uploadAs = async (caller: Caller, tree: FormTree, u: Upload) => {
  const input = await uploadInput(tree, u)
  return runAs(
    caller,
    Effect.flatMap(Data, (data) => data.upload(input)),
  )
}

export const uploadFailure = async (
  caller: Caller,
  tree: FormTree,
  u: Upload,
) => {
  const input = await uploadInput(tree, u)
  return failureAs(
    caller,
    Effect.flatMap(Data, (data) => data.upload(input)),
  )
}

export const withdrawAs = (
  caller: Caller,
  tree: FormTree,
  path: string,
  opId = crypto.randomUUID(),
) =>
  runAs(
    caller,
    Effect.flatMap(Data, (data) =>
      data.withdraw({ treeId: tree.treeId, path, opId: opId as OpId }),
    ),
  )

export const withdrawFailure = (caller: Caller, tree: FormTree, path: string) =>
  failureAs(
    caller,
    Effect.flatMap(Data, (data) =>
      data.withdraw({
        treeId: tree.treeId,
        path,
        opId: crypto.randomUUID() as OpId,
      }),
    ),
  )

/** Every version of the data file at a path, oldest first. */
export const versionsAt = (treeId: string, path: string) =>
  rows<{
    revision: number
    state: string
    json_value: string | null
    blob_sha256: string | null
    author_id: string
    seen_push_number: number | null
    op_id: string | null
    created_at: number
  }>(
    `select v.revision, v.state, v.json_value, v.blob_sha256, v.author_id,
       v.seen_push_number, v.op_id, v.created_at
     from node_versions v join nodes n on n.id = v.node_id
     where n.tree_id = ? and n.path = ? order by n.created_at, v.revision`,
    treeId,
    path,
  )

export const liveValue = async (treeId: string, path: string) => {
  const [row] = await rows<{
    json_value: string | null
    owner_id: string | null
  }>(
    `select v.json_value, n.owner_id from nodes n
       join node_versions v on v.id = n.current_version_id
     where n.tree_id = ? and n.path = ? and n.deleted_at is null`,
    treeId,
    path,
  )
  return row === undefined
    ? null
    : {
        value:
          row.json_value === null
            ? null
            : (JSON.parse(row.json_value) as unknown),
        owner: row.owner_id,
      }
}
