import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from '@effect/platform'
import { Schema } from 'effect'

import { DossierError } from './errors.ts'
import {
  AgentKeyId,
  AgentKeySecret,
  AuthoredSeq,
  PushId,
  PushNumber,
  Sha256,
  TreeId,
} from './ids.ts'
import { Person } from './person.ts'
import { PROTOCOL } from './protocol.ts'

export const Health = Schema.Struct({
  ok: Schema.Literal(true),
  service: Schema.Literal('dossier'),
  version: Schema.String,
  protocol: Schema.Literal(PROTOCOL),
  deployment: Schema.String,
  db: Schema.Literal('ok'),
})
export type Health = typeof Health.Type

export const KeyInfo = Schema.Struct({
  id: AgentKeyId,
  name: Schema.String,
  /** The node the key is limited to, as `workspace/tree/path`; null for all. */
  scope: Schema.NullOr(Schema.String),
  readOnly: Schema.Boolean,
})
export type KeyInfo = typeof KeyInfo.Type

export const Me = Schema.Struct({
  person: Person,
  deployment: Schema.String,
  key: Schema.NullOr(KeyInfo),
})
export type Me = typeof Me.Type

export const DeviceToken = Schema.Struct({
  key: AgentKeySecret,
  name: Schema.String,
  deployment: Schema.String,
  person: Person,
})
export type DeviceToken = typeof DeviceToken.Type

export class SystemGroup extends HttpApiGroup.make('system').add(
  // unavailable
  HttpApiEndpoint.get('health', '/health').addSuccess(Health),
) {}

export class MeGroup extends HttpApiGroup.make('me')
  // sign_in_required
  .add(HttpApiEndpoint.get('me', '/me').addSuccess(Me))
  // sign_in_required (needs an agent key)
  .add(
    HttpApiEndpoint.del('revokeCurrentKey', '/keys/current').addSuccess(
      Schema.Void,
      { status: 204 },
    ),
  ) {}

export class DeviceGroup extends HttpApiGroup.make('device').add(
  // device_pending | slow_down | device_expired | access_denied
  HttpApiEndpoint.post('token', '/device/token')
    .setPayload(Schema.Struct({ deviceCode: Schema.String }))
    .addSuccess(DeviceToken),
) {}

export const ManifestFileSchema = Schema.Struct({
  /** Inside the pushed folder, with `/` between segments. */
  path: Schema.String,
  sha256: Sha256,
  size: Schema.Int.pipe(Schema.nonNegative()),
})
export type ManifestFileWire = typeof ManifestFileSchema.Type

export const PushWarningSchema = Schema.Struct({
  code: Schema.String,
  path: Schema.String,
  line: Schema.NullOr(Schema.Int),
  message: Schema.String,
})

export const PushPlanSchema = Schema.Struct({
  createsTree: Schema.Boolean,
  added: Schema.Array(Schema.String),
  changed: Schema.Array(Schema.String),
  deleted: Schema.Array(Schema.String),
  unchanged: Schema.Int,
  ignored: Schema.Array(
    Schema.Struct({ path: Schema.String, reason: Schema.Literal('data_path') }),
  ),
  warnings: Schema.Array(PushWarningSchema),
})
export type PushPlanWire = typeof PushPlanSchema.Type

export const StagePayload = Schema.Struct({
  /** `workspace/tree[/path]`, or a link on this deployment. */
  target: Schema.String,
  /** The tree's authored sequence this folder last pulled or pushed. */
  baseSeq: Schema.NullOr(AuthoredSeq),
  /**
   * The tree that sequence belongs to. A base from another tree of the same
   * name, one deleted since, counts as no base.
   */
  baseTree: Schema.NullOr(TreeId),
  force: Schema.Boolean,
  dryRun: Schema.Boolean,
  message: Schema.NullOr(Schema.String.pipe(Schema.maxLength(500))),
  files: Schema.Array(ManifestFileSchema),
})
export type StagePayload = typeof StagePayload.Type

