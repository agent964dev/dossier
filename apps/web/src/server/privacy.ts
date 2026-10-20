import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import {
  Config,
  defaultPrivacyText,
  People,
  Settings,
  signInProviders,
} from '../core/index.ts'
import { runScreen } from './run.ts'

export interface PrivacyView {
  readonly deployment: string
  /** What the page shows: a super admin's text, else the generated one. */
  readonly text: string
  /** A super admin replaced the generated text. */
  readonly custom: boolean
}

/** Anyone may read it, signed in or not. */
export const privacyView = createServerFn({ method: 'GET' }).handler(() =>
  runScreen(
    Effect.gen(function* () {
      const config = yield* Config
      const current = yield* Effect.flatMap(Settings, (s) => s.current())
      return {
        deployment: config.deploymentName,
        text:
          current.privacyText ??
          defaultPrivacyText(config.deploymentName, signInProviders(config)),
        custom: current.privacyText !== null,
      } satisfies PrivacyView
    }),
  ),
)

/** Super admins only. Empty text, or null, brings the generated text back. */
export const setPrivacyText = createServerFn({ method: 'POST' })
  .validator((input: { readonly text: string | null }) => ({
    text: input.text === null ? null : String(input.text),
  }))
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(People, (people) => people.setPrivacyText(data.text)),
    ),
  )
