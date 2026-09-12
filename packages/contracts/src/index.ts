import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from '@effect/platform'
import { PolicyResult } from '@dossier/policy'
import { Schema } from 'effect'

export {
  CssPolicyResult,
  PolicyResult,
  PolicyStats,
} from '@dossier/policy'
export type {
  CssPolicyResultType,
  PolicyResultType,
  PolicyStatsType,
} from '@dossier/policy'

const OptionalString = Schema.optional(Schema.String)
const OptionalNullableString = Schema.optional(Schema.NullOr(Schema.String))

export const DocumentId = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9]{12}$/),
)
export type DocumentId = typeof DocumentId.Type

export const Visibility = Schema.Literal('public', 'team', 'private')
export type Visibility = typeof Visibility.Type

export const WorkspaceRole = Schema.Literal('admin', 'member')
export type WorkspaceRole = typeof WorkspaceRole.Type

export const DocumentReader = Schema.Struct({
  id: DocumentId,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.String),
  parentId: Schema.NullOr(DocumentId),
  effectiveVisibility: Visibility,
  workspaceSlug: Schema.String,
  authorAccountId: Schema.String,
  authorName: Schema.String,
  latestVersionNumber: Schema.Number,
  disabled: Schema.Boolean,
  url: Schema.String,
  rawUrl: Schema.String,
  hubUrl: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type DocumentReader = typeof DocumentReader.Type

export const DocumentEditor = Schema.Struct({
  ...DocumentReader.fields,
  visibility: Schema.NullOr(Visibility),
  accessSource: Schema.Literal('own', 'inherited'),
  versionCount: Schema.Number,
  revision: Schema.Number,
  deletionBatchId: Schema.NullOr(Schema.String),
  deletedAt: Schema.NullOr(Schema.String),
  deletedBy: Schema.NullOr(Schema.String),
  disabledAt: Schema.NullOr(Schema.String),
})
export type DocumentEditor = typeof DocumentEditor.Type

export const Version = Schema.Struct({
  id: Schema.String,
  documentId: DocumentId,
  versionNumber: Schema.Number,
  contentHash: Schema.String,
  fileSize: Schema.Number,
  originalFilename: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  createdByAccountId: Schema.String,
  createdByApiKeyId: Schema.NullOr(Schema.String),
  url: Schema.String,
  rawUrl: Schema.String,
})
export type Version = typeof Version.Type

export const UploadMetadata = Schema.Struct({
  userAgent: OptionalNullableString,
  cliVersion: OptionalNullableString,
  repoOrg: OptionalNullableString,
  repoName: OptionalNullableString,
  repoHost: OptionalNullableString,
  fileSha256: OptionalNullableString,
  ciProvider: OptionalNullableString,
  gitBranch: OptionalNullableString,
  gitCommitSha: OptionalNullableString,
  gitCommitSubject: OptionalNullableString,
  gitDirty: Schema.optional(Schema.NullOr(Schema.Boolean)),
  ciRunUrl: OptionalNullableString,
  ciActor: OptionalNullableString,
})
export type UploadMetadata = typeof UploadMetadata.Type

export const UploadRequest = Schema.Struct({
  html: Schema.String,
  filename: OptionalString,
  documentId: Schema.optional(DocumentId),
  draftId: Schema.optional(Schema.NullOr(DocumentId)),
  parentId: Schema.optional(Schema.NullOr(DocumentId)),
  kind: OptionalNullableString,
  visibility: Schema.optional(Schema.NullOr(Visibility)),
  description: OptionalNullableString,
  shares: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(UploadMetadata),
  idempotencyKey: OptionalString,
})
export type UploadRequest = typeof UploadRequest.Type

export const UploadResponse = Schema.Struct({
  ok: Schema.Literal(true),
  document: DocumentEditor,
  versionNumber: Schema.Number,
  versionUrl: Schema.String,
  warnings: Schema.Array(Schema.String),
  draftId: DocumentId,
  publicUrl: Schema.String,
  rawUrl: Schema.String,
})
export type UploadResponse = typeof UploadResponse.Type

export const Me = Schema.Struct({
  accountId: Schema.String,
  accountName: Schema.String,
  apiKeyId: Schema.NullOr(Schema.String),
  apiKeyName: Schema.NullOr(Schema.String),
  workspace: Schema.Struct({
    id: Schema.String,
    slug: Schema.String,
    kind: Schema.Literal('team', 'personal'),
    role: Schema.NullOr(WorkspaceRole),
  }),
  email: Schema.NullOr(Schema.String),
})
export type Me = typeof Me.Type

export const ApiKey = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  workspaceId: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
})
export type ApiKey = typeof ApiKey.Type

