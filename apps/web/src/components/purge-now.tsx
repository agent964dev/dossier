import { Trash2 } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'
import { purgeNow, type PurgeOutcome, type PurgeRun } from '../server/admin'
import { isScreenFailure } from '../server/failure'
import { Refusal, ROW } from './settings-parts'
import { Button } from './ui/button'
import { Modal } from './ui/modal'

const count = (n: number, one: string, many: string) =>
  n === 1 ? `1 ${one}` : `${n} ${many}`

const daysText = (days: number) => count(days, 'day', 'days')

/** "Purged 120 versions and 31 files." */
export const purgedText = (outcome: PurgeOutcome): string =>
  `Purged ${count(outcome.versions, 'version', 'versions')} and ${count(outcome.nodes, 'file', 'files')}.`

export const MORE_REMAINS =
  'More remains. The weekly run or another Purge now finishes it.'

const WHEN = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})

/** The newest purge, weekly or pressed, as the Health section shows it. */
export const lastPurgeText = (run: PurgeRun | null): string => {
  if (run === null) return 'No purge has run yet.'
  const when = `${WHEN.format(new Date(run.finishedAt ?? run.startedAt))} UTC`
  const how = run.trigger === 'weekly' ? 'weekly' : 'Purge now'
  if (run.state === 'running') return `Running since ${when} · ${how}`
  if (run.state === 'failed') return `Failed ${when} · ${how}`
  const outcome =
    run.outcome === null
      ? ''
      : ` · ${count(run.outcome.versions, 'version', 'versions')} and ${count(run.outcome.nodes, 'file', 'files')}`
  const more = run.state === 'partial' ? ' · more remains' : ''
  return `${when} · ${how}${outcome}${more}`
}

/** The last purge, a line under Health. */
export function LastPurge({ run }: { run: PurgeRun | null }) {
  return (
    <div className={ROW}>
      <span className="min-w-0 flex-1">
        <span className="block text-[0.9375rem] text-neutral-50">
          Last purge
        </span>
        <span
          className={cn(
            'block font-mono text-xs',
            run?.state === 'failed' ? 'text-error-300' : 'text-neutral-400',
          )}
        >
          {lastPurgeText(run)}
        </span>
      </span>
    </div>
  )
}

/**
 * "Purge now" under the retention period: everything past it goes now, as
 * the weekly run would remove it. Asks first; says what went.
 */
export function PurgeNow({
  days,
  onDone,
}: {
  days: number
  onDone: () => Promise<void> | void
}) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [done, setDone] = useState<PurgeOutcome | null>(null)
  const close = () => {
    setAsking(false)
    setRefused(null)
  }
  const purge = async () => {
    setBusy(true)
    setRefused(null)
    try {
      const result = await purgeNow()
      if (isScreenFailure(result)) {
        setRefused(result.error.message)
        setBusy(false)
        return
      }
      setDone(result)
      setAsking(false)
      setBusy(false)
      await onDone()
    } catch {
      setRefused('Something went wrong. Try again.')
      setBusy(false)
    }
  }
  return (
    <>
      <div className={ROW}>
        <span className="min-w-0 flex-1">
          <span className="block text-[0.9375rem] text-neutral-50">
            Purge now
          </span>
          <span className="block font-mono text-xs text-neutral-400">
            what the weekly run would remove
          </span>
        </span>
        <Button
          variant="destructive"
          size="xs"
          aria-haspopup="dialog"
          onClick={() => {
            setDone(null)
            setAsking(true)
          }}
        >
          Purge now
        </Button>
      </div>
      <div role="status" className={cn(done === null && 'sr-only')}>
        {done === null ? null : (
          <div className="flex flex-col gap-1 border-t border-border/80 px-3.5 py-3 text-sm">
            <p className="text-neutral-100">{purgedText(done)}</p>
            {done.remaining ? (
              <p className="text-warning-300">{MORE_REMAINS}</p>
            ) : null}
          </div>
        )}
      </div>
      <Modal
        open={asking}
        onClose={close}
        title={`Purge everything past ${daysText(days)} now?`}
        description="Deleted files and data older than that, and their bytes, are removed for good. Nothing can bring them back."
        footer={
          <>
            <Button variant="ghost" type="button" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="destructive-solid"
              type="button"
              disabled={busy}
              onClick={() => void purge()}
            >
              <Trash2 aria-hidden />
              {busy ? 'Purging…' : 'Purge'}
            </Button>
          </>
        }
      >
        {refused === null ? null : <Refusal message={refused} />}
      </Modal>
    </>
  )
}
