// The forms controller: prefills the forms Dossier manages, keeps their
// drafts with the shell, sends them, and shows how each send went on a plain
// status line. Page code follows along through the `dossier:state` event.
import {
  DossierError,
  ERRORS,
  docFromWire,
  formKey,
  type Doc,
  type DocWire,
  type DraftValues,
  type FormInfo,
  type Me,
  type PageBootstrap,
  type SendRequest,
  type SendValue,
  type UploadRef,
} from '@dossier/contracts/bridge'
import type { DossierStateDetail, FormState } from './create-page-client.ts'
import type { Requests, Resumed } from './requests.ts'

/** After the last input, how long until the shell keeps the draft. */
export const DRAFT_DELAY = 300
/** After the last input, how long until a form without a submit button saves. */
export const AUTOSAVE_DELAY = 800
/** How long the withdraw button waits for its second tap. */
export const WITHDRAW_CONFIRM = 3000

export const TEXT = {
  sending: 'Sending…',
  saving: 'Saving…',
  saved: 'Saved',
  readOnly: 'You can open this but not change it.',
  closed: 'This form is closed.',
  withdrawn: 'Your answer was withdrawn.',
  confirmWithdraw: 'Tap again to withdraw',
  tryAgain: 'Try again',
  offline: ERRORS.offline.message,
  unavailable: ERRORS.unavailable.message,
  rateLimited: 'Too many sends. Try again in a minute.',
  forbidden: ERRORS.forbidden.message,
  formChanged: ERRORS.form_changed.message,
} as const

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

const pad = (n: number): string => String(n).padStart(2, '0')

