import { useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeftRight,
  Columns2,
  FileCode,
  MonitorSmartphone,
  Rows3,
  Type,
} from 'lucide-react'

import { absoluteDateTime, fileSize } from './format'
import { Button } from './ui/button'
import { Select } from './ui/input'
import { cn } from '@/lib/utils'
import type { DiffLayout, DiffMode, DiffVersionRef } from '../server/diff'

/** The whole URL vocabulary of the diff page, in one place. */
export interface DiffSearch {
  readonly from?: number
  readonly to?: number
  /** Absent means the layout follows the viewport (side on wide, unified on a phone). */
  readonly view?: 'side' | 'unified'
  /** Absent means the html diff; `text` asks for visible text only. */
  readonly mode?: 'text'
}

function readVersion(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[0-9]{1,9}$/.test(value)
        ? Number(value)
        : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** Search parsing for the route, kept beside the controls that write it. */
export function readDiffSearch(search: Record<string, unknown>): DiffSearch {
  const from = readVersion(search.from)
  const to = readVersion(search.to)
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(search.view === 'side' || search.view === 'unified'
      ? { view: search.view }
      : {}),
    ...(search.mode === 'text' ? { mode: 'text' as const } : {}),
  }
}

function versionLabel(version: DiffVersionRef): string {
  const size = fileSize(version.fileSize)
  return `v${version.versionNumber} · ${absoluteDateTime(version.createdAt)}${
    size ? ` · ${size}` : ''
  }${version.current ? ' · current' : ''}`
}

const ROUTE = '/dashboard/documents/$id/diff' as const

export function DiffControls({
  documentId,
  versions,
  from,
  to,
  layout,
  mode,
  textSupported,
}: {
  documentId: string
  versions: readonly DiffVersionRef[]
  from: DiffVersionRef
  to: DiffVersionRef
  layout: DiffLayout
  mode: DiffMode
  textSupported: boolean
}) {
  const navigate = useNavigate()
  // Rendered on the server, so the form works before (and without) hydration;
  // once React is live the selects navigate on change and the button retires.
  const [enhanced, setEnhanced] = useState(false)
  // oxlint-disable-next-line react/set-state-in-effect -- Hydration enhancement.
  useEffect(() => setEnhanced(true), [])

  /**
   * Every control writes the whole search, so no link can carry a stale
   * parameter: `undefined` in an override means "drop this one from the URL".
   */
  const search = (overrides: {
    from?: number
    to?: number
    view?: 'side' | 'unified' | undefined
    mode?: 'text' | undefined
  }): DiffSearch => {
    const view =
      'view' in overrides
        ? overrides.view
        : layout === 'auto'
          ? undefined
          : layout
    const compare =
      'mode' in overrides
        ? overrides.mode
        : mode === 'text'
          ? ('text' as const)
          : undefined
    return {
      from: overrides.from ?? from.versionNumber,
      to: overrides.to ?? to.versionNumber,
      ...(view === undefined ? {} : { view }),
      ...(compare === undefined ? {} : { mode: compare }),
    }
  }

  function pick(side: 'from' | 'to', value: string) {
    const picked = readVersion(value)
    if (picked === undefined) return
    void navigate({
      to: ROUTE,
      params: { id: documentId },
      search: search(side === 'from' ? { from: picked } : { to: picked }),
    })
  }

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-4 sm:px-5">
      <form
        method="get"
        action={`/dashboard/documents/${documentId}/diff`}
        className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4"
      >
        {layout === 'auto' ? null : (
          <input type="hidden" name="view" value={layout} />
        )}
        {mode === 'text' ? (
          <input type="hidden" name="mode" value="text" />
        ) : null}

        <VersionPicker
          id="diff-from"
          name="from"
          label="From"
          hint="older"
          value={from.versionNumber}
          versions={versions}
          onPick={(value) => pick('from', value)}
        />

        {/* Swap is a link, so it is one server-rendered navigation, not state. */}
        <Link
          to={ROUTE}
          params={{ id: documentId }}
          search={search({ from: to.versionNumber, to: from.versionNumber })}
          title="Swap the two versions"
          aria-label="Swap the two versions"
          className={cn(
            'inline-flex size-9 shrink-0 items-center justify-center self-center rounded-lg border border-border',
            'text-neutral-400 transition-[color,background-color,transform] duration-200 ease-agent',
            'hover:-translate-y-[2px] hover:border-brand-300/45 hover:text-brand-100 active:translate-y-[1px]',
            'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
            'sm:mb-0.5 sm:self-end',
          )}
        >
          <ArrowLeftRight aria-hidden className="size-4 sm:rotate-0" />
        </Link>

        <VersionPicker
          id="diff-to"
          name="to"
          label="To"
          hint="newer"
          value={to.versionNumber}
          versions={versions}
          onPick={(value) => pick('to', value)}
        />

        {/* Without JavaScript the form is the whole control; with it, the
            selects navigate on change and this button would be noise. */}
        {enhanced ? null : (
          <Button type="submit" size="lg" className="shrink-0">
            Compare
          </Button>
        )}
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-3 border-t border-border/70 pt-4">
        <Segmented label="Layout">
          <SegmentedLink
            to={search({ view: undefined })}
            documentId={documentId}
            active={layout === 'auto'}
            Icon={MonitorSmartphone}
            label="Auto"
            title="Side by side on a wide screen, unified on a phone"
          />
          <SegmentedLink
            to={search({ view: 'side' })}
            documentId={documentId}
            active={layout === 'side'}
            Icon={Columns2}
            label="Side (wide)"
            title="Always side by side; best on a wide screen"
          />
          <SegmentedLink
            to={search({ view: 'unified' })}
            documentId={documentId}
            active={layout === 'unified'}
            Icon={Rows3}
            label="Unified"
            title="Always one column"
          />
        </Segmented>

        {textSupported ? (
          <Segmented label="Compare">
            <SegmentedLink
              to={search({ mode: undefined })}
              documentId={documentId}
              active={mode === 'html'}
              Icon={FileCode}
              label="HTML"
              title="Compare the stored HTML"
            />
            <SegmentedLink
              to={search({ mode: 'text' })}
              documentId={documentId}
              active={mode === 'text'}
              Icon={Type}
              label="Text"
              title="Compare the visible text only"
            />
          </Segmented>
        ) : null}

        {layout === 'auto' ? (
          <p className="text-micro-lg text-neutral-500">
            Layout follows your screen
          </p>
        ) : null}
      </div>
    </div>
  )
}

