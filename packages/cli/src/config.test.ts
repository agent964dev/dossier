import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  defaultConfigPath,
  emptyConfig,
  readConfig,
  updateConfig,
} from './config.ts'
import { CliProblem } from './render.ts'

let dir = ''
let path = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dossier-config-'))
  path = join(dir, 'dossier', 'config.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const withKey = (key: string) => (config: typeof emptyConfig) => ({
  ...config,
  default: 'dossier.acme.com',
  deployments: {
    ...config.deployments,
    'dossier.acme.com': {
      key,
      keyName: 'cli on m4',
      person: 'sara@acme.com',
      savedAt: '2026-10-11T00:00:00.000Z',
    },
  },
})

describe('the config file', () => {
  it('lives under XDG_CONFIG_HOME, else ~/.config', () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: '/x' }, '/home/sara')).toBe(
      '/x/dossier/config.json',
    )
    expect(defaultConfigPath({}, '/home/sara')).toBe(
      '/home/sara/.config/dossier/config.json',
    )
  })

  it('reads as empty before the first login', async () => {
    expect(await readConfig(path)).toEqual(emptyConfig)
  })

  it('is written with mode 0600 in a 0700 directory', async () => {
    await updateConfig(path, withKey('dsk_one'))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
    expect((await readConfig(path)).deployments['dossier.acme.com']?.key).toBe(
      'dsk_one',
    )
  })

  it('waits for the lock and fails when another process keeps it', async () => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(`${path}.lock`, '1\n')

    const failure = await updateConfig(path, withKey('dsk_one'), {
      timeoutMs: 100,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CliProblem)
    expect((failure as CliProblem).fix).toContain(`${path}.lock`)
    await expect(readFile(path)).rejects.toThrow()
  })

  it('serialises concurrent changes', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        updateConfig(path, (config) => ({
          ...config,
          deployments: {
            ...config.deployments,
            [`d${n}.example.com`]: {
              key: `dsk_${n}`,
              keyName: 'k',
              person: 'p',
              savedAt: '',
            },
          },
        })),
      ),
    )
    expect(Object.keys((await readConfig(path)).deployments)).toHaveLength(8)
  })

  it('refuses a corrupted file with a fix', async () => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{ not json')
    await expect(readConfig(path)).rejects.toMatchObject({
      exit: 1,
      fix: expect.stringContaining('dossier login'),
    })
  })
})
