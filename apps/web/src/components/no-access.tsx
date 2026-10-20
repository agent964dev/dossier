import { Lock } from 'lucide-react'
import { useState } from 'react'

import { signOut, startGoogleSignIn } from '../lib/auth-client'
import { AppHeader } from './app-header'
import { Button } from './ui/button'

/**
 * The one page for a link the person cannot open, whether it exists or not:
 * it names who is signed in and offers another account, nothing more.
 */
export function NoAccessScreen({ email }: { email: string | null }) {
  const [busy, setBusy] = useState(false)
  const useAnotherAccount = async () => {
    setBusy(true)
    try {
      await signOut()
      await startGoogleSignIn(
        `${window.location.pathname}${window.location.search}`,
      )
    } catch {
      setBusy(false)
    }
  }
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader email={email} />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-6 pt-10 pb-24">
        <span
          aria-hidden
          className="flex size-8 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-300"
        >
          <Lock className="size-4" />
        </span>
        <h1 className="font-clash text-[1.625rem] leading-tight font-semibold tracking-[-0.03em] text-neutral-50">
          You can&apos;t open this page.
        </h1>
        {email === null ? null : (
          <p className="text-[0.9375rem] leading-relaxed text-neutral-300">
            You&apos;re signed in as{' '}
            <span className="break-all text-neutral-50">{email}</span>.
          </p>
        )}
        <p className="text-[0.9375rem] leading-relaxed text-neutral-300">
          If someone sent you this link, ask them to share it with this address.
        </p>
        <Button
          size="lg"
          className="mt-2 w-full"
          disabled={busy}
          onClick={useAnotherAccount}
        >
          Use another account
        </Button>
      </main>
    </div>
  )
}
