import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  contentOrigin,
  DossierError,
  dossierError,
  ERROR_CODES,
  ErrorBody,
  ERRORS,
  exitCodeFor,
  statusFor,
  treeIdForHost,
  type TreeId,
} from './index.ts'

const PAGE_CLIENT_ONLY = ['offline', 'not_in_export']

describe('the error table', () => {
  it('gives every code a status, or none for the page client codes', () => {
    for (const code of ERROR_CODES) {
      const { status } = ERRORS[code]
      if (PAGE_CLIENT_ONLY.includes(code)) {
        expect(status, code).toBeNull()
        expect(() => statusFor(code)).toThrow(TypeError)
      } else {
        expect(status, code).toBeGreaterThanOrEqual(400)
        expect(status, code).toBeLessThan(600)
        expect(status, code).not.toBe(500)
        expect(statusFor(code)).toBe(status)
      }
    }
    expect(ERROR_CODES.filter((c) => ERRORS[c].status === null)).toEqual(
      PAGE_CLIENT_ONLY,
    )
  })

  it('gives every code an exit code from 0 to 6', () => {
    for (const code of ERROR_CODES) {
      const exit = exitCodeFor(code)
      expect(Number.isInteger(exit), code).toBe(true)
      expect(exit, code).toBeGreaterThanOrEqual(0)
      expect(exit, code).toBeLessThanOrEqual(6)
      expect(exit).toBe(ERRORS[code].exit)
    }
  })

  it('maps the codes people meet to the documented exit codes', () => {
    expect(exitCodeFor('not_found')).toBe(3)
    expect(exitCodeFor('forbidden')).toBe(3)
    expect(exitCodeFor('sign_in_required')).toBe(4)
    expect(exitCodeFor('conflict')).toBe(5)
    expect(exitCodeFor('policy_rejected')).toBe(6)
    expect(exitCodeFor('unavailable')).toBe(1)
    expect(statusFor('unavailable')).toBe(503)
    expect(statusFor('sign_in_required')).toBe(401)
  })

  it('round-trips the error body', () => {
    const body: ErrorBody = {
      error: {
        code: 'not_found',
        message: 'Not found.',
        fix: null,
        path: 'acme/plan',
      },
    }
    const encoded = JSON.parse(
      JSON.stringify(Schema.encodeSync(ErrorBody)(body)),
    )
    expect(Schema.decodeUnknownSync(ErrorBody)(encoded)).toEqual(body)
    expect(() =>
      Schema.decodeUnknownSync(ErrorBody)({
        error: { code: 'teapot', message: '', fix: null, path: null },
      }),
    ).toThrow()
  })

  it('fills the message from the table', () => {
    const error = dossierError('unavailable')
    expect(error).toBeInstanceOf(DossierError)
    expect(error.message).toBe('Something went wrong. Try again.')
    expect(dossierError('not_found').message).toBe('Not found.')
  })
})

const tree = 'k3v9q2m7x8c4w1z5h6t0' as TreeId
const patterns = {
  production: ['{tree}.dossier-content.com', 'dossier.agent964.com'],
  dev: [
    '{tree}-dev.dossier-content.com',
    'dossier-next-dev.tech964.workers.dev',
  ],
  local: ['{tree}.content.localhost:8787', 'localhost:8787'],
} as const

describe('content origins', () => {
  it('derives each tree origin and reads the tree back from the host', () => {
    expect(contentOrigin(patterns.production[0], tree)).toBe(
      'https://k3v9q2m7x8c4w1z5h6t0.dossier-content.com',
    )
    expect(contentOrigin(patterns.dev[0], tree)).toBe(
      'https://k3v9q2m7x8c4w1z5h6t0-dev.dossier-content.com',
    )
    expect(contentOrigin(patterns.local[0], tree)).toBe(
      'https://k3v9q2m7x8c4w1z5h6t0.content.localhost:8787',
    )
    for (const [pattern] of Object.values(patterns)) {
      const host = new URL(contentOrigin(pattern, tree)).host
      expect(treeIdForHost(pattern, host)).toBe(tree)
    }
  })

  it('refuses a label with a hyphen', () => {
    expect(
      treeIdForHost(patterns.production[0], 'abc-def.dossier-content.com'),
    ).toBeNull()
  })

  it('refuses a dev host under the production pattern', () => {
    expect(
      treeIdForHost(patterns.production[0], `${tree}-dev.dossier-content.com`),
    ).toBeNull()
  })

  it('refuses the main host and other hosts', () => {
    for (const [pattern, main] of Object.values(patterns)) {
      expect(treeIdForHost(pattern, main)).toBeNull()
    }
    expect(treeIdForHost(patterns.production[0], 'dossier-content.com')).toBe(
      null,
    )
    expect(
      treeIdForHost(patterns.production[0], '.dossier-content.com'),
    ).toBeNull()
    expect(
      treeIdForHost(patterns.production[0], 'a.b.dossier-content.com'),
    ).toBeNull()
    expect(
      treeIdForHost(patterns.local[0], `${tree}.content.localhost:9999`),
    ).toBeNull()
  })
})
