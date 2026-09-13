import { cn } from '@/lib/utils'
import type {
  DiffHunk,
  DiffLayout,
  DiffLine,
  DiffVersionRef,
} from '../server/diff'

/**
 * The diff surface (PLAN section 1, "Versions").
 *
 * Auto layout renders conventional unified ordering on a phone and paired
 * columns from `md` upward. Colour is never the only signal: every changed
 * line also carries a `+`/`-` marker and a tinted left edge.
 */

const CODE =
  'min-w-0 flex-1 font-mono text-[0.78125rem] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere] [tab-size:2]'
const NUMBER =
  'select-none px-1.5 py-[3px] text-right font-mono text-[0.6875rem] leading-[1.6] tabular-nums'
const CELL = 'flex min-w-0 items-start gap-2 px-2 py-[3px]'

const TONE = {
  context: {
    cell: 'text-neutral-400',
    number: 'text-neutral-600',
    sign: 'text-neutral-700',
    mark: ' ',
  },
  remove: {
    cell: 'border-l-2 border-error-500/45 bg-error-500/8 text-neutral-200',
    number: 'bg-error-500/6 text-error-300/70',
    sign: 'text-error-300',
    mark: '-',
  },
  add: {
    cell: 'border-l-2 border-success-500/40 bg-success-500/8 text-neutral-200',
    number: 'bg-success-500/6 text-success-200/70',
    sign: 'text-success-200',
    mark: '+',
  },
} as const

const FILLER = 'bg-neutral-950/45'

function Num({
  value,
  op,
  className,
}: {
  value: number | null
  op: DiffLine['op']
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-numeric
      className={cn(NUMBER, TONE[op].number, className)}
    >
      {value ?? ''}
    </span>
  )
}

function Code({ line, className }: { line: DiffLine; className?: string }) {
  const tone = TONE[line.op]
  return (
    <div className={cn(CELL, tone.cell, className)}>
      <span
        className={cn(
          'shrink-0 select-none font-mono text-[0.78125rem] leading-[1.6]',
          tone.sign,
        )}
      >
        {tone.mark}
      </span>
      <span className={CODE}>
        {line.text === '' ? ' ' : line.text}
        {line.noNewline ? (
          <span className="ml-2 text-[0.625rem] text-neutral-500">
            no newline at EOF
          </span>
        ) : null}
      </span>
    </div>
  )
}

function HunkHeader({
  hunk,
  total,
  first,
  idPrefix,
}: {
  hunk: DiffHunk
  total: number
  first: boolean
  idPrefix: string
}) {
  return (
    <h3
      id={`${idPrefix}-${hunk.index}`}
      data-diff-hunk={hunk.index}
      tabIndex={-1}
      aria-label={`Change ${hunk.index} of ${total}: ${hunk.added} added, ${hunk.removed} removed, at line ${hunk.newStart}`}
      className={cn(
        'col-span-full flex scroll-mt-44 flex-wrap items-center justify-between gap-x-3 gap-y-1',
        'border-b border-border/70 bg-neutral-800/35 px-3 py-1.5 md:scroll-mt-36',
        'outline-none focus-visible:bg-brand-300/8 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        first ? '' : 'border-t border-border/70',
      )}
    >
      <span className="text-micro-lg text-neutral-400">{hunk.label}</span>
      <span className="text-micro-lg flex items-center gap-2.5 text-neutral-500">
        <span className="text-success-200/80">+{hunk.added}</span>
        <span className="text-error-300/80">−{hunk.removed}</span>
        <span>
          {hunk.index}/{total}
        </span>
      </span>
    </h3>
  )
}

function ColumnHead({
  version,
  role,
}: {
  version: DiffVersionRef
  role: string
}) {
  return (
    <div className="text-micro-lg col-span-2 flex items-baseline gap-2 border-b border-border/70 bg-neutral-900/70 px-3 py-2 text-neutral-500">
      <span className="text-neutral-300">v{version.versionNumber}</span>
      <span>{role}</span>
    </div>
  )
}

function UnifiedGrid({
  hunks,
  className,
  idPrefix,
}: {
  hunks: readonly DiffHunk[]
  className?: string
  idPrefix: string
}) {
  const total = hunks.length
  return (
    <div
      className={cn(
        'grid grid-cols-[2.25rem_2.25rem_minmax(0,1fr)] items-stretch',
        className,
      )}
    >
      {hunks.map((hunk) => (
        <div key={hunk.index} className="contents">
          <HunkHeader
            hunk={hunk}
            total={total}
            first={hunk.index === 1}
            idPrefix={idPrefix}
          />
          {hunk.lines.map((line, index) => (
            <div key={`${hunk.index}-${index}`} className="contents">
              <Num value={line.oldNumber} op={line.op} />
              <Num value={line.newNumber} op={line.op} />
              <Code line={line} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function SideGrid({
  hunks,
  from,
  to,
  className,
  idPrefix,
}: {
  hunks: readonly DiffHunk[]
  from: DiffVersionRef
  to: DiffVersionRef
  className?: string
  idPrefix: string
}) {
  const total = hunks.length
  return (
    <div
      className={cn(
        'grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem_minmax(0,1fr)] items-stretch',
        className,
      )}
    >
      <ColumnHead version={from} role="from" />
      <ColumnHead version={to} role="to" />

      {hunks.map((hunk) => (
        <div key={hunk.index} className="contents">
          <HunkHeader
            hunk={hunk}
            total={total}
            first={hunk.index === 1}
            idPrefix={idPrefix}
          />
          {hunk.rows.map((row, index) => (
            <div key={`${hunk.index}-${index}`} className="contents">
              {row.old === null ? (
                <>
                  <span aria-hidden className={FILLER} />
                  <span aria-hidden className={FILLER} />
                </>
              ) : (
                <>
                  <Num value={row.old.oldNumber} op={row.old.op} />
                  <Code line={row.old} />
                </>
              )}
              {row.added === null ? (
                <>
                  <span aria-hidden className={FILLER} />
                  <span aria-hidden className={FILLER} />
                </>
              ) : (
                <>
                  <Num value={row.added.newNumber} op={row.added.op} />
                  <Code line={row.added} />
                </>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function DiffView({
  hunks,
  layout,
  from,
  to,
}: {
  hunks: readonly DiffHunk[]
  layout: DiffLayout
  from: DiffVersionRef
  to: DiffVersionRef
}) {
  if (layout === 'unified') {
    return <UnifiedGrid hunks={hunks} idPrefix="hunk" />
  }
  if (layout === 'side') {
    return <SideGrid hunks={hunks} from={from} to={to} idPrefix="hunk" />
  }
  return (
    <>
      <UnifiedGrid hunks={hunks} idPrefix="hunk-mobile" className="md:hidden" />
      <SideGrid
        hunks={hunks}
        from={from}
        to={to}
        idPrefix="hunk-desktop"
        className="hidden md:grid"
      />
    </>
  )
}
