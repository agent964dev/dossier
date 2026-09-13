import { Link } from '@tanstack/react-router'
import { Equal, ExternalLink, GitCompare, TriangleAlert } from 'lucide-react'

import { EmptyState } from './empty-state'
import { Button } from './ui/button'
import { cn } from '@/lib/utils'
import type { DiffMode, DiffVersionRef } from '../server/diff'

/**
 * Every way a diff can fail to be a diff. Each one keeps the reader moving:
 * the two versions are always one click away as rendered pages and as raw
 * bytes, so "too large to diff" never means "too large to read".
 */

function Frame({
  tone,
  Icon,
  title,
  children,
}: {
  tone: 'warn' | 'error' | 'muted'
  Icon: typeof TriangleAlert
  title: string
  children: React.ReactNode
}) {
  const frame =
    tone === 'warn'
      ? 'border-warning-400/25 bg-warning-400/6'
      : tone === 'error'
        ? 'border-destructive/30 bg-destructive/8'
        : 'border-border bg-card'
  const accent =
    tone === 'warn'
      ? 'text-warning-300'
      : tone === 'error'
        ? 'text-error-300'
        : 'text-neutral-400'
  return (
    <section className={cn('rounded-xl border px-5 py-6 sm:px-6', frame)}>
      <div className="flex items-start gap-3">
        <Icon aria-hidden className={cn('mt-0.5 size-5 shrink-0', accent)} />
        <div className="min-w-0">
          <h2 className="font-clash text-lg font-semibold tracking-[-0.02em] text-neutral-100">
            {title}
          </h2>
          <div className="mt-2 text-sm leading-body text-neutral-400">{children}</div>
        </div>
      </div>
    </section>
  )
}

/** The two versions as links: rendered page and raw bytes, side by side. */
export function VersionLinks({
  from,
  to,
  className,
}: {
  from: DiffVersionRef
  to: DiffVersionRef
  className?: string
}) {
  const versions = from.versionNumber === to.versionNumber ? [from] : [from, to]
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {versions.map((version, index) => (
        <span
          key={`${version.versionNumber}-${index}`}
          className="flex items-center gap-1 rounded-lg border border-border bg-neutral-900/60 py-1 pr-1 pl-2.5"
        >
          <span data-numeric className="text-micro-lg text-neutral-400">
            v{version.versionNumber}
          </span>
          <Button asChild variant="ghost" size="xs">
            <a href={version.url} target="_blank" rel="noreferrer">
              Open
              <ExternalLink aria-hidden />
            </a>
          </Button>
          <Button asChild variant="ghost" size="xs">
            <a href={version.rawUrl} target="_blank" rel="noreferrer">
              Raw
            </a>
          </Button>
        </span>
      ))}
    </div>
  )
}

export function DiffTooLarge({
  from,
  to,
  message,
}: {
  from: DiffVersionRef
  to: DiffVersionRef
  message: string
}) {
  return (
    <Frame tone="warn" Icon={TriangleAlert} title="This diff is too large to render">
      <p>{message}</p>
      <p className="mt-2">
        Pick two closer versions, or read the two files directly — the raw links
        serve the exact bytes that were published.
      </p>
      <VersionLinks from={from} to={to} className="mt-4" />
    </Frame>
  )
}

export function DiffUnavailable({
  from,
  to,
  code,
  message,
}: {
  from: DiffVersionRef
  to: DiffVersionRef
  code: string
  message: string
}) {
  return (
    <Frame tone="error" Icon={TriangleAlert} title="The diff could not be computed">
      <p>
        {message}{' '}
        <span className="text-micro-lg text-neutral-500">{code}</span>
      </p>
      <VersionLinks from={from} to={to} className="mt-4" />
    </Frame>
  )
}

export function DiffIdentical({
  from,
  to,
  mode,
}: {
  from: DiffVersionRef
  to: DiffVersionRef
  mode: DiffMode
}) {
  const same = from.versionNumber === to.versionNumber
  return (
    <Frame
      tone="muted"
      Icon={Equal}
      title={same ? 'That is the same version twice' : 'No differences'}
    >
      <p>
        {same
          ? `Pick a second version to compare v${from.versionNumber} against.`
          : mode === 'text'
            ? `v${from.versionNumber} and v${to.versionNumber} read identically. Their HTML may still differ — switch to the HTML comparison to see it.`
            : `v${from.versionNumber} and v${to.versionNumber} are byte-for-byte identical.`}
      </p>
      <VersionLinks from={from} to={to} className="mt-4" />
    </Frame>
  )
}

/** Fewer than two versions exist, so there is nothing to compare yet. */
export function DiffNeedsTwoVersions({
  documentId,
  version,
}: {
  documentId: string
  version: DiffVersionRef | null
}) {
  return (
    <EmptyState
      title="Nothing to compare yet"
      body="A diff needs two versions. Upload this file again and the second version will appear here beside the first."
      command={`dossier upload <file> --doc ${documentId}`}
    >
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboard/documents/$id" params={{ id: documentId }}>
            <GitCompare aria-hidden />
            Back to the document
          </Link>
        </Button>
        {version ? (
          <Button asChild variant="ghost" size="sm">
            <a href={version.url} target="_blank" rel="noreferrer">
              Open v{version.versionNumber}
              <ExternalLink aria-hidden />
            </a>
          </Button>
        ) : null}
      </div>
    </EmptyState>
  )
}

/** The page's own ceiling, reached before the service's 413. */
export function DiffTruncated({
  omitted,
  from,
  to,
}: {
  omitted: number
  from: DiffVersionRef
  to: DiffVersionRef
}) {
  return (
    <div className="border-t border-border bg-neutral-900/60 px-4 py-4">
      <p className="text-sm leading-body text-neutral-400">
        {omitted === 1
          ? 'One further change was left out to keep this page fast.'
          : `${omitted} further changes were left out to keep this page fast.`}{' '}
        Compare two closer versions, or read the files directly.
      </p>
      <VersionLinks from={from} to={to} className="mt-3" />
    </div>
  )
}
