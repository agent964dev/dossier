import { createFileRoute, redirect } from '@tanstack/react-router'
import { AlertTriangle, Info } from 'lucide-react'
import { useState } from 'react'

import { HostName } from '../../components/host-name'
import { PrivacyLink } from '../../components/privacy-link'
import { GoogleMark } from '../../components/google-mark'
import { Button } from '../../components/ui/button'
import { safeNext, startGoogleSignIn } from '../../lib/auth-client'
import { isScreenFailure } from '../../server/failure'
import { signInView, type SignInView } from '../../server/sign-in'

interface SignInSearch {
  readonly next?: string
  readonly error?: string
  readonly notice?: string
  readonly who?: string
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

export const Route = createFileRoute('/_/sign-in')({
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    next: text(search.next),
    error: text(search.error),
    notice: text(search.notice),
    who: text(search.who),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const view = await signInView({
      data: { error: deps.error, notice: deps.notice, who: deps.who },
    })
    if (isScreenFailure(view)) throw new Error(view.error.message)
    // Someone already signed in goes on, unless there is something to read.
    if (view.signedInAs !== null && view.notice === null) {
      throw redirect({ href: safeNext(deps.next) })
    }
    return view
  },
  // A private link redirects here, so its preview names only the deployment.
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData?.deployment ?? 'Dossier' }],
  }),
  component: SignInScreen,
})

function SignInScreen() {
  const view = Route.useLoaderData()
  const { next, error } = Route.useSearch()
  const target = safeNext(next)
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12">
      <span className="inline-flex w-fit max-w-full items-center gap-1.5 truncate rounded-md border border-brand-300/35 bg-brand-300/10 px-2 py-0.5 font-mono text-[0.625rem] tracking-[0.16em] text-brand-200 uppercase">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full bg-brand-300"
        />
        {view.deployment}
      </span>
      <h1 className="font-clash text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.03em] text-neutral-50 break-words">
        Sign in to continue to <HostName host={view.deployment} />
      </h1>
      <Notice
        view={view}
        genericError={error !== undefined && view.notice === null}
      />
      {view.notice?.kind === 'email_in_use' ? (
        <Button asChild size="lg" className="w-full">
          <a href={target}>Continue</a>
        </Button>
      ) : view.ready ? (
        <ContinueWithGoogle next={target} />
      ) : (
        <p className="flex gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5 text-neutral-300">
          <Info aria-hidden className="mt-1 size-4 shrink-0 text-neutral-500" />
          Sign-in is not set up on this deployment yet.
        </p>
      )}
      <PrivacyLink />
    </main>
  )
}

function Notice({
  view,
  genericError,
}: {
  view: SignInView
  genericError: boolean
}) {
  if (view.notice?.kind === 'email_unconfirmed') {
    return (
      <Callout>
        Another Google account already uses {view.notice.email} on{' '}
        {view.deployment}, and Google can't confirm this one still owns the
        address. Sign in with the other account, or ask an admin of your
        workspace for help.
      </Callout>
    )
  }
  if (view.notice?.kind === 'email_in_use') {
    return (
      <Callout>
        Google now gives this account the address {view.notice.email}, which
        another person already uses on {view.deployment}. You stay signed in as{' '}
        {view.signedInAs ?? 'before'}. Ask an admin of your workspace to sort
        out the two addresses.
      </Callout>
    )
  }
  if (genericError) {
    return <Callout>Sign-in did not finish. Try again.</Callout>
  }
  return null
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="flex gap-2.5 rounded-xl border border-warning-400/30 bg-warning-400/10 px-4 py-3.5 text-[0.9375rem] leading-relaxed text-warning-100"
    >
      <AlertTriangle
        aria-hidden
        className="mt-1 size-4 shrink-0 text-warning-300"
      />
      <span>{children}</span>
    </p>
  )
}

function ContinueWithGoogle({ next }: { next: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  const start = async () => {
    setState('busy')
    try {
      await startGoogleSignIn(next)
    } catch {
      setState('failed')
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <Button
        size="lg"
        className="w-full shadow-[0_8px_28px_-10px_var(--glow-cyan)]"
        disabled={state === 'busy'}
        onClick={start}
      >
        <span className="flex size-5 items-center justify-center rounded-full bg-white">
          <GoogleMark className="size-3.5" />
        </span>
        Continue with Google
      </Button>
      {state === 'failed' ? (
        <p role="alert" className="text-sm text-error-300">
          Sign-in did not start. Try again.
        </p>
      ) : null}
    </div>
  )
}
