import type { FormSummary } from './analyze.ts'
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

export type FieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'url'
  | 'tel'
  | 'search'
  | 'color'
  | 'hidden'
  | 'number'
  | 'range'
  | 'checkbox'
  | 'checkboxes'
  | 'radio'
  | 'select'
  | 'select-multiple'
  | 'date'
  | 'time'
  | 'datetime-local'
  | 'month'
  | 'week'
  | 'file'
  | 'submit'
  /** A hidden input marked `data-type="json"`: one JSON object page code draws. */
  | 'json'

/** One field of a form: every control of one name, merged. */
export interface FieldRule {
  readonly name: string
  readonly type: FieldType
  /** Its label, or for a group of radios or checkboxes its legend. */
  readonly label: string | null
  readonly required: boolean
  /** As written. */
  readonly min: string | null
  readonly max: string | null
  readonly step: string | null
  /**
   * The control's own value attribute, for a field that takes typed text:
   * a date or time's step counts from it when there is no min.
   */
  readonly value?: string | null
  readonly minLength: number | null
  readonly maxLength: number | null
  readonly pattern: string | null
  readonly accept: string | null
  /** A file or email field taking several, or a multiple select. */
  readonly multiple: boolean
  /** What radios, checkboxes, buttons and selects offer. */
  readonly options: readonly {
    readonly value: string
    readonly label: string
  }[]
}

/** A form as the person saw it, which a send is checked against. */
export interface FormSchema {
  readonly title: string | null
  readonly fields: readonly FieldRule[]
}

/** A file a send carried, once stored. */
export interface UploadValue {
  readonly file: string
  readonly name: string
  readonly size: number
  readonly type: string
}

export type FieldEntry = readonly [name: string, value: string | UploadValue]

export type SendCheck =
  | { readonly ok: true; readonly values: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false
      readonly problems: readonly {
        readonly field: string
        readonly message: string
      }[]
    }

/**
 * Who a form's answers belong to: a `.json` target is one shared file, a
 * folder with `data-entries="many"` keeps every send as its own entry, and
 * any other folder keeps one answer per person.
 */
export const formKind = (
  form: FormSummary,
  target: { readonly kind: 'folder' | 'json' },
): 'person' | 'entries' | 'shared' =>
  target.kind === 'json'
    ? 'shared'
    : form.entries === 'many'
      ? 'entries'
      : 'person'

/** When a `data-closes` value closes its form, or null when it cannot. */
export const closesAt = (value: string): number | null => {
  const time = closingTime(value)
  return typeof time === 'number' ? time : null
}

export const formSchema = (form: FormSummary): FormSchema => ({
  title: form.title,
  fields: form.fields,
})

const FILL_IN = 'Fill in this field.'
const JSON_OBJECT = 'Use a JSON object for this field.'
const OFFERED = 'Choose one of the options offered.'
const VALID = 'Enter a valid value.'

const LENGTH_TYPES: ReadonlySet<FieldType> = new Set([
  'text',
  'textarea',
  'email',
  'url',
  'tel',
  'search',
])
const PATTERN_TYPES: ReadonlySet<FieldType> = new Set([
  'text',
  'email',
  'url',
  'tel',
  'search',
])
const DATE_TYPES: ReadonlySet<FieldType> = new Set([
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
])

const takesMany = (field: FieldRule): boolean =>
  field.type === 'checkboxes' ||
  field.type === 'select-multiple' ||
  (field.type === 'file' && field.multiple)

