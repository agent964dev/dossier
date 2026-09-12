import { describe, expect, it } from 'vitest'
import { normalizeGlobalOptions } from './index.js'

describe('argument normalization', () => {
  it('allows global options after a subcommand', () => {
    expect(
      normalizeGlobalOptions(['node', 'dossier', 'whoami', '--api-url', 'http://localhost:8787', '--json'])
        .args,
    ).toEqual([
      'node',
      'dossier',
      '--api-url',
      'http://localhost:8787',
      '--json',
      'whoami',
    ])
  })

  it('allows upload and fetch options after their positional argument', () => {
    expect(
      normalizeGlobalOptions([
        'node',
        'dossier',
        'upload',
        'plan.html',
        '--kind',
        'plan',
        '--new',
      ]).args,
    ).toEqual([
      'node',
      'dossier',
      'upload',
      '--kind',
      'plan',
      '--new',
      'plan.html',
    ])
    expect(
      normalizeGlobalOptions(['node', 'dossier', 'fetch', '7k2m9x1qz3ab', '-o', 'plan.html']).args,
    ).toEqual([
      'node',
      'dossier',
      'fetch',
      '-o',
      'plan.html',
      '7k2m9x1qz3ab',
    ])
  })
})
