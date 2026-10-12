// How the screens write a moment: "12 Oct", "12 Oct 2025", "12 Oct, 16:10".
// Screens show it on the viewer's clock (components/local-time.tsx); the
// server, which does not know their time zone, writes UTC.

export type TimeStyle =
  /** "12 Oct". */
  | 'day'
  /** "12 Oct", with the year when it is not this year: "3 Mar 2025". */
  | 'day-or-year'
  /** "12 Oct, 16:10". */
  | 'when'

const formats = new Map<string, Intl.DateTimeFormat>()

const formatOf = (
  options: Intl.DateTimeFormatOptions,
  timeZone: string | undefined,
): Intl.DateTimeFormat => {
  const key = `${JSON.stringify(options)}|${timeZone ?? ''}`
  let format = formats.get(key)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-GB', { ...options, timeZone })
    formats.set(key, format)
  }
  return format
}

const DAY = { day: 'numeric', month: 'short' } as const
const WHEN = {
  ...DAY,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
} as const

/** The year of `at` in `timeZone`, or the runtime's own zone. */
const yearOf = (at: number, timeZone: string | undefined) =>
  formatOf({ year: 'numeric' }, timeZone).format(at)

/**
 * `at` (ms since the epoch) as the screens write it, in `timeZone`, or the
 * runtime's own zone when none is given.
 */
export const timeText = (
  at: number,
  style: TimeStyle,
  timeZone?: string,
  now = Date.now(),
): string => {
  if (style === 'when') {
    return formatOf(WHEN, timeZone).format(at).replace(' at ', ', ')
  }
  const sameYear = yearOf(at, timeZone) === yearOf(now, timeZone)
  return style === 'day' || sameYear
    ? formatOf(DAY, timeZone).format(at)
    : formatOf({ ...DAY, year: 'numeric' }, timeZone).format(at)
}