const isUpload = (value: unknown): value is UploadValue => {
  if (typeof value !== 'object' || value === null) return false
  const upload = value as Record<string, unknown>
  return (
    typeof upload.file === 'string' &&
    typeof upload.name === 'string' &&
    typeof upload.type === 'string' &&
    typeof upload.size === 'number' &&
    Number.isFinite(upload.size) &&
    upload.size >= 0
  )
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A JSON field's value: an object page code wrote, or the JSON text of the
 * hidden input a plain send carried. Empty text leaves the field out.
 */
const jsonOutcome = (sent: unknown): Outcome => {
  if (sent === undefined) return null
  if (typeof sent !== 'string') {
    return isJsonObject(sent) ? { value: sent } : { message: JSON_OBJECT }
  }
  if (sent.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(sent)
  } catch {
    return { message: JSON_OBJECT }
  }
  return isJsonObject(parsed) ? { value: parsed } : { message: JSON_OBJECT }
}

const offers = (field: FieldRule, value: string): boolean =>
  field.options.some((option) => option.value === value)

/** HTML's valid floating-point number, or null. */
const numberOf = (text: string | null): number | null => {
  if (text === null) return null
  const trimmed = text.trim()
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return null
  }
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/** HTML's valid email address. */
const EMAIL =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

const PATTERN_FLAGS = (() => {
  try {
    return new RegExp('', 'v').flags
  } catch {
    return 'u'
  }
})()

const patterns = new Map<string, RegExp | null>()

/** A pattern attribute as HTML reads it, or null when it does not compile. */
const patternOf = (pattern: string): RegExp | null => {
  const known = patterns.get(pattern)
  if (known !== undefined) return known
  let compiled: RegExp | null = null
  try {
    compiled = new RegExp(`^(?:${pattern})$`, PATTERN_FLAGS)
  } catch {
    compiled = null
  }
  if (patterns.size >= 256) patterns.clear()
  patterns.set(pattern, compiled)
  return compiled
}

const isLeap = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

const monthLength = (year: number, month: number): number =>
  month === 2
    ? isLeap(year)
      ? 29
      : 28
    : month === 4 || month === 6 || month === 9 || month === 11
      ? 30
      : 31

const isDate = (text: string): boolean => {
  const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= monthLength(year, month)
  )
}

const isTime = (text: string): boolean => {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/.exec(text)
  return (
    match !== null &&
    Number(match[1]) <= 23 &&
    Number(match[2]) <= 59 &&
    Number(match[3] ?? 0) <= 59
  )
}

const isDateText = (type: FieldType, text: string): boolean => {
  switch (type) {
    case 'date':
      return isDate(text)
    case 'time':
      return isTime(text)
    case 'datetime-local': {
      const at = text.indexOf('T')
      return at > 0 && isDate(text.slice(0, at)) && isTime(text.slice(at + 1))
    }
    case 'month': {
      const match = /^(\d{4,})-(\d{2})$/.exec(text)
      const month = Number(match?.[2])
      return (
        match !== null && Number(match[1]) >= 1 && month >= 1 && month <= 12
      )
    }
    case 'week': {
      const match = /^(\d{4,})-W(\d{2})$/.exec(text)
      const week = Number(match?.[2])
      return match !== null && Number(match[1]) >= 1 && week >= 1 && week <= 53
    }
    default:
      return false
  }
}

/** A time written in full, so times with and without seconds compare. */
const fullTime = (text: string): string =>
  text.replace(
    /(\d{2}:\d{2})(:\d{2})?(\.\d{1,3})?$/,
    (_, hm, s, ms) => `${hm}${s ?? ':00'}${(ms ?? '.').padEnd(4, '0')}`,
  )

const dateKey = (type: FieldType, text: string): string =>
  type === 'time' || type === 'datetime-local' ? fullTime(text) : text

/** Whether a file matches an accept list: wildcards, MIME types, extensions. */
export const acceptsFile = (
  accept: string,
  upload: Pick<UploadValue, 'name' | 'type'>,
): boolean => {
  const tokens = accept
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '')
  if (tokens.length === 0) return true
  const type = (upload.type.split(';')[0] ?? '').trim().toLowerCase()
  const name = upload.name.toLowerCase()
  return tokens.some((token) =>
    token.startsWith('.')
      ? name.endsWith(token)
      : token.endsWith('/*')
        ? type.startsWith(token.slice(0, -1))
        : type === token,
  )
}

const DAY = 86_400_000

