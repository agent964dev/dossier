import type { AgentKeyId } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import { CurrentCaller, SignIn, type AgentKeyView } from '../core/index.ts'
import { runScreen } from './run.ts'

export interface AccountView {
  readonly email: string
  readonly name: string
  readonly keys: readonly AgentKeyView[]
}

export const accountView = createServerFn({ method: 'GET' }).handler(() =>
  runScreen(
    Effect.gen(function* () {
      const signIn = yield* SignIn
      const keys = yield* signIn.keys()
      const { person } = yield* CurrentCaller
      return {
        email: person?.email ?? '',
        name: person?.name ?? '',
        keys,
      } satisfies AccountView
    }),
  ),
)

export const createKey = createServerFn({ method: 'POST' })
  .validator((input: { readonly name: string }) => ({
    name: String(input.name),
  }))
  .handler(({ data }) =>
    runScreen(Effect.flatMap(SignIn, (signIn) => signIn.createKey(data))),
  )

export const revokeKey = createServerFn({ method: 'POST' })
  .validator((input: { readonly id: string }) => ({ id: String(input.id) }))
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(SignIn, (signIn) =>
        signIn.revokeKey(data.id as AgentKeyId),
      ),
    ),
  )

export const signOutEverywhere = createServerFn({ method: 'POST' }).handler(
  () =>
    runScreen(Effect.flatMap(SignIn, (signIn) => signIn.signOutEverywhere())),
)
