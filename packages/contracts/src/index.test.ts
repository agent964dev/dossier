import { FetchHttpClient, HttpApiClient } from '@effect/platform'
import { Effect, Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
  ApiError,
  DocumentEditor,
  DocumentGetResponse,
  DocumentListResponse,
  DocumentReader,
  DossierApi,
  EditLinkResponse,
  FieldType,
  HealthzResponse,
  PolicyResult,
  PolicyStats,
  ShareDelta,
  SharesResponse,
  StateResponse,
  StateSaveRequest,
  TreeResponse,
  UploadRequest,
  UploadResponse,
} from './index'

describe('shared contracts', () => {
  it('decodes the health response schema', () => {
    expect(
      Schema.decodeUnknownSync(HealthzResponse)({
        ok: true,
        service: 'dossier',
        version: '0.0.0',
      }),
    ).toEqual({ ok: true, service: 'dossier', version: '0.0.0' })
    expect(
      Schema.decodeUnknownSync(HealthzResponse)({
        ok: true,
        service: 'dossier',
        version: '0.0.0',
        features: ['state'],
      }),
    ).toMatchObject({ features: ['state'] })
  })

  it('decodes the saved-value contract additions', () => {
    const response = {
      documentId: 'abcdefghijkl',
      version: 1,
      revision: 0,
      updatedAt: null,
      data: { approved: false, notes: '' },
      fields: {
        approved: { value: false, revision: 0, type: 'checkbox' },
        notes: { value: '', revision: 0, type: 'textarea' },
      },
    }

    expect(Schema.decodeUnknownSync(FieldType)('select-multiple')).toBe(
      'select-multiple',
    )
    expect(Schema.decodeUnknownSync(StateResponse)(response)).toEqual(response)
    expect(
      Schema.decodeUnknownSync(EditLinkResponse)({
        documentId: 'abcdefghijkl',
        active: false,
        editUrl: null,
      }),
    ).toEqual({
      documentId: 'abcdefghijkl',
      active: false,
      editUrl: null,
    })
    expect(
      Schema.decodeUnknownSync(StateSaveRequest)({
        changes: [
          { name: 'approved', value: true, base: 0 },
          { name: 'notes', value: 'Ready', base: 2 },
        ],
      }),
    ).toEqual({
      changes: [
        { name: 'approved', value: true, base: 0 },
        { name: 'notes', value: 'Ready', base: 2 },
      ],
    })

    const specialName = Schema.decodeUnknownSync(StateResponse)({
      ...response,
      data: JSON.parse('{"__proto__":"keep me"}'),
      fields: JSON.parse(
        '{"__proto__":{"value":"keep me","revision":0,"type":"text"}}',
      ),
    })
    expect(Object.hasOwn(specialName.data, '__proto__')).toBe(true)
    expect(specialName.data.__proto__).toBe('keep me')
    expect(Object.hasOwn(specialName.fields, '__proto__')).toBe(true)
    expect(specialName.fields.__proto__).toEqual({
      value: 'keep me',
      revision: 0,
      type: 'text',
    })
    const stateFields = {
      stateful: true,
      stateRevision: 0,
      stateUpdatedAt: null,
    }
    expect(
      Schema.decodeUnknownSync(
        DocumentReader.pick('stateful', 'stateRevision', 'stateUpdatedAt'),
      )(stateFields),
    ).toEqual(stateFields)
    expect(
      Schema.decodeUnknownSync(UploadRequest)({
        html: '<!doctype html><title>stateful</title>',
        stateful: true,
        acceptStateChanges: true,
      }),
    ).toMatchObject({ stateful: true, acceptStateChanges: true })
  })

  it('defaults legacy document state fields and still encodes them', () => {
    const legacyReader = {
      id: 'abcdefghijkl',
      title: 'Legacy document',
      description: null,
      kind: null,
      parentId: null,
      effectiveVisibility: 'team',
      workspaceSlug: 'test',
      authorAccountId: 'acct_test',
      authorName: 'Test User',
      latestVersionNumber: 1,
      disabled: false,
      url: 'https://dossier.test/d/abcdefghijkl',
      rawUrl: 'https://dossier.test/d/abcdefghijkl/raw',
      hubUrl: 'https://dossier.test/d/abcdefghijkl/tree',
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    } satisfies typeof DocumentReader.Encoded
    const legacyEditor = {
      ...legacyReader,
      visibility: 'team',
      accessSource: 'own',
      versionCount: 1,
      revision: 1,
      deletionBatchId: null,
      deletionRootTitle: null,
      deletedAt: null,
      deletedBy: null,
      disabledAt: null,
    } satisfies typeof DocumentEditor.Encoded
    const defaults = {
      stateful: false,
      stateRevision: null,
      stateUpdatedAt: null,
    }
    const reader = Schema.decodeUnknownSync(DocumentReader)(legacyReader)
    const editor = Schema.decodeUnknownSync(DocumentEditor)(legacyEditor)
    expect(reader).toEqual({ ...legacyReader, ...defaults })
    expect(editor).toEqual({ ...legacyEditor, ...defaults })
    expect(Schema.encodeSync(DocumentReader)(reader)).toEqual(reader)
    expect(Schema.encodeSync(DocumentEditor)(editor)).toEqual(editor)
    expect(
      Schema.decodeUnknownSync(DocumentListResponse)({
        ok: true,
        documents: [legacyReader, legacyEditor],
        nextCursor: null,
      }),
    ).toMatchObject({ documents: [reader, editor] })
    expect(
      Schema.decodeUnknownSync(DocumentGetResponse)({
        ok: true,
        document: legacyEditor,
        versions: [],
      }),
    ).toMatchObject({ document: editor })
    expect(
      Schema.decodeUnknownSync(TreeResponse)({
        breadcrumb: [legacyReader],
        document: legacyReader,
        siblings: [legacyReader],
        children: [legacyReader],
      }),
    ).toEqual({
      breadcrumb: [reader],
      document: reader,
      siblings: [reader],
      children: [reader],
    })
    const receipt = Schema.decodeUnknownSync(UploadResponse)({
      ok: true,
      document: legacyEditor,
      versionNumber: 1,
      versionUrl: `${legacyReader.url}/v/1`,
      warnings: [],
      draftId: legacyReader.id,
      publicUrl: legacyReader.url,
      rawUrl: legacyReader.rawUrl,
    })
    expect(receipt.document).toEqual(editor)
    expect(Schema.encodeSync(UploadResponse)(receipt)).toEqual(receipt)
  })

  it('decodes signed-in state grant share fields', () => {
    expect(
      Schema.decodeUnknownSync(ShareDelta)({
        addSavers: ['saver@example.test'],
        removeSavers: ['reader@example.test'],
        removeGrants: ['removed@example.test'],
      }),
    ).toEqual({
      addSavers: ['saver@example.test'],
      removeSavers: ['reader@example.test'],
      removeGrants: ['removed@example.test'],
    })
    expect(
      Schema.decodeUnknownSync(SharesResponse)({
        configured: [],
        effective: [],
        accessSource: 'own',
        grants: [{ email: 'saver@example.test', canSave: true }],
      }),
    ).toMatchObject({
      grants: [{ email: 'saver@example.test', canSave: true }],
    })
  })

  it('defaults legacy share responses to no grants and still encodes them', () => {
    const legacy = {
      configured: ['reader@example.test'],
      effective: ['reader@example.test'],
      accessSource: 'own',
    } satisfies typeof SharesResponse.Encoded
    const decoded = Schema.decodeUnknownSync(SharesResponse)(legacy)
    expect(decoded).toEqual({ ...legacy, grants: [] })
    expect(Schema.encodeSync(SharesResponse)(decoded)).toEqual(decoded)
  })

  it('decodes every state save error through the derived client', async () => {
    const errors = [
      {
        status: 409,
        code: 'state_conflict',
        message: 'Saved values changed.',
        details: {
          fields: [{ name: 'approved', revision: 3, value: true }],
        },
      },
      {
        status: 409,
        code: 'state_version_changed',
        message: 'The document version changed.',
        details: { currentVersion: 4 },
      },
      {
        status: 422,
        code: 'state_type_mismatch',
        message: 'Saved values do not match the document.',
        details: { fields: ['approved'] },
      },
      {
        status: 413,
        code: 'state_too_large',
        message: 'Saved values are too large.',
        details: { bytes: 262_145, limit: 262_144 },
      },
      {
        status: 409,
        code: 'state_not_enabled',
        message: 'Saved values are not enabled.',
      },
      {
        status: 403,
        code: 'state_edit_required',
        message: 'Saved-value edit access is required.',
      },
      {
        status: 503,
        code: 'state_unavailable',
        message: 'Saved values are unavailable.',
      },
      {
        status: 429,
        code: 'rate_limited',
        message: 'Too many saved-value requests.',
      },
    ] as const
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    try {
      const client = await Effect.runPromise(
        HttpApiClient.make(DossierApi, {
          baseUrl: 'https://dossier.example',
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      )

      for (const error of errors) {
        const envelope = {
          ok: false as const,
          code: error.code,
          message: error.message,
          ...('details' in error ? { details: error.details } : {}),
        }
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify(envelope), {
            status: error.status,
            headers: {
              'cache-control': 'no-store',
              'content-type': 'application/json; charset=utf-8',
            },
          }),
        )

        const decoded = await Effect.runPromise(
          Effect.flip(
            client.state.set({
              path: { id: 'abcdefghijkl' },
              payload: { changes: [] },
            }),
          ),
        )
        expect(decoded).toEqual(envelope)
      }

      const unavailable = {
        ok: false as const,
        code: 'state_unavailable' as const,
        message: 'Saved values are unavailable.',
      }
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(unavailable), {
          status: 503,
          headers: {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
          },
        }),
      )
      const decodedGet = await Effect.runPromise(
        Effect.flip(client.state.get({ path: { id: 'abcdefghijkl' } })),
      )
      expect(decodedGet).toEqual(unavailable)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('decodes state-not-enabled on every edit-link endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    try {
      const client = await Effect.runPromise(
        HttpApiClient.make(DossierApi, {
          baseUrl: 'https://dossier.example',
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      )
      const calls = [
        () =>
          Effect.runPromise(
            Effect.flip(
              client.state.linkCreate({ path: { id: 'abcdefghijkl' } }),
            ),
          ),
        () =>
          Effect.runPromise(
            Effect.flip(client.state.linkGet({ path: { id: 'abcdefghijkl' } })),
          ),
        () =>
          Effect.runPromise(
            Effect.flip(
              client.state.linkRevoke({ path: { id: 'abcdefghijkl' } }),
            ),
          ),
      ] as const

      for (const call of calls) {
        const envelope = {
          ok: false as const,
          code: 'state_not_enabled' as const,
          message: 'Saved values are not enabled.',
        }
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify(envelope), {
            status: 409,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          }),
        )
        expect(await call()).toEqual(envelope)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('decodes publication state errors through the derived client', async () => {
    const errors = [
      {
        status: 409,
        envelope: {
          ok: false as const,
          code: 'state_schema_change' as const,
          message: 'Publishing would change saved-value fields.',
          details: {
            retyped: [
              { name: 'notes', from: 'textarea' as const, to: 'text' as const },
            ],
            orphaned: ['approved'],
          },
        },
      },
      {
        status: 413,
        envelope: {
          ok: false as const,
          code: 'state_too_large' as const,
          message: 'Saved values are too large.',
          details: { bytes: 262_145, limit: 262_144 },
        },
      },
    ] as const
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    try {
      const client = await Effect.runPromise(
        HttpApiClient.make(DossierApi, {
          baseUrl: 'https://dossier.example',
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      )

      for (const error of errors) {
        fetchMock.mockResolvedValueOnce(
          new Response(JSON.stringify(error.envelope), {
            status: error.status,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          }),
        )
        const decoded = await Effect.runPromise(
          Effect.flip(
            client.uploads.publish({
              payload: {
                html: '<!doctype html><title>Stateful publish</title>',
                acceptStateChanges: true,
              },
            }),
          ),
        )
        expect(decoded).toEqual(error.envelope)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('re-exports the policy schemas', () => {
    const stats = {
      hasInlineScript: false,
      externalImageHosts: [],
      stylesheetRefs: [],
      embedHosts: [],
    }
    expect(Schema.decodeUnknownSync(PolicyStats)(stats)).toEqual(stats)
    expect(
      Schema.decodeUnknownSync(PolicyResult)({
        ok: true,
        errors: [],
        warnings: [],
        title: 'Shared policy',
        stats,
      }).ok,
    ).toBe(true)
  })

  it('accepts the provenance fields emitted by the upstream CLI', () => {
    const metadata = {
      cliVersion: '0.0.4',
      repoOrg: 'agent964',
      repoName: 'dossier',
      repoHost: 'github.com',
      fileSha256: 'a'.repeat(64),
      ciProvider: 'github_actions',
      gitBranch: 'main',
      gitCommitSha: 'b'.repeat(40),
      gitCommitSubject: 'phase one',
      gitDirty: true,
      ciRunUrl: 'https://github.com/agent964/dossier/actions/runs/1',
      ciActor: 'agent964',
    }
    expect(
      Schema.decodeUnknownSync(UploadRequest, { onExcessProperty: 'error' })({
        html: '<!doctype html><title>upstream</title>',
        draftId: null,
        metadata,
      }),
    ).toEqual({
      html: '<!doctype html><title>upstream</title>',
      draftId: null,
      metadata,
    })
  })

  it('accepts legacy-null upload identifiers and typed API errors', () => {
    expect(
      Schema.decodeUnknownSync(UploadRequest)({
        html: '<!doctype html><title>legacy</title>',
        draftId: null,
      }),
    ).toEqual({
      html: '<!doctype html><title>legacy</title>',
      draftId: null,
    })
    expect(
      Schema.decodeUnknownSync(ApiError)({
        ok: false,
        code: 'idempotency_conflict',
        message: 'already used',
      }),
    ).toMatchObject({ code: 'idempotency_conflict' })
    expect(
      Schema.decodeUnknownSync(ApiError)({
        ok: false,
        code: 'state_not_enabled',
      }),
    ).toMatchObject({ code: 'state_not_enabled' })
    expect(
      Schema.decodeUnknownSync(ApiError)({
        ok: false,
        code: 'link_revoked',
      }),
    ).toMatchObject({ code: 'link_revoked' })
  })
})
