import { createFileRoute, Link } from '@tanstack/react-router'
import { Share2, Terminal, Trash2 } from 'lucide-react'

import { AppShell } from '../../components/app-shell'
import { CopyField } from '../../components/copy-field'
import {
  DocumentTree,
  SharedDocumentList,
} from '../../components/document-tree'
import { EmptyState } from '../../components/empty-state'
import { PageHeader, SectionLabel } from '../../components/page-header'
import { StatusMessage } from '../../components/status-message'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { loadDashboard, type DocumentScope } from '../../server/documents'
import { requireData, RouteError } from '../-lib/guard'

export const Route = createFileRoute('/dashboard/')({
  // `scope` is absent from the URL in the default view, so every other page
  // can link to `/dashboard` without carrying search state it does not own.
  validateSearch: (
    search: Record<string, unknown>,
  ): { scope?: DocumentScope } =>
    search.scope === 'workspace' ? { scope: 'workspace' } : {},
  loaderDeps: ({ search }) => ({
    scope: search.scope ?? ('mine' as DocumentScope),
  }),
  loader: async ({ deps }) =>
    requireData(
      await loadDashboard({ data: { scope: deps.scope } }),
      '/dashboard',
    ),
  head: () => ({ meta: [{ title: 'Documents — dossier' }] }),
  component: DashboardPage,
  errorComponent: RouteError,
})

function DashboardPage() {
  const { viewer, nodes, shared, total, mine, scope, trashCount, truncated } =
    Route.useLoaderData()

  return (
    <AppShell viewer={viewer} subtitle="Documents">
      <PageHeader
        kicker={`${viewer.workspaceSlug} workspace`}
        title="Documents"
        description="Every document in this workspace you can read, nested the way it is filed. A document whose parent you cannot read sits at the top level — the parent is never named."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/dashboard/trash">
              <Trash2 aria-hidden />
              Trash
              {trashCount > 0 ? (
                <span data-numeric className="text-micro-lg text-neutral-500">
                  {trashCount}
                </span>
              ) : null}
            </Link>
          </Button>
        }
      />

      {viewer.publisher ? null : (
        <StatusMessage tone="error" className="mb-6">
          Your membership in {viewer.workspaceSlug} was removed, so you can no
          longer publish or change documents here. Existing documents are
          untouched — ask an admin to add you back.
        </StatusMessage>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <Link
          to="/dashboard"
          search={scope === 'mine' ? { scope: 'workspace' } : {}}
          role="switch"
          aria-checked={scope === 'mine'}
          className="inline-flex w-fit items-center gap-2.5 rounded-lg px-1 py-1 text-[0.8125rem] font-medium text-neutral-300 outline-none transition-colors duration-200 ease-agent hover:text-neutral-50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span
            aria-hidden
            className={`relative h-5 w-9 rounded-full border transition-colors duration-200 ease-agent ${
              scope === 'mine'
                ? 'border-brand-300/45 bg-brand-300/20'
                : 'border-border bg-neutral-800'
            }`}
          >
            <span
              className={`absolute top-0.5 size-3.5 rounded-full transition-[transform,background-color] duration-200 ease-agent ${
                scope === 'mine'
                  ? 'translate-x-[1.125rem] bg-brand-200'
                  : 'translate-x-0.5 bg-neutral-500'
              }`}
            />
          </span>
          Highlight mine
        </Link>

        <p className="text-micro-lg text-neutral-500">
          <span data-numeric className="text-neutral-300">
            {total}
          </span>
          {total === 1 ? ' document' : ' documents'}
          {mine > 0 ? (
            <>
              <span aria-hidden className="px-1.5 text-neutral-700">
                ·
              </span>
              <span data-numeric className="text-neutral-300">
                {mine}
              </span>
              {' yours'}
            </>
          ) : null}
        </p>
      </div>

      <div className="mt-5">
        {nodes.length === 0 ? (
          <EmptyState
            title="Nothing here yet"
            body={
              viewer.publisher
                ? 'Documents arrive from the CLI. Upload an HTML file and it gets a permanent link, a version number, and a place in this tree. Pass --parent to file it under another document.'
                : 'Documents arrive from the CLI, and publishing here needs a membership in this workspace.'
            }
            {...(viewer.publisher
              ? { command: 'dossier upload plan.html --kind plan' }
              : {})}
          >
            {viewer.publisher ? (
              <Button asChild variant="outline" size="sm">
                <Link to="/cli/auth">
                  <Terminal aria-hidden />
                  Set up the CLI
                </Link>
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <>
            {truncated ? (
              <StatusMessage tone="info" className="mb-3">
                This workspace holds more documents than one page shows. The
                tree below is the first thousand by recency; use the CLI’s
                <span className="font-mono"> dossier list --tree </span>
                for the rest.
              </StatusMessage>
            ) : null}
            <DocumentTree
              nodes={nodes}
              now={viewer.now}
              accountId={viewer.accountId}
              highlightMine={scope === 'mine'}
            />
          </>
        )}
      </div>

      {shared.length > 0 ? (
        <section className="mt-10">
          <SectionLabel
            aside={
              <Badge variant="accent">
                <Share2 aria-hidden />
                {shared.length}
              </Badge>
            }
          >
            Shared with you
          </SectionLabel>
          <p className="pb-4 text-sm leading-body text-neutral-500">
            Readable from outside {viewer.workspaceSlug}: someone invited{' '}
            {viewer.email ?? 'your email'}, or the document is public. Their
            hierarchy stays theirs — open one to see where it sits.
          </p>
          <SharedDocumentList documents={shared} now={viewer.now} />
        </section>
      ) : null}

      {nodes.length > 0 && viewer.publisher ? (
        <div className="mt-8 grid gap-3 rounded-xl border border-border bg-card px-5 py-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-5">
          <div className="flex items-center gap-2">
            <Badge variant="muted">
              <Terminal aria-hidden />
              Next upload
            </Badge>
          </div>
          <CopyField
            value="dossier upload plan.html --kind plan"
            label="Copy the upload command"
            prefix="$"
          />
        </div>
      ) : null}
    </AppShell>
  )
}
