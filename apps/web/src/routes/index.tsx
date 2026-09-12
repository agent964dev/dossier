import { createFileRoute, redirect } from '@tanstack/react-router'
import { ArrowRight, Terminal } from 'lucide-react'
import { Atmosphere } from '../components/atmosphere'
import { BrandMark } from '../components/brand-mark'
import { CopyButton } from '../components/copy-button'
import { HealthStatus } from '../components/health-status'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card'
import { peekSession } from '../server/account'

export const Route = createFileRoute('/')({
  // Signed in already? The landing page has nothing to say — go to the work.
  loader: async () => {
    const session = await peekSession()
    if (session.signedIn) throw redirect({ to: '/dashboard' })
  },
  component: HomePage,
})

const AUTH_COMMAND = 'bunx @agent964/dossier auth login'

const STEPS = [
  {
    n: '01',
    title: 'Authenticate',
    body: 'Opens sign-in in your browser and stores a scoped key on this machine.',
  },
  {
    n: '02',
    title: 'Upload',
    body: 'One command returns a permanent link and a version number.',
  },
  {
    n: '03',
    title: 'Share',
    body: 'Hand the link to a teammate, or keep it to you and the admins.',
  },
] as const

const PROPERTIES = [
  {
    label: 'Versioned',
    body: 'Every upload adds a version. Nothing is overwritten, and any two can be compared.',
  },
  {
    label: 'Addressable',
    body: 'Each document keeps one permanent link, with its own tree of child documents.',
  },
  {
    label: 'Scoped',
    body: 'Public, team, or private — chosen per document, inherited down the tree.',
  },
  {
    label: 'Recoverable',
    body: 'Deleting archives the whole subtree, authors included. Restoring brings it back.',
  },
] as const

function HomePage() {
  return (
    <main className="relative isolate flex min-h-dvh flex-col overflow-x-hidden">
      <Atmosphere />

      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-5 py-5 sm:px-8 sm:py-6">
        <a
          href="/"
          className="group flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <BrandMark className="mark-glow size-[22px] text-brand-300" />
          <span className="font-clash text-[1.0625rem] font-semibold tracking-[-0.015em] text-neutral-50">
            dossier
          </span>
          <span className="text-micro-lg hidden border-l border-border pl-2.5 text-neutral-500 sm:inline">
            agent964
          </span>
        </a>
        <HealthStatus />
      </header>

      <section className="mx-auto w-full max-w-6xl px-5 pt-8 pb-12 sm:px-8 sm:pt-12 lg:pt-14 lg:pb-16">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12 lg:gap-14">
          <div className="min-w-0 lg:col-span-7">
            <div className="flex items-center gap-2.5">
              <Badge variant="accent">Invite only</Badge>
              <span className="text-micro-lg text-neutral-500">
                Agent964 workspace
              </span>
            </div>

            <h1 className="font-clash mt-6 text-[2.125rem] leading-[1.05] font-semibold tracking-[-0.035em] text-balance text-neutral-50 sm:text-5xl lg:text-[3.75rem]">
              Everything your agents write, filed.
            </h1>

            <p className="mt-5 max-w-xl text-base leading-body text-neutral-400 sm:text-lg">
              dossier is a private publishing workspace: an agent uploads a
              document, every version is kept, and each one gets a permanent
              link your team can open.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button asChild size="lg" className="w-full sm:w-auto">
                <a href="/sign-in">
                  Sign in
                  <ArrowRight aria-hidden />
                </a>
              </Button>
              <Button
                asChild
                variant="outline"
                size="lg"
                className="w-full sm:w-auto"
              >
                <a href="#cli">Set up the CLI</a>
              </Button>
            </div>

            <p className="text-micro-lg mt-5 text-neutral-500">
              Access by allowlist only
            </p>
          </div>

          <Card id="cli" className="min-w-0 scroll-mt-6 lg:col-span-5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Terminal className="size-4 text-complement-400" aria-hidden />
                Publish from the terminal
              </CardTitle>
              <CardAction>
                <Badge variant="muted">npm</Badge>
              </CardAction>
              <CardDescription>
                Authenticate once on a machine, then publish from any agent
                session on it.
              </CardDescription>
            </CardHeader>

            <CardContent>
              <div className="flex items-start gap-1 rounded-lg border border-border bg-neutral-950/70 p-1.5">
                <pre className="min-w-0 flex-1 px-2 py-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-neutral-200 sm:text-[0.8125rem]">
                  <code>
                    <span
                      aria-hidden
                      className="pr-1.5 text-neutral-400 select-none"
                    >
                      $
                    </span>
                    {AUTH_COMMAND}
                  </code>
                </pre>
                <CopyButton
                  value={AUTH_COMMAND}
                  label="Copy the sign-in command"
                />
              </div>

              <ol className="mt-5 grid gap-3.5">
                {STEPS.map((step) => (
                  <li key={step.n} className="flex gap-3">
                    <span
                      data-numeric
                      className="text-micro-lg mt-[5px] text-neutral-600"
                    >
                      {step.n}
                    </span>
                    <p className="text-sm leading-body text-neutral-400">
                      <span className="font-medium text-neutral-200">
                        {step.title}
                      </span>
                      <span className="text-neutral-600"> — </span>
                      {step.body}
                    </p>
                  </li>
                ))}
              </ol>
            </CardContent>

            <CardFooter className="gap-2 border-t border-border/60 pt-4">
              <span className="text-micro-lg text-neutral-400">
                Node 22+ or Bun
              </span>
              <span aria-hidden className="text-neutral-700">
                ·
              </span>
              <span className="text-micro-lg text-neutral-400">
                Nothing to install
              </span>
            </CardFooter>
          </Card>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 pb-14 sm:px-8 lg:pb-20">
        <h2 className="text-micro-lg border-t border-border pt-6 text-neutral-500">
          What a document gets
        </h2>
        <dl className="mt-6 grid gap-x-10 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
          {PROPERTIES.map((property) => (
            <div key={property.label} className="border-l border-border pl-4">
              <dt className="text-micro-lg text-neutral-200">
                {property.label}
              </dt>
              <dd className="mt-2 text-sm leading-body text-neutral-500">
                {property.body}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="mt-auto border-t border-border/70">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1.5 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p className="text-micro-lg text-neutral-500">dossier.agent964.com</p>
          <p className="text-micro-lg text-neutral-500">
            Cloudflare Workers · D1 · R2
          </p>
        </div>
      </footer>
    </main>
  )
}