export const StageResponse = Schema.Struct({
  pushId: Schema.NullOr(PushId),
  /** The hashes to upload: those this tree does not already hold. */
  missing: Schema.Array(Sha256),
  plan: PushPlanSchema,
  /** Where the push lands. */
  link: Schema.String,
  /** The tree as it stands, once it exists: for "No changes" and heads. */
  tree: Schema.NullOr(
    Schema.Struct({
      id: TreeId,
      seq: AuthoredSeq,
      push: Schema.NullOr(PushNumber),
    }),
  ),
})
export type StageResponse = typeof StageResponse.Type

export const CommitResponse = Schema.Struct({
  number: PushNumber,
  link: Schema.String,
  seq: AuthoredSeq,
  treeId: TreeId,
  plan: PushPlanSchema,
})
export type CommitResponse = typeof CommitResponse.Type

export const EntryKindSchema = Schema.Literal(
  'page',
  'folder',
  'attachment',
  'kit',
  'data',
)
export type EntryKind = typeof EntryKindSchema.Type

export const EntryWire = Schema.Struct({
  name: Schema.String,
  /** Inside the tree. */
  path: Schema.String,
  kind: EntryKindSchema,
  /** A folder, whatever its kind: a page folder holds index.html. */
  folder: Schema.Boolean,
  size: Schema.NullOr(Schema.Int),
  sha256: Schema.NullOr(Sha256),
  contentType: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  /** The push that wrote the file, or the latest one below a folder. */
  push: Schema.NullOr(Schema.Struct({ number: PushNumber, at: Schema.String })),
})
export type EntryWire = typeof EntryWire.Type

export const LsResponse = Schema.Struct({
  tree: Schema.Struct({
    id: TreeId,
    workspace: Schema.String,
    name: Schema.String,
  }),
  path: Schema.String,
  seq: AuthoredSeq,
  entries: Schema.Array(EntryWire),
})
export type LsResponse = typeof LsResponse.Type

export class PushesGroup extends HttpApiGroup.make('pushes')
  // not_found | sign_in_required | forbidden | stale_head | policy_rejected |
  // too_large | rate_limited | invalid
  .add(
    HttpApiEndpoint.post('stage', '/pushes')
      .setPayload(StagePayload)
      .addSuccess(StageResponse),
  )
  // The body is the file's bytes, with Content-Length, at most the file
  // limit. The same 201 whether the bytes were stored already or not.
  // not_found | invalid | too_large | blob_reclaiming
  .add(
    HttpApiEndpoint.put('blob', '/pushes/:pushId/blobs/:sha256')
      .setPath(Schema.Struct({ pushId: PushId, sha256: Sha256 }))
      .addSuccess(Schema.Void, { status: 201 }),
  )
  // not_found | invalid | stale_head | policy_rejected | conflict |
  // blob_reclaiming
  .add(
    HttpApiEndpoint.post('commit', '/pushes/:pushId/commit')
      .setPath(Schema.Struct({ pushId: PushId }))
      .addSuccess(CommitResponse),
  ) {}

export class FilesGroup extends HttpApiGroup.make('files')
  // not_found | sign_in_required
  .add(
    HttpApiEndpoint.get('ls', '/ls')
      .setUrlParams(
        Schema.Struct({
          path: Schema.String,
          depth: Schema.Literal('one', 'all'),
        }),
      )
      .addSuccess(LsResponse),
  )
  // Streamed with ETag = the hash, always as a download: Content-Disposition:
  // attachment, X-Content-Type-Options: nosniff, Content-Security-Policy:
  // sandbox. not_found | sign_in_required
  .add(
    HttpApiEndpoint.get('file', '/file')
      .setUrlParams(Schema.Struct({ path: Schema.String }))
      .addSuccess(HttpApiSchema.Uint8Array()),
  ) {}

export const ViewGrantSchema = Schema.Struct({
  /** Goes in the frame's path on the tree's content host. */
  handle: Schema.String,
  expiresAt: Schema.String,
  /** The tree's authored sequence the frame opens. */
  seq: AuthoredSeq,
  role: Schema.Literal('read', 'respond', 'write'),
})
export type ViewGrant = typeof ViewGrantSchema.Type

