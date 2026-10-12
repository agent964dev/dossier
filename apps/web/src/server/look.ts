import { dossierError } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import { Config, LookSettings, People, type LookState } from '../core/index.ts'
import {
  backgroundHex,
  builtInPreloads,
  contrastChecks,
  headerName,
  logoUrl,
  PRESETS,
  schemeOf,
  type Look,
} from '../lib/look.ts'
import { runScreen } from './run.ts'

export interface LookView {
  readonly state: LookState
  readonly presets: typeof PRESETS
  readonly checks: ReturnType<typeof contrastChecks>
  /** The deployment's name, for the crumb. */
  readonly deployment: string
  readonly email: string
}

/** What every screen's root needs: the stylesheet, the name and the logo. */
export interface CurrentLook {
  readonly version: string
  /** The header's name: the Look's, or "Dossier". */
  readonly name: string
  /** The logo's URL, or null. */
  readonly logo: string | null
  /** The browser's chrome colour and colour scheme. */
  readonly themeColor: string
  readonly scheme: 'light' | 'dark'
  /** agent964's own faces to preload when the Look uses them. */
  readonly preload: readonly string[]
}

/** Super admins only; anyone else gets `not_found`. */
export const lookView = createServerFn({ method: 'GET' }).handler(() =>
  runScreen(
    Effect.gen(function* () {
      const people = yield* People
      const me = yield* people.superAdminOnly()
      const config = yield* Config
      const state = yield* Effect.flatMap(LookSettings, (look) =>
        look.current(),
      )
      return {
        state,
        presets: PRESETS,
        checks: contrastChecks(state.look),
        deployment: config.deploymentName,
        email: me.email,
      } satisfies LookView
    }),
  ),
)

export const currentLookVersion = createServerFn({ method: 'GET' }).handler(
  async (): Promise<CurrentLook> => {
    const state = await runScreen(
      Effect.flatMap(LookSettings, (look) => look.current()),
    )
    if ('ok' in state) throw new Error(state.error.message)
    return {
      version: state.version,
      name: headerName(state.look),
      logo: state.look.logo === null ? null : logoUrl(state.look.logo),
      themeColor: backgroundHex(state.look),
      scheme: schemeOf(state.look),
      preload: builtInPreloads(state.look),
    }
  },
)

const fileOf = (data: unknown): File => {
  const file = data instanceof FormData ? data.get('file') : null
  if (!(file instanceof File)) throw dossierError('invalid', 'Choose a file.')
  return file
}

const bytesOf = (file: File) =>
  Effect.promise(async () => new Uint8Array(await file.arrayBuffer()))

export const fetchGoogleFont = createServerFn({ method: 'POST' })
  .validator((input: { readonly family: string }) => ({
    family: String(input.family),
  }))
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(LookSettings, (look) => look.fetchGoogleFont(data.family)),
    ),
  )

/** FormData with `file` and `family`. */
export const uploadFont = createServerFn({ method: 'POST' })
  .validator((data: FormData) => ({
    file: fileOf(data),
    family: String(data.get('family') ?? ''),
  }))
  .handler(({ data }) =>
    runScreen(
      Effect.gen(function* () {
        const bytes = yield* bytesOf(data.file)
        const look = yield* LookSettings
        return yield* look.uploadFont({ family: data.family, bytes })
      }),
    ),
  )

/** FormData with `file`. */
export const uploadLogo = createServerFn({ method: 'POST' })
  .validator((data: FormData) => ({ file: fileOf(data) }))
  .handler(({ data }) =>
    runScreen(
      Effect.gen(function* () {
        const bytes = yield* bytesOf(data.file)
        const look = yield* LookSettings
        return yield* look.uploadLogo({ bytes })
      }),
    ),
  )

export const saveLook = createServerFn({ method: 'POST' })
  .validator((input: { readonly look: Look }) => ({ look: input.look }))
  .handler(({ data }) =>
    runScreen(Effect.flatMap(LookSettings, (look) => look.save(data.look))),
  )

export const resetLook = createServerFn({ method: 'POST' }).handler(() =>
  runScreen(Effect.flatMap(LookSettings, (look) => look.reset())),
)
