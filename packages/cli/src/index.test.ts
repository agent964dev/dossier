import { describe, expect, it, vi } from 'vitest'
import { normalizeGlobalOptions, runCli } from './index.js'

describe('argument normalization', () => {
  it('allows global options before or after a subcommand', () => {
    expect(
      normalizeGlobalOptions([
        'node',
        'dossier',
        'whoami',
        '--api-url',
        'http://localhost:8787',
        '--json',
      ]).args,
    ).toEqual([
      'node',
      'dossier',
      '--api-url',
      'http://localhost:8787',
      '--json',
      'whoami',
    ])
    expect(
      normalizeGlobalOptions([
        'node',
        'dossier',
        '--json',
        'assets',
        '--api-url=http://localhost:8787',
        'list',
      ]).args,
    ).toEqual([
      'node',
      'dossier',
      '--json',
      '--api-url=http://localhost:8787',
      'assets',
      'list',
    ])
  })

  it('allows command options after positional arguments', () => {
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
      normalizeGlobalOptions([
        'node',
        'dossier',
        'fetch',
        '7k2m9x1qz3ab',
        '-o',
        'plan.html',
      ]).args,
    ).toEqual(['node', 'dossier', 'fetch', '-o', 'plan.html', '7k2m9x1qz3ab'])
    expect(
      normalizeGlobalOptions([
        'node',
        'dossier',
        'diff',
        '7k2m9x1qz3ab',
        '--from',
        '2',
        '--text',
      ]).args,
    ).toEqual([
      'node',
      'dossier',
      'diff',
      '--from',
      '2',
      '--text',
      '7k2m9x1qz3ab',
    ])
  })

  it('normalizes options for nested workspace and asset commands', () => {
    expect(
      normalizeGlobalOptions([
        'node',
        'dossier',
        'workspace',
        'allow',
        'person@example.com',
        '--role',
        'admin',
        '--json',
      ]).args,
    ).toEqual([
      'node',
      'dossier',
      '--json',
      'workspace',
      'allow',
      '--role',
      'admin',
      'person@example.com',
    ])
    expect(
      normalizeGlobalOptions([
        'node',
        'dossier',
        'assets',
        'push',
        'theme.css',
        '--slug',
        'shared-theme',
      ]).args,
    ).toEqual([
      'node',
      'dossier',
      'assets',
      'push',
      '--slug',
      'shared-theme',
      'theme.css',
    ])
  })

  it('normalizes options for the nested admin purge command', () => {
    expect(
      normalizeGlobalOptions([
        'node',
        'dossier',
        'admin',
        'purge',
        '--execute',
        '--retention-days',
        '45',
        '--api-url',
        'https://dossier.example',
        '--json',
      ]).args,
    ).toEqual([
      'node',
      'dossier',
      '--api-url',
      'https://dossier.example',
      '--json',
      'admin',
      'purge',
      '--execute',
      '--retention-days',
      '45',
    ])
    expect(
      normalizeGlobalOptions([
        'node',
        'dossier',
        '--json',
        'admin',
        'purge',
        '--retention-days=14',
      ]).args,
    ).toEqual([
      'node',
      'dossier',
      '--json',
      'admin',
      'purge',
      '--retention-days=14',
    ])
    expect(
      normalizeGlobalOptions(['node', 'dossier', 'admin', 'purge']).args,
    ).toEqual(['node', 'dossier', 'admin', 'purge'])
  })

  it('does not steal a command option value that looks global', () => {
    expect(
      normalizeGlobalOptions([
        'node',
        'dossier',
        'upload',
        'plan.html',
        '--description',
        '--json',
      ]).args,
    ).toEqual([
      'node',
      'dossier',
      'upload',
      '--description',
      '--json',
      'plan.html',
    ])
  })

  it('keeps update check while moving JSON to global options', () => {
    expect(
      normalizeGlobalOptions(['node', 'dossier', 'update', '--check', '--json'])
        .args,
    ).toEqual(['node', 'dossier', '--json', 'update', '--check'])
  })

  it('allows delete and restore options after their document IDs', () => {
    expect(
      normalizeGlobalOptions([
        'node',
        'dossier',
        'delete',
        '7k2m9x1qz3ab',
        '--force',
      ]).args,
    ).toEqual(['node', 'dossier', 'delete', '--force', '7k2m9x1qz3ab'])
    expect(
      normalizeGlobalOptions([
        'node',
        'dossier',
        'restore',
        '7k2m9x1qz3ab',
        '--batch',
        'batch_1',
      ]).args,
    ).toEqual([
      'node',
      'dossier',
      'restore',
      '--batch',
      'batch_1',
      '7k2m9x1qz3ab',
    ])
  })
})

describe('JSON output', () => {
  it('escapes DEL and all C1 controls without changing decoded document text', async () => {
    const controls = Array.from({ length: 0x9f - 0x7f + 1 }, (_, index) =>
      String.fromCharCode(0x7f + index),
    ).join('')
    const text = `safe café 漢字 ${controls}\u001b]52;c;payload\u0007\n\t`
    const response = {
      ok: true,
      documentId: '7k2m9x1qz3ab',
      from: {
        versionNumber: 1,
        createdAt: '2026-09-12T00:00:00Z',
        fileSize: 0,
      },
      to: {
        versionNumber: 2,
        createdAt: '2026-09-12T00:01:00Z',
        fileSize: 100,
      },
      mode: 'html',
      hunks: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: [{ op: '+', text }],
        },
      ],
      stats: { added: 1, removed: 0 },
    }
    const fetchMock = vi.fn().mockResolvedValue(Response.json(response))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DOSSIER_API_KEY', 'test-key')
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      expect(
        await runCli([
          'node',
          'dossier',
          '--api-url',
          'https://dossier.example',
          '--json',
          'diff',
          response.documentId,
          '--from',
          '1',
          '--to',
          '2',
        ]),
      ).toBe(0)
      expect(fetchMock).toHaveBeenCalledOnce()
      const output = write.mock.calls.map(([chunk]) => String(chunk)).join('')
      expect(output).not.toMatch(/[\u007f-\u009f]/)
      for (const control of controls) {
        expect(output).toContain(
          `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`,
        )
      }
      expect(output).not.toContain('\u001b')
      expect(output).not.toContain('\u0007')
      expect(output).toContain('café 漢字')
      expect(JSON.parse(output)).toEqual(response)
    } finally {
      write.mockRestore()
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })
})
