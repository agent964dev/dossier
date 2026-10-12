import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  File,
  FileText,
  History as HistoryIcon,
  Info,
  RotateCcw,
  Trash2,
  Undo2,
  UserMinus,
} from 'lucide-react'
import { useId, useState, type MouseEvent, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { isScreenFailure } from '../server/failure'
import {
  historyView,
  restore,
  type HistoryLine,
  type HistoryView,
  type PushFileView,
  type PushView,
  type RestoreChoice,
} from '../server/history'
import { Counts, DiffView } from './diff-view'
import { Button } from './ui/button'
import { Modal } from './ui/modal'

/** Where the screen's history comes from, for Show older. */
export interface HistoryAt {
  readonly workspace: string
  readonly tree: string
  readonly path: string
  readonly folder: boolean
}

/** The push opened beside the list (desktop) or instead of it (phones). */
export type OpenedPush =
  | { readonly number: number; readonly view: PushView }
  | { readonly number: number; readonly failure: string }

/** What the restore sheet asks about. */
interface Asking {
  readonly title: string
  readonly sentence: string
  /** The file or folder card under the sentence. */
  readonly name: string
  readonly where: string
  readonly target: string
  readonly to: RestoreChoice
  /** The sentence a conflict shows, when the screen words it. */
  readonly conflict: string | null
}

const META = 'block truncate font-mono text-xs text-neutral-400'
const FOCUS = 'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

/** A plain left click: the screen opens it in place. */
const inPlace = (event: MouseEvent) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey

const linesText = (count: number) => (count === 1 ? '1 line' : `${count} lines`)

/** "added · 48 lines", "changed", "deleted · 12 lines". */
export const fileDetail = (file: PushFileView): string =>
  file.text && file.lines !== null && file.change !== 'changed'
    ? `${file.change} · ${linesText(file.lines)}`
    : file.change

/** The sentence of a deletion's restore sheet. */
export const deletionSentence = (line: HistoryLine): string => {
  const before =
    line.who === ''
      ? `before it was deleted on ${line.date}`
      : `before ${line.who} deleted it on ${line.date}`
  const from = line.push === null ? '' : `, from push ${line.push.number}`
  return `It comes back as it was ${before}${from}.`
}

/** The folder a path sits in, as the history names it: "acme/". */
const whereOf = (name: string, folder: string) => {
  const slash = name.replace(/\/$/, '').lastIndexOf('/')
  return slash < 0 ? folder : name.slice(0, slash + 1)
}

function LineIcon({
  children,
  tone = 'plain',
}: {
  children: ReactNode
  tone?: 'plain' | 'deleted' | 'current'
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg border font-mono text-xs [&_svg]:size-4',
        tone === 'deleted' &&
          'border-error-400/30 bg-error-400/10 text-error-300',
        tone === 'current' &&
          'border-brand-300/60 bg-brand-300/10 text-brand-100',
        tone === 'plain' && 'border-border bg-neutral-800/70 text-neutral-300',
      )}
    >
      {children}
    </span>
  )
}