/** "Sent on 12 Oct at 14:05", in the viewer's local time. */
export const sentText = (at: string): string => {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return 'Sent'
  const month = MONTHS[date.getMonth()]!.slice(0, 3)
  return `Sent on ${date.getDate()} ${month} at ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** "This form closed on 20 October", in the viewer's local time. */
export const closedOnText = (at: number): string => {
  const date = new Date(at)
  return `This form closed on ${date.getDate()} ${MONTHS[date.getMonth()]}`
}

const closesAtOf = (info: FormInfo): number | null => {
  if (info.closesAt === null) return null
  const at = Date.parse(info.closesAt)
  return Number.isNaN(at) ? null : at
}

const closedTextOf = (info: FormInfo, now: number): string => {
  const at = closesAtOf(info)
  return at !== null && at <= now ? closedOnText(at) : TEXT.closed
}

/** The FormInfo of a form Dossier manages, or null for any other form. */
export const formInfoOf = (
  bootstrap: PageBootstrap,
  form: Element,
): FormInfo | null => {
  if (form.localName !== 'form') return null
  if (form.getAttribute('data-dossier') === 'off') return null
  const raw = form.getAttribute('data-dossier-form')
  if (raw === null || !/^\d+$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return bootstrap.forms.find((info) => info.n === n) ?? null
}

type Control =
  | HTMLInputElement
  | HTMLSelectElement
  | HTMLTextAreaElement
  | HTMLButtonElement

const CONTROLS: ReadonlySet<string> = new Set([
  'input',
  'select',
  'textarea',
  'button',
])

/** Input types that take `disabled`, not `readOnly`, to stop changes. */
const DISABLE_TYPES: ReadonlySet<string> = new Set([
  'checkbox',
  'radio',
  'file',
  'button',
  'submit',
  'reset',
  'image',
  'range',
  'color',
])

/** Input types never filled from stored values. */
const UNFILLED_TYPES: ReadonlySet<string> = new Set([
  'file',
  'button',
  'submit',
  'reset',
  'image',
])

const controlsOf = (form: HTMLFormElement): Control[] =>
  [...form.elements].filter((element) =>
    CONTROLS.has(element.localName),
  ) as Control[]

const ownElement = (element: Element): boolean =>
  element.hasAttribute('data-dossier-retry') ||
  element.hasAttribute('data-dossier-withdraw')

const isSubmitButton = (element: Element): boolean => {
  if (ownElement(element)) return false
  if (element.localName === 'button') {
    return (element as HTMLButtonElement).type === 'submit'
  }
  if (element.localName === 'input') {
    const { type } = element as HTMLInputElement
    return type === 'submit' || type === 'image'
  }
  return false
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUploadRef = (value: unknown): value is UploadRef =>
  isRecord(value) &&
  typeof value.file === 'string' &&
  typeof value.name === 'string' &&
  typeof value.size === 'number' &&
  typeof value.type === 'string'

/** The same answers: text alike, the very same files, stored uploads alike. */
const sameEntries = (
  a: SendRequest['entries'],
  b: SendRequest['entries'],
): boolean =>
  a.length === b.length &&
  a.every(([name, value], index) => {
    const [otherName, other] = b[index]!
    if (name !== otherName) return false
    if (typeof value === 'string' || typeof other === 'string') {
      return value === other
    }
    if (isUploadRef(value) && isUploadRef(other)) {
      return JSON.stringify(value) === JSON.stringify(other)
    }
    return value === other
  })

const isDocWire = (value: unknown): value is DocWire =>
  isRecord(value) &&
  typeof value.path === 'string' &&
  typeof value.by === 'string' &&
  typeof value.at === 'string' &&
  typeof value.push === 'number'

/** A stored value as text for a text-like field, or null to leave it. */
const textOf = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value === null) return ''
  return null
}

const listOf = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = textOf(item)
      return text === null ? [] : [text]
    })
  }
  const text = textOf(value)
  return text === null || value === null ? [] : [text]
}

const unfilled = (control: Control): boolean =>
  control.localName === 'button' ||
  (control.localName === 'input' &&
    UNFILLED_TYPES.has((control as HTMLInputElement).type))

const lock = (form: HTMLFormElement, keepWithdraw: boolean): void => {
  for (const control of controlsOf(form)) {
    if (control.hasAttribute('data-dossier-retry')) continue
    if (keepWithdraw && control.hasAttribute('data-dossier-withdraw')) continue
    if (control.localName === 'textarea') {
      ;(control as HTMLTextAreaElement).readOnly = true
    } else if (
      control.localName === 'input' &&
      !DISABLE_TYPES.has((control as HTMLInputElement).type)
    ) {
      ;(control as HTMLInputElement).readOnly = true
    } else {
      control.disabled = true
    }
  }
}

/** Empties every field a person fills; hidden fields keep their value. */
const clearFields = (form: HTMLFormElement): void => {
  for (const control of controlsOf(form)) {
    if (control.localName === 'button') continue
    if (control.localName === 'select') {
      const select = control as HTMLSelectElement
      for (const option of select.options) {
        option.selected = !select.multiple && option.defaultSelected
      }
      continue
    }
    if (control.localName === 'input') {
      const input = control as HTMLInputElement
      if (input.type === 'checkbox' || input.type === 'radio') {
        input.checked = false
        continue
      }
      if (input.type === 'hidden' || UNFILLED_TYPES.has(input.type)) {
        if (input.type === 'file') input.value = ''
        continue
      }
    }
    ;(control as HTMLInputElement | HTMLTextAreaElement).value = ''
  }
}

export interface FormsController {
  /** A send of a managed form: a submit event page code let through, or submit(). */
  readonly submitted: (
    form: HTMLFormElement,
    submitter: HTMLElement | null,
    how: 'event' | 'method',
  ) => void
  /** The shell's answer to a pending send it replayed. */
  readonly resumed: (notice: Resumed) => void
  /** The state of a managed form, or null for any other form. */
  readonly stateOf: (form: HTMLFormElement) => FormState | null
  readonly stop: () => void
}

interface Managed {
  readonly form: HTMLFormElement
  readonly info: FormInfo
  readonly key: string
  readonly manual: boolean
  /** No submit button: the form saves as people type. */
  readonly autosave: boolean
  readonly status: HTMLOutputElement
  retry: HTMLButtonElement | null
  state: FormState
  closed: boolean
  closedText: string
  readOnly: boolean
  /** Someone changed a field since the controller started. */
  touched: boolean
  /** Counts changes, to tell whether any came during a send. */
  edits: number
  /** The fields the person changed on this page, which a late prefill leaves. */
  readonly typed: Set<string>
  /** The stored uploads of each file field, kept when its input stays empty. */
  readonly uploads: Map<string, readonly UploadRef[]>
  /**
   * The last attempt, with its own op ID and how many edits it holds: Try
   * again and an unchanged resend repeat it exactly; anything changed since
   * is a new attempt with a new op ID.
   */
  last: {
    readonly request: SendRequest
    readonly autosave: boolean
    readonly edits: number
  } | null
  /** A send of this page load succeeded: older stored values never replace it. */
  settled: boolean
  inflight: boolean
  queued: {
    readonly autosave: boolean
    readonly submitter: HTMLElement | null
  } | null
  invalid: Control | null
  draftTimer: number | undefined
  saveTimer: number | undefined
  closeTimer: number | undefined
}

export const startForms = (deps: {
  readonly window: Window
  readonly bootstrap: PageBootstrap
  readonly me: () => Me | null
  readonly drafts: Readonly<Record<string, DraftValues>>
  readonly resume: readonly string[]
  readonly requests: Requests
}): FormsController => {
  const { bootstrap, requests } = deps
  const win = deps.window as Window & typeof globalThis
  const doc = win.document
  const managed: Managed[] = []
  /**
   * Each managed form carries its record, so a form is found however it is
   * reached: through the DOM, an event, or `this` in one of its methods.
   */
  const RECORD = Symbol('dossier form')
  const recordOf = (form: unknown): Managed | undefined =>
    typeof form === 'object' && form !== null
      ? (form as { [RECORD]?: Managed })[RECORD]
      : undefined
  const resume = new Set(deps.resume)

  const newOpId = (): string => win.crypto.randomUUID()

  const setStatus = (m: Managed, text: string, retry = false): void => {
    m.status.textContent = text
    if (retry && m.retry === null) {
      const button = doc.createElement('button')
      button.type = 'button'
      button.setAttribute('data-dossier-retry', '')
      button.textContent = TEXT.tryAgain
      button.addEventListener('click', () => tryAgain(m))
      m.status.after(button)
      m.retry = button
    } else if (!retry && m.retry !== null) {
      m.retry.remove()
      m.retry = null
    }
  }

  /** The status line of a form people can still change. */
  const report = (m: Managed, text: string, retry = false): void => {
    if (m.closed || m.readOnly) return
    setStatus(m, text, retry)
  }

  const setState = (
    m: Managed,
    next: FormState,
    outcome: { readonly error?: DossierError; readonly doc?: Doc | null } = {},
    announce = false,
  ): void => {
    const state = m.closed ? 'closed' : next
    const changed = m.state !== state
    m.state = state
    m.form.setAttribute('data-state', state)
    if (!changed && !announce) return
    const detail: DossierStateDetail = {
      state,
      error: outcome.error ?? null,
      doc: outcome.doc ?? null,
    }
    m.form.dispatchEvent(
      new win.CustomEvent('dossier:state', { bubbles: true, detail }),
    )
  }

  const fill = (
    m: Managed,
    values: Readonly<Record<string, unknown>>,
    whole: boolean,
    keep: ReadonlySet<string> = new Set(),
  ): void => {
    const groups = new Map<string, Control[]>()
    for (const control of controlsOf(m.form)) {
      if (control.name === '' || ownElement(control)) continue
      const group = groups.get(control.name)
      if (group === undefined) groups.set(control.name, [control])
      else group.push(control)
    }
    for (const [name, group] of groups) {
      if (keep.has(name)) continue
      const has = Object.hasOwn(values, name)
      // A prefill leaves the fields its data does not name; a draft holds
      // the whole form, so a box missing from it was unticked.
      if (!has && !whole) continue
      const value = has ? values[name] : undefined
      const boxes = group.filter(
        (control) => (control as HTMLInputElement).type === 'checkbox',
      )
      let index = 0
      for (const control of group) {
        if (control.localName === 'input') {
          const input = control as HTMLInputElement
          if (input.type === 'file') {
            const refs = refsOf(value)
            if (refs.length > 0) keepUploads(m, name, refs)
            continue
          }
          if (input.type === 'checkbox') {
            input.checked =
              typeof value === 'boolean'
                ? boxes.length === 1
                  ? value
                  : input.checked
                : listOf(value).includes(input.value)
            continue
          }
          if (input.type === 'radio') {
            input.checked = listOf(value).includes(input.value)
            continue
          }
        }
        if (unfilled(control)) continue
        if (control.localName === 'select') {
          const select = control as HTMLSelectElement
          if (!has) continue
          const chosen = listOf(value)
          for (const option of select.options) {
            option.selected = select.multiple
              ? chosen.includes(option.value)
              : option.value === chosen[0]
          }
          continue
        }
        if (!has) continue
        const text = Array.isArray(value)
          ? textOf(value[index++])
          : textOf(value)
        if (text !== null) {
          ;(control as HTMLInputElement | HTMLTextAreaElement).value = text
        }
      }
    }
  }

  const draftValues = (form: HTMLFormElement): DraftValues => {
    const out: Record<string, string | string[]> = {}
    for (const [name, value] of new win.FormData(form)) {
      if (typeof value !== 'string') continue
      const before = out[name]
      out[name] =
        before === undefined
          ? value
          : Array.isArray(before)
            ? [...before, value]
            : [before, value]
    }
    return out
  }

  const entriesOf = (m: Managed): [string, SendValue][] => {
    const out: [string, SendValue][] = []
    const kept = new Set<string>()
    for (const [name, value] of new win.FormData(m.form)) {
      if (typeof value === 'string') {
        out.push([name, value])
        continue
      }
      const file = value as File
      if (file.name === '' && file.size === 0) {
        // No file chosen: the stored uploads stay, if there are any.
        const uploads = m.uploads.get(name) ?? []
        if (!kept.has(name)) {
          kept.add(name)
          for (const upload of uploads) out.push([name, upload])
        }
        continue
      }
      out.push([name, file])
    }
    return out
  }

  const submitterOf = (
    m: Managed,
    submitter: HTMLElement | null,
  ): SendRequest['submitter'] => {
    if (submitter === null || submitter === m.form) return null
    const name = submitter.getAttribute('name')
    if (name === null || name === '') return null
    return { name, value: (submitter as HTMLButtonElement).value ?? '' }
  }

  const send = (
    m: Managed,
    options: {
      readonly autosave: boolean
      readonly submitter: HTMLElement | null
      readonly again?: SendRequest
    },
  ): void => {
    if (m.closed || m.readOnly) return
    win.clearTimeout(m.saveTimer)
    if (m.inflight) {
      m.queued = { autosave: options.autosave, submitter: options.submitter }
      return
    }
    const submitter = submitterOf(m, options.submitter)
    const entries = entriesOf(m)
    // An attempt with the same answers as the last one that failed is that
    // attempt again, under its op ID; anything else is a new one.
    const unchanged =
      options.again === undefined &&
      m.last !== null &&
      sameEntries(m.last.request.entries, entries) &&
      JSON.stringify(m.last.request.submitter) === JSON.stringify(submitter)
    const request: SendRequest = options.again ??
      (unchanged ? m.last!.request : null) ?? {
        form: { host: m.info.host, target: m.info.target, id: m.info.id },
        seq: bootstrap.seq,
        entries,
        submitter,
        opId: newOpId(),
      }
    const edits =
      options.again !== undefined || unchanged ? m.last!.edits : m.edits
    m.last = { request, autosave: options.autosave, edits }
    m.inflight = true
    report(m, options.autosave ? TEXT.saving : TEXT.sending)
    setState(m, 'sending')
    requests.request({ op: 'send', send: request }).then(
      (value) => {
        m.inflight = false
        succeeded(m, value, options.autosave, edits)
        next(m)
      },
      (error: unknown) => {
        m.inflight = false
        failed(m, error)
        next(m)
      },
    )
  }

  const next = (m: Managed): void => {
    const queued = m.queued
    m.queued = null
    if (queued !== null) send(m, queued)
  }

  /** A file field's stored uploads: one, several, or none. */
  const refsOf = (value: unknown): readonly UploadRef[] =>
    Array.isArray(value)
      ? value.filter(isUploadRef)
      : isUploadRef(value)
        ? [value]
        : []

  const fileInputs = (m: Managed, name: string): HTMLInputElement[] =>
    controlsOf(m.form).filter(
      (control): control is HTMLInputElement =>
        control.localName === 'input' &&
        (control as HTMLInputElement).type === 'file' &&
        control.name === name,
    )

  /**
   * Keeps a file field's stored uploads for later sends. While it has some,
   * a required file input is not left empty: the browser would refuse a
   * form that already holds its file.
   */
  const keepUploads = (
    m: Managed,
    name: string,
    refs: readonly UploadRef[],
  ): void => {
    if (refs.length === 0) m.uploads.delete(name)
    else m.uploads.set(name, refs)
    for (const input of fileInputs(m, name)) {
      if (refs.length > 0 && input.hasAttribute('required')) {
        input.removeAttribute('required')
        input.setAttribute('data-dossier-required', '')
      } else if (
        refs.length === 0 &&
        input.hasAttribute('data-dossier-required')
      ) {
        input.removeAttribute('data-dossier-required')
        input.setAttribute('required', '')
      }
    }
  }

  const forgetUploads = (m: Managed): void => {
    for (const name of m.uploads.keys()) keepUploads(m, name, [])
  }

  const rememberUploads = (m: Managed, data: unknown): void => {
    if (!isRecord(data)) return
    for (const control of controlsOf(m.form)) {
      const input = control as HTMLInputElement
      if (input.localName !== 'input' || input.type !== 'file') continue
      const refs = refsOf(data[input.name])
      if (refs.length === 0) continue
      // The files are stored: later sends keep them without uploading again.
      keepUploads(m, input.name, refs)
      input.value = ''
    }
  }

  const succeeded = (
    m: Managed,
    value: unknown,
    autosave: boolean,
    edits: number,
  ): void => {
    m.last = null
    m.settled = true
    const wire = isRecord(value) && isDocWire(value.doc) ? value.doc : null
    const stored = wire === null ? null : docFromWire(wire, bootstrap.path)
    // Edits made since this send began stay, with their draft.
    const changedSince = edits !== m.edits
    if (m.info.kind === 'entries') {
      if (!changedSince) {
        m.form.reset()
        forgetUploads(m)
      }
    } else if (wire !== null) {
      // The form shows what was stored, unless the person changed it since.
      if (!changedSince && isRecord(wire.data)) fill(m, wire.data, false)
      rememberUploads(m, wire.data)
    }
    if (!changedSince) {
      win.clearTimeout(m.draftTimer)
      requests.draft(m.key, null)
    }
    report(
      m,
      autosave ? TEXT.saved : sentText(wire?.at ?? new Date().toISOString()),
    )
    setState(m, 'sent', { doc: stored }, true)
    if (changedSince) setState(m, 'draft')
  }

  const failed = (m: Managed, error: unknown): void => {
    const e =
      error instanceof DossierError
        ? error
        : new DossierError({
            code: 'unavailable',
            message: TEXT.unavailable,
            fix: null,
            path: null,
          })
    switch (e.code) {
      case 'sign_in_required':
        // The shell keeps the send and goes to sign-in.
        return
      case 'closed':
        close(
          m,
          e.message === '' ? closedTextOf(m.info, Date.now()) : e.message,
        )
        setState(m, 'closed', { error: e }, true)
        return
      case 'offline':
        report(m, TEXT.offline, true)
        break
      case 'unavailable':
        report(m, TEXT.unavailable, true)
        break
      case 'rate_limited':
        report(m, TEXT.rateLimited)
        break
      case 'forbidden':
        report(m, TEXT.forbidden)
        break
      case 'form_changed':
        report(m, TEXT.formChanged)
        break
      case 'invalid': {
        const field =
          e.path === null
            ? undefined
            : controlsOf(m.form).find((control) => control.name === e.path)
        if (field !== undefined && 'setCustomValidity' in field) {
          field.setCustomValidity(e.message)
          field.reportValidity()
          m.invalid = field
        }
        report(m, e.message)
        break
      }
      default:
        report(m, e.message)
    }
    setState(m, 'failed', { error: e }, true)
  }

  const tryAgain = (m: Managed): void => {
    const last = m.last
    // Changed answers are a new attempt; unchanged ones the same again.
    if (last === null || last.edits !== m.edits) {
      send(m, { autosave: last?.autosave ?? false, submitter: null })
    } else {
      send(m, { autosave: last.autosave, submitter: null, again: last.request })
    }
  }

  const close = (m: Managed, text: string): void => {
    win.clearTimeout(m.saveTimer)
    win.clearTimeout(m.closeTimer)
    m.queued = null
    m.closed = true
    m.closedText = text
    lock(m.form, true)
    setStatus(m, text)
    setState(m, 'closed')
  }

  const scheduleClose = (m: Managed): void => {
    const at = closesAtOf(m.info)
    if (at === null) return
    // Timers hold at most about 24.8 days; a later close waits in steps.
    const wait = Math.min(Math.max(at - Date.now(), 0), 2_147_483_647)
    m.closeTimer = win.setTimeout(() => {
      if (Date.now() >= at) close(m, closedOnText(at))
      else scheduleClose(m)
    }, wait)
  }

  const withdraw = (m: Managed): void => {
    const email = deps.me()?.email
    if (email === undefined) return
    requests
      .request({
        op: 'withdraw',
        path: `/${m.info.target}${email}.json`,
        opId: newOpId(),
      })
      .then(
        () => {
          win.clearTimeout(m.draftTimer)
          win.clearTimeout(m.saveTimer)
          m.queued = null
          m.last = null
          forgetUploads(m)
          clearFields(m.form)
          requests.draft(m.key, null)
          if (m.closed) {
            setStatus(m, m.closedText)
            return
          }
          // A viewer who may only read still withdraws their own answer.
          setStatus(m, TEXT.withdrawn)
          setState(m, 'idle')
        },
        (error: unknown) => {
          const code = error instanceof DossierError ? error.code : null
          setStatus(
            m,
            code === null || code === 'offline' || code === 'unavailable'
              ? TEXT.unavailable
              : (error as DossierError).message,
          )
        },
      )
  }

  const watchWithdraw = (m: Managed, button: HTMLElement): void => {
    let armed: number | undefined
    let text = ''
    const disarm = (): void => {
      win.clearTimeout(armed)
      armed = undefined
      button.textContent = text
    }
    button.addEventListener('click', (event) => {
      // A button in a form submits it unless told otherwise.
      event.preventDefault()
      if (armed === undefined) {
        text = button.textContent ?? ''
        button.textContent = TEXT.confirmWithdraw
        armed = win.setTimeout(disarm, WITHDRAW_CONFIRM)
        return
      }
      disarm()
      withdraw(m)
    })
  }

  const onInput = (event: Event): void => {
    const target = event.target as Partial<Control> | null
    const form = target?.form
    if (form === null || form === undefined) return
    const m = recordOf(form)
    if (m === undefined || m.closed || m.readOnly) return
    if (ownElement(target as Element)) return
    m.touched = true
    m.edits += 1
    if (typeof target?.name === 'string' && target.name !== '') {
      m.typed.add(target.name)
    }
    if (m.invalid !== null && m.invalid === target) {
      m.invalid.setCustomValidity('')
      m.invalid = null
    }
    if (m.state !== 'sending') setState(m, 'draft')
    win.clearTimeout(m.draftTimer)
    m.draftTimer = win.setTimeout(() => {
      requests.draft(m.key, draftValues(m.form))
    }, DRAFT_DELAY)
    if (m.autosave && !m.manual) {
      win.clearTimeout(m.saveTimer)
      m.saveTimer = win.setTimeout(() => {
        // While typing, an answer the browser would refuse is not sent yet.
        if (m.form.checkValidity()) send(m, { autosave: true, submitter: null })
      }, AUTOSAVE_DELAY)
    }
  }

  const prefill = async (m: Managed): Promise<void> => {
    const me = deps.me()
    const path =
      m.info.kind === 'person'
        ? me === null
          ? null
          : `/${m.info.target}${me.email}.json`
        : m.info.kind === 'shared'
          ? `/${m.info.target}`
          : null
    if (path === null) return
    let value: unknown
    try {
      value = await requests.request({ op: 'read', path })
    } catch {
      return
    }
    if (!isDocWire(value)) return
    // A send of this page load already shows what is stored now.
    if (m.settled) return
    const stored = docFromWire(value, bootstrap.path)
    // What the person already typed stays; the rest is what they sent.
    if (isRecord(value.data)) fill(m, value.data, false, m.typed)
    if (m.state === 'sending' || m.state === 'draft') return
    report(m, sentText(value.at))
    setState(m, 'sent', { doc: stored })
  }

  const restoreDraft = (m: Managed): void => {
    const draft = deps.drafts[m.key]
    if (draft === undefined || m.closed || m.readOnly || m.touched) return
    if (m.settled) return
    fill(m, draft, true)
    if (m.state !== 'sending') setState(m, 'draft')
  }

  const setUp = (form: HTMLFormElement, info: FormInfo): Managed => {
    const buttons = controlsOf(form).filter(isSubmitButton)
    const status =
      form.querySelector<HTMLOutputElement>('output[data-dossier-status]') ??
      doc.createElement('output')
    if (!status.isConnected || status.parentNode === null) {
      status.setAttribute('data-dossier-status', '')
      const first = buttons[0]
      if (first === undefined) form.append(status)
      else first.after(status)
    }
    const m: Managed = {
      form,
      info,
      key: formKey(info),
      manual: form.getAttribute('data-dossier') === 'manual',
      autosave: buttons.length === 0,
      status,
      retry: null,
      state: 'idle',
      closed: false,
      closedText: '',
      readOnly: false,
      touched: false,
      edits: 0,
      typed: new Set(),
      uploads: new Map(),
      last: null,
      settled: false,
      inflight: false,
      queued: null,
      invalid: null,
      draftTimer: undefined,
      saveTimer: undefined,
      closeTimer: undefined,
    }
    managed.push(m)
    ;(form as { [RECORD]?: Managed })[RECORD] = m
    form.setAttribute('data-state', 'idle')
    if (info.kind === 'person') {
      for (const button of form.querySelectorAll<HTMLElement>(
        '[data-dossier-withdraw]',
      )) {
        watchWithdraw(m, button)
      }
    }
    return m
  }

  /** Takes a managed form in: its state, closing, prefill and draft. */
  const manage = (form: HTMLFormElement): void => {
    const info = formInfoOf(bootstrap, form)
    if (info === null || recordOf(form) !== undefined) return
    const m = setUp(form, info)
    if (deps.me()?.role === 'read') {
      m.readOnly = true
      // Owners may always withdraw their own answer, whatever their role.
      lock(form, true)
      setStatus(m, TEXT.readOnly)
    }
    const now = Date.now()
    if (info.closed || (closesAtOf(info) ?? Infinity) <= now) {
      close(m, closedTextOf(info, now))
    } else {
      scheduleClose(m)
    }
    if (resume.has(m.key) && !m.closed) {
      report(m, TEXT.sending)
      setState(m, 'sending')
    }
    void prefill(m).then(() => restoreDraft(m))
  }

  const manageWithin = (node: Node): void => {
    if (node.nodeType !== 1) return
    const element = node as Element
    if (
      element.localName === 'form' &&
      element.hasAttribute('data-dossier-form')
    ) {
      manage(element as HTMLFormElement)
    }
    for (const form of element.querySelectorAll<HTMLFormElement>(
      'form[data-dossier-form]',
    )) {
      manage(form)
    }
  }

  for (const form of doc.querySelectorAll<HTMLFormElement>(
    'form[data-dossier-form]',
  )) {
    manage(form)
  }
  // Page code may add a managed form later, cloned from a template.
  const added = new win.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) manageWithin(node)
    }
  })
  added.observe(doc, { childList: true, subtree: true })

  win.addEventListener('input', onInput, true)
  win.addEventListener('change', onInput, true)

  return {
    submitted: (form, submitter, how) => {
      const m = recordOf(form)
      if (m === undefined || m.closed || m.readOnly) return
      if (how === 'event') {
        const skip =
          form.noValidate ||
          (submitter as HTMLButtonElement | null)?.formNoValidate === true
        if (!skip && !form.checkValidity()) {
          form.reportValidity()
          return
        }
      }
      send(m, { autosave: false, submitter })
    },
    resumed: (notice) => {
      for (const m of managed) {
        if (m.key !== notice.form) continue
        if (notice.ok) {
          // A kept send holds the answers as they were when it was made: on
          // this page, the last attempt's; from before, none of this page's.
          succeeded(m, notice.value, false, m.last?.edits ?? 0)
          continue
        }
        const error = new DossierError(notice.error)
        if (error.code === 'sign_in_required') {
          // A kept send this viewer cannot make: Try again goes to sign-in.
          report(m, error.message, true)
          setState(m, 'failed', { error }, true)
        } else {
          failed(m, error)
        }
      }
    },
    stateOf: (form) => recordOf(form)?.state ?? null,
    stop: () => {
      added.disconnect()
      win.removeEventListener('input', onInput, true)
      win.removeEventListener('change', onInput, true)
      for (const m of managed) {
        win.clearTimeout(m.draftTimer)
        win.clearTimeout(m.saveTimer)
        win.clearTimeout(m.closeTimer)
      }
    },
  }
}
