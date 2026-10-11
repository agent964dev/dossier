import type { PushProblemCode } from './check-push.ts'
import { isKitName, isNodeName, parentOf } from './paths.ts'
import { decodeSegment, trimUrl } from './urls.ts'

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Where a form on `pagePath` writes: a folder (`answers/`, one file per
 * person) or a `.json` file (one shared file), as a path inside the tree
 * without a trailing slash, or the problem with its action.
 *
 * The action resolves like a relative URL from the page's folder: `.` and
 * `..` segments step through the tree, a backslash counts as a slash, each
 * segment is percent-decoded, and a query or fragment after the path is
 * dropped. An empty action is `form_without_action`; callers report it
 * before resolving. A scheme, `//host`, a path rooted at `/`, an action that
 * is only a query or fragment, or one climbing above the tree's root is
 * `form_action_outside`. A segment that cannot name a file or folder is
 * `bad_name`. The tree's root or any `_` segment is `form_action_authored`.
 * Anything not ending in `/` or `.json` is `form_action_kind`.
 */
export const resolveFormAction = (
  pagePath: string,
  action: string,
):
  | { readonly target: string; readonly kind: 'folder' | 'json' }
  | { readonly problem: PushProblemCode } => {
  const url = trimUrl(action)
  if (url === '') return { problem: 'form_without_action' }
  if (
    SCHEME.test(url) ||
    url.startsWith('/') ||
    url.startsWith('\\') ||
    url.startsWith('?') ||
    url.startsWith('#')
  ) {
    return { problem: 'form_action_outside' }
  }
  const path = url.split(/[?#]/, 1)[0] ?? ''
  const raw = path.split(/[\\/]/)
  const last = decodeSegment(raw[raw.length - 1] ?? '')
  const folder = last === '' || last === '.' || last === '..'

  const parent = parentOf(pagePath)
  const segments = parent === '' ? [] : parent.split('/')
  for (const piece of raw) {
    const segment = decodeSegment(piece)
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return { problem: 'form_action_outside' }
      segments.pop()
      continue
    }
    if (!isNodeName(segment)) return { problem: 'bad_name' }
    segments.push(segment)
  }

  if (segments.length === 0 || segments.some(isKitName)) {
    return { problem: 'form_action_authored' }
  }
  const target = segments.join('/')
  if (folder) return { target, kind: 'folder' }
  if (target.toLowerCase().endsWith('.json')) return { target, kind: 'json' }
  return { problem: 'form_action_kind' }
}

const CLOSES =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/

const daysIn = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate()

/**
 * When a form's `data-closes` closes it, in milliseconds since 1970: a date
 * and time with `Z` or an offset (`2026-10-20T18:00+03:00`, `+0300`).
 * `'no_offset'` for a date and time without one, null for anything else.
 */
export const closingTime = (closes: string): number | 'no_offset' | null => {
  const match = CLOSES.exec(closes.trim())
  if (match === null) return null
  const [, y, mo, d, h, mi, s = '0', fraction = '', z, sign, oh, om] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const second = Number(s)
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysIn(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null
  }
  if (z === undefined && sign === undefined) return 'no_offset'
  let offset = 0
  if (sign !== undefined) {
    const offsetHours = Number(oh)
    const offsetMinutes = Number(om)
    if (offsetHours > 23 || offsetMinutes > 59) return null
    offset = (sign === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes)
  }
  const millis = Math.floor(Number(`0${fraction}`) * 1000)
  return (
    Date.UTC(year, month - 1, day, hour, minute, second, millis) -
    offset * 60_000
  )
}