function Line({
  line,
  current,
  newest,
  pushHref,
  onOpenPush,
  onRestore,
}: {
  line: HistoryLine
  current: boolean
  /** The newest push here: the one line that offers Restore to here. */
  newest: boolean
  pushHref: (number: number | null) => string
  onOpenPush: (number: number | null) => void
  onRestore: (line: HistoryLine) => void
}) {
  const push = line.kind === 'push' ? line.push : null
  const icon =
    push !== null ? (
      <LineIcon tone={current ? 'current' : 'plain'}>{push.number}</LineIcon>
    ) : line.kind === 'delete' ? (
      <LineIcon tone="deleted">
        <Trash2 />
      </LineIcon>
    ) : line.kind === 'restore' ? (
      <LineIcon>
        <RotateCcw />
      </LineIcon>
    ) : line.kind === 'move' ? (
      <LineIcon>
        <ArrowRight />
      </LineIcon>
    ) : (
      <LineIcon>
        <UserMinus />
      </LineIcon>
    )
  return (
    <li
      className={cn(
        'flex min-h-14 items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors duration-200 ease-agent',
        current ? 'bg-card' : push !== null && 'hover:bg-neutral-800/35',
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">
        {push !== null ? (
          <a
            href={pushHref(push.number)}
            aria-current={current ? 'true' : undefined}
            onClick={(event) => {
              if (!inPlace(event)) return
              event.preventDefault()
              onOpenPush(push.number)
            }}
            className={cn(
              'block truncate rounded-sm text-[0.9375rem] text-neutral-50 hover:text-brand-100',
              FOCUS,
            )}
          >
            {line.label}
          </a>
        ) : (
          <p className="truncate text-[0.9375rem] text-neutral-50">
            {line.label}
          </p>
        )}
        <span className={META}>{line.meta}</span>
      </div>
      {line.restore === null ? null : line.kind === 'delete' ? (
        <Button
          size="xs"
          className="h-7 px-2.5"
          aria-haspopup="dialog"
          aria-label={`Restore ${line.name}`}
          onClick={() => onRestore(line)}
        >
          <Undo2 aria-hidden />
          Restore
        </Button>
      ) : !newest ? null : (
        // On a phone, the newest push offers it in the list; any opened push
        // carries it, which is where a desktop finds it.
        <Button
          variant="outline"
          size="xs"
          className="h-7 px-2.5 lg:hidden"
          aria-haspopup="dialog"
          aria-label={`Restore to here, push ${push?.number ?? ''}`}
          onClick={() => onRestore(line)}
        >
          Restore to here
        </Button>
      )}
    </li>
  )
}

function Crumbs({ crumbs }: { crumbs: HistoryView['crumbs'] }) {
  return (
    <nav aria-label="Breadcrumbs">
      <ol className="flex flex-wrap items-center gap-x-1.5 font-mono text-xs text-neutral-400">
        {crumbs.map((crumb, index) => (
          <li key={crumb.href} className="flex items-center gap-1.5">
            {index === 0 ? null : (
              <span aria-hidden className="text-neutral-600">
                /
              </span>
            )}
            <a
              href={crumb.href}
              aria-current={index === crumbs.length - 1 ? 'page' : undefined}
              className={cn(
                'rounded-sm break-all hover:text-neutral-100',
                FOCUS,
              )}
            >
              {crumb.name}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}

/** A name for the first page, so Show older starts again after a change. */
const pageKey = (view: HistoryView) =>
  `${view.target}|${view.lines.length}|${view.lines[0]?.seq ?? ''}|${view.next ?? ''}`

const restoreToHere = (
  view: HistoryView,
  number: number,
  target: string,
): Asking => ({
  title: `Restore ${view.folder.name} to push ${number}?`,
  sentence: `${view.folder.name} goes back to how it was at push ${number}. Data written since stays, and every change stays in history.`,
  name: view.folder.name,
  where: `push ${number}`,
  target,
  to: { push: number },
  conflict: null,
})

export function HistoryScreen({
  view,
  at,
  opened,
  pushHref,
  onOpenPush,
  onRestored,
}: {
  view: HistoryView
  at: HistoryAt
  opened: OpenedPush | null
  /** The screen's address with a push opened, or with none. */
  pushHref: (number: number | null) => string
  onOpenPush: (number: number | null) => void
  /** After a restore: read the history again. */
  onRestored: () => void
}) {
  const key = pageKey(view)
  const [older, setOlder] = useState<{
    readonly key: string
    readonly lines: readonly HistoryLine[]
    readonly next: string | null
  }>({ key, lines: [], next: view.next })
  const [loading, setLoading] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [asking, setAsking] = useState<Asking | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const listId = useId()
  // A new first page (after a restore) starts the older pages again.
  const shown = older.key === key ? older : { key, lines: [], next: view.next }
  const lines = [...view.lines, ...shown.lines]
  const newest = lines.find((line) => line.kind === 'push')?.seq ?? null

  const showOlder = async () => {
    if (shown.next === null) return
    setLoading('loading')
    try {
      const page = await historyView({ data: { ...at, cursor: shown.next } })
      if (isScreenFailure(page)) {
        setLoading('failed')
        return
      }
      setOlder({ key, lines: [...shown.lines, ...page.lines], next: page.next })
      setLoading('idle')
    } catch {
      setLoading('failed')
    }
  }

  const ask = (line: HistoryLine) => {
    if (line.restore === null) return
    if (line.kind === 'delete') {
      setAsking({
        title: `Restore ${line.name}?`,
        sentence: deletionSentence(line),
        name: line.name,
        where: whereOf(line.name, view.folder.name),
        target: line.restore.target,
        to: line.restore.to,
        conflict: `A newer ${line.name} is there now. Move it first.`,
      })
      return
    }
    setAsking(restoreToHere(view, line.push?.number ?? 0, line.restore.target))
  }

  const pushOpen = opened !== null
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-6">
      <div className={cn('flex flex-col gap-2', pushOpen && 'max-lg:hidden')}>
        <Crumbs crumbs={view.crumbs} />
        <h1 className="font-clash text-[2rem] leading-tight font-semibold tracking-[-0.03em] text-neutral-50 lg:sr-only">
          History
        </h1>
      </div>
      <div role="status" className={cn(notice === null && 'sr-only')}>
        {notice === null ? null : (
          <p className="rounded-xl border border-success-500/30 bg-success-500/10 px-4 py-2.5 text-sm text-success-300">
            {notice}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:items-start lg:gap-8">
        <section
          aria-labelledby={listId}
          className={cn(
            'flex min-w-0 flex-col gap-3',
            pushOpen && 'max-lg:hidden',
          )}
        >
          <h2
            id={listId}
            className={cn(
              'flex items-center gap-2 text-sm text-neutral-300',
              'lg:font-mono lg:text-[0.6875rem] lg:tracking-[0.2em] lg:text-neutral-400 lg:uppercase',
            )}
          >
            <HistoryIcon
              aria-hidden
              className="size-4 text-neutral-500 lg:hidden"
            />
            {view.folder.name}, newest first
            <span
              aria-hidden
              className="hidden h-px flex-1 bg-border/80 lg:block"
            />
          </h2>
          {lines.length === 0 ? (
            <p className="rounded-xl border border-border bg-card px-5 py-8 text-center font-clash text-[1.125rem] font-semibold tracking-[-0.02em] text-neutral-50">
              No history yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {lines.map((line) => (
                <Line
                  key={line.seq}
                  line={line}
                  current={
                    opened !== null &&
                    line.kind === 'push' &&
                    line.push?.number === opened.number
                  }
                  newest={line.seq === newest}
                  pushHref={pushHref}
                  onOpenPush={onOpenPush}
                  onRestore={ask}
                />
              ))}
            </ul>
          )}
          {shown.next === null ? null : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={loading === 'loading'}
                onClick={() => void showOlder()}
              >
                {loading === 'loading' ? 'Loading…' : 'Show older'}
              </Button>
              {loading === 'failed' ? (
                <span role="alert" className="text-sm text-error-300">
                  Could not load older history. Try again.
                </span>
              ) : null}
            </div>
          )}
          <p className="flex items-start gap-2 text-[0.8125rem] leading-relaxed text-neutral-400">
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Deleted files and data stay restorable for{' '}
              {view.retentionDays === 1
                ? '1 day'
                : `${view.retentionDays} days`}
              , then are purged.
            </span>
          </p>
        </section>
        {opened === null ? (
          <p className="hidden rounded-xl border border-dashed border-border px-5 py-8 text-center text-sm text-neutral-400 lg:block">
            Open a push to see what it changed.
          </p>
        ) : 'failure' in opened ? (
          <section
            aria-label={`Push ${opened.number}`}
            className="flex min-w-0 flex-col gap-3"
          >
            <BackLink href={pushHref(null)} onBack={() => onOpenPush(null)} />
            <p className="rounded-xl border border-border bg-card px-5 py-6 text-sm text-neutral-300">
              {opened.failure}
            </p>
          </section>
        ) : (
          <PushDetail
            key={opened.number}
            push={opened.view}
            backHref={pushHref(null)}
            onBack={() => onOpenPush(null)}
            onRestore={() =>
              setAsking(restoreToHere(view, opened.number, view.target))
            }
          />
        )}
      </div>
      <RestoreSheet
        asking={asking}
        onClose={() => setAsking(null)}
        onRestored={(text) => {
          setAsking(null)
          setNotice(text)
          onRestored()
        }}
      />
    </main>
  )
}

function BackLink({ href, onBack }: { href: string; onBack: () => void }) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (!inPlace(event)) return
        event.preventDefault()
        onBack()
      }}
      className={cn(
        'flex w-fit items-center gap-1 rounded-sm font-mono text-xs text-neutral-400 hover:text-neutral-100 lg:hidden',
        FOCUS,
      )}
    >
      <ChevronLeft aria-hidden className="size-3.5" />
      History
    </a>
  )
}

/** One push: the files it changed under the folder, and the open one's diff. */
export function PushDetail({
  push,
  backHref,
  onBack,
  onRestore,
}: {
  push: PushView
  backHref: string
  onBack: () => void
  onRestore: () => void
}) {
  // The first text file opens with the push, as the mocks draw it.
  const [open, setOpen] = useState<string | null>(
    () => push.files.find((file) => file.text)?.path ?? null,
  )
  const id = useId()
  const opened = push.files.find((file) => file.path === open) ?? null
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-4"
    >
      <BackLink href={backHref} onBack={onBack} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2
            id={`${id}-title`}
            className="font-clash text-[1.625rem] leading-tight font-semibold tracking-[-0.03em] break-words text-neutral-50 lg:text-[2rem]"
          >
            Push {push.number}
            {push.title === null ? null : (
              <span className="max-lg:hidden"> · {push.title}</span>
            )}
          </h2>
          <p className="flex items-center gap-2 text-sm text-neutral-300">
            <HistoryIcon
              aria-hidden
              className="size-4 shrink-0 text-neutral-500"
            />
            <span className="min-w-0">
              {push.title === null ? null : (
                <span className="lg:hidden">{push.title} · </span>
              )}
              {push.meta}
            </span>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="sm:h-10 sm:px-4 sm:text-sm"
          aria-haspopup="dialog"
          onClick={onRestore}
        >
          <Undo2 aria-hidden />
          Restore to here
        </Button>
      </div>
      {push.files.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-5 py-6 text-sm text-neutral-300">
          This push changed nothing here.
        </p>
      ) : (
        <ul
          aria-label={`Files push ${push.number} changed`}
          className="divide-y divide-border/80 overflow-hidden rounded-xl border border-border bg-card"
        >
          {push.files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              open={file.path === open}
              controls={`${id}-diff`}
              onToggle={() => setOpen(file.path === open ? null : file.path)}
            />
          ))}
        </ul>
      )}
      <div id={`${id}-diff`}>
        {opened === null || !opened.text ? null : (
          <DiffView
            key={opened.path}
            name={opened.name}
            target={opened.target}
            push={push.number}
            change={opened.change}
            added={opened.added}
            removed={opened.removed}
          />
        )}
      </div>
    </section>
  )
}