function VersionPicker({
  id,
  name,
  label,
  hint,
  value,
  versions,
  onPick,
}: {
  id: string
  name: 'from' | 'to'
  label: string
  hint: string
  value: number
  versions: readonly DiffVersionRef[]
  onPick: (value: string) => void
}) {
  return (
    <div className="min-w-0 flex-1">
      <label
        htmlFor={id}
        className="text-micro-lg flex items-baseline gap-1.5 pb-1.5"
      >
        <span className="text-neutral-400">{label}</span>
        <span className="text-neutral-500">{hint}</span>
      </label>
      <Select
        id={id}
        name={name}
        value={value}
        onChange={(event) => onPick(event.target.value)}
      >
        {versions.map((version) => (
          <option key={version.versionNumber} value={version.versionNumber}>
            {versionLabel(version)}
          </option>
        ))}
      </Select>
    </div>
  )
}

function Segmented({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-micro-lg hidden text-neutral-500 sm:inline">
        {label}
      </span>
      <div
        role="group"
        aria-label={label}
        className="flex items-center gap-0.5 rounded-lg border border-border bg-neutral-900/60 p-0.5"
      >
        {children}
      </div>
    </div>
  )
}

function SegmentedLink({
  to,
  documentId,
  active,
  Icon,
  label,
  title,
}: {
  to: DiffSearch
  documentId: string
  active: boolean
  Icon: typeof Columns2
  label: string
  title: string
}) {
  return (
    <Link
      to={ROUTE}
      params={{ id: documentId }}
      search={to}
      title={title}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'text-micro-lg inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 py-2 sm:min-h-0 sm:py-1.5',
        'transition-colors duration-200 ease-agent',
        'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active
          ? 'bg-brand-300/10 text-brand-100'
          : 'text-neutral-400 hover:bg-neutral-800/70 hover:text-neutral-100',
      )}
    >
      <Icon aria-hidden className="size-3.5 opacity-80" />
      {label}
    </Link>
  )
}
