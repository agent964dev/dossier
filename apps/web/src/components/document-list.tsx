import type { DocumentEditor } from '@dossier/contracts'
import { Link } from '@tanstack/react-router'
import { ChevronRight, EyeOff, Globe, Lock, Users } from 'lucide-react'

import { Avatar } from './avatar'
import { relativeTime, absoluteDateTime } from './format'
import { Badge } from './ui/badge'
import { cn } from '@/lib/utils'

const VISIBILITY = {
  public: { label: 'Public', Icon: Globe },
  team: { label: 'Team', Icon: Users },
  private: { label: 'Private', Icon: Lock },
} as const

export function VisibilityTag({
  visibility,
  inherited,
  className,
}: {
  visibility: 'public' | 'team' | 'private'
  inherited?: boolean
  className?: string
}) {
  const { label, Icon } = VISIBILITY[visibility]
  return (
    <span
      className={cn(
        'text-micro-lg inline-flex items-center gap-1.5 text-neutral-400',
        className,
      )}
      title={inherited ? `${label}, inherited from an ancestor` : label}
    >
      <Icon aria-hidden className="size-3 opacity-70" />
      {label}
      {inherited ? <span className="text-neutral-600">inh</span> : null}
    </span>
  )
}

export function KindTag({ kind }: { kind: string | null }) {
  if (kind === null) {
    return (
      <span aria-hidden className="text-micro-lg text-neutral-700">
        —
      </span>
    )
  }
  return <Badge variant="accent">{kind}</Badge>
}

/** The column headings, shown only where the grid actually has columns. */
export function DocumentListHeader() {
  return (
    <div className="hidden grid-cols-[minmax(0,1fr)_6rem_5.5rem_3.5rem_6rem_10rem_1rem] items-center gap-4 px-5 pb-2 lg:grid">
      <span className="text-micro-lg text-neutral-600">Document</span>
      <span className="text-micro-lg text-neutral-600">Kind</span>
      <span className="text-micro-lg text-neutral-600">Access</span>
      <span className="text-micro-lg text-neutral-600">Ver</span>
      <span className="text-micro-lg text-neutral-600">Updated</span>
      <span className="text-micro-lg text-neutral-600">Author</span>
      <span className="sr-only">Open</span>
    </div>
  )
}

/**
 * One row per document: a stacked card on a phone, an aligned six-column table
 * from `lg`. The whole row is the link to the detail page — there is exactly
 * one click target, so nothing is ambiguous under a thumb.
 */
export function DocumentRow({
  document,
  now,
}: {
  document: DocumentEditor
  now: string
}) {
  const updated = relativeTime(document.updatedAt, now)
  const updatedTitle = absoluteDateTime(document.updatedAt)

  return (
    <li className="group min-w-0">
      <Link
        to="/dashboard/documents/$id"
        params={{ id: document.id }}
        className={cn(
          'grid gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5',
          'transition-[border-color,background-color,transform] duration-200 ease-agent',
          'hover:-translate-y-[1px] hover:border-brand-300/35 hover:bg-neutral-800/35',
          'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'lg:grid-cols-[minmax(0,1fr)_6rem_5.5rem_3.5rem_6rem_10rem_1rem] lg:items-center lg:gap-4 lg:px-5 lg:py-3',
        )}
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-[0.9375rem] leading-ui font-medium text-neutral-50 group-hover:text-brand-100">
              {document.title}
            </span>
            {document.disabled ? (
              <Badge variant="warn" className="shrink-0">
                <EyeOff aria-hidden />
                Disabled
              </Badge>
            ) : null}
          </span>
          {document.description ? (
            <span className="mt-1 line-clamp-2 text-xs leading-ui text-neutral-500 lg:line-clamp-1">
              {document.description}
            </span>
          ) : null}
        </span>

        <span className="hidden lg:flex">
          <KindTag kind={document.kind} />
        </span>
        <span className="hidden lg:block">
          <VisibilityTag
            visibility={document.effectiveVisibility}
            inherited={document.accessSource === 'inherited'}
          />
        </span>
        <span
          data-numeric
          className="text-micro-lg hidden text-neutral-300 lg:block"
        >
          v{document.latestVersionNumber}
        </span>
        <span
          className="text-micro-lg hidden text-neutral-500 lg:block"
          title={updatedTitle}
        >
          {updated}
        </span>
        <span className="hidden min-w-0 items-center gap-2 lg:flex">
          <Avatar name={document.authorName} className="size-5 text-[0.5rem]" />
          <span className="truncate text-xs text-neutral-400">
            {document.authorName}
          </span>
        </span>
        <ChevronRight
          aria-hidden
          className="hidden size-4 text-neutral-600 transition-colors group-hover:text-brand-300 lg:block"
        />

        {/*
          Phone layout: one row of tags, one line of provenance. Separators are
          only ever drawn between two values that exist, so a wrapped line never
          ends in a stray dot.
        */}
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 lg:hidden">
          <KindTag kind={document.kind} />
          <VisibilityTag
            visibility={document.effectiveVisibility}
            inherited={document.accessSource === 'inherited'}
          />
          <span data-numeric className="text-micro-lg text-neutral-300">
            v{document.latestVersionNumber}
          </span>
        </span>
        <span className="text-micro-lg flex min-w-0 items-center gap-1.5 text-neutral-500 lg:hidden">
          <span className="truncate">{document.authorName}</span>
          <span aria-hidden className="text-neutral-700">
            ·
          </span>
          <span className="shrink-0" title={updatedTitle}>
            {updated}
          </span>
        </span>
      </Link>
    </li>
  )
}
