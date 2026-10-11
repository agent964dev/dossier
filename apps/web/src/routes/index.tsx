import { createFileRoute, Link } from '@tanstack/react-router'
import { Folder, Info } from 'lucide-react'
import { useState } from 'react'

import { HostName } from '../components/host-name'
import { AppHeader } from '../components/app-header'
import { SectionLabel } from '../components/section-label'
import { Button } from '../components/ui/button'
import { WorkspaceMenu } from '../components/workspace-menu'
import type { TreeSharing } from '../core/index'
import { signOut, startGoogleSignIn } from '../lib/auth-client'
import { homeView, type HomeTree, type HomeView } from '../server/home'
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

/** How a tree is shared, as its row says it. */
export function sharingLabel(sharing: TreeSharing): string {
  switch (sharing.kind) {
    case 'private':
      return 'Private'
    case 'workspace':
      return 'Shared with the workspace'
    case 'public':
      return 'Public'
    case 'people':
      return sharing.count === 1
        ? 'Shared with 1 person'
        : `Shared with ${sharing.count} people`
  }
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
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-300"
                >
                  <Folder className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[0.9375rem] text-neutral-50">
                    {tree.name}/
                  </span>
                  <span className="block text-xs text-neutral-400">
                    {sharingLabel(tree.sharing)}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
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
        {view.workspace === null ? null : (
          <Trees workspace={view.workspace} trees={view.trees} />
        )}
        <section
          aria-labelledby={view.workspace === null ? undefined : 'shared-label'}
          aria-label={view.workspace === null ? 'Shared with me' : undefined}
          className="flex flex-col gap-3"
        >
          {view.workspace === null ? null : (
            <SectionLabel id="shared-label">Shared with me</SectionLabel>
          )}
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