function FileRow({
  file,
  open,
  controls,
  onToggle,
}: {
  file: PushFileView
  open: boolean
  controls: string
  onToggle: () => void
}) {
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg border bg-neutral-800/70 [&_svg]:size-4',
          open
            ? 'border-brand-300/50 text-brand-100'
            : 'border-border text-neutral-300',
        )}
      >
        {file.text ? <FileText /> : <File />}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate font-mono text-[0.8125rem] text-neutral-50">
          {file.name}
        </span>
        <span className="block truncate font-mono text-xs text-neutral-400">
          {fileDetail(file)}
        </span>
      </span>
      {file.text ? (
        <>
          <Counts
            added={file.added}
            removed={file.removed}
            change={file.change}
          />
          {open ? (
            <ChevronDown
              aria-hidden
              className="size-4 shrink-0 text-neutral-400"
            />
          ) : (
            <ChevronRight
              aria-hidden
              className="size-4 shrink-0 text-neutral-400"
            />
          )}
        </>
      ) : (
        <span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[0.6875rem] tracking-[0.12em] text-neutral-400 uppercase">
          Binary
        </span>
      )}
    </>
  )
  const row = 'flex min-h-14 w-full items-center gap-3 px-3 py-2.5'
  return (
    <li
      className={cn(
        'border-l-2',
        open ? 'border-l-brand-300 bg-brand-300/5' : 'border-l-transparent',
      )}
    >
      {file.text ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={controls}
          onClick={onToggle}
          className={cn(
            row,
            'transition-colors duration-200 ease-agent hover:bg-neutral-800/35 focus-visible:ring-inset',
            FOCUS,
          )}
        >
          {body}
        </button>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  )
}

