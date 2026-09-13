import { createFileRoute, redirect } from '@tanstack/react-router'
import { ArrowRight, ShieldCheck } from 'lucide-react'

import { Atmosphere } from '../components/atmosphere'
import { BrandMark } from '../components/brand-mark'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { peekSession } from '../server/account'

/** Same rule as the server: only same-site relative paths survive. */
function safeNext(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '/dashboard'
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  ) {
    return '/dashboard'
  }
  return value
}

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === 'string' ? { next: safeNext(search.next) } : {},
  loaderDeps: ({ search }) => ({ next: safeNext(search.next) }),
  loader: async ({ deps }) => {
    const session = await peekSession()
    if (session.signedIn) throw redirect({ href: deps.next })
    return { next: deps.next }
  },
  head: () => ({ meta: [{ title: 'Sign in — dossier' }] }),
  component: SignInPage,
})

const FACTS = [
  'Your verified email is matched against the allowlist on every sign-in.',
  'No entry, no account — nothing is created for an address an admin has not allowed.',
  'dossier reads your name and picture only to label the documents you publish.',
] as const

function SignInPage() {
  const { next } = Route.useLoaderData()
  const href = `/auth/sign-in?next=${encodeURIComponent(next)}`

  return (
    <main className="relative isolate flex min-h-dvh flex-col overflow-x-hidden">
      <Atmosphere />

      <header className="mx-auto w-full max-w-6xl px-5 py-5 sm:px-8 sm:py-6">
        <a
          href="/"
          className="group flex w-fit items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <BrandMark className="mark-glow size-[22px] text-brand-300" />
          <span className="font-clash text-[1.0625rem] font-semibold tracking-[-0.015em] text-neutral-50">
            dossier
          </span>
        </a>
      </header>

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 pb-16 sm:px-8">
        <Badge variant="accent" className="mb-5">
          <ShieldCheck aria-hidden />
          Invite only
        </Badge>

        <h1 className="font-clash text-[2rem] leading-[1.06] font-semibold tracking-[-0.035em] text-balance text-neutral-50 sm:text-[2.5rem]">
          Sign in to dossier
        </h1>
        <p className="mt-4 text-base leading-body text-neutral-400">
          dossier uses shoo for sign-in, so there is no password to keep. You
          will be asked to approve sharing your email once.
        </p>

        <Button asChild size="lg" className="mt-7 w-full">
          <a href={href}>
            Continue with shoo
            <ArrowRight aria-hidden />
          </a>
        </Button>

        <ul className="mt-8 grid gap-3 border-t border-border pt-6">
          {FACTS.map((fact) => (
            <li
              key={fact}
              className="flex gap-2.5 text-sm leading-body text-neutral-500"
            >
              <span
                aria-hidden
                className="mt-[9px] size-1 shrink-0 rounded-full bg-brand-300/70"
              />
              {fact}
            </li>
          ))}
        </ul>

        <p className="text-micro-lg mt-8 text-neutral-600">
          Need access? Ask a workspace admin
        </p>
      </div>
    </main>
  )
}
