import { Link } from '@tanstack/react-router'
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BellRing,
  FileDown,
  KeyRound,
  MessageSquareText,
  Search,
  Sigma,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { Route as Root } from '../routes/__root'
import { HostName } from './host-name'
import {
  CompanionFigure,
  FormsFigure,
  HeroFigure,
  HistoryFigure,
  KitFigure,
  SharingFigure,
} from './landing-art'
import { Button } from './ui/button'

/** Dossier's source, for people who run their own deployment. */
const SOURCE = 'https://github.com/agent964dev/dossier'

/**
 * The front page a visitor sees: what Dossier does, and the way in. It wears
 * the deployment's Look (name, logo, palette and fonts); the product is
 * named Dossier on every deployment.
 */
export function LandingPage({ deployment }: { deployment: string }) {
  return (
    <div className="min-h-dvh overflow-x-clip">
      <Header />
      <main>
        <Hero deployment={deployment} />
        <HowItWorks />
        <Feature
          id="kit"
          kicker="01 · The kit"
          title="Each page carries only its own content."
          figure={<KitFigure />}
        >
          <p>
            Put a <Code>_theme.css</Code>, a <Code>_layout.html</Code> and a{' '}
            <Code>_components/</Code> folder anywhere in a tree, and every page
            below uses them; the closest one wins. Dossier composes the page
            when it is opened, so there is no build step.
          </p>
          <p>
            Agents write only what is new. One mockup measured at 562 KB carried
            29 KB of its own, and the rest was a copied design system. In a tree
            with a kit, that page is the 29 KB.
          </p>
        </Feature>
        <Feature
          id="forms"
          kicker="02 · Forms that remember"
          title="Each person's answers stay on the server."
          figure={<FormsFigure />}
          flip
        >
          <p>
            A plain <Code>{'<form method="post">'}</Code> saves one file for
            each person who sends it. Unsent edits wait in the browser as a
            draft. Sent answers come back on any device the person signs in
            from, and they can change or withdraw them.
          </p>
          <p>
            Pages read and watch that data live through a small page client, so
            a results page updates as answers arrive.
          </p>
        </Feature>
        <Feature
          id="sharing"
          kicker="03 · Sharing"
          title="Share any folder or page with anyone by email."
          figure={<SharingFigure />}
        >
          <p>
            Give a person, a team, the whole workspace or anyone the role to
            read, respond or write. A share on a folder covers everything in it,
            and roles add up across shares.
          </p>
          <p>
            A public page opens without signing in; answering its forms still
            asks them to sign in. A guest sees only what is shared with them.
          </p>
        </Feature>
        <Feature
          id="companions"
          kicker="04 · Companions"
          title="Agents read the companion, not the HTML."
          figure={<CompanionFigure />}
          flip
        >
          <p>
            Beside <Code>questions.html</Code>, a <Code>questions.md</Code>{' '}
            tells agents what the page is for. <Code>dossier read</Code>, or the
            page's link asked with an agent key, returns it, or Markdown made
            from the page when there is none.
          </p>
          <p>
            It ends with where the page's answers and comments are, so an agent
            joining cold learns what a page says and what people did in one
            read. <Code>dossier watch --next</Code> waits for the next answer.
          </p>
        </Feature>
        <Feature
          id="history"
          kicker="05 · History"
          title="Every push is one change you can take back."
          figure={<HistoryFigure />}
        >
          <p>
            A push lands whole or not at all, with its message. People who can
            write see each page's history, compare any two pushes, and restore a
            file or a whole folder to how it was.
          </p>
          <p>
            Deleted files stay restorable for the deployment's retention period,
            30 days unless it sets another.
          </p>
        </Feature>
        <AlsoInEveryTree />
        <SelfHost deployment={deployment} />
        <Closing />
      </main>
      <Footer deployment={deployment} />
    </div>
  )
}

/** The way in: the one solid button of its view. */
function SignInButton() {
  return (
    <Button
      asChild
      size="lg"
      className="h-12 px-5 text-[0.9375rem] shadow-[0_10px_32px_-12px_var(--glow-cyan)]"
    >
      <Link to="/_/sign-in">
        Sign in
        <ArrowRight />
      </Link>
    </Button>
  )
}