/**
 * A date or time as a number in its step's unit, as the browser counts it:
 * days for a date, months for a month, weeks for a week (from 1970-W01),
 * seconds for a time or a date and time. Null for text that is not one.
 */
const stepNumber = (type: FieldType, text: string): number | null => {
  if (!isDateText(type, text)) return null
  const seconds = (time: string): number => {
    const [h = '0', m = '0', s = '0'] = time.split(':')
    return Number(h) * 3600 + Number(m) * 60 + Number(s)
  }
  switch (type) {
    case 'date':
      return (
        Date.UTC(
          Number(text.slice(0, -6)),
          Number(text.slice(-5, -3)) - 1,
          Number(text.slice(-2)),
        ) / DAY
      )
    case 'month': {
      const [y = '0', m = '0'] = text.split('-')
      return (Number(y) - 1970) * 12 + Number(m) - 1
    }
    case 'week': {
      const [y = '0', w = '0'] = text.split('-W')
      // Week 1 holds 4 January; its Monday starts it.
      const jan4 = Date.UTC(Number(y), 0, 4)
      const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY
      const start = Date.UTC(1969, 11, 29)
      return Math.round((monday - start) / (7 * DAY)) + Number(w) - 1
    }
    case 'time':
      return seconds(text)
    case 'datetime-local': {
      const at = text.indexOf('T')
      return (
        (stepNumber('date', text.slice(0, at)) ?? 0) * 86_400 +
        seconds(text.slice(at + 1))
      )
    }
    default:
      return null
  }
}

/** A minute for times, one unit otherwise: the browser's default steps. */
const DEFAULT_STEP: Partial<Record<FieldType, number>> = {
  time: 60,
  'datetime-local': 60,
}

const dateStepProblem = (field: FieldRule, text: string): string | null => {
  const step = field.step?.trim().toLowerCase() ?? ''
  if (step === 'any') return null
  const written = numberOf(step)
  const unit =
    written !== null && written > 0 ? written : (DEFAULT_STEP[field.type] ?? 1)
  const value = stepNumber(field.type, text)
  if (value === null) return null
  // From min, else the control's own value, else the epoch.
  const base =
    (field.min === null ? null : stepNumber(field.type, field.min)) ??
    (field.value === null || field.value === undefined
      ? null
      : stepNumber(field.type, field.value)) ??
    0
  // Whole units, counted exactly: a remainder, not a ratio of large numbers.
  const rest = (((value - base) % unit) + unit) % unit
  return rest > 1e-6 && unit - rest > 1e-6 ? VALID : null
}

const numberProblem = (field: FieldRule, value: number): string | null => {
  const range = field.type === 'range'
  const min = numberOf(field.min) ?? (range ? 0 : null)
  let max = numberOf(field.max) ?? (range ? 100 : null)
  if (range && min !== null && max !== null && max < min) max = min
  const shown = (written: string | null, fallback: number | null) =>
    numberOf(written) === null ? String(fallback) : (written ?? '').trim()
  if (min !== null && value < min) {
    return `Enter a value of ${shown(field.min, min)} or more.`
  }
  if (max !== null && value > max) {
    return `Enter a value of ${shown(field.max, max)} or less.`
  }
  const step = field.step?.trim().toLowerCase() ?? ''
  if (step === 'any') return null
  const size = numberOf(step)
  const unit = size !== null && size > 0 ? size : 1
  const steps = (value - (min ?? 0)) / unit
  if (
    Math.abs(steps - Math.round(steps)) >
    1e-7 * Math.max(1, Math.abs(steps))
  ) {
    return VALID
  }
  return null
}