export const ApiKeyCreate = Schema.Struct({
  name: Schema.String,
})
export type ApiKeyCreate = typeof ApiKeyCreate.Type

export const ApiKeyCreateResponse = Schema.Struct({
  ok: Schema.Literal(true),
  apiKey: ApiKey,
  token: Schema.String,
})
export type ApiKeyCreateResponse = typeof ApiKeyCreateResponse.Type

export const ApiKeyListResponse = Schema.Struct({
  ok: Schema.Literal(true),
  apiKeys: Schema.Array(ApiKey),
})
export type ApiKeyListResponse = typeof ApiKeyListResponse.Type

export const DocumentGetResponse = Schema.Struct({
  ok: Schema.Literal(true),
  document: DocumentEditor,
  versions: Schema.Array(Version),
})
export type DocumentGetResponse = typeof DocumentGetResponse.Type

export const DocumentListResponse = Schema.Struct({
  ok: Schema.Literal(true),
  documents: Schema.Array(DocumentEditor),
  nextCursor: Schema.NullOr(Schema.String),
})
export type DocumentListResponse = typeof DocumentListResponse.Type

export const DeleteResponse = Schema.Struct({
  ok: Schema.Literal(true),
  batchId: Schema.String,
  deleted: Schema.Number,
  authors: Schema.Array(Schema.String),
})
export type DeleteResponse = typeof DeleteResponse.Type

export const MutationResponse = Schema.Struct({
  ok: Schema.Literal(true),
  document: DocumentEditor,
})
export type MutationResponse = typeof MutationResponse.Type

