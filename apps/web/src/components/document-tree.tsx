import { useMemo, useState } from 'react'
import { isDocumentEditor, type DocumentView } from '@dossier/contracts'
import { Link } from '@tanstack/react-router'
import { ChevronRight, EyeOff } from 'lucide-react'

import { KindTag, VisibilityTag } from './document-list'
import { absoluteDateTime, relativeTime } from './format'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import type { DashboardNode } from '../server/documents'
import { cn } from '@/lib/utils'

/**
 * The workspace as its hierarchy, not as a flat list.
 *
 * Nesting is real `<ul>`/`<li>` so a screen reader gets the shape for free;
 * indentation is one CSS step per level, capped, so depth 16 still fits a
 * 375px phone. Expand and collapse is the only client state on the page.
 */

function collectParents(
  nodes: readonly DashboardNode[],
  into: string[] = [],
): string[] {
  for (const node of nodes) {
    if (node.children.length > 0) {
      into.push(node.document.id)
      collectParents(node.children, into)
    }
  }
  return into
}

export function DocumentTree({
  nodes,
  now,
  accountId,
  highlightMine,
}: {
  nodes: readonly DashboardNode[]
  now: string
  accountId: string
  highlightMine: boolean
}) {
  const parents = useMemo(() => collectParents(nodes), [nodes])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div>
      {parents.length > 0 ? (
        <div className="flex items-center justify-end gap-1 pb-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setCollapsed(new Set())}
            disabled={collapsed.size === 0}
          >
            Expand all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setCollapsed(new Set(parents))}
            disabled={collapsed.size === parents.length}
          >
            Collapse all
          </Button>
        </div>
      ) : null}

      <div className="[--tree-step:0.625rem] sm:[--tree-step:1.15rem]">
        <TreeLevel
          nodes={nodes}
          depth={0}
          now={now}
          accountId={accountId}
          highlightMine={highlightMine}
          collapsed={collapsed}
          onToggle={toggle}
        />
      </div>
    </div>
  )
}

