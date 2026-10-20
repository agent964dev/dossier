import { describe, expect, it } from 'vitest'

import { safeNext } from '../src/lib/auth-client.ts'

const ORIGIN = 'https://dossier.test'

describe('where sign-in continues to', () => {
  it('keeps a same-origin path as given', () => {
    expect(safeNext('/acme/plan?x=1#c', ORIGIN)).toBe('/acme/plan?x=1#c')
    expect(safeNext('/', ORIGIN)).toBe('/')
  })

  it("turns an absolute URL on the Deployment's own origin into its path, query and fragment", () => {
    expect(safeNext('https://dossier.test/acme/plan?x=1#c', ORIGIN)).toBe(
      '/acme/plan?x=1#c',
    )
    expect(safeNext('https://dossier.test/acme/plan', ORIGIN)).toBe(
      '/acme/plan',
    )
  })

  it('sends a content host to the front page', () => {
    expect(safeNext('https://t1.content.test/acme/plan?x=1#c', ORIGIN)).toBe(
      '/',
    )
  })

  it('sends any other origin to the front page', () => {
    for (const next of [
      'https://evil.test/acme/plan',
      'http://dossier.test/acme/plan',
      'https://dossier.test:8443/acme/plan',
      'https://dossier.test.evil.test/acme/plan',
      'https://dossier.test@evil.test/acme/plan',
      '//evil.test',
      '//evil.test/acme/plan',
      '/\\evil.test',
      '//path.invalid/acme/plan',
      '/\\path.invalid/acme/plan',
      'javascript:alert(1)',
    ]) {
      expect(safeNext(next, ORIGIN), next).toBe('/')
    }
  })

  it('sends anything that is not a string to the front page', () => {
    for (const next of [undefined, null, 42, { href: '/acme' }]) {
      expect(safeNext(next, ORIGIN)).toBe('/')
    }
  })
})
