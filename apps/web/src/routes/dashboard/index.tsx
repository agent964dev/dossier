import { createFileRoute, Link } from '@tanstack/react-router'
import { Terminal, Trash2 } from 'lucide-react'

import { AppShell } from '../../components/app-shell'
import { CopyField } from '../../components/copy-field'
import {
  DocumentListHeader,
  DocumentRow,
} from '../../components/document-list'
import { EmptyState } from '../../components/empty-state'
import { PageHeader } from '../../components/page-header'
import { StatusMessage } from '../../components/status-message'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { loadDashboard, type DocumentScope } from '../../server/documents'
import { requireData, RouteError } from '../-lib/guard'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/dashboard/')({
  // `scope` is absent from the URL in the default view, so every other page
  // can link to `/dashboard` without carrying search state it does not own.
  validateSearch: (search: Record<string, unknown>): { scope?: DocumentScope } =>
    search.scope === 'workspace' ? { scope: 'workspace' } : {},
  loaderDeps: ({ search }) => ({ scope: search.scope ?? ('mine' as DocumentScope) }),
  loader: async ({ deps }) =>
    requireData(await loadDashboard({ data: { scope: deps.scope } }), '/dashboard'),
  head: () => ({ meta: [{ title: 'Documents — dossier' }] }),
  component: DashboardPage,
  errorComponent: RouteError,
})

const SCOPES: ReadonlyArray<{ value: DocumentScope; label: string; hint: string }> = [
  { value: 'mine', label: 'Yours', hint: 'Documents you published' },
  { value: 'workspace', label: 'Workspace', hint: 'Everything you can edit here' },
]

function DashboardPage() {
  const { viewer, documents, scope, trashCount } = Route.useLoaderData()

  return (
    <AppShell viewer={viewer} subtitle="Documents">
      <PageHeader
        kicker={`${viewer.workspaceSlug} workspace`}
        title="Documents"
        description={
          scope === 'mine'
            ? 'Everything you have published here, newest first. Every upload keeps its own version history.'
            : viewer.role === 'admin'
              ? 'Everything in this workspace you can edit: your documents, plus every member’s as an admin.'
              : 'Everything in this workspace you can edit.'
        }
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
        <div
          role="tablist"
          aria-label="Which documents to list"
          className="inline-flex w-fit rounded-lg border border-border bg-neutral-900/60 p-0.5"
        >
          {SCOPES.map((option) => {
            const active = option.value === scope
            return (
              <Link
                key={option.value}
                to="/dashboard"
                search={option.value === 'mine' ? {} : { scope: option.value }}
                role="tab"
                aria-selected={active}
                title={option.hint}
                className={cn(
                  'rounded-[7px] px-3 py-1.5 text-[0.8125rem] font-medium',
                  'transition-colors duration-200 ease-agent',
                  'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  active
                    ? 'bg-brand-300/12 text-brand-100'
                    : 'text-neutral-400 hover:text-neutral-100',
                )}
              >
                {option.label}
              </Link>
            )
          })}
        </div>

        <p className="text-micro-lg text-neutral-500">
          <span data-numeric className="text-neutral-300">
            {documents.length}
          </span>
          {documents.length === 1 ? ' document' : ' documents'}
        </p>
      </div>

      <div className="mt-5">
        {documents.length === 0 ? (
          <EmptyState
            title={scope === 'mine' ? 'Nothing published yet' : 'This workspace is empty'}
            body={
              viewer.publisher
                ? 'Documents arrive from the CLI. Upload an HTML file and it gets a permanent link, a version number, and a place in this list.'
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
            <DocumentListHeader />
            <ul className="grid gap-2">
              {documents.map((document) => (
                <DocumentRow key={document.id} document={document} now={viewer.now} />
              ))}
            </ul>
          </>
        )}
      </div>

      {documents.length > 0 && viewer.publisher ? (
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
