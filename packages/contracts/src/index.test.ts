import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  ApiError,
  HealthzResponse,
  PolicyResult,
  PolicyStats,
  UploadRequest,
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
  })
})