/** "Restore plan.html?": the dialog both restores open. */
function RestoreSheet({
  asking,
  onClose,
  onRestored,
}: {
  asking: Asking | null
  onClose: () => void
  onRestored: (notice: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  // Each question starts afresh.
  const [askedAbout, setAskedAbout] = useState(asking)
  if (askedAbout !== asking) {
    setAskedAbout(asking)
    setBusy(false)
    setRefused(null)
  }
  const send = async () => {
    if (asking === null) return
    setBusy(true)
    setRefused(null)
    try {
      const result = await restore({
        data: { target: asking.target, to: asking.to },
      })
      if (isScreenFailure(result)) {
        setBusy(false)
        setRefused(
          result.error.code === 'conflict' && asking.conflict !== null
            ? asking.conflict
            : result.error.message,
        )
        return
      }
      onRestored(`Restored ${asking.name}.`)
    } catch {
      setBusy(false)
      setRefused('Something went wrong. Try again.')
    }
  }
  return (
    <Modal
      open={asking !== null}
      onClose={onClose}
      title={asking?.title ?? 'Restore'}
      handle
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={() => void send()}>
            <Undo2 aria-hidden />
            Restore
          </Button>
        </>
      }
    >
      {asking === null ? null : (
        <div className="flex flex-col gap-3">
          <p className="flex items-start gap-2.5 rounded-xl border border-brand-300/30 bg-brand-300/8 px-3.5 py-3 text-sm leading-relaxed text-neutral-100">
            <RotateCcw
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-brand-300"
            />
            <span>{asking.sentence}</span>
          </p>
          <div className="flex items-center gap-3 rounded-xl border border-border bg-neutral-900/50 px-3 py-2.5">
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-300"
            >
              <FileText className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-mono text-sm text-neutral-50">
                {asking.name}
              </span>
              <span className="block truncate font-mono text-xs text-neutral-400">
                {asking.where}
              </span>
            </span>
          </div>
          {refused === null ? null : (
            <p role="alert" className="text-sm text-error-300">
              {refused}
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
