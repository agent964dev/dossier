import { useSyncExternalStore } from 'react'

import { timeText, type TimeStyle } from '../lib/times'

const never = () => () => {}

/**
 * A moment on the viewer's own clock, as the page forms and comments show
 * theirs. The server cannot know the viewer's time zone: it writes UTC,
 * saying so when there is an hour, and the browser rewrites it once the
 * screen has loaded.
 */
export function LocalTime({
  at,
  format,
}: {
  /** ms since the epoch, or an ISO 8601 time. */
  at: number | string
  format: TimeStyle
}) {
  const local = useSyncExternalStore(
    never,
    () => true,
    () => false,
  )
  const ms = typeof at === 'number' ? at : Date.parse(at)
  if (Number.isNaN(ms)) return <>{String(at)}</>
  const text = local
    ? timeText(ms, format)
    : `${timeText(ms, format, 'UTC')}${format === 'when' ? ' UTC' : ''}`
  return <time dateTime={new Date(ms).toISOString()}>{text}</time>
}
