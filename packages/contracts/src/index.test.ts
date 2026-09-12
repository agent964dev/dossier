import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  HealthzResponse,
  PolicyResult,
  PolicyStats,
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
})
