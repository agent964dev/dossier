import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

import { AppShell } from '../../components/app-shell'
import {
  DiffControls,
  readDiffSearch,
  type DiffSearch,
} from '../../components/diff-controls'
import { DiffNavigator } from '../../components/diff-navigator'
import {
  DiffIdentical,
  DiffNeedsTwoVersions,
  DiffTooLarge,
  DiffTruncated,
  DiffUnavailable,
} from '../../components/diff-states'
import { DiffView } from '../../components/diff-view'
import { PageHeader } from '../../components/page-header'
import { StatusMessage } from '../../components/status-message'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { absoluteDateTime } from '../../components/format'
import { loadDiff, type DiffLayout } from '../../server/diff'
import { requireData, RouteError } from '../-lib/guard'

export const Route = createFileRoute('/dashboard/documents/$id_/diff')({
  validateSearch: (search: Record<string, unknown>): DiffSearch =>
    readDiffSearch(search),
  // `view` is a rendering choice, so it deliberately stays out of the deps: a
  // layout switch re-renders from the data already in hand.
  loaderDeps: ({ search }) => ({
    from: search.from,
    to: search.to,
    mode: search.mode,
  }),
  loader: async ({ params, deps }) =>
    requireData(
      await loadDiff({
        data: {
          id: params.id,
          ...(deps.from === undefined ? {} : { from: deps.from }),
          ...(deps.to === undefined ? {} : { to: deps.to }),
          ...(deps.mode === undefined ? {} : { mode: deps.mode }),
        },
      }),
      `/dashboard/documents/${params.id}/diff`,
    ),
  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData && loaderData.from && loaderData.to
            ? `v${loaderData.from.versionNumber} → v${loaderData.to.versionNumber} · ${loaderData.documentTitle} — dossier`
            : 'Compare versions — dossier',
      },
    ],
  }),
  component: DiffPage,
  errorComponent: RouteError,
})

function DiffPage() {
  const {
    viewer,
    documentId,
    documentTitle,
    documentKind,
    versions,
    versionCount,
    from,
    to,
    requestedMode,
    mode,
    textSupported,
    outcome,
  } = Route.useLoaderData()
  const search = Route.useSearch()
  const layout: DiffLayout = search.view ?? 'auto'

  return (
    <AppShell viewer={viewer} subtitle="Compare">
      <PageHeader
        kicker="Compare versions"
        title={documentTitle}
        description={
          from && to && from.versionNumber !== to.versionNumber
            ? `v${from.versionNumber} (${absoluteDateTime(from.createdAt)}) → v${to.versionNumber} (${absoluteDateTime(to.createdAt)}). Every version is kept, so nothing here is destructive.`
            : 'Every version of this document is kept, and any two of them can be compared here.'
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/dashboard/documents/$id" params={{ id: documentId }}>
              <ArrowLeft aria-hidden />
              Document
            </Link>
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-6">
        {documentKind ? <Badge variant="accent">{documentKind}</Badge> : null}
        <span data-numeric className="text-micro-lg text-neutral-500">
          {versionCount} {versionCount === 1 ? 'version' : 'versions'} kept
        </span>
      </div>

      {outcome === null || from === null || to === null ? (
        <DiffNeedsTwoVersions
          documentId={documentId}
          version={versions[0] ?? null}
        />
      ) : (
        <>
          <DiffControls
            documentId={documentId}
            versions={versions}
            from={from}
            to={to}
            layout={layout}
            mode={mode}
            textSupported={textSupported}
          />

          {requestedMode === 'text' && mode !== 'text' ? (
            /*
              The text differ is optional. When it is absent the page does not
              dead-end on an error: it shows the html diff, drops the toggle,
              and offers the link that clears the request from the URL.
            */
            <StatusMessage tone="info" className="mt-4">
              This deployment cannot compare visible text yet, so the HTML
              comparison is shown instead.{' '}
              <Link
                to="/dashboard/documents/$id/diff"
                params={{ id: documentId }}
                search={{
                  from: from.versionNumber,
                  to: to.versionNumber,
                  ...(search.view === undefined ? {} : { view: search.view }),
                }}
                className="underline underline-offset-4 hover:text-brand-100"
              >
                Clear the text request
              </Link>
              .
            </StatusMessage>
          ) : null}

          {outcome.state === 'too_large' ? (
            <div className="mt-6">
              <DiffTooLarge from={from} to={to} message={outcome.message} />
            </div>
          ) : outcome.state === 'unavailable' ? (
            <div className="mt-6">
              <DiffUnavailable
                from={from}
                to={to}
                code={outcome.code}
                message={outcome.message}
              />
            </div>
          ) : outcome.hunks.length === 0 ? (
            <div className="mt-6">
              <DiffIdentical from={from} to={to} mode={mode} />
            </div>
          ) : (
            <section className="mt-6 overflow-clip rounded-xl border border-border bg-card">
              {/*
                The summary line and the hunk navigator: the only two things a
                reader needs before the diff itself, and the only place the
                page spends client JavaScript.
              */}
              <header className="sticky top-[7.5rem] z-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-card/95 px-3 py-2.5 backdrop-blur md:top-24">
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span data-numeric className="text-micro-lg text-neutral-400">
                    v{from.versionNumber} → v{to.versionNumber}
                  </span>
                  <span data-numeric className="text-micro-lg text-success-200/90">
                    +{outcome.added}
                  </span>
                  <span data-numeric className="text-micro-lg text-error-300/90">
                    −{outcome.removed}
                  </span>
                  <span className="text-micro-lg text-neutral-500">
                    {mode === 'text' ? 'text only' : 'html'}
                  </span>
                </span>
                <DiffNavigator count={outcome.hunks.length} />
              </header>

              <DiffView
                hunks={outcome.hunks}
                layout={layout}
                from={from}
                to={to}
              />

              {outcome.omittedHunks > 0 ? (
                <DiffTruncated
                  omitted={outcome.omittedHunks}
                  from={from}
                  to={to}
                />
              ) : null}
            </section>
          )}
        </>
      )}
    </AppShell>
  )
}
