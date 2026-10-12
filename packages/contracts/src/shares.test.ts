import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  formatShareTarget,
  parseShareSpec,
  parseShareTarget,
  SHARE_ROLES,
  ShareSpecSchema,
  type ShareTarget,
} from './shares.ts'

const TARGETS: readonly [string, ShareTarget][] = [
  ['sara@acme.com', { kind: 'email', email: 'sara@acme.com' }],
  ['team:Design', { kind: 'team', team: 'Design' }],
  ['team:Field ops', { kind: 'team', team: 'Field ops' }],
  ['workspace', { kind: 'workspace' }],
  ['anyone', { kind: 'anyone' }],
]

describe('the share grammar', () => {
  it('reads emails, teams, the workspace and anyone, and writes them back as they were', () => {
    for (const [text, target] of TARGETS) {
      expect(parseShareTarget(text), text).toEqual(target)
      expect(formatShareTarget(target), text).toBe(text)
    }
    // An email is kept lower-cased, as shares store it.
    expect(parseShareTarget(' Sara@Acme.com ')).toEqual({
      kind: 'email',
      email: 'sara@acme.com',
    })
  })

  it('reads a spec with each role, split at the last colon', () => {
    for (const [text, target] of TARGETS) {
      for (const role of SHARE_ROLES) {
        const spec = parseShareSpec(`${text}:${role}`)
        expect(spec, `${text}:${role}`).toEqual({ target, role })
        expect(Schema.is(ShareSpecSchema)(spec)).toBe(true)
      }
    }
    expect(parseShareSpec('team:Ops:admin:read')).toEqual({
      target: { kind: 'team', team: 'Ops:admin' },
      role: 'read',
    })
  })

  it('refuses anything else', () => {
    for (const text of [
      '',
      'sara',
      'sara@',
      '@acme.com',
      'sara@acme',
      'sara @acme.com',
      'team:',
      'team: Design',
      'Workspace',
      'everyone',
      '*',
    ]) {
      expect(parseShareTarget(text), text).toBeNull()
    }
    for (const text of [
      'sara@acme.com',
      'sara@acme.com:',
      'sara@acme.com:admin',
      'sara@acme.com:Read',
      ':read',
      'nobody:read',
      'anyone:comment',
    ]) {
      expect(parseShareSpec(text), text).toBeNull()
    }
  })
})