function Kicker({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[0.6875rem] tracking-[0.2em] text-brand-200 uppercase">
      {children}
    </p>
  )
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md border border-border bg-neutral-900/70 px-1.5 py-0.5 font-mono text-[0.85em] break-words text-brand-100">
      {children}
    </code>
  )
}

const NAV_LINK =
  'rounded-lg px-2.5 py-1.5 text-sm text-neutral-300 outline-none transition-colors duration-200 ease-agent hover:text-neutral-50 focus-visible:ring-[3px] focus-visible:ring-ring/50'

function Header() {
  const look = Root.useLoaderData() as
    | { readonly name: string; readonly logo: string | null }
    | undefined
  const { name, logo } = look ?? { name: 'Dossier', logo: null }
  return (
    <header className="sticky top-0 z-20 px-3 pt-3 sm:px-6">
      <div className="chrome-glass mx-auto flex h-12 max-w-6xl items-center justify-between gap-3 rounded-xl pr-2 pl-3.5">
        <Link
          to="/"
          className="flex min-w-0 items-center gap-2 rounded-md font-clash text-[1.0625rem] font-semibold tracking-[-0.02em] text-neutral-50 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {logo === null ? null : (
            <img
              src={logo}
              alt=""
              className="h-6 w-auto max-w-24 shrink-0 object-contain"
            />
          )}
          <span className="truncate">{name}</span>
        </Link>
        <nav aria-label="Front page" className="flex items-center gap-1">
          <a href="#how" className={`${NAV_LINK} max-md:hidden`}>
            How it works
          </a>
          <a href="#self-host" className={`${NAV_LINK} max-md:hidden`}>
            Self-host
          </a>
          <Button asChild size="sm" variant="outline">
            <Link to="/_/sign-in">Sign in</Link>
          </Button>
        </nav>
      </div>
    </header>
  )
}

function Hero({ deployment }: { deployment: string }) {
  return (
    <section
      aria-labelledby="landing-title"
      className="relative isolate -mt-15 pt-15"
    >
      <div
        aria-hidden
        className="lp-atmosphere pointer-events-none absolute inset-0 -z-10"
      />
      <div
        aria-hidden
        className="lp-dots pointer-events-none absolute inset-0 -z-10"
      />
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 pt-10 pb-16 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.04fr)] lg:gap-14 lg:pt-16 lg:pb-24">
        <div className="flex flex-col items-start gap-6">
          <p className="inline-flex max-w-full items-center gap-2 rounded-md border border-brand-300/35 bg-brand-300/10 px-2 py-1 font-mono text-[0.6875rem] tracking-[0.16em] text-brand-200">
            <span
              aria-hidden
              className="status-pulse size-1.5 shrink-0 rounded-full bg-brand-300 text-brand-300"
            />
            <span className="uppercase">Dossier</span>
            <span aria-hidden className="text-neutral-500">
              ·
            </span>
            <span className="min-w-0 truncate tracking-normal text-neutral-300">
              <HostName host={deployment} />
            </span>
          </p>
          <h1
            id="landing-title"
            className="font-clash text-[clamp(2.5rem,1.3rem+4.4vw,4.25rem)] lg:text-[clamp(2.75rem,0.6rem+3.6vw,4.25rem)] leading-[1.02] font-semibold tracking-[-0.035em] text-balance text-neutral-50"
          >
            Your agents write the page.{' '}
            <span className="lp-glow text-brand-300">
              Dossier handles the rest.
            </span>
          </h1>
          <p className="max-w-xl text-[1.0625rem] leading-relaxed text-neutral-300 sm:text-lg">
            Agents push folders of plain HTML. Each page takes its theme, layout
            and components from the folders above it, keeps every person's form
            answers on the server, opens for anyone you share it with, and has a
            version agents read instead of the HTML.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <SignInButton />
            <Button
              asChild
              size="lg"
              variant="ghost"
              className="h-12 max-sm:px-1"
            >
              <a href="#how">
                How it works
                <ArrowDown aria-hidden />
              </a>
            </Button>
          </div>
          <p className="max-w-md text-sm leading-relaxed text-neutral-400">
            Opening a link someone sent you? Sign in with the email they shared
            it with.
          </p>
        </div>
        <div className="mx-auto w-full max-w-xl max-sm:-mx-2 max-sm:w-auto lg:max-w-none">
          <HeroFigure />
        </div>
      </div>
    </section>
  )
}

