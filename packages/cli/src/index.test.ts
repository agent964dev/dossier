import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { detectCommand, normalizeGlobalOptions, runCli } from './index.js'

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

  it('walks command trees at depth two and three', () => {
    expect(detectCommand(['state', 'get', '7k2m9x1qz3ab'])).toBe('state get')
    expect(detectCommand(['state', 'set', '7k2m9x1qz3ab'])).toBe('state set')
    expect(
      detectCommand(['state', 'link', 'create', '7k2m9x1qz3ab'], {
        state: { link: { create: true } },
      }),
    ).toBe('state link create')
    expect(
      normalizeGlobalOptions([
        'node',
        'dossier',
        'state',
        'get',
        '7k2m9x1qz3ab',
        '--json',
      ]).args,
    ).toEqual(['node', 'dossier', '--json', 'state', 'get', '7k2m9x1qz3ab'])
    expect(
      normalizeGlobalOptions(
        [
          'node',
          'dossier',
          'state',
          'link',
          'create',
          '7k2m9x1qz3ab',
          '--expires-in',
          '24h',
          '--json',
        ],
        { state: { link: { create: true } } },
        { 'state link create': new Set(['--expires-in']) },
      ).args,
    ).toEqual([
      'node',
      'dossier',
      '--json',
      'state',
      'link',
      'create',
      '--expires-in',
      '24h',
      '7k2m9x1qz3ab',
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

describe('state set', () => {
  const snapshot = {
    documentId: 'stateset0001',
    version: 2,
    revision: 5,
    updatedAt: '2026-09-14T08:00:00Z',
    data: { objective: 'Before', approved: false },
    fields: {
      objective: { value: 'Before', revision: 4, type: 'text' },
      approved: { value: false, revision: 0, type: 'checkbox' },
    },
  }

  async function dataFile(value: unknown): Promise<{
    readonly directory: string
    readonly file: string
  }> {
    const directory = await mkdtemp(join(tmpdir(), 'dossier-state-unit-'))
    const file = join(directory, 'values.json')
    await writeFile(file, JSON.stringify(value), 'utf8')
    return { directory, file }
  }

  function requestFrom(input: string | URL | Request, init?: RequestInit) {
    return input instanceof Request ? input : new Request(input, init)
  }

  it('reads first and uses each field revision as its baseline', async () => {
    const fixture = await dataFile({ objective: 'After', approved: true })
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = requestFrom(input, init)
        const url = new URL(request.url)
        const body =
          request.method === 'PUT' ? await request.clone().json() : undefined
        calls.push({ method: request.method, path: url.pathname, body })
        if (url.pathname === '/api/healthz') {
          return Response.json({
            ok: true,
            service: 'dossier',
            version: '0.0.0',
            features: ['state'],
          })
        }
        if (request.method === 'GET') return Response.json(snapshot)
        return Response.json({
          ...snapshot,
          revision: 6,
          updatedAt: '2026-09-14T08:01:00Z',
        })
      },
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DOSSIER_API_KEY', 'test-key')
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const exitCode = await runCli([
        'node',
        'dossier',
        'state',
        'set',
        snapshot.documentId,
        '--data',
        fixture.file,
        '--api-url',
        'https://state-baseline.example',
      ])
      expect(exitCode).toBe(0)
      expect(calls).toEqual([
        { method: 'GET', path: '/api/healthz', body: undefined },
        {
          method: 'GET',
          path: `/api/documents/${snapshot.documentId}/state`,
          body: undefined,
        },
        {
          method: 'PUT',
          path: `/api/documents/${snapshot.documentId}/state`,
          body: {
            changes: [
              { name: 'objective', value: 'After', base: 4 },
              { name: 'approved', value: true, base: 0 },
            ],
          },
        },
      ])
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('retries a version change once with the original field bases', async () => {
    const fixture = await dataFile({ objective: 'After' })
    const payloads: unknown[] = []
    let setAttempts = 0
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = requestFrom(input, init)
        const url = new URL(request.url)
        if (url.pathname === '/api/healthz') {
          return Response.json({
            ok: true,
            service: 'dossier',
            version: '0.0.0',
            features: ['state'],
          })
        }
        if (request.method === 'GET') return Response.json(snapshot)
        payloads.push(await request.clone().json())
        setAttempts += 1
        if (setAttempts === 1) {
          return Response.json(
            {
              ok: false,
              code: 'state_version_changed',
              message: 'The current document version changed.',
              details: { currentVersion: 3 },
            },
            { status: 409 },
          )
        }
        return Response.json({
          ...snapshot,
          version: 3,
          revision: 6,
          updatedAt: '2026-09-14T08:01:00Z',
        })
      },
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DOSSIER_API_KEY', 'test-key')
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const exitCode = await runCli([
        'node',
        'dossier',
        '--api-url',
        'https://state-retry.example',
        'state',
        'set',
        snapshot.documentId,
        '--data',
        fixture.file,
      ])
      expect(exitCode).toBe(0)
      expect(payloads).toEqual([
        { changes: [{ name: 'objective', value: 'After', base: 4 }] },
        { changes: [{ name: 'objective', value: 'After', base: 4 }] },
      ])
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
      await rm(fixture.directory, { recursive: true, force: true })
    }
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