export const LegacyDraft = Schema.Struct({
  id: DocumentId,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  url: Schema.String,
  rawUrl: Schema.String,
  version: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type LegacyDraft = typeof LegacyDraft.Type

export const LegacyDraftListResponse = Schema.Struct({
  ok: Schema.Literal(true),
  drafts: Schema.Array(LegacyDraft),
})
export type LegacyDraftListResponse = typeof LegacyDraftListResponse.Type

function errorSchema<const Code extends string>(code: Code) {
  return Schema.Struct({
    ok: Schema.Literal(false),
    code: Schema.Literal(code),
    message: Schema.optional(Schema.String),
    details: Schema.optional(Schema.Unknown),
  })
}

export const UnauthenticatedError = errorSchema('unauthenticated')
export const NotFoundError = errorSchema('not_found')
export const EditorRequiredError = errorSchema('editor_required')
export const PublisherRequiredError = errorSchema('publisher_required')
export const HasChildrenError = errorSchema('has_children')
export const ConflictError = errorSchema('conflict')
export const IdempotencyConflictError = errorSchema('idempotency_conflict')
export const BodyTooLargeError = errorSchema('body_too_large')
export const PolicyRejectedError = errorSchema('policy_rejected')
export const RateLimitedError = errorSchema('rate_limited')

export const ApiError = Schema.Union(
  UnauthenticatedError,
  NotFoundError,
  EditorRequiredError,
  PublisherRequiredError,
  HasChildrenError,
  ConflictError,
  IdempotencyConflictError,
  BodyTooLargeError,
  PolicyRejectedError,
  RateLimitedError,
)
export type ApiError = typeof ApiError.Type

export const HealthzResponse = Schema.Struct({
  ok: Schema.Literal(true),
  service: Schema.Literal('dossier'),
  version: Schema.String,
})
export type HealthzResponse = typeof HealthzResponse.Type

export const PolicyCheckPayload = HttpApiSchema.Text({
  contentType: 'text/html',
})
export type PolicyCheckPayload = typeof PolicyCheckPayload.Type

export const SystemApiGroup = HttpApiGroup.make('system')
  .add(
    HttpApiEndpoint.get('healthz', '/api/healthz').addSuccess(
      HealthzResponse,
    ),
  )
  .add(
    HttpApiEndpoint.post('policyCheck', '/api/policy/check')
      .setPayload(PolicyCheckPayload)
      .addSuccess(PolicyResult),
  )

export const UploadsApiGroup = HttpApiGroup.make('uploads').add(
  HttpApiEndpoint.post('publish', '/api/uploads')
    .setPayload(UploadRequest)
    .addSuccess(UploadResponse),
)

const DocumentPath = Schema.Struct({ id: DocumentId })
const RestorePayload = Schema.Struct({ batchId: Schema.String })
const DisablePayload = Schema.Struct({ reason: OptionalNullableString })

export const DocumentsApiGroup = HttpApiGroup.make('documents')
  .add(
    HttpApiEndpoint.get('get', '/api/documents/:id')
      .setPath(DocumentPath)
      .addSuccess(DocumentGetResponse),
  )
  .add(
    HttpApiEndpoint.get('list', '/api/documents')
      .setUrlParams(
        Schema.Struct({
          scope: Schema.optional(
            Schema.Literal('mine', 'workspace', 'trash'),
          ),
          limit: OptionalString,
          cursor: OptionalString,
        }),
      )
      .addSuccess(DocumentListResponse),
  )
  .add(
    HttpApiEndpoint.del('delete', '/api/documents/:id')
      .setPath(DocumentPath)
      .setUrlParams(Schema.Struct({ force: OptionalString }))
      .addSuccess(DeleteResponse),
  )
  .add(
    HttpApiEndpoint.post('restore', '/api/documents/:id/restore')
      .setPath(DocumentPath)
      .setPayload(RestorePayload)
      .addSuccess(MutationResponse),
  )
  .add(
    HttpApiEndpoint.post('disable', '/api/documents/:id/disable')
      .setPath(DocumentPath)
      .setPayload(DisablePayload)
      .addSuccess(MutationResponse),
  )
  .add(
    HttpApiEndpoint.post('enable', '/api/documents/:id/enable')
      .setPath(DocumentPath)
      .addSuccess(MutationResponse),
  )

export const KeysApiGroup = HttpApiGroup.make('keys')
  .add(
    HttpApiEndpoint.post('create', '/api/api-keys')
      .setPayload(ApiKeyCreate)
      .addSuccess(ApiKeyCreateResponse),
  )
  .add(
    HttpApiEndpoint.get('list', '/api/api-keys').addSuccess(
      ApiKeyListResponse,
    ),
  )
  .add(
    HttpApiEndpoint.post('revoke', '/api/api-keys/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(Schema.Struct({ ok: Schema.Literal(true) })),
  )

export const MeApiGroup = HttpApiGroup.make('me').add(
  HttpApiEndpoint.get('get', '/api/me').addSuccess(Me),
)

export const LegacyApiGroup = HttpApiGroup.make('legacy').add(
  HttpApiEndpoint.get('drafts', '/api/drafts').addSuccess(
    LegacyDraftListResponse,
  ),
)

export const SystemApi = HttpApi.make('dossier').add(SystemApiGroup)

export const DossierApi = SystemApi
  .add(UploadsApiGroup)
  .add(DocumentsApiGroup)
  .add(KeysApiGroup)
  .add(MeApiGroup)
  .add(LegacyApiGroup)
  .addError(UnauthenticatedError, { status: 401 })
  .addError(NotFoundError, { status: 404 })
  .addError(EditorRequiredError, { status: 403 })
  .addError(PublisherRequiredError, { status: 403 })
  .addError(HasChildrenError, { status: 409 })
  .addError(ConflictError, { status: 409 })
  .addError(IdempotencyConflictError, { status: 409 })
  .addError(BodyTooLargeError, { status: 413 })
  .addError(PolicyRejectedError, { status: 422 })
  .addError(RateLimitedError, { status: 429 })
