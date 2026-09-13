import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  compareSemver,
  detectInstall,
  fetchLatestVersion,
  parseSemver,
  runUpdate,
  type DetectInstallOptions,
  type UpdateExecFile,
} from './update.js'

function installOptions(
  argv1RealPath: string,
  overrides: Partial<DetectInstallOptions> = {},
): DetectInstallOptions {
  return {
    argv1RealPath,
    platform: 'linux',
    npmRootGlobal: '/opt/npm/lib/node_modules',
    bunGlobalDir: '/home/test/.bun/install/global',
    pnpmRootGlobal: '/opt/pnpm/global/node_modules',
    yarnGlobalDir: '/home/test/.config/yarn/global',
    home: '/home/test',
    ...overrides,
  }
}

function versionFetch(version: string): typeof globalThis.fetch {
  return vi.fn(async () =>
    Response.json({ version }),
  ) as unknown as typeof globalThis.fetch
}

function writeInstalledPackage(directory: string, version: string): void {
  mkdirSync(join(directory, 'dist'), { recursive: true })
  writeFileSync(join(directory, 'dist', 'index.js'), '')
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: '@agent964/dossier', version }),
  )
}

describe('semantic versions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.2.0', '1.10.0', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.0.0-alpha', '1.0.0', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-alpha.beta', '1.0.0-beta', -1],
    ['1.0.0-beta', '1.0.0-beta.2', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0+build.1', '1.0.0+build.2', 0],
  ])('compares %s with %s', (left, right, expected) => {
    expect(compareSemver(left, right)).toBe(expected)
    expect(compareSemver(right, left)).toBe(expected === 0 ? 0 : -expected)
  })

  it('parses valid versions and rejects invalid versions', () => {
    expect(parseSemver('2.3.4-rc.1+build.7')).toEqual({
      major: 2,
      minor: 3,
      patch: 4,
      prerelease: ['rc', '1'],
      build: ['build', '7'],
    })
    expect(parseSemver('01.2.3')).toBeNull()
    expect(parseSemver('1.2')).toBeNull()
    expect(() => compareSemver('latest', '1.0.0')).toThrow(
      'invalid semantic version',
    )
  })
})

describe('install detection', () => {
  it.each([
    [
      'npm',
      '/opt/npm/lib/node_modules/@agent964/dossier/dist/index.js',
      ['npm', ['install', '-g', '@agent964/dossier@latest']],
    ],
    [
      'bun',
      '/home/test/.bun/install/global/node_modules/' +
        '@agent964/dossier/dist/index.js',
      ['bun', ['add', '-g', '@agent964/dossier@latest']],
    ],
    [
      'pnpm',
      '/opt/pnpm/global/node_modules/@agent964/dossier/dist/index.js',
      ['pnpm', ['add', '-g', '@agent964/dossier@latest']],
    ],
    [
      'yarn',
      '/home/test/.config/yarn/global/node_modules/' +
        '@agent964/dossier/dist/index.js',
      ['yarn', ['global', 'add', '@agent964/dossier@latest']],
    ],
    [
      'npx',
      '/home/test/.npm/_npx/123/node_modules/@agent964/dossier/dist/index.js',
      undefined,
    ],
    [
      'bunx',
      '/home/test/.bun/install/cache/@agent964/dossier/dist/index.js',
      undefined,
    ],
    ['checkout', '/work/dossier/packages/cli/dist/index.js', undefined],
    ['unknown', '/usr/local/bin/dossier-real', undefined],
  ])('detects %s installations', (method, path, upgradeCommand) => {
    expect(detectInstall(installOptions(path))).toEqual({
      method,
      ...(upgradeCommand === undefined ? {} : { upgradeCommand }),
    })
  })

  it('uses the home directory for Bun when no root is supplied', () => {
    expect(
      detectInstall({
        ...installOptions(
          '/home/test/.bun/install/global/node_modules/' +
            '@agent964/dossier/dist/index.js',
        ),
        bunGlobalDir: undefined,
      }),
    ).toMatchObject({ method: 'bun' })
  })

  it('compares Windows paths case-insensitively', () => {
    expect(
      detectInstall({
        ...installOptions(
          'C:\\NPM\\node_modules\\@agent964\\dossier\\dist\\index.js',
        ),
        platform: 'win32',
        npmRootGlobal: 'c:\\npm\\node_modules',
        home: 'C:\\Users\\test',
      }),
    ).toMatchObject({ method: 'npm' })
  })
})

