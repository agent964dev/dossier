import { FileText } from 'lucide-react'
import { useEffect, useRef, useState, type ComponentType } from 'react'

import { isScreenFailure } from '../server/failure'
import { diffView, type DiffView as Diff } from '../server/history'
import { Button } from './ui/button'

/** Split from this width of the diff itself, unified below it. */
export const SPLIT_FROM_PX = 640

type CodeProps = {
  path: string
  before: string | null
  after: string | null
  split: boolean
  label: string
}

/** "+2 −1"; only the counts a change has. */
export function Counts({
  added,
  removed,
  change,
}: {
  added: number | null
  removed: number | null
  change: 'added' | 'changed' | 'deleted'
}) {
  const plus = change === 'deleted' ? null : added
  const minus = change === 'added' ? null : removed
  if (plus === null && minus === null) return null
  return (
    <span
      dir="ltr"
      className="font-mono text-xs whitespace-nowrap tabular-nums"
      aria-label={[
        plus === null ? null : `${plus} added`,
        minus === null ? null : `${minus} removed`,
      ]
        .filter((part) => part !== null)
        .join(', ')}
    >
      {plus === null ? null : <span className="text-success-300">+{plus}</span>}
      {plus !== null && minus !== null ? ' ' : null}
      {minus === null ? null : <span className="text-error-300">−{minus}</span>}
    </span>
  )
}

/** The width of an element, followed as it changes. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    setWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry !== undefined) setWidth(entry.contentRect.width)
    })
    observer.observe(element as never)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

/**
 * The code of a diff. @pierre/diffs and Shiki load here, in the browser
 * only, the first time a diff opens.
 */
export function DiffCodeLoader({
  diff,
  label,
}: {
  diff: Pick<Diff, 'path' | 'before' | 'after'>
  label: string
}) {
  const [Code, setCode] = useState<ComponentType<CodeProps> | 'failed' | null>(
    null,
  )
  const { ref, width } = useWidth()
  useEffect(() => {
    // The server build drops this branch, so the libraries never enter the
    // Worker; effects only run in the browser anyway.
    if (import.meta.env.SSR) return
    let live = true
    import('./diff-code').then(
      (loaded) => {
        if (live) setCode(() => loaded.DiffCode)
      },
      () => {
        if (live) setCode('failed')
      },
    )
    return () => {
      live = false
    }
  }, [])
  return (
    <div ref={ref} className="min-w-0">
      {Code === null ? (
        <p role="status" className="px-3 py-3 text-sm text-neutral-400">
          Loading diff…
        </p>
      ) : Code === 'failed' ? (
        <p role="status" className="px-3 py-3 text-sm text-neutral-300">
          Could not show this diff. Reload the page to try again.
        </p>
      ) : (
        <Code
          path={diff.path}
          before={diff.before}
          after={diff.after}
          split={width >= SPLIT_FROM_PX}
          label={label}
        />
      )}
    </div>
  )
}

/**
 * One file's diff in a push: its two versions, loaded when the file opens.
 * A binary file, or one too large to show, says so with no diff.
 */
export function DiffView({
  name,
  target,
  push,
  change,
  added,
  removed,
}: {
  /** As the history's folder names it. */
  name: string
  /** '<workspace>/<tree>/<path>'. */
  target: string
  push: number
  change: 'added' | 'changed' | 'deleted'
  added: number | null
  removed: number | null
}) {
  const [attempt, setAttempt] = useState(0)
  return (
    <section
      aria-label={`Changes to ${name}`}
      className="overflow-hidden rounded-xl border border-border bg-neutral-950"
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-border bg-card px-3 py-2 text-xs text-neutral-200">
        <FileText aria-hidden className="size-3.5 shrink-0 text-neutral-400" />
        <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
        <Counts added={added} removed={removed} change={change} />
      </div>
      <DiffBody
        key={`${target}|${push}|${attempt}`}
        name={name}
        target={target}
        push={push}
        change={change}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    </section>
  )
}

function DiffBody({
  name,
  target,
  push,
  change,
  onRetry,
}: {
  name: string
  target: string
  push: number
  change: 'added' | 'changed' | 'deleted'
  onRetry: () => void
}) {
  const [state, setState] = useState<Diff | 'loading' | 'failed'>('loading')
  useEffect(() => {
    let live = true
    diffView({ data: { target, from: null, to: push } }).then(
      (value) => {
        if (live) setState(isScreenFailure(value) ? 'failed' : value)
      },
      () => {
        if (live) setState('failed')
      },
    )
    return () => {
      live = false
    }
  }, [target, push])
  if (state === 'loading') {
    return (
      <p role="status" className="px-3 py-3 text-sm text-neutral-400">
        Loading diff…
      </p>
    )
  }
  if (state === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-3 px-3 py-3">
        <p role="status" className="text-sm text-neutral-300">
          Could not load this diff.
        </p>
        <Button variant="outline" size="xs" onClick={onRetry}>
          Try again
        </Button>
      </div>
    )
  }
  if (state.binary) {
    return (
      <p className="px-3 py-3 text-sm text-neutral-300">
        {change === 'changed'
          ? 'Changed'
          : change === 'added'
            ? 'Added'
            : 'Deleted'}{' '}
        · binary or too large to show line by line
      </p>
    )
  }
  return <DiffCodeLoader diff={state} label={`Line changes in ${name}`} />
}
