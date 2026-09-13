import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireStateLock,
  fileMode,
  readDocuments,
  readJsonFile,
  mutateDocuments,
  statePaths,
  writeJsonAtomic,
} from './state.js'

const homes: string[] = []

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dossier-state-'))
  homes.push(home)
  return home
}

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  )
})

describe('CLI state', () => {
  it('uses DOSSIER_HOME and atomically writes private JSON', async () => {
    const home = await temporaryHome()
    const paths = statePaths({ DOSSIER_HOME: home })

    await writeJsonAtomic(paths.credentials, {
      'https://example.test': 'ds_secret',
    })

    expect(JSON.parse(await readFile(paths.credentials, 'utf8'))).toEqual({
      'https://example.test': 'ds_secret',
    })
    expect(await fileMode(home)).toBe(0o700)
    expect(await fileMode(paths.credentials)).toBe(0o600)
    expect(
      (await readdir(home)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([])
    expect(
      (await readdir(home)).filter((name) => name.includes('lock')),
    ).toEqual([])
  })

  it('serializes writers with a lock file and times out actionably', async () => {
    const home = await temporaryHome()
    const release = await acquireStateLock(home)
    await expect(
      acquireStateLock(home, { timeoutMs: 30, retryMs: 5 }),
    ).rejects.toThrow(/state is locked by another dossier process/)
    await release()

    const releaseAgain = await acquireStateLock(home, { timeoutMs: 30 })
    await releaseAgain()
  })

  it('reports corrupted JSON with repair guidance', async () => {
    const home = await temporaryHome()
    const path = join(home, 'config.json')
    await writeFile(path, '{broken', 'utf8')

    await expect(readJsonFile(path, {})).rejects.toThrow(
      /corrupted JSON.*repair it or remove the file/,
    )
  })

  it('stores mappings by origin, account, and absolute path', async () => {
    const home = await temporaryHome()
    const paths = statePaths({ DOSSIER_HOME: home })
    const absolutePath = join(home, 'plan.html')
    await mutateDocuments((documents) => {
      documents['https://dossier.example'] = {
        acct_test: {
          [absolutePath]: {
            documentId: '7k2m9x1qz3ab',
            url: 'https://dossier.example/d/7k2m9x1qz3ab',
            rawUrl: 'https://dossier.example/d/7k2m9x1qz3ab/raw',
            updatedAt: '2026-09-12T00:00:00.000Z',
          },
        },
      }
    }, paths)

    expect(await readDocuments(paths)).toMatchObject({
      'https://dossier.example': {
        acct_test: {
          [absolutePath]: { documentId: '7k2m9x1qz3ab' },
        },
      },
    })
    expect(await fileMode(paths.documents)).toBe(0o600)
  })
})