describe('latest version fetch', () => {
  it('requests the latest npm metadata as JSON', async () => {
    const fetchMock = versionFetch('0.2.0')
    await expect(
      fetchLatestVersion({
        registryUrl: 'https://registry.example/',
        fetch: fetchMock,
      }),
    ).resolves.toBe('0.2.0')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.example/@agent964%2Fdossier/latest',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it('times out across the request and body deadline', async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    ) as unknown as typeof globalThis.fetch
    await expect(
      fetchLatestVersion({
        registryUrl: 'https://registry.example',
        fetch: fetchMock,
        timeoutMs: 5,
      }),
    ).rejects.toThrow('timed out after 5ms')
  })

  it('rejects registry errors and malformed metadata', async () => {
    const notFound = vi.fn(
      async () => new Response('', { status: 404 }),
    ) as unknown as typeof globalThis.fetch
    await expect(
      fetchLatestVersion({
        registryUrl: 'https://registry.example',
        fetch: notFound,
      }),
    ).rejects.toThrow('HTTP 404')

    await expect(
      fetchLatestVersion({
        registryUrl: 'https://registry.example',
        fetch: versionFetch('not-semver'),
      }),
    ).rejects.toThrow('malformed latest version')

    const malformed = vi.fn(
      async () => new Response('{', { status: 200 }),
    ) as unknown as typeof globalThis.fetch
    await expect(
      fetchLatestVersion({
        registryUrl: 'https://registry.example',
        fetch: malformed,
      }),
    ).rejects.toThrow('malformed JSON')
  })
})

