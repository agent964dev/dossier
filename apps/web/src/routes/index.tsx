import { createFileRoute, Link } from '@tanstack/react-router'
import { Info } from 'lucide-react'
import { useState } from 'react'

import { HostName } from '../components/host-name'
import { AppHeader } from '../components/app-header'
import { Button } from '../components/ui/button'
import { signOut, startGoogleSignIn } from '../lib/auth-client'
import { homeView, type HomeView } from '../server/home'
import { isScreenFailure } from '../server/failure'

export const Route = createFileRoute('/')({
  loader: async () => {
    const view = await homeView()
    if (isScreenFailure(view)) throw new Error(view.error.message)
    return view
  },
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData?.deployment ?? 'Dossier' }],
  }),
  component: HomeScreen,
})

function HomeScreen() {
  const view = Route.useLoaderData()
  return view.me === null ? (
    <FrontPage deployment={view.deployment} />
  ) : (
    <Home view={view} me={view.me} />
  )
}

function FrontPage({ deployment }: { deployment: string }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12">
      <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-brand-300/35 bg-brand-300/10 px-2 py-0.5 font-mono text-[0.625rem] tracking-[0.16em] text-brand-200 uppercase">
        <span aria-hidden className="size-1.5 rounded-full bg-brand-300" />
        Dossier
      </span>
      <h1 className="font-clash text-[2rem] leading-[1.05] font-semibold tracking-[-0.03em] text-neutral-50 break-words">
        <HostName host={deployment} />
      </h1>
      <p className="text-neutral-400">
        Open what is shared with you, signed in with your Google account.
      </p>
      <Button asChild size="lg" className="w-full">
        <Link to="/_/sign-in">Sign in with Google</Link>
      </Button>
    </main>
  )
}

function Home({
  me,
}: {
  view: HomeView
  me: { readonly email: string; readonly name: string }
}) {
  const [busy, setBusy] = useState(false)
  const useAnotherAccount = async () => {
    setBusy(true)
    try {
      await signOut()
      await startGoogleSignIn('/')
    } catch {
      setBusy(false)
    }
  }
  return (
    <div className="min-h-dvh">
      <AppHeader email={me.email} />
      <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 pt-6 pb-16 sm:px-6">
        <h1 className="font-clash text-[1.75rem] font-semibold tracking-[-0.03em] text-neutral-50 break-words">
          Shared with me
        </h1>
        <section aria-label="Shared with me" className="flex flex-col gap-3">
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-card px-4 py-5">
            <p className="flex gap-2.5 text-[0.9375rem] leading-relaxed text-neutral-300">
              <Info
                aria-hidden
                className="mt-1 size-4 shrink-0 text-neutral-500"
              />
              <span>
                Nothing is shared with{' '}
                <span className="text-neutral-50">{me.email}</span> yet. If
                someone sent you a link, open it while signed in with this
                address.
              </span>
            </p>
            <Button
              variant="outline"
              className="w-fit"
              disabled={busy}
              onClick={useAnotherAccount}
            >
              Use another Google account
            </Button>
          </div>
        </section>
      </main>
    </div>
  )
}