function TreeLevel({
  nodes,
  depth,
  now,
  accountId,
  highlightMine,
  collapsed,
  onToggle,
  id,
}: {
  nodes: readonly DashboardNode[]
  depth: number
  now: string
  accountId: string
  highlightMine: boolean
  collapsed: ReadonlySet<string>
  onToggle: (id: string) => void
  id?: string
}) {
  return (
    <ul {...(id ? { id } : {})} className="grid gap-1.5">
      {nodes.map((node) => {
        const open = !collapsed.has(node.document.id)
        const hasChildren = node.children.length > 0
        return (
          <li key={node.document.id} className="min-w-0">
            <TreeRow
              node={node}
              depth={depth}
              now={now}
              accountId={accountId}
              highlightMine={highlightMine}
              open={open}
              onToggle={onToggle}
            />
            {hasChildren && open ? (
              <div className="mt-1.5">
                <TreeLevel
                  id={`subtree-${node.document.id}`}
                  nodes={node.children}
                  depth={depth + 1}
                  now={now}
                  accountId={accountId}
                  highlightMine={highlightMine}
                  collapsed={collapsed}
                  onToggle={onToggle}
                />
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function TreeRow({
  node,
  depth,
  now,
  accountId,
  highlightMine,
  open,
  onToggle,
}: {
  node: DashboardNode
  depth: number
  now: string
  accountId: string
  highlightMine: boolean
  open: boolean
  onToggle: (id: string) => void
}) {
  const { document, children, descendants } = node
  const mine = document.authorAccountId === accountId
  const editor = isDocumentEditor(document)
  const updated = relativeTime(document.updatedAt, now)

  const body = (
    <>
      <span className="flex min-w-0 items-center gap-2 sm:flex-1">
        <span
          className={cn(
            'truncate text-[0.9375rem] leading-ui font-medium',
            mine && highlightMine ? 'text-neutral-50' : 'text-neutral-100',
            'group-hover/row:text-brand-100',
          )}
        >
          {document.title}
        </span>
        {children.length > 0 && !open ? (
          <Badge variant="muted" className="shrink-0">
            +{descendants}
          </Badge>
        ) : null}
        {document.disabled ? (
          <Badge variant="warn" className="shrink-0">
            <EyeOff aria-hidden />
            Disabled
          </Badge>
        ) : null}
        {editor ? null : (
          <Badge variant="outline" className="shrink-0">
            Read only
          </Badge>
        )}
      </span>

      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 sm:shrink-0">
        <KindTag kind={document.kind} />
        <VisibilityTag
          visibility={document.effectiveVisibility}
          inherited={editor ? document.accessSource === 'inherited' : false}
        />
        <span data-numeric className="text-micro-lg text-neutral-300">
          v{document.latestVersionNumber}
        </span>
        <span className="text-micro-lg min-w-0 truncate text-neutral-400">
          {mine ? 'You' : document.authorName}
        </span>
        <span
          className="text-micro-lg shrink-0 text-neutral-500"
          title={absoluteDateTime(document.updatedAt)}
        >
          {updated}
        </span>
      </span>
    </>
  )

  const rowClass = cn(
    'group/row grid min-w-0 flex-1 gap-1.5 rounded-lg border px-3 py-2.5',
    'transition-[border-color,background-color] duration-200 ease-agent',
    'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
    'hover:border-brand-300/35 hover:bg-neutral-800/35',
    'sm:flex sm:items-center sm:gap-3 sm:py-2',
    mine && highlightMine
      ? 'border-brand-300/30 bg-brand-300/[0.05]'
      : 'border-border bg-card',
  )

  return (
    <div
      className="flex items-stretch gap-1"
      style={{ paddingLeft: `calc(var(--tree-step) * ${Math.min(depth, 8)})` }}
    >
      {depth > 0 ? (
        <span
          aria-hidden
          className="w-px shrink-0 self-stretch rounded-full bg-border/70"
        />
      ) : null}

      {children.length > 0 ? (
        <button
          type="button"
          onClick={() => onToggle(document.id)}
          aria-expanded={open}
          aria-controls={`subtree-${document.id}`}
          title={open ? 'Collapse' : `Expand ${descendants} below`}
          className={cn(
            'flex w-6 shrink-0 items-center justify-center rounded-md text-neutral-500',
            'transition-colors duration-200 ease-agent',
            'hover:bg-neutral-800/70 hover:text-brand-100',
            'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          )}
        >
          <span className="sr-only">
            {open ? 'Collapse' : 'Expand'} {document.title}
          </span>
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3.5 transition-transform duration-200 ease-agent',
              open ? 'rotate-90' : '',
            )}
          />
        </button>
      ) : (
        <span
          aria-hidden
          className="flex w-6 shrink-0 items-center justify-center"
        >
          <span className="size-1 rounded-full bg-neutral-700" />
        </span>
      )}

      {editor ? (
        <Link
          to="/dashboard/documents/$id"
          params={{ id: document.id }}
          className={rowClass}
        >
          {body}
        </Link>
      ) : (
        <a href={document.hubUrl} className={rowClass}>
          {body}
        </a>
      )}
    </div>
  )
}

/**
 * Documents from outside this workspace: readable because they are public, or
 * because someone invited this email. Flat by design — their hierarchy is not
 * ours to draw, and the hub page shows it without leaking hidden parents.
 */
export function SharedDocumentList({
  documents,
  now,
}: {
  documents: readonly DocumentView[]
  now: string
}) {
  return (
    <ul className="grid gap-1.5">
      {documents.map((document) => (
        <li key={document.id} className="min-w-0">
          <a
            href={document.hubUrl}
            className={cn(
              'group/row grid min-w-0 gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5',
              'transition-[border-color,background-color] duration-200 ease-agent',
              'hover:border-complement-400/35 hover:bg-neutral-800/35',
              'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              'sm:flex sm:items-center sm:gap-3 sm:py-2',
            )}
          >
            <span className="flex min-w-0 items-center gap-2 sm:flex-1">
              <span className="truncate text-[0.9375rem] leading-ui font-medium text-neutral-100 group-hover/row:text-brand-100">
                {document.title}
              </span>
              <Badge variant="outline" className="shrink-0">
                Read only
              </Badge>
            </span>
            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 sm:shrink-0">
              <KindTag kind={document.kind} />
              <Badge variant="outline">{document.workspaceSlug}</Badge>
              <VisibilityTag visibility={document.effectiveVisibility} />
              <span className="text-micro-lg min-w-0 truncate text-neutral-400">
                {document.authorName}
              </span>
              <span
                className="text-micro-lg shrink-0 text-neutral-500"
                title={absoluteDateTime(document.updatedAt)}
              >
                {relativeTime(document.updatedAt, now)}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  )
}