const STEPS: readonly {
  readonly title: string
  readonly text: string
  readonly code: string
}[] = [
  {
    title: 'An agent pushes a folder',
    text: 'Plain HTML, CSS and scripts, published as one push with a message. No build step, and no design system pasted into every page.',
    code: 'dossier push ./acme agent964/acme',
  },
  {
    title: 'People open it and answer',
    text: "They sign in and see what is shared with them. A page's forms save each person's answers as they send them.",
    code: 'agent964/acme/questions',
  },
  {
    title: 'Agents read it back',
    text: "The agent reads the page's companion and every answer, or waits for the next one, without parsing HTML.",
    code: 'dossier read agent964/acme/answers/',
  },
]

function HowItWorks() {
  return (
    <section
      id="how"
      aria-labelledby="how-title"
      className="scroll-mt-20 border-y border-border bg-neutral-900/40"
    >
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-20">
        <Kicker>How it works</Kicker>
        <h2
          id="how-title"
          className="mt-3 font-clash text-[clamp(1.75rem,1.2rem+2vw,2.5rem)] leading-[1.08] font-semibold tracking-[-0.03em] text-balance text-neutral-50"
        >
          A folder goes in. Answers come back.
        </h2>
        <ol className="mt-10 grid gap-4 lg:grid-cols-3">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className="relative flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
            >
              <span className="font-mono text-xs tracking-[0.2em] text-brand-300">
                0{i + 1}
              </span>
              <h3 className="text-lg font-semibold text-neutral-50">
                {step.title}
              </h3>
              <p className="text-[0.9375rem] leading-relaxed text-neutral-300">
                {step.text}
              </p>
              <p className="mt-auto rounded-lg border border-border bg-neutral-950/60 px-3 py-2 font-mono text-[0.8125rem] break-all text-neutral-200">
                {step.code}
              </p>
              {i < STEPS.length - 1 ? (
                <span
                  aria-hidden
                  className="absolute top-1/2 -right-3 z-10 hidden size-6 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-neutral-900 text-brand-300 lg:flex"
                >
                  <ArrowRight className="size-3.5" />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

function Feature({
  id,
  kicker,
  title,
  figure,
  flip,
  children,
}: {
  id: string
  kicker: string
  title: string
  figure: ReactNode
  flip?: boolean
  children: ReactNode
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="mx-auto grid max-w-6xl scroll-mt-20 items-center gap-8 px-5 py-14 sm:px-8 lg:grid-cols-2 lg:gap-16 lg:py-20"
    >
      <div
        className={`flex min-w-0 flex-col gap-4 ${flip ? 'lg:order-2' : ''}`}
      >
        <Kicker>{kicker}</Kicker>
        <h2
          id={`${id}-title`}
          className="font-clash text-[clamp(1.75rem,1.2rem+2vw,2.5rem)] leading-[1.08] font-semibold tracking-[-0.03em] text-balance text-neutral-50"
        >
          {title}
        </h2>
        <div className="flex flex-col gap-4 text-[1.0625rem] leading-relaxed text-neutral-300">
          {children}
        </div>
      </div>
      {/* On phones the stage runs edge to edge, so the figure is larger. */}
      <div className="lp-stage p-7 max-sm:-mx-5 max-sm:rounded-none max-sm:border-x-0 max-sm:px-3 max-sm:py-5">
        {figure}
      </div>
    </section>
  )
}

const ALSO: readonly {
  readonly icon: typeof Search
  readonly title: string
  readonly text: string
}[] = [
  {
    icon: MessageSquareText,
    title: 'Comments',
    text: 'Threads on any part of a page, pins on images, and mentions that point a person to it.',
  },
  {
    icon: BellRing,
    title: 'Watch and webhooks',
    text: 'dossier watch and signed webhooks report each submission, comment, mention, share and push.',
  },
  {
    icon: Search,
    title: 'Search',
    text: 'Titles, paths and page text, across everything you can open on the deployment.',
  },
  {
    icon: FileDown,
    title: 'One-file export',
    text: 'Any page as a single HTML file that opens offline, with a snapshot of its data.',
  },
  {
    icon: Sigma,
    title: 'Rich pages',
    text: 'Mermaid diagrams, highlighted code, maths and diffs come with the base layer.',
  },
  {
    icon: KeyRound,
    title: 'Agent keys',
    text: 'Each key acts as its person, and can be held to one tree and to reading.',
  },
]

function AlsoInEveryTree() {
  return (
    <section
      aria-labelledby="also-title"
      className="mx-auto max-w-6xl px-5 py-14 sm:px-8 lg:py-20"
    >
      <h2
        id="also-title"
        className="font-clash text-[clamp(1.5rem,1.2rem+1.2vw,2rem)] leading-[1.1] font-semibold tracking-[-0.03em] text-neutral-50"
      >
        And in every tree
      </h2>
      <ul className="mt-8 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
        {ALSO.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex gap-3.5 bg-card p-5">
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-brand-300/25 bg-brand-300/10 text-brand-300"
            >
              <Icon className="size-4" />
            </span>
            <span className="flex flex-col gap-1">
              <span className="font-semibold text-neutral-50">{title}</span>
              <span className="text-[0.9375rem] leading-relaxed text-neutral-400">
                {text}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function SelfHost({ deployment }: { deployment: string }) {
  return (
    <section
      id="self-host"
      aria-labelledby="self-host-title"
      className="mx-auto max-w-6xl scroll-mt-20 px-5 py-8 sm:px-8 lg:py-12"
    >
      <div className="lp-stage grid gap-8 p-5 sm:p-10 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:gap-12">
        <div className="flex min-w-0 flex-col gap-4">
          <Kicker>Self-hosted</Kicker>
          <h2
            id="self-host-title"
            className="font-clash text-[clamp(1.75rem,1.2rem+2vw,2.5rem)] leading-[1.08] font-semibold tracking-[-0.03em] text-balance text-neutral-50"
          >
            Free, MIT licensed, and yours to run.
          </h2>
          <p className="text-[1.0625rem] leading-relaxed text-neutral-300">
            Dossier runs on Cloudflare: one Worker, D1 and R2. A deployment of
            your own keeps its own workspaces and people, and its own look: your
            name, logo, colours and fonts on every screen. Every feature works
            there.
          </p>
          <Button asChild variant="outline" size="lg" className="w-fit">
            <a href={SOURCE}>
              Dossier on GitHub
              <ArrowUpRight aria-hidden />
            </a>
          </Button>
        </div>
        <figure className="flex min-w-0 flex-col gap-2">
          <figcaption className="font-mono text-[0.6875rem] tracking-[0.2em] text-neutral-400 uppercase">
            The CLI, on this deployment
          </figcaption>
          <pre className="rounded-xl border border-border bg-neutral-950/70 p-4 font-mono text-[0.8125rem] leading-7 break-words whitespace-pre-wrap text-neutral-200">
            <code>
              <span className="text-brand-300">$</span> npm i -g
              @agent964/dossier
              {'\n'}
              <span className="text-brand-300">$</span> dossier login{' '}
              {deployment}
              {'\n'}
              <span className="text-brand-300">$</span> dossier push ./site{' '}
              <span className="text-neutral-400">
                &lt;workspace&gt;/&lt;tree&gt;
              </span>
            </code>
          </pre>
        </figure>
      </div>
    </section>
  )
}

function Closing() {
  return (
    <section
      aria-labelledby="closing-title"
      className="mx-auto flex max-w-3xl flex-col items-center gap-5 px-5 py-20 text-center sm:px-8 lg:py-28"
    >
      <h2
        id="closing-title"
        className="font-clash text-[clamp(1.75rem,1.2rem+2vw,2.5rem)] leading-[1.08] font-semibold tracking-[-0.03em] text-balance text-neutral-50"
      >
        Has someone shared a page with you?
      </h2>
      <p className="max-w-xl text-[1.0625rem] leading-relaxed text-neutral-300">
        Sign in with the email they sent it to. You see everything shared with
        that address, across workspaces.
      </p>
      <SignInButton />
    </section>
  )
}

function Footer({ deployment }: { deployment: string }) {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 text-sm text-neutral-400 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p className="break-words">
          <HostName host={deployment} /> runs Dossier, free and open source.
        </p>
        <nav aria-label="About this deployment">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            <li>
              <Link
                to="/_/privacy"
                className="underline underline-offset-4 hover:text-neutral-100"
              >
                Privacy
              </Link>
            </li>
            <li>
              <a
                href={SOURCE}
                className="underline underline-offset-4 hover:text-neutral-100"
              >
                Source on GitHub
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  )
}