export class ViewGroup extends HttpApiGroup.make('view')
  // not_found | sign_in_required · browser callers only
  .add(
    HttpApiEndpoint.post('view', '/view')
      .setPayload(
        Schema.Struct({
          tree: TreeId,
          /** The link's path inside the tree: '', 'questions/', 'plan'. */
          path: Schema.String,
        }),
      )
      .addSuccess(ViewGrantSchema),
  ) {}

/**
 * One file as a read gives it, with who wrote it and when. Every later read
 * of a data file has this shape.
 */
export const DocWire = Schema.Struct({
  /** Inside the tree: 'answers/sara@acme.com.json'. */
  path: Schema.String,
  /** Parsed JSON for .json, text for text files, null otherwise. */
  data: Schema.Unknown,
  /**
   * A data file's writer by email. An authored file's pusher by email to the
   * members of the tree's workspace and to the pusher, by name to anyone else.
   */
  by: Schema.String,
  /** ISO 8601. */
  at: Schema.String,
  /** Data: the push the writer saw. Authored: the push that wrote it. */
  push: PushNumber,
})
export type DocWire = typeof DocWire.Type

/** Where else to look from a page: its data and its comments. */
export const Pointer = Schema.Struct({
  data: Schema.Array(Schema.Struct({ path: Schema.String, files: Schema.Int })),
  comments: Schema.Int,
})
export type Pointer = typeof Pointer.Type

/** One `_` file available at a folder, for write holders. */
export const KitItemWire = Schema.Struct({
  /** Relative to the folder it comes from: '_components/acme-card.js'. */
  path: Schema.String,
  /** That folder ('' for the root), or null for the base layer. */
  from: Schema.NullOr(Schema.String),
  kind: Schema.Literal('layout', 'theme', 'component', 'doc', 'file'),
  tag: Schema.NullOr(Schema.String),
  /** The text of _components/<tag>.md. */
  doc: Schema.NullOr(Schema.String),
  /** Themes: the custom properties the file declares. */
  variables: Schema.Array(Schema.String),
})
export type KitItemWire = typeof KitItemWire.Type

const Located = {
  /** Inside the tree. */
  path: Schema.String,
  link: Schema.String,
  /** Exactly what the link returns to an agent. */
  text: Schema.String,
}

/** What `dossier read` and a link asked by an agent answer. */
export const ReadResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('page'),
    ...Located,
    push: PushNumber,
    source: Schema.Literal('companion', 'generated'),
    /** The companion's path inside the tree, when there is one. */
    companion: Schema.NullOr(Schema.String),
    type: Schema.Literal('text/markdown', 'application/json'),
    pointer: Pointer,
  }),
  Schema.Struct({
    kind: Schema.Literal('folder'),
    ...Located,
    entries: Schema.Array(EntryWire),
    /** Write holders only. */
    kit: Schema.NullOr(Schema.Array(KitItemWire)),
  }),
  Schema.Struct({
    kind: Schema.Literal('data'),
    ...Located,
    files: Schema.Array(DocWire),
  }),
  Schema.Struct({
    kind: Schema.Literal('file'),
    path: Schema.String,
    link: Schema.String,
    /** Text files up to 1 MiB; null otherwise. */
    text: Schema.NullOr(Schema.String),
    contentType: Schema.String,
    size: Schema.Int,
    /** Data files only. */
    doc: Schema.NullOr(DocWire),
  }),
)
export type ReadResult = typeof ReadResult.Type

export class ReadGroup extends HttpApiGroup.make('read')
  // not_found | sign_in_required
  .add(
    HttpApiEndpoint.get('read', '/read')
      .setUrlParams(
        Schema.Struct({
          /** '<workspace>/<tree>/<path>', or a link on this deployment. */
          path: Schema.String,
        }),
      )
      .addSuccess(ReadResult),
  ) {}

export class DossierApi extends HttpApi.make('dossier')
  .add(SystemGroup)
  .add(MeGroup)
  .add(DeviceGroup)
  .add(PushesGroup)
  .add(FilesGroup)
  .add(ViewGroup)
  .add(ReadGroup)
  .addError(DossierError)
  .prefix('/_/api') {}
