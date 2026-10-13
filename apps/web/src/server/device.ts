import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import { SignIn } from '../core/index.ts'
import { runScreen } from './run.ts'

const userCodeOf = (input: { readonly userCode: string }) => ({
  userCode: String(input.userCode).slice(0, 32),
})

export const devicePrompt = createServerFn({ method: 'GET' })
  .validator(userCodeOf)
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(SignIn, (signIn) => signIn.devicePrompt(data.userCode)),
    ),
  )

export const approveDevice = createServerFn({ method: 'POST' })
  .validator(userCodeOf)
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(SignIn, (signIn) => signIn.approveDevice(data.userCode)),
    ),
  )

export const denyDevice = createServerFn({ method: 'POST' })
  .validator(userCodeOf)
  .handler(({ data }) =>
    runScreen(
      Effect.flatMap(SignIn, (signIn) => signIn.denyDevice(data.userCode)),
    ),
  )
