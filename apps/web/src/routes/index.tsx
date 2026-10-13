import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { FileText, Folder, Info } from 'lucide-react'
import { useState } from 'react'

import { LocalTime } from '../components/local-time'
import { MentionedBadge } from '../components/mentioned-badge'
import { SearchField } from '../components/search-field'
import { AppHeader } from '../components/app-header'
import { LandingPage } from '../components/landing-page'
import { SectionLabel } from '../components/section-label'
import { Note } from '../components/settings-parts'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { WorkspaceMenu } from '../components/workspace-menu'
import { treeSharingLabel } from '../lib/sharing'
import { signOut, startGoogleSignIn } from '../lib/auth-client'
import {
  homeView,
  type HomeTree,
  type HomeView,
  type SharedWithMe,
} from '../server/home'
import { isScreenFailure } from '../server/failure'

interface HomeSearch {
  readonly w?: string
}

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    w: typeof search.w === 'string' ? search.w : undefined,
  }),
  loaderDeps: ({ search }) => ({ w: search.w }),
  loader: async ({ deps }) => {
    const view = await homeView({ data: { w: deps.w } })
    if (isScreenFailure(view)) throw new Error(view.error.message)
    // A new deployment's super admin first chooses who may create workspaces.
    if (view.firstRun) throw redirect({ href: '/_/admin' })
    return view
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData?.deployment ?? 'Dossier' },
      {
        name: 'description',
        content:
          "Your agents write the page. Dossier handles the rest: pages that share a theme and layout, forms that keep each person's answers, sharing with any Google account, and a version agents can read.",
      },
    ],
  }),
  component: HomeScreen,
})

function HomeScreen() {
  const view = Route.useLoaderData()
  return view.me === null ? (
    <LandingPage deployment={view.deployment} />
  ) : (
    <Home view={view} me={view.me} />
  )
}

function Trees({
  workspace,
  trees,
}: {
  workspace: string
  trees: readonly HomeTree[]
}) {
  return (
    <section aria-labelledby="trees-label" className="flex flex-col gap-3">
      <SectionLabel id="trees-label" count={trees.length}>
        Trees
      </SectionLabel>
      {trees.length === 0 ? (
        <p className="text-[0.9375rem] leading-relaxed text-neutral-400">
          No trees yet. Publish with{' '}
          <code className="rounded-md border border-border bg-neutral-900/70 px-1.5 py-0.5 font-mono text-[0.8125rem] break-all text-brand-100">
            dossier push &lt;folder&gt; {workspace}/&lt;tree&gt;/
          </code>
          .
        </p>
      ) : (
        <ul className="divide-y divide-border/80 overflow-hidden rounded-xl border border-border bg-card">
          {trees.map((tree) => (
            <li key={tree.name}>
              <a
                href={tree.href}
                className="flex items-center gap-3 px-3.5 py-3 outline-none transition-colors duration-200 ease-agent hover:bg-neutral-800/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                <span
                  aria-hidden
                  className={`flex size-8 shrink-0 items-center justify-center rounded-lg border ${
                    tree.mentioned
                      ? TILE['mentioned you']
                      : 'border-border bg-neutral-800/70 text-neutral-300'
                  }`}
                >
                  <Folder className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[0.9375rem] text-neutral-50">
                    {tree.name}/
                  </span>
                  <span className="block text-xs text-neutral-400">
                    {treeSharingLabel(tree.sharing)}
                  </span>
                  {tree.mentioned ? <MentionedBadge className="mt-1" /> : null}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** The tile's tone follows the row's label. */
const TILE = {
  'waiting for your answer':
    'border-complement-400/25 bg-complement-400/10 text-complement-400',
  'mentioned you': 'border-brand-300/25 bg-brand-300/10 text-brand-300',
} as const

function SharedRow({ row }: { row: SharedWithMe }) {
  return (
    <li>
      <a
        href={row.link}
        className="flex items-center gap-3 px-3.5 py-3 outline-none transition-colors duration-200 ease-agent hover:bg-neutral-800/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <span
          aria-hidden
          className={`flex size-8 shrink-0 items-center justify-center rounded-lg border ${
            row.label === null
              ? 'border-border bg-neutral-800/70 text-neutral-300'
              : TILE[row.label]
          }`}
        >
          {row.kind === 'folder' ? (
            <Folder className="size-4" />
          ) : (
            <FileText className="size-4" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[0.9375rem] text-neutral-50">
            {row.title}
          </span>
          <span className="font-mono text-xs break-words text-neutral-400">
            {row.place} · from {row.from} ·{' '}
            <LocalTime at={row.date} format="day" />
          </span>
          {row.label === 'mentioned you' ? (
            <MentionedBadge className="mt-1" />
          ) : row.label === null ? null : (
            <Badge variant="accent" className="mt-1">
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-current shadow-[0_0_6px_currentColor]"
              />
              {row.label}
            </Badge>
          )}
        </span>
        <span className="shrink-0 font-mono text-[0.6875rem] tracking-[0.16em] text-neutral-400 uppercase">
          {row.action}
        </span>
      </a>
    </li>
  )
}

/** The field on the home: typing or Enter opens the search screen. */
function HomeSearch() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const open = (q: string) =>
    navigate({ to: '/_/search', search: q === '' ? {} : { q } })
  return (
    <search>
      <SearchField
        id="home-search"
        value={text}
        onChange={(next) => {
          setText(next)
          if (next.trim() !== '') void open(next)
        }}
        onEnter={() => void open(text)}
      />
    </search>
  )
}

function Home({
  view,
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
      <AppHeader
        email={me.email}
        beside={
          view.workspace === null ? undefined : (
            <WorkspaceMenu
              current={view.workspace}
              workspaces={view.workspaces}
            />
          )
        }
      />
      <main className="mx-auto flex max-w-3xl flex-col gap-5 px-4 pt-6 pb-16 sm:px-6">
        <h1 className="font-clash text-[1.75rem] font-semibold tracking-[-0.03em] text-neutral-50 break-words">
          {view.workspace ?? 'Shared with me'}
        </h1>
        <HomeSearch />
        {view.workspace === null ? null : (
          <Trees workspace={view.workspace} trees={view.trees} />
        )}
        <section
          aria-labelledby={view.workspace === null ? undefined : 'shared-label'}
          aria-label={view.workspace === null ? 'Shared with me' : undefined}
          className="flex flex-col gap-3"
        >
          {view.workspace === null ? null : (
            <SectionLabel
              id="shared-label"
              count={view.shared.length === 0 ? undefined : view.shared.length}
            >
              Shared with me
            </SectionLabel>
          )}
          {view.shared.length === 0 ? null : (
            <ul className="divide-y divide-border/80 overflow-hidden rounded-xl border border-border bg-card">
              {view.shared.map((row) => (
                <SharedRow key={row.link} row={row} />
              ))}
            </ul>
          )}
          {view.shared.length === 0 ? null : view.workspace === null ? (
            <Note>
              A guest has only what others share with{' '}
              <span className="text-neutral-300">{me.email}</span>.
            </Note>
          ) : null}
          {view.shared.length > 0 ? null : (
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
          )}
        </section>
      </main>
    </div>
  )
}