const textProblem = (field: FieldRule, text: string): string | null => {
  if (field.type === 'hidden') return null
  if (field.type === 'color') {
    return /^#[0-9a-fA-F]{6}$/.test(text) ? null : VALID
  }
  if (LENGTH_TYPES.has(field.type)) {
    if (field.minLength !== null && text.length < field.minLength) {
      return `Use at least ${field.minLength} characters.`
    }
    if (field.maxLength !== null && text.length > field.maxLength) {
      return `Use at most ${field.maxLength} characters.`
    }
  }
  const parts =
    field.type === 'email' && field.multiple
      ? text
          .split(',')
          .map((part) => part.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ''))
      : [text]
  if (field.type === 'email' && parts.some((part) => !EMAIL.test(part))) {
    return 'Enter an email address.'
  }
  if (field.type === 'url' && !URL.canParse(text)) return 'Enter a URL.'
  if (PATTERN_TYPES.has(field.type) && field.pattern !== null) {
    const pattern = patternOf(field.pattern)
    if (pattern !== null && parts.some((part) => !pattern.test(part))) {
      return 'Match the requested format.'
    }
  }
  return null
}

/** A field's typed value, its problem, or null to leave it out. */
type Outcome = { readonly value: unknown } | { readonly message: string } | null

const checkField = (field: FieldRule, sent: readonly unknown[]): Outcome => {
  if (sent.length > 1 && !takesMany(field)) {
    return { message: 'Send only one value for this field.' }
  }
  // Never required: page code fills it, and an empty one is left out.
  if (field.type === 'json') return jsonOutcome(sent[0])
  if (field.type === 'file') {
    if (!sent.every(isUpload)) return { message: 'Send a file, not text.' }
    if (sent.length === 0)
      return field.required ? { message: 'Choose a file.' } : null
    if (
      field.accept !== null &&
      !sent.every((file) => acceptsFile(field.accept!, file))
    ) {
      return { message: 'Choose a file of a type this field accepts.' }
    }
    return { value: field.multiple ? sent : sent[0] }
  }
  if (sent.some(isUpload)) return { message: 'Send text, not a file.' }
  if (!sent.every((value) => typeof value === 'string'))
    return { message: VALID }
  const texts = sent as readonly string[]

  switch (field.type) {
    case 'submit':
      return null
    case 'checkbox':
      if (texts.length === 0 && field.required) {
        return { message: 'Check this box to go on.' }
      }
      return { value: texts.length > 0 }
    case 'checkboxes':
    case 'select-multiple':
      if (texts.length === 0 && field.required) {
        return { message: 'Choose at least one option.' }
      }
      return texts.every((text) => offers(field, text))
        ? { value: [...texts] }
        : { message: OFFERED }
    case 'radio':
    case 'select': {
      const text = texts[0] ?? ''
      if (text === '') {
        return field.required
          ? { message: 'Choose an option.' }
          : { value: null }
      }
      return offers(field, text) ? { value: text } : { message: OFFERED }
    }
    default:
      break
  }

  const text = texts[0]
  const checked = field.required && field.type !== 'hidden'
  if (text === undefined) return checked ? { message: FILL_IN } : null
  const isNumber = field.type === 'number' || field.type === 'range'
  const isDateType = DATE_TYPES.has(field.type)
  if (text === '') {
    if (checked) return { message: FILL_IN }
    return { value: isNumber || isDateType ? null : '' }
  }
  if (isNumber) {
    const value = numberOf(text)
    if (value === null || text.trim() !== text)
      return { message: 'Enter a number.' }
    const message = numberProblem(field, value)
    return message === null ? { value } : { message }
  }
  if (isDateType) {
    if (!isDateText(field.type, text)) return { message: VALID }
    const key = dateKey(field.type, text)
    if (field.min !== null && isDateText(field.type, field.min)) {
      if (key < dateKey(field.type, field.min)) {
        return { message: `Enter ${field.min} or later.` }
      }
    }
    if (field.max !== null && isDateText(field.type, field.max)) {
      if (key > dateKey(field.type, field.max)) {
        return { message: `Enter ${field.max} or earlier.` }
      }
    }
    const stepped = dateStepProblem(field, text)
    if (stepped !== null) return { message: stepped }
    return { value: text }
  }
  const message = textProblem(field, text)
  return message === null ? { value: text } : { message }
}

/**
 * The server's check of one send against the form as the person saw it,
 * which holds for posts that never came from the page too. The submitter is
 * the button that sent it, when it has a name. On success, the values hold
 * one typed value per field that has one, in the form's order.
 */