describe('update orchestration', () => {
  it('checks without invoking the installer', async () => {
    const calls: Array<[string, readonly string[]]> = []
    const execFile: UpdateExecFile = (file, args) => {
      calls.push([file, args])
      return Buffer.alloc(0)
    }
    const result = await runUpdate({
      ...installOptions(
        '/opt/npm/lib/node_modules/@agent964/dossier/dist/index.js',
      ),
      currentVersion: '0.1.0',
      check: true,
      json: false,
      registryUrl: 'https://registry.example',
      fetch: versionFetch('0.2.0'),
      execFile,
    })
    expect(result).toEqual({
      ok: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      installMethod: 'npm',
      updateAvailable: true,
      checked: true,
      updated: false,
    })
    expect(calls).toEqual([])
  })

  it('installs with fixed arguments and reports the installed version', async () => {
    const calls: Array<{
      file: string
      args: readonly string[]
      options: unknown
    }> = []
    const statuses: string[] = []
    const execFile: UpdateExecFile = (file, args, options) => {
      calls.push({ file, args, options })
      return Buffer.alloc(0)
    }
    const result = await runUpdate({
      ...installOptions(
        '/opt/npm/lib/node_modules/@agent964/dossier/dist/index.js',
      ),
      currentVersion: '0.1.0',
      check: false,
      json: true,
      registryUrl: 'https://registry.example',
      fetch: versionFetch('0.2.0'),
      execFile,
      onStatus: (message) => statuses.push(message),
      readInstalledVersion: () => '0.2.0',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      file: 'npm',
      args: ['install', '-g', '@agent964/dossier@0.2.0'],
    })
    expect(calls[0]?.options).toMatchObject({
      stdio: ['ignore', process.stderr, 'inherit'],
    })
    expect(statuses).toEqual([
      'Updating dossier 0.1.0 → 0.2.0 with npm…',
      'Updated dossier to 0.2.0.',
    ])
    expect(result).toMatchObject({
      latestVersion: '0.2.0',
      updateAvailable: true,
      checked: false,
      updated: true,
    })
  })

  it('re-resolves a versioned pnpm package after relinking', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dossier-pnpm-update-'))
    try {
      const pnpmRoot = join(root, 'global', '5', 'node_modules')
      const oldPackage = join(
        pnpmRoot,
        '.pnpm',
        '@agent964+dossier@0.2.0',
        'node_modules',
        '@agent964',
        'dossier',
      )
      const newPackage = join(
        pnpmRoot,
        '.pnpm',
        '@agent964+dossier@0.3.0',
        'node_modules',
        '@agent964',
        'dossier',
      )
      const stablePackage = join(pnpmRoot, '@agent964', 'dossier')
      writeInstalledPackage(oldPackage, '0.2.0')
      writeInstalledPackage(newPackage, '0.3.0')
      mkdirSync(join(pnpmRoot, '@agent964'), { recursive: true })
      symlinkSync(oldPackage, stablePackage, 'dir')
      const stableEntry = join(stablePackage, 'dist', 'index.js')
      const oldRealPath = realpathSync(stableEntry)
      const calls: Array<[string, readonly string[]]> = []
      const execFile: UpdateExecFile = (file, args) => {
        calls.push([file, args])
        rmSync(stablePackage)
        symlinkSync(newPackage, stablePackage, 'dir')
        return Buffer.alloc(0)
      }

      const result = await runUpdate({
        ...installOptions(oldRealPath, { pnpmRootGlobal: pnpmRoot }),
        argv1Path: stableEntry,
        currentVersion: '0.2.0',
        check: false,
        json: false,
        registryUrl: 'https://registry.example',
        fetch: versionFetch('0.3.0'),
        execFile,
      })

      expect(calls).toEqual([
        ['pnpm', ['add', '-g', '@agent964/dossier@0.3.0']],
      ])
      expect(result).toMatchObject({
        latestVersion: '0.3.0',
        installMethod: 'pnpm',
        updated: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('prints the fixed command when installation lacks permission', async () => {
    const denied = Object.assign(new Error('spawn EACCES'), {
      code: 'EACCES',
    })
    const execFile: UpdateExecFile = () => {
      throw denied
    }
    await expect(
      runUpdate({
        ...installOptions(
          '/opt/npm/lib/node_modules/@agent964/dossier/dist/index.js',
        ),
        currentVersion: '0.1.0',
        check: false,
        json: false,
        registryUrl: 'https://registry.example',
        fetch: versionFetch('0.2.0'),
        execFile,
      }),
    ).rejects.toThrow(
      'rerun `npm install -g @agent964/dossier@0.2.0` with elevated rights',
    )
  })

  it('includes the exact manual command for child failures', async () => {
    const failed = Object.assign(new Error('Command failed'), { status: 1 })
    const execFile: UpdateExecFile = () => {
      throw failed
    }
    await expect(
      runUpdate({
        ...installOptions(
          '/opt/npm/lib/node_modules/@agent964/dossier/dist/index.js',
        ),
        currentVersion: '0.1.0',
        check: false,
        json: true,
        registryUrl: 'https://registry.example',
        fetch: versionFetch('0.2.0'),
        execFile,
      }),
    ).rejects.toThrow(
      'Run `npm install -g @agent964/dossier@0.2.0` manually; ' +
        'if it reports a permission error, rerun it with elevated rights',
    )
  })

  it('refuses automatic updates on Windows', async () => {
    const execFile = vi.fn<UpdateExecFile>(() => Buffer.alloc(0))
    await expect(
      runUpdate({
        ...installOptions(
          'C:\\npm\\node_modules\\@agent964\\dossier\\dist\\index.js',
          {
            platform: 'win32',
            npmRootGlobal: 'C:\\npm\\node_modules',
          },
        ),
        currentVersion: '0.1.0',
        check: false,
        json: false,
        registryUrl: 'https://registry.example',
        fetch: versionFetch('0.2.0'),
        execFile,
      }),
    ).rejects.toThrow('automatic updates are not supported on Windows')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('does not downgrade a version ahead of npm', async () => {
    const execFile = vi.fn<UpdateExecFile>(() => Buffer.alloc(0))
    const result = await runUpdate({
      ...installOptions('/work/dossier/packages/cli/dist/index.js'),
      currentVersion: '0.2.0',
      check: false,
      json: false,
      registryUrl: 'https://registry.example',
      fetch: versionFetch('0.1.0'),
      execFile,
    })
    expect(result).toMatchObject({
      installMethod: 'checkout',
      updateAvailable: false,
      updated: false,
    })
    expect(execFile).not.toHaveBeenCalled()
  })
})
