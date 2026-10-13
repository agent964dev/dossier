import { createFileRoute, redirect } from '@tanstack/react-router'
import { Check, Info, X } from 'lucide-react'
import { useState } from 'react'

import { HostName } from '../../components/host-name'
import { AppHeader } from '../../components/app-header'
import { Button } from '../../components/ui/button'
import { approveDevice, denyDevice, devicePrompt } from '../../server/device'
import { isScreenFailure } from '../../server/failure'

interface DeviceSearch {
  readonly user_code?: string
}

export const Route = createFileRoute('/_/device')({
  validateSearch: (search: Record<string, unknown>): DeviceSearch => ({
    user_code:
      typeof search.user_code === 'string' ? search.user_code : undefined,
  }),
  loaderDeps: ({ search }) => ({ userCode: search.user_code ?? '' }),
  loader: async ({ deps }) => {
    const prompt = await devicePrompt({ data: { userCode: deps.userCode } })
    if (isScreenFailure(prompt)) {
      if (prompt.error.code === 'sign_in_required') {
        const next = `/_/device?user_code=${encodeURIComponent(deps.userCode)}`
        throw redirect({ href: `/_/sign-in?next=${encodeURIComponent(next)}` })
      }
      if (prompt.error.code === 'device_expired')
        return { expired: true as const }
      throw new Error(prompt.error.message)
    }
    return { expired: false as const, prompt }
  },
  head: () => ({ meta: [{ title: 'Sign in a device · Dossier' }] }),
  component: DeviceScreen,
})

function DeviceScreen() {
  const data = Route.useLoaderData()
  const { user_code: userCode = '' } = Route.useSearch()
  const [state, setState] = useState<
    'ask' | 'busy' | 'allowed' | 'denied' | 'expired'
  >(data.expired ? 'expired' : 'ask')

  const decide = async (allow: boolean) => {
    setState('busy')
    const result = allow
      ? await approveDevice({ data: { userCode } })
      : await denyDevice({ data: { userCode } })
    if (isScreenFailure(result)) {
      setState('expired')
      return
    }
    setState(allow ? 'allowed' : 'denied')
  }

  return (
    <div className="min-h-dvh">
      <AppHeader email={null} />
      <main className="mx-auto flex max-w-md flex-col gap-6 px-6 pt-12 pb-16">
        {state === 'expired' ? (
          <Message>This code expired. Run dossier login again.</Message>
        ) : state === 'allowed' ? (
          <Message icon="done">
            Done. Return to the terminal: the CLI is signed in.
          </Message>
        ) : state === 'denied' ? (
          <Message icon="denied">Denied. The CLI was not signed in.</Message>
        ) : data.expired ? null : (
          <>
            <h1 className="font-clash text-[1.625rem] leading-[1.15] font-semibold tracking-[-0.03em] text-neutral-50 break-words">
              Allow ‘{data.prompt.name}’ to act as you on{' '}
              <HostName host={data.prompt.deployment} />?
            </h1>
            <p className="font-mono text-sm tracking-[0.12em] text-neutral-400">
              Code {formatCode(userCode)}
            </p>
            <div className="flex gap-2">
              <Button
                size="lg"
                disabled={state === 'busy'}
                onClick={() => decide(true)}
              >
                Allow
              </Button>
              <Button
                size="lg"
                variant="outline"
                disabled={state === 'busy'}
                onClick={() => decide(false)}
              >
                Deny
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

const formatCode = (code: string) => {
  const plain = code.replaceAll('-', '').toUpperCase()
  return plain.length === 8 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : plain
}

function Message({
  children,
  icon = 'info',
}: {
  children: React.ReactNode
  icon?: 'info' | 'done' | 'denied'
}) {
  const Icon = icon === 'done' ? Check : icon === 'denied' ? X : Info
  return (
    <p className="flex gap-2.5 rounded-xl border border-border bg-card px-4 py-4 text-[0.9375rem] text-neutral-200">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-neutral-400" />
      <span>{children}</span>
    </p>
  )
}