export const validateSend = (
  form: FormSchema,
  entries: readonly FieldEntry[],
  submitter: { readonly name: string; readonly value: string } | null,
): SendCheck => {
  const fields = new Map(form.fields.map((field) => [field.name, field]))
  const sent = new Map<string, unknown[]>()
  /** Names in the order they were first sent. */
  const order: string[] = []
  for (const [name, value] of entries) {
    const list = sent.get(name)
    if (list === undefined) {
      sent.set(name, [value])
      order.push(name)
    } else list.push(value)
  }

  const problems: { readonly field: string; readonly message: string }[] = []
  const decided = new Map<string, unknown>()
  const settle = (field: FieldRule, values: readonly unknown[]): void => {
    const outcome = checkField(field, values)
    if (outcome === null) return
    if ('message' in outcome) {
      problems.push({ field: field.name, message: outcome.message })
    } else decided.set(field.name, outcome.value)
  }

  for (const name of order) {
    const field = fields.get(name)
    if (field === undefined || field.type === 'submit') {
      problems.push({
        field: name,
        message: `This form has no field named ${name}.`,
      })
    } else settle(field, sent.get(name) ?? [])
  }
  if (submitter !== null) {
    const field = fields.get(submitter.name)
    if (field === undefined || field.type !== 'submit') {
      problems.push({
        field: submitter.name,
        message: `This form has no button named ${submitter.name}.`,
      })
    } else if (!offers(field, submitter.value)) {
      problems.push({ field: submitter.name, message: OFFERED })
    } else decided.set(submitter.name, submitter.value)
  }
  for (const field of form.fields) {
    if (!sent.has(field.name) && field.type !== 'submit') settle(field, [])
  }

  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    values: Object.fromEntries(
      form.fields.flatMap((field) =>
        decided.has(field.name) ? [[field.name, decided.get(field.name)]] : [],
      ),
    ),
  }
}

/** A stored value as the values a send would have carried for it. */
const sentOf = (field: FieldRule, value: unknown): unknown[] | string => {
  if (value === null) return []
  if (field.type === 'checkbox') {
    return typeof value === 'boolean'
      ? value
        ? [field.options[0]?.value ?? 'on']
        : []
      : 'Use true or false for this field.'
  }
  if (takesMany(field)) {
    return Array.isArray(value) ? value : 'Use a list for this field.'
  }
  if (field.type === 'number' || field.type === 'range') {
    return typeof value === 'number' && Number.isFinite(value)
      ? [String(value)]
      : 'Enter a number.'
  }
  if (field.type === 'file') return [value]
  if (field.type === 'json') return isJsonObject(value) ? [value] : JSON_OBJECT
  return typeof value === 'string' ? [value] : VALID
}

/**
 * A page-code write into a form's target, checked against the forms that
 * target it: each key must be a field of one of them, and its value, typed
 * as a send would store it, must pass that field's rules. A null removes
 * the field, which a required field refuses.
 */
export const validateValues = (
  forms: readonly FormSchema[],
  values: Readonly<Record<string, unknown>>,
): SendCheck => {
  const problems: { readonly field: string; readonly message: string }[] = []
  const decided: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values)) {
    const fields = forms.flatMap((form) =>
      form.fields.filter((f) => f.name === name && f.type !== 'submit'),
    )
    if (fields.length === 0) {
      problems.push({
        field: name,
        message: `This form has no field named ${name}.`,
      })
      continue
    }
    let message: string | null = null
    let passed = false
    for (const field of fields) {
      const sent = sentOf(field, value)
      if (typeof sent === 'string') {
        message ??= sent
        continue
      }
      const outcome = checkField(field, sent)
      if (outcome !== null && 'message' in outcome) {
        message ??= outcome.message
        continue
      }
      passed = true
      break
    }
    if (passed) decided[name] = value
    else problems.push({ field: name, message: message ?? VALID })
  }
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, values: decided }
}
