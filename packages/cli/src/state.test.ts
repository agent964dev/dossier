import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  mutateCredentials,
  readCredentials,
  statePaths,
  writeCredentials,
} from './lib/state.js'

const temporaryHomes: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryHomes
      .splice(0)
      .map((home) => rm(home, { recursive: true, force: true })),
  )
})

describe('credential state', () => {
  it('serializes concurrent updates and removals across origins', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dossier-credentials-'))
    temporaryHomes.push(home)
    const paths = statePaths({ DOSSIER_HOME: home })
    await writeCredentials(
      {
        'https://keep.example': 'ds_keep',
        'https://remove.example': 'ds_remove',
      },
      paths,
    )

    let signalFirstMutationStarted!: () => void
    const firstMutationStarted = new Promise<void>((resolve) => {
      signalFirstMutationStarted = resolve
    })
    let releaseFirstMutation!: () => void
    const firstMutationMayFinish = new Promise<void>((resolve) => {
      releaseFirstMutation = resolve
    })

    const first = mutateCredentials(async (credentials) => {
      credentials['https://first.example'] = 'ds_first'
      signalFirstMutationStarted()
      await firstMutationMayFinish
    }, paths)

    await firstMutationStarted
    const second = mutateCredentials((credentials) => {
      delete credentials['https://remove.example']
      credentials['https://second.example'] = 'ds_second'
    }, paths)

    releaseFirstMutation()
    await Promise.all([first, second])

    expect(await readCredentials(paths)).toEqual({
      'https://keep.example': 'ds_keep',
      'https://first.example': 'ds_first',
      'https://second.example': 'ds_second',
    })
  })
})
