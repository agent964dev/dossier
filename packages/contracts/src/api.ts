import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from '@effect/platform'
import { Schema } from 'effect'

import { DossierError } from './errors.ts'
import { EventTypeSchema } from './events.ts'
import {
  AgentKeyId,
  AgentKeySecret,
  AuthoredSeq,
  NodeId,
  OpId,
  PushId,
  PushNumber,
  Sha256,
  TreeId,
} from './ids.ts'
import { Person } from './person.ts'
import { PROTOCOL } from './protocol.ts'
import {
  ShareRoleSchema,
  ShareSpecSchema,
  ShareTargetSchema,
} from './shares.ts'

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
  /** Shares granted on the pushed folder in the commit's batch. */
  share: Schema.optionalWith(Schema.Array(ShareSpecSchema), {
    default: () => [],
  }),
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
  /** The tree path of the page or file the frame opens. */
  path: Schema.String,
  /** Whom the grant is for: the shell refuses to go on as anyone else. */
  email: Schema.NullOr(Schema.String),
  /**
   * The events cursor as of the grant: opaque, so it says nothing about how
   * many events the tree holds. The shell's first `after`.
   */
  events: Schema.String,
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
          /** The shell renewing an open page's handle: not a new view. */
          renewal: Schema.optionalWith(Schema.Boolean, {
            default: () => false,
          }),
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
  /** A page's comments folder: its threads, assembled. */
  Schema.Struct({
    kind: Schema.Literal('comments'),
    ...Located,
    /** The page the comments are on, inside the tree. */
    page: Schema.String,
    /** One per thread: the root comment's path, and the Thread as data. */
    threads: Schema.Array(DocWire),
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

export const FormRefSchema = Schema.Struct({
  /** The page or a layout of its composition at the send's sequence. */
  host: NodeId,
  /** As the server derived it; a target that differs is form_changed. */
  target: Schema.String,
  id: Schema.NullOr(Schema.String),
})

export const UploadRefSchema = Schema.Struct({
  /** Relative to the writer's own folder in the target: 'files/cv.pdf'. */
  file: Schema.String,
  name: Schema.String,
  size: Schema.Int.pipe(Schema.nonNegative()),
  type: Schema.String,
})

export const SendPayload = Schema.Struct({
  tree: TreeId,
  /** The page's tree path: 'questions/index.html'. */
  page: Schema.String,
  /** The tree's sequence the page was served at. */
  seq: AuthoredSeq,
  form: FormRefSchema,
  entries: Schema.Array(
    Schema.Tuple(Schema.String, Schema.Union(Schema.String, UploadRefSchema)),
  ),
  submitter: Schema.NullOr(
    Schema.Struct({ name: Schema.String, value: Schema.String }),
  ),
  /** One of the caller's entries to revise; plain forms send null. */
  entry: Schema.NullOr(Schema.String),
  opId: OpId,
  /**
   * Whom the page was shown to. A send under anyone else is refused with
   * sign_in_required, so a page never sends as the wrong person.
   */
  as: Schema.optional(Schema.NullOr(Schema.String)),
})
export type SendPayload = typeof SendPayload.Type

/** doc null: the answer was withdrawn since. */
export const SendResult = Schema.Struct({
  doc: Schema.NullOr(DocWire),
  replayed: Schema.Boolean,
})
export type SendResult = typeof SendResult.Type

export const UploadParams = Schema.Struct({
  tree: TreeId,
  page: Schema.String,
  seq: Schema.NumberFromString,
  host: Schema.optional(NodeId),
  target: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  /** The file field's name. */
  field: Schema.optional(Schema.String),
  name: Schema.String,
  type: Schema.String,
  size: Schema.NumberFromString,
  sha256: Sha256,
  opId: OpId,
  /** Whom the page was shown to, as in a send. */
  as: Schema.optional(Schema.String),
})
export type UploadParams = typeof UploadParams.Type

export const UploadResult = Schema.Struct({
  /** The tree path of the stored file. */
  path: Schema.String,
  ...UploadRefSchema.fields,
})
export type UploadResult = typeof UploadResult.Type

export const DataReadResult = Schema.Union(
  /** A file; missing and unreadable are both null. */
  Schema.Struct({ file: Schema.NullOr(DocWire) }),
  /** A folder: every readable file below it, `_` files left out. */
  Schema.Struct({ files: Schema.Array(DocWire) }),
)
export type DataReadResult = typeof DataReadResult.Type

export const WithdrawPayload = Schema.Struct({
  tree: TreeId,
  /** The data file's tree path. */
  path: Schema.String,
  opId: OpId,
  /** Whom the page was shown to, as in a send. */
  as: Schema.optional(Schema.NullOr(Schema.String)),
})

/** Page code's write into a data file, or a new entry in its own folder. */
export const WritePayload = Schema.Struct({
  tree: TreeId,
  /** The page's tree path: 'board.html'. */
  page: Schema.String,
  /** A tree path, already resolved: 'layout.json', or 'ideas/<email>/'. */
  path: Schema.String,
  patch: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  /** The patch is the whole new value of a file the caller owns. */
  replace: Schema.Boolean,
  opId: OpId,
  /** The page's bootstrap sequence; the version records the push seen at it. */
  seq: AuthoredSeq,
  /** Whom the page was shown to, as in a send. */
  as: Schema.optional(Schema.NullOr(Schema.String)),
})
export type WritePayload = typeof WritePayload.Type

/** One event as the events route gives it to the caller. */
export const EventWire = Schema.Struct({
  /** Opaque: the cursor that resumes after this event. */
  cursor: Schema.String,
  type: EventTypeSchema,
  /** Inside the tree. */
  path: Schema.String,
  /** ISO 8601. */
  at: Schema.String,
  /**
   * A data event's writer by email; an authored event's pusher by email to
   * members of the tree's workspace and to the pusher, by name to anyone
   * else. Null where the event hides its actor.
   */
  by: Schema.NullOr(Schema.String),
  push: Schema.NullOr(PushNumber),
})
export type EventWire = typeof EventWire.Type

export const EventsResponse = Schema.Struct({
  events: Schema.Array(EventWire),
  /** Opaque: the `after` of the next request. */
  next: Schema.String,
  /** More events follow `next`. */
  more: Schema.Boolean,
})
export type EventsResponse = typeof EventsResponse.Type

export class EventsGroup extends HttpApiGroup.make('events')
  // not_found | sign_in_required
  .add(
    HttpApiEndpoint.get('events', '/events')
      .setUrlParams(
        Schema.Struct({
          /** A tree ID, or '<workspace>/<tree>'. */
          tree: Schema.String,
          /** A cursor this route or a view gave; none gives the cursor now. */
          after: Schema.optional(Schema.String),
          /** Only events at, below or above this tree path. */
          path: Schema.optional(Schema.String),
        }),
      )
      .addSuccess(EventsResponse),
  ) {}

/**
 * The path of the watch upgrade; outside the HttpApi. Each hint is the text
 * `{"type":"changed","tree":"<tree id>","sub":<n>}`: no sequence, path or
 * actor, sent only for a change the socket's caller may read. `ping` is
 * answered `pong`.
 */
export const WATCH_PATH = '/_/api/watch'

export class DataGroup extends HttpApiGroup.make('data')
  // invalid | closed | form_changed | forbidden | not_found |
  // sign_in_required | too_large | not_mergeable | rate_limited
  .add(
    HttpApiEndpoint.post('send', '/data/send')
      .setPayload(SendPayload)
      .addSuccess(SendResult),
  )
  // The body is the file's bytes, at most the upload limit. invalid | closed
  // | form_changed | forbidden | not_found | sign_in_required | too_large |
  // rate_limited | blob_reclaiming
  .add(
    HttpApiEndpoint.put('upload', '/data/upload')
      .setUrlParams(UploadParams)
      .addSuccess(UploadResult, { status: 201 }),
  )
  // not_found | forbidden | sign_in_required
  .add(
    HttpApiEndpoint.post('withdraw', '/data/withdraw')
      .setPayload(WithdrawPayload)
      .addSuccess(Schema.Void, { status: 204 }),
  )
  // Never not_found: missing and unreadable read as nothing. too_large for
  // a folder over 1,000 files or 10 MiB of data.
  .add(
    HttpApiEndpoint.get('read', '/data/read')
      .setUrlParams(Schema.Struct({ tree: TreeId, path: Schema.String }))
      .addSuccess(DataReadResult),
  )
  // forbidden | invalid | not_mergeable | closed | too_large | rate_limited |
  // sign_in_required
  .add(
    HttpApiEndpoint.post('write', '/data/write')
      .setPayload(WritePayload)
      .addSuccess(DocWire),
  ) {}

export const ShareWire = Schema.Struct({
  target: ShareTargetSchema,
  role: ShareRoleSchema,
  /** The tree path of the node the share sits on. */
  on: Schema.String,
  /** A share on a folder above: a lower node cannot narrow it. */
  inherited: Schema.Boolean,
  /** ISO 8601. */
  createdAt: Schema.String,
})
export type ShareWire = typeof ShareWire.Type

export const SharesResponse = Schema.Struct({
  /** The node's tree path. */
  path: Schema.String,
  link: Schema.String,
  shares: Schema.Array(ShareWire),
  /** Tree paths of the `_` files above that are public with the node. */
  publicReach: Schema.Array(Schema.String),
})
export type SharesResponse = typeof SharesResponse.Type

export const SetSharePayload = Schema.Struct({
  /** '<workspace>/<tree>/<path>', or a link on this deployment. */
  path: Schema.String,
  target: ShareTargetSchema,
  /** null removes the target's share. */
  role: Schema.NullOr(ShareRoleSchema),
})
export type SetSharePayload = typeof SetSharePayload.Type

export class SharesGroup extends HttpApiGroup.make('shares')
  // not_found | sign_in_required | forbidden
  .add(
    HttpApiEndpoint.get('list', '/shares')
      .setUrlParams(Schema.Struct({ path: Schema.String }))
      .addSuccess(SharesResponse),
  )
  // not_found | sign_in_required | forbidden | invalid | conflict
  .add(
    HttpApiEndpoint.post('set', '/shares')
      .setPayload(SetSharePayload)
      .addSuccess(SharesResponse),
  ) {}

/** The tree paths an export linked instead of inlining, as JSON, percent-encoded. */
export const EXPORT_LINKED_HEADER = 'Dossier-Export-Linked'

export class ExportGroup extends HttpApiGroup.make('export')
  // Streamed text/html as an attachment, Cache-Control: no-store, with
  // Dossier-Export-Linked. not_found | sign_in_required | too_large
  .add(
    HttpApiEndpoint.get('export', '/export')
      .setUrlParams(
        Schema.Struct({
          /** A link on this deployment, or '<workspace>/<tree>/<path>'. */
          link: Schema.String,
        }),
      )
      .addSuccess(HttpApiSchema.Uint8Array()),
  ) {}

export class DossierApi extends HttpApi.make('dossier')
  .add(SystemGroup)
  .add(MeGroup)
  .add(DeviceGroup)
  .add(PushesGroup)
  .add(FilesGroup)
  .add(ViewGroup)
  .add(ReadGroup)
  .add(DataGroup)
  .add(EventsGroup)
  .add(SharesGroup)
  .add(ExportGroup)
  .addError(DossierError)
  .prefix('/_/api') {}
