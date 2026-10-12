import {
  DossierError,
  formKey,
  type DocWire,
  type DraftValues,
  type ErrorCode,
  type FormInfo,
  type Me,
  type SendRequest,
} from '@dossier/contracts/bridge'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DossierStateDetail } from '../src/page-client/create-page-client.ts'
import {
  AUTOSAVE_DELAY,
  DRAFT_DELAY,
  WITHDRAW_CONFIRM,
} from '../src/page-client/forms.ts'
import { install, type Installed } from '../src/page-client/install.ts'
import { BOOTSTRAP, SARA, openPage, type Page } from './fake-shell.ts'
import { flush, type FakePort } from './ports.ts'

const PERSON: FormInfo = {
  n: 1,
  host: 'n1',
  target: 'questions/answers/',
  id: null,
  kind: 'person',
  closesAt: null,
  closed: false,
}
const SHARED: FormInfo = {
  n: 2,
  host: 'n1',
  target: 'questions/board.json',
  id: 'board',
  kind: 'shared',
  closesAt: null,
  closed: false,
}
const ENTRIES: FormInfo = {
  n: 3,
  host: 'n1',
  target: 'questions/ideas/',
  id: null,
  kind: 'entries',
  closesAt: null,
  closed: false,
}

const PERSON_FORM = `
  <form data-dossier-form="1">
    <input name="name" required>
    <input name="nickname" value="Sam">
    <input type="radio" name="color" value="red">
    <input type="radio" name="color" value="blue">
    <input type="checkbox" name="tags" value="a">
    <input type="checkbox" name="tags" value="b">
    <input type="checkbox" name="agree" value="yes">
    <select name="size"><option value="s">S</option><option value="m">M</option></select>
    <textarea name="notes"></textarea>
    <input type="number" name="age">
    <input type="file" name="cv">
    <button name="action" value="send">Send</button>
    <button type="button" data-dossier-withdraw>Withdraw</button>
  </form>`

interface Request {
  readonly type: 'request'
  readonly id: number
  readonly op: 'read' | 'send' | 'withdraw'
  readonly path?: string
  readonly opId?: string
  readonly send?: SendRequest
}

const bootName = (
  me: Me | null,
  drafts: Readonly<Record<string, DraftValues>> = {},
  resume: readonly string[] = [],
) => `dossier-boot:${JSON.stringify({ v: 1, me, drafts, resume })}`

const wire = (
  data: unknown,
  at = '2026-10-12T14:05:00',
  path = 'questions/answers/sara@acme.com.json',
): DocWire => ({
  path,
  data,
  by: 'sara@acme.com',
  at,
  push: 2 as DocWire['push'],
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-12T15:00:00'))
})

afterEach(() => {
  vi.useRealTimers()
})

interface Opened {
  readonly page: Page
  readonly installed: Installed
  readonly doc: Document
  readonly form: (n?: number) => HTMLFormElement
  readonly field: <T extends Element = HTMLInputElement>(selector: string) => T
  /** What the page sent the shell. */
  readonly messages: () => { readonly type: string }[]
  readonly requests: (op?: Request['op']) => Request[]
  readonly drafts: () => unknown[]
  readonly answer: (id: number, value: unknown) => Promise<void>
  readonly fail: (
    id: number,
    code: ErrorCode,
    message?: string,
    path?: string | null,
  ) => Promise<void>
  /** The page's own messages before cloning, for File values. */
  readonly raw: () => unknown[]
  readonly status: (n?: number) => string
  readonly states: DossierStateDetail[]
}

const open = (options: {
  readonly body: string
  readonly forms?: readonly FormInfo[]
  readonly me?: Me | null
  readonly drafts?: Readonly<Record<string, DraftValues>>
  readonly resume?: readonly string[]
  readonly placement?: 'top' | 'nested'
}): Opened => {
  const me = options.me === undefined ? SARA : options.me
  const placement = options.placement ?? 'top'
  const page = openPage({
    placement,
    name:
      placement === 'top'
        ? bootName(me, options.drafts, options.resume)
        : undefined,
    body: options.body,
    bootstrap: { ...BOOTSTRAP, forms: options.forms ?? [PERSON] },
  })
  const raw: unknown[] = []
  const installed = install(page.window)
  const shellEnd = page.shell.hellos[0]!.ports[0]!
  const pageEnd = shellEnd.other as FakePort
  const post = pageEnd.postMessage.bind(pageEnd)
  pageEnd.postMessage = (data: unknown) => {
    raw.push(data)
    post(data)
  }
  const doc = page.win.document as unknown as Document
  const states: DossierStateDetail[] = []
  doc.addEventListener('dossier:state', (event) => {
    states.push((event as CustomEvent<DossierStateDetail>).detail)
  })
  const messages = () => page.shell.received() as { readonly type: string }[]
  const requests = (op?: Request['op']) =>
    (messages().filter((m) => m.type === 'request') as Request[]).filter(
      (m) => op === undefined || m.op === op,
    )
  return {
    page,
    installed,
    doc,
    form: (n = 1) =>
      doc.querySelector(`form[data-dossier-form="${n}"]`) as HTMLFormElement,
    field: <T extends Element = HTMLInputElement>(selector: string) =>
      doc.querySelector(selector) as T,
    messages,
    requests,
    drafts: () => messages().filter((m) => m.type === 'draft'),
    answer: async (id, value) => {
      page.shell.tell({ type: 'result', id, ok: true, value })
      await flush()
    },
    fail: async (id, code, message = `The ${code} answer.`, path = null) => {
      page.shell.tell({
        type: 'result',
        id,
        ok: false,
        error: { code, message, fix: null, path },
      })
      await flush()
    },
    raw: () => raw,
    status: (n = 1) =>
      doc.querySelector(
        `form[data-dossier-form="${n}"] output[data-dossier-status]`,
      )?.textContent ?? '',
    states,
  }
}

const type = (it: Opened, selector: string, value: string): void => {
  const input = it.field<HTMLInputElement>(selector)
  input.value = value
  input.dispatchEvent(
    new it.page.win.Event('input', { bubbles: true }) as never,
  )
}

const submitEvent = (it: Opened, n = 1, submitter?: Element | null) => {
  const form = it.form(n)
  const event = new it.page.win.SubmitEvent('submit', {
    bubbles: true,
    cancelable: true,
    submitter: (submitter === undefined
      ? form.querySelector('button:not([type])')
      : submitter) as never,
  })
  return event as unknown as SubmitEvent
}

/** Dispatches a submit event and lets the decision run. */
const submit = async (it: Opened, n = 1, event = submitEvent(it, n)) => {
  it.form(n).dispatchEvent(event)
  await vi.advanceTimersByTimeAsync(0)
  await flush()
  return event
}

/** The browser's own record of the event's cancellation, past any shadow. */
const nativelyPrevented = (event: Event): boolean => {
  let proto: object | null = Object.getPrototypeOf(event)
  while (proto !== null) {
    const get = Object.getOwnPropertyDescriptor(proto, 'defaultPrevented')?.get
    if (get !== undefined) return get.call(event) as boolean
    proto = Object.getPrototypeOf(proto)
  }
  throw new Error('no defaultPrevented getter')
}

const sendsOf = (it: Opened) => it.requests('send').map((r) => r.send!)

/** Opens a person form and answers its prefill with nothing stored. */
const openEmpty = async (
  options: Partial<Parameters<typeof open>[0]> = {},
): Promise<Opened> => {
  const it = open({ body: PERSON_FORM, ...options })
  await flush()
  for (const read of it.requests('read')) await it.answer(read.id, null)
  return it
}

describe('prefill', () => {
  test('fills fields by name from the stored answer and leaves the rest alone', async () => {
    const it = open({ body: PERSON_FORM })
    await flush()
    const [read] = it.requests('read')
    expect(read).toMatchObject({
      op: 'read',
      path: '/questions/answers/sara@acme.com.json',
    })
    await it.answer(
      read!.id,
      wire({
        name: 'Sara',
        color: 'blue',
        tags: ['b'],
        agree: true,
        size: 'm',
        notes: 'Hello',
        age: 41,
        cv: { file: 'files/cv.pdf', name: 'cv.pdf', size: 10, type: 'x' },
        gone: 'a field the form no longer has',
      }),
    )
    expect(it.field('[name=name]').value).toBe('Sara')
    expect(it.field('[name=nickname]').value).toBe('Sam')
    expect(it.field('[name=color][value=blue]').checked).toBe(true)
    expect(it.field('[name=color][value=red]').checked).toBe(false)
    expect(it.field('[name=tags][value=a]').checked).toBe(false)
    expect(it.field('[name=tags][value=b]').checked).toBe(true)
    expect(it.field('[name=agree]').checked).toBe(true)
    expect(it.field<HTMLSelectElement>('[name=size]').value).toBe('m')
    expect(it.field<HTMLTextAreaElement>('[name=notes]').value).toBe('Hello')
    expect(it.field('[name=age]').value).toBe('41')
    expect(it.doc.querySelector('[name=gone]')).toBeNull()
    expect(it.status()).toBe('Sent on 12 Oct at 14:05')
    expect(it.form().getAttribute('data-state')).toBe('sent')
  })

  test('a late prefill keeps what the person already typed and fills the rest', async () => {
    const it = open({ body: PERSON_FORM })
    await flush()
    const [read] = it.requests('read')
    type(it, '[name=name]', 'Typed first')
    await it.answer(read!.id, wire({ name: 'Sara', notes: 'Hello', age: 41 }))
    expect(it.field('[name=name]').value).toBe('Typed first')
    expect(it.field<HTMLTextAreaElement>('[name=notes]').value).toBe('Hello')
    expect(it.field('[name=age]').value).toBe('41')
  })

  test('a shared form reads its file; an entries form and a visitor read nothing', async () => {
    const shared = open({
      body: '<form data-dossier-form="2"><input name="title"></form>',
      forms: [SHARED],
    })
    await flush()
    expect(shared.requests('read')).toMatchObject([
      { path: '/questions/board.json' },
    ])
    const entries = open({
      body: '<form data-dossier-form="3"><input name="idea"><button>Add</button></form>',
      forms: [ENTRIES],
    })
    const visitor = open({ body: PERSON_FORM, me: null })
    await flush()
    expect(entries.requests('read')).toEqual([])
    expect(visitor.requests('read')).toEqual([])
  })

  test('the status line follows the first submit button, or ends the form', async () => {
    const it = await openEmpty()
    const status = it.doc.querySelector('output[data-dossier-status]')!
    expect(status.previousElementSibling?.getAttribute('name')).toBe('action')
    const shared = open({
      body: '<form data-dossier-form="2"><input name="title"></form>',
      forms: [SHARED],
    })
    expect(shared.form(2).lastElementChild?.localName).toBe('output')
  })

  test('forms that say off, and numbers the page does not list, are left alone', async () => {
    const it = open({
      body: `
        <form data-dossier-form="1" data-dossier="off"><input name="a"></form>
        <form data-dossier-form="9"><input name="b"></form>`,
    })
    await flush()
    expect(it.requests()).toEqual([])
    expect(it.doc.querySelector('output')).toBeNull()
    const event = submitEvent(it, 1, null)
    it.doc.querySelector('form')!.dispatchEvent(event)
    expect(nativelyPrevented(event)).toBe(false)
  })
})

describe('drafts', () => {
  const key = formKey(PERSON)

  test('a kept draft fills over the prefill', async () => {
    const it = open({
      body: PERSON_FORM,
      drafts: { [key]: { name: 'Draft', tags: 'a', notes: 'Later' } },
    })
    await flush()
    await it.answer(
      it.requests('read')[0]!.id,
      wire({ name: 'Sara', tags: ['b'], agree: true, size: 'm' }),
    )
    expect(it.field('[name=name]').value).toBe('Draft')
    expect(it.field('[name=tags][value=a]').checked).toBe(true)
    // A draft holds the whole form: a box it does not name was unticked.
    expect(it.field('[name=tags][value=b]').checked).toBe(false)
    expect(it.field('[name=agree]').checked).toBe(false)
    expect(it.field<HTMLTextAreaElement>('[name=notes]').value).toBe('Later')
    expect(it.form().getAttribute('data-state')).toBe('draft')
  })

  test('the shell gets the draft 300 ms after the last input, without files', async () => {
    const it = await openEmpty()
    type(it, '[name=name]', 'Sa')
    expect(it.form().getAttribute('data-state')).toBe('draft')
    await vi.advanceTimersByTimeAsync(DRAFT_DELAY - 100)
    type(it, '[name=name]', 'Sara')
    it.field('[name=tags][value=a]').checked = true
    it.field('[name=tags][value=b]').checked = true
    await vi.advanceTimersByTimeAsync(DRAFT_DELAY - 1)
    await flush()
    expect(it.drafts()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(it.drafts()).toEqual([
      {
        type: 'draft',
        form: key,
        values: {
          name: 'Sara',
          nickname: 'Sam',
          tags: ['a', 'b'],
          size: 's',
          notes: '',
          age: '',
        },
      },
    ])
  })

  test('a nested page takes drafts from its welcome', async () => {
    const it = open({ body: PERSON_FORM, placement: 'nested' })
    await flush()
    expect(it.requests()).toEqual([])
    it.page.shell.welcome(SARA, { drafts: { [key]: { name: 'Nested' } } })
    await flush()
    await it.answer(it.requests('read')[0]!.id, null)
    expect(it.field('[name=name]').value).toBe('Nested')
  })
})

describe('sending', () => {
  test('a submit sends the form with its submitter and an op ID', async () => {
    const it = await openEmpty()
    type(it, '[name=name]', 'Sara')
    const event = await submit(it)
    expect(nativelyPrevented(event)).toBe(true)
    const [send] = sendsOf(it)
    expect(send).toMatchObject({
      form: { host: 'n1', target: 'questions/answers/', id: null },
      seq: 3,
      submitter: { name: 'action', value: 'send' },
    })
    expect(send!.entries).toContainEqual(['name', 'Sara'])
    expect(send!.opId).toMatch(/^[0-9a-f-]{36}$/)
    expect(it.status()).toBe('Sending…')
    expect(it.form().getAttribute('data-state')).toBe('sending')
  })

  test('the browser checks the form first and nothing is sent when it fails', async () => {
    const it = await openEmpty()
    const report = vi.spyOn(it.form(), 'reportValidity')
    await submit(it)
    expect(report).toHaveBeenCalled()
    expect(sendsOf(it)).toEqual([])
  })

  test('form.submit() on a managed form sends it; other forms keep the browser’s', async () => {
    const it = await openEmpty({
      body: `${PERSON_FORM}<form id="plain"><input name="q"></form>`,
    })
    type(it, '[name=name]', 'Sara')
    it.form().submit()
    await flush()
    expect(sendsOf(it)).toHaveLength(1)
    expect(sendsOf(it)[0]!.submitter).toBeNull()
    const plain = it.doc.getElementById('plain') as HTMLFormElement
    const event = submitEvent(it, 1, null)
    plain.dispatchEvent(event)
    expect(nativelyPrevented(event)).toBe(false)
  })

  test('success: sent, draft gone, and dossier:state carries the doc', async () => {
    const it = await openEmpty()
    type(it, '[name=name]', 'Sara')
    await submit(it)
    const [request] = it.requests('send')
    await it.answer(request!.id, {
      doc: wire({ name: 'Sara' }, '2026-10-12T15:00:00'),
      replayed: false,
    })
    expect(it.status()).toBe('Sent on 12 Oct at 15:00')
    expect(it.form().getAttribute('data-state')).toBe('sent')
    expect(it.drafts().at(-1)).toEqual({
      type: 'draft',
      form: formKey(PERSON),
      values: null,
    })
    expect(it.states.at(-1)).toEqual({
      state: 'sent',
      error: null,
      doc: {
        path: 'answers/sara@acme.com.json',
        data: { name: 'Sara' },
        by: 'sara@acme.com',
        at: '2026-10-12T15:00:00',
        push: 2,
      },
    })
  })

  test('a failure fires dossier:state with the error', async () => {
    const it = await openEmpty()
    type(it, '[name=name]', 'Sara')
    await submit(it)
    await it.fail(it.requests('send')[0]!.id, 'forbidden')
    const last = it.states.at(-1)!
    expect(last.state).toBe('failed')
    expect(last.doc).toBeNull()
    expect(last.error).toBeInstanceOf(DossierError)
    expect(last.error).toMatchObject({ code: 'forbidden' })
  })

  test('Try again sends the same request with the same op ID', async () => {
    const it = await openEmpty()
    type(it, '[name=name]', 'Sara')
    await submit(it)
    const [first] = it.requests('send')
    await it.fail(first!.id, 'offline', 'No network.')
    expect(it.status()).toBe(
      'Not sent. Your answers are kept on this device. Try again.',
    )
    const retry = it.doc.querySelector<HTMLButtonElement>(
      'button[data-dossier-retry]',
    )!
    expect(retry.type).toBe('button')
    expect(retry.textContent).toBe('Try again')
    retry.click()
    await flush()
    const [, second] = it.requests('send')
    expect(second!.send).toEqual(first!.send)
    expect(it.status()).toBe('Sending…')
    await it.answer(second!.id, { doc: null, replayed: true })
    expect(it.doc.querySelector('button[data-dossier-retry]')).toBeNull()
    // The next send is a new one.
    type(it, '[name=name]', 'Sara B')
    await submit(it)
    expect(it.requests('send')[2]!.send!.opId).not.toBe(first!.send!.opId)
  })

  test.each([
    [
      'offline',
      'Not sent. Your answers are kept on this device. Try again.',
      true,
      'failed',
    ],
    ['unavailable', 'Something went wrong. Try again.', true, 'failed'],
    ['rate_limited', 'Too many sends. Try again in a minute.', false, 'failed'],
    ['forbidden', 'You can open this but not change it.', false, 'failed'],
    ['too_large', 'The too_large answer.', false, 'failed'],
    ['invalid', 'The invalid answer.', false, 'failed'],
    [
      'form_changed',
      'This form has changed. Reload the page to see the current version.',
      false,
      'failed',
    ],
    ['closed', 'The closed answer.', false, 'closed'],
    ['sign_in_required', 'Sending…', false, 'sending'],
  ] as const)('the status line for %s', async (code, text, retry, state) => {
    const it = await openEmpty()
    type(it, '[name=name]', 'Sara')
    await submit(it)
    await it.fail(it.requests('send')[0]!.id, code)
    expect(it.status()).toBe(text)
    expect(it.doc.querySelector('[data-dossier-retry]') !== null).toBe(retry)
    expect(it.form().getAttribute('data-state')).toBe(state)
  })

  test('invalid marks the field it names until its next input', async () => {
    const it = await openEmpty()
    type(it, '[name=name]', 'Sara')
    await submit(it)
    await it.fail(it.requests('send')[0]!.id, 'invalid', 'Too short.', 'notes')
    const notes = it.field<HTMLTextAreaElement>('[name=notes]')
    expect(notes.validationMessage).toBe('Too short.')
    expect(it.status()).toBe('Too short.')
    notes.value = 'Much longer'
    notes.dispatchEvent(
      new it.page.win.Event('input', { bubbles: true }) as never,
    )
    expect(notes.validationMessage).toBe('')
  })

  test('a closed answer without a message uses the form’s own closed text', async () => {
    const it = await openEmpty()
    type(it, '[name=name]', 'Sara')
    await submit(it)
    await it.fail(it.requests('send')[0]!.id, 'closed', '')
    expect(it.status()).toBe('This form is closed.')
  })

  test('a kept upload is sent when its file input stays empty', async () => {
    const it = open({ body: PERSON_FORM })
    await flush()
    const cv = { file: 'files/cv.pdf', name: 'cv.pdf', size: 10, type: 'x' }
    await it.answer(it.requests('read')[0]!.id, wire({ name: 'Sara', cv }))
    await submit(it)
    expect(sendsOf(it)[0]!.entries).toContainEqual(['cv', cv])
  })

  test('a chosen file goes to the shell as a File, and an empty one never', async () => {
    const it = await openEmpty()
    type(it, '[name=name]', 'Sara')
    await submit(it)
    const empty = it.raw().at(-1) as { send: SendRequest }
    expect(empty.send.entries.some(([name]) => name === 'cv')).toBe(false)
    await it.fail(it.requests('send')[0]!.id, 'unavailable')

    const input = it.field('[name=cv]')
    const file = new it.page.win.File(['%PDF'], 'cv.pdf', {
      type: 'application/pdf',
    })
    // happy-dom takes a list of files for a file input.
    ;(input as unknown as { files: unknown }).files = [file]
    await submit(it)
    const sent = it.raw().at(-1) as { send: SendRequest }
    const value = sent.send.entries.find(([name]) => name === 'cv')?.[1]
    expect(value).toBe(file)
  })
})

describe('autosave', () => {
  const BOARD = `
    <form data-dossier-form="2">
      <input name="title">
    </form>`

  test('a form without a submit button saves 800 ms after the last input', async () => {
    const it = open({ body: BOARD, forms: [SHARED] })
    await flush()
    await it.answer(it.requests('read')[0]!.id, null)
    type(it, '[name=title]', 'Pla')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY - 200)
    type(it, '[name=title]', 'Plan')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY - 1)
    await flush()
    expect(sendsOf(it)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(sendsOf(it)).toHaveLength(1)
    expect(sendsOf(it)[0]!.entries).toEqual([['title', 'Plan']])
    expect(it.status(2)).toBe('Saving…')
    await it.answer(it.requests('send')[0]!.id, { doc: null, replayed: false })
    expect(it.status(2)).toBe('Saved')
    expect(it.form(2).getAttribute('data-state')).toBe('sent')
  })

  test('manual mode never saves on its own', async () => {
    const it = open({
      body: BOARD.replace('<form', '<form data-dossier="manual"'),
      forms: [SHARED],
    })
    await flush()
    await it.answer(it.requests('read')[0]!.id, null)
    type(it, '[name=title]', 'Plan')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY * 2)
    await flush()
    expect(sendsOf(it)).toEqual([])
    expect(it.drafts()).toHaveLength(1)
  })
})

describe('page code and the submit event', () => {
  const MANUAL = PERSON_FORM.replace('<form', '<form data-dossier="manual"')

  test('manual: a handler on the form that cancels takes over; nothing is sent', async () => {
    const it = await openEmpty({ body: MANUAL })
    type(it, '[name=name]', 'Sara')
    it.form().addEventListener('submit', (event) => event.preventDefault())
    const event = await submit(it)
    expect(nativelyPrevented(event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(sendsOf(it)).toEqual([])
  })

  test('manual: a handler that lets it through sends once', async () => {
    const it = await openEmpty({ body: MANUAL })
    type(it, '[name=name]', 'Sara')
    const seen: boolean[] = []
    it.form().addEventListener('submit', (event) => {
      seen.push(event.defaultPrevented)
    })
    const event = await submit(it)
    expect(seen).toEqual([false])
    expect(nativelyPrevented(event)).toBe(true)
    expect(sendsOf(it)).toHaveLength(1)
  })

  test.each([
    ['automatic', PERSON_FORM],
    ['manual', MANUAL],
  ])(
    '%s: a window listener the page adds later can cancel',
    async (_, body) => {
      const it = await openEmpty({ body })
      type(it, '[name=name]', 'Sara')
      it.page.win.addEventListener('submit', (event) => event.preventDefault())
      await submit(it)
      expect(sendsOf(it)).toEqual([])
    },
  )

  test.each([
    ['automatic', PERSON_FORM],
    ['manual', MANUAL],
  ])(
    '%s: so can Event.prototype.preventDefault.call(event) in it',
    async (_, body) => {
      const it = await openEmpty({ body })
      type(it, '[name=name]', 'Sara')
      const EventClass = it.page.win.Event
      const native = EventClass.prototype.preventDefault
      it.page.win.addEventListener('submit', (event) => {
        EventClass.prototype.preventDefault.call(event as never)
      })
      const event = await submit(it)
      expect(event.defaultPrevented).toBe(true)
      expect(sendsOf(it)).toEqual([])
      // The decision put the native method back.
      expect(EventClass.prototype.preventDefault).toBe(native)
      // Other events keep the native behaviour throughout.
      const other = new EventClass('x', { cancelable: true })
      EventClass.prototype.preventDefault.call(other)
      expect(other.defaultPrevented).toBe(true)
    },
  )

  test('the browser never submits, even when a handler stops propagation', async () => {
    const it = await openEmpty()
    type(it, '[name=name]', 'Sara')
    it.form().addEventListener('submit', (event) => event.stopPropagation())
    const event = await submit(it)
    expect(nativelyPrevented(event)).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(sendsOf(it)).toHaveLength(1)
  })

  test('page code sees defaultPrevented false until it cancels', async () => {
    const it = await openEmpty()
    const seen: unknown[] = []
    it.form().addEventListener('submit', (event) => {
      seen.push(event.defaultPrevented, event.returnValue)
      event.returnValue = false
      seen.push(event.defaultPrevented, event.returnValue)
    })
    it.page.win.addEventListener('submit', (event) => {
      seen.push(event.defaultPrevented)
    })
    await submit(it)
    expect(seen).toEqual([false, true, true, false, true])
    expect(sendsOf(it)).toEqual([])
  })
})

describe('closing', () => {
  test('closes at closesAt; the withdraw button stays enabled', async () => {
    const it = await openEmpty({
      forms: [{ ...PERSON, closesAt: '2026-10-20T11:00:00' }],
    })
    await vi.advanceTimersByTimeAsync(
      Date.parse('2026-10-20T11:00:00') - Date.now() - 1,
    )
    expect(it.form().getAttribute('data-state')).not.toBe('closed')
    await vi.advanceTimersByTimeAsync(1)
    expect(it.form().getAttribute('data-state')).toBe('closed')
    expect(it.status()).toBe('This form closed on 20 October')
    expect(it.field('[name=name]').readOnly).toBe(true)
    expect(it.field<HTMLTextAreaElement>('[name=notes]').readOnly).toBe(true)
    expect(it.field('[name=agree]').disabled).toBe(true)
    expect(it.field<HTMLSelectElement>('[name=size]').disabled).toBe(true)
    expect(it.field<HTMLButtonElement>('[name=action]').disabled).toBe(true)
    expect(
      it.field<HTMLButtonElement>('[data-dossier-withdraw]').disabled,
    ).toBe(false)
    await submit(it)
    expect(sendsOf(it)).toEqual([])
  })

  test('a form already past closesAt opens closed', async () => {
    const it = await openEmpty({
      forms: [{ ...PERSON, closesAt: '2026-10-01T09:00:00' }],
    })
    expect(it.status()).toBe('This form closed on 1 October')
    expect(it.form().getAttribute('data-state')).toBe('closed')
  })

  test('a withdrawal empties a closed form, which stays closed', async () => {
    const it = open({ body: PERSON_FORM, forms: [{ ...PERSON, closed: true }] })
    await flush()
    await it.answer(it.requests('read')[0]!.id, wire({ name: 'Sara' }))
    expect(it.field('[name=name]').value).toBe('Sara')
    expect(it.status()).toBe('This form is closed.')
    const withdraw = it.field<HTMLButtonElement>('[data-dossier-withdraw]')
    withdraw.click()
    withdraw.click()
    await flush()
    await it.answer(it.requests('withdraw')[0]!.id, null)
    expect(it.field('[name=name]').value).toBe('')
    expect(it.field('[name=name]').readOnly).toBe(true)
    expect(it.form().getAttribute('data-state')).toBe('closed')
    expect(it.status()).toBe('This form is closed.')
  })
})

describe('withdrawing', () => {
  test('asks twice before withdrawing', async () => {
    const it = open({ body: PERSON_FORM })
    await flush()
    await it.answer(it.requests('read')[0]!.id, wire({ name: 'Sara' }))
    const withdraw = it.field<HTMLButtonElement>('[data-dossier-withdraw]')
    withdraw.click()
    expect(withdraw.textContent).toBe('Tap again to withdraw')
    await vi.advanceTimersByTimeAsync(WITHDRAW_CONFIRM)
    expect(withdraw.textContent).toBe('Withdraw')
    expect(it.requests('withdraw')).toEqual([])

    withdraw.click()
    withdraw.click()
    await flush()
    const [request] = it.requests('withdraw')
    expect(request).toMatchObject({
      path: '/questions/answers/sara@acme.com.json',
    })
    expect(request!.opId).toMatch(/^[0-9a-f-]{36}$/)
    expect(withdraw.textContent).toBe('Withdraw')
    await it.answer(request!.id, null)
    expect(it.field('[name=name]').value).toBe('')
    expect(it.status()).toBe('Your answer was withdrawn.')
    expect(it.form().getAttribute('data-state')).toBe('idle')
  })
})

describe('entries, roles and resumed sends', () => {
  test('an entries form resets for the next entry after a send', async () => {
    const it = open({
      body: '<form data-dossier-form="3"><input name="idea" value=""><button>Add</button></form>',
      forms: [ENTRIES],
    })
    await flush()
    type(it, '[name=idea]', 'Lunch talks')
    await submit(it, 3)
    await it.answer(it.requests('send')[0]!.id, {
      doc: wire(
        { idea: 'Lunch talks' },
        '2026-10-12T15:00:00',
        'questions/ideas/x.json',
      ),
      replayed: false,
    })
    expect(it.field('[name=idea]').value).toBe('')
    expect(it.status(3)).toBe('Sent on 12 Oct at 15:00')
  })

  test('a viewer who can only read sees every field locked', async () => {
    const it = await openEmpty({ me: { ...SARA, role: 'read' } })
    expect(it.status()).toBe('You can open this but not change it.')
    expect(it.field('[name=name]').readOnly).toBe(true)
    expect(it.field('[name=color][value=red]').disabled).toBe(true)
    expect(it.field('[name=cv]').disabled).toBe(true)
    expect(it.field<HTMLButtonElement>('[name=action]').disabled).toBe(true)
  })

  test('a send the shell is replaying shows Sending… until it answers', async () => {
    const key = formKey(PERSON)
    const it = await openEmpty({
      resume: [key],
      drafts: { [key]: { name: 'Kept' } },
    })
    expect(it.status()).toBe('Sending…')
    expect(it.form().getAttribute('data-state')).toBe('sending')
    expect(it.field('[name=name]').value).toBe('Kept')
    it.page.shell.tell({
      type: 'resumed',
      form: key,
      ok: true,
      value: {
        doc: wire({ name: 'Kept' }, '2026-10-12T15:00:00'),
        replayed: false,
      },
    })
    await flush()
    expect(it.status()).toBe('Sent on 12 Oct at 15:00')
    expect(it.form().getAttribute('data-state')).toBe('sent')
  })
})

describe('review fixes', () => {
  const ok = (data: unknown = { name: 'Sara' }) => ({
    doc: wire(data, '2026-10-12T14:30:00'),
    replayed: false,
  })

  test('a resumed send leaves the draft and the edits made since the page opened', async () => {
    const key = formKey(PERSON)
    const it = open({
      body: PERSON_FORM,
      drafts: { [key]: { name: 'Kept' } },
      resume: [key],
    })
    await flush()
    await it.answer(it.requests('read')[0]!.id, null)
    type(it, '[name=name]', 'Newer')
    await vi.advanceTimersByTimeAsync(DRAFT_DELAY)
    it.page.shell.tell({ type: 'resumed', form: key, ok: true, value: ok() })
    await flush()
    expect(it.drafts().at(-1)).toMatchObject({ values: { name: 'Newer' } })
    expect(it.field('[name=name]').value).toBe('Newer')
    expect(it.form().getAttribute('data-state')).toBe('draft')
  })

  test('a prefill that comes after a resumed send keeps what was sent', async () => {
    const key = formKey(PERSON)
    const it = open({
      body: PERSON_FORM,
      drafts: { [key]: { name: 'From the draft' } },
      resume: [key],
    })
    await flush()
    it.page.shell.tell({
      type: 'resumed',
      form: key,
      ok: true,
      value: ok({ name: 'As sent' }),
    })
    await flush()
    await it.answer(
      it.requests('read')[0]!.id,
      wire({ name: 'Older' }, '2026-10-12T09:00:00'),
    )
    await flush()
    expect(it.field('[name=name]').value).toBe('As sent')
    expect(it.form().getAttribute('data-state')).toBe('sent')
  })

  test('each attempt keeps its own op ID: edits during a send go under a new one', async () => {
    const BOARD = '<form data-dossier-form="2"><input name="title"></form>'
    const it = open({ body: BOARD, forms: [SHARED] })
    await flush()
    await it.answer(it.requests('read')[0]!.id, null)
    type(it, '[name=title]', 'A')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY)
    await flush()
    const [first] = it.requests('send')
    type(it, '[name=title]', 'AB')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY)
    await it.fail(first!.id, 'offline')
    await flush()
    const sends = sendsOf(it)
    expect(sends).toHaveLength(2)
    expect(sends[1]!.entries).toEqual([['title', 'AB']])
    expect(sends[1]!.opId).not.toBe(sends[0]!.opId)
  })

  test('Try again sends the failed attempt as it was, under its op ID', async () => {
    const it = await openEmpty()
    type(it, '[name=name]', 'Sara')
    await submit(it)
    const [first] = it.requests('send')
    await it.fail(first!.id, 'offline')
    ;(it.doc.querySelector('[data-dossier-retry]') as HTMLButtonElement).click()
    await flush()
    const sends = sendsOf(it)
    expect(sends[1]).toEqual(sends[0])
  })

  test('an entries form keeps what the person typed while its send was in flight', async () => {
    const BODY =
      '<form data-dossier-form="3"><input name="idea"><button>Add</button></form>'
    const it = open({ body: BODY, forms: [ENTRIES] })
    await flush()
    type(it, '[name=idea]', 'First')
    await submit(it, 3)
    type(it, '[name=idea]', 'Second, typed meanwhile')
    await it.answer(it.requests('send')[0]!.id, ok({ idea: 'First' }))
    expect(it.field('[name=idea]').value).toBe('Second, typed meanwhile')
  })

  test('a kept upload satisfies a required file field and goes with the next send', async () => {
    const BODY = `<form data-dossier-form="1"><input name="name">
      <input type="file" name="cv" required><button>Send</button></form>`
    const it = open({ body: BODY })
    await flush()
    const cv = { file: 'files/cv.pdf', name: 'cv.pdf', size: 4, type: 'x' }
    await it.answer(it.requests('read')[0]!.id, wire({ name: 'Sara', cv }))
    expect(it.form().checkValidity()).toBe(true)
    await submit(it)
    expect(sendsOf(it)[0]!.entries).toContainEqual(['cv', cv])
  })

  test('several kept uploads of one field all go with the next send', async () => {
    const BODY = `<form data-dossier-form="1"><input name="name">
      <input type="file" name="cv" multiple><button>Send</button></form>`
    const it = open({ body: BODY })
    await flush()
    const a = { file: 'files/a.pdf', name: 'a.pdf', size: 1, type: 'x' }
    const b = { file: 'files/b.pdf', name: 'b.pdf', size: 1, type: 'x' }
    await it.answer(
      it.requests('read')[0]!.id,
      wire({ name: 'Sara', cv: [a, b] }),
    )
    await submit(it)
    const files = sendsOf(it)[0]!.entries.filter(([name]) => name === 'cv')
    expect(files).toEqual([
      ['cv', a],
      ['cv', b],
    ])
  })

  test('a viewer who may only read can still withdraw their own answer', async () => {
    const it = open({ body: PERSON_FORM, me: { ...SARA, role: 'read' } })
    await flush()
    const withdraw = it.doc.querySelector(
      '[data-dossier-withdraw]',
    ) as HTMLButtonElement
    expect(withdraw.disabled).toBe(false)
    expect(it.field('[name=name]').readOnly).toBe(true)
  })

  test('a managed form cloned from a template is set up like the others', async () => {
    const it = open({
      body: `<template id="t">${PERSON_FORM}</template><div id="here"></div>`,
    })
    await flush()
    expect(it.requests('read')).toHaveLength(0)
    const template = it.doc.getElementById('t') as HTMLTemplateElement
    it.doc
      .getElementById('here')!
      .append(template.content.cloneNode(true) as DocumentFragment)
    await flush()
    expect(it.form().getAttribute('data-state')).toBe('idle')
    expect(
      it.form().querySelector('output[data-dossier-status]'),
    ).not.toBeNull()
    expect(it.requests('read')).toHaveLength(1)
  })
})

describe('second review fixes', () => {
  const ack = (data: unknown) => ({
    doc: wire(data, '2026-10-12T14:30:00'),
    replayed: true,
  })

  test('after a reload, a kept send acknowledged later never replaces a newer draft', async () => {
    const key = formKey(PERSON)
    const it = open({
      body: PERSON_FORM,
      drafts: { [key]: { name: 'B, typed after A was kept' } },
      resume: [key],
    })
    await flush()
    it.page.shell.tell({
      type: 'resumed',
      form: key,
      ok: true,
      value: ack({ name: 'A' }),
      sent: { name: 'A' },
    })
    await flush()
    await it.answer(it.requests('read')[0]!.id, wire({ name: 'A' }))
    await flush()
    expect(it.field('[name=name]').value).toBe('B, typed after A was kept')
    expect(
      it.drafts().some((d) => (d as { values: unknown }).values === null),
    ).toBe(false)
    expect(it.form().getAttribute('data-state')).toBe('draft')
  })

  test('a kept send acknowledged while a newer attempt is in flight leaves the form alone', async () => {
    const key = formKey(PERSON)
    const it = await openEmpty({ resume: [key] })
    type(it, '[name=name]', 'C')
    await submit(it)
    it.page.shell.tell({
      type: 'resumed',
      form: key,
      ok: true,
      value: ack({ name: 'A' }),
      sent: { name: 'A' },
    })
    await flush()
    expect(it.field('[name=name]').value).toBe('C')
    expect(it.form().getAttribute('data-state')).toBe('sending')
    expect(
      it.drafts().some((d) => (d as { values: unknown }).values === null),
    ).toBe(false)
  })

  test('an acknowledgement keeps a file chosen while its send was in flight', async () => {
    const it = await openEmpty()
    type(it, '[name=name]', 'Sara')
    const input = it.field('[name=cv]')
    const first = new it.page.win.File(['one'], 'one.pdf', {
      type: 'application/pdf',
    })
    ;(input as unknown as { files: unknown }).files = [first]
    await submit(it)
    const second = new it.page.win.File(['two'], 'two.pdf', {
      type: 'application/pdf',
    })
    ;(input as unknown as { files: unknown }).files = [second]
    const cv = { file: 'files/one.pdf', name: 'one.pdf', size: 3, type: 'x' }
    await it.answer(it.requests('send')[0]!.id, ack({ name: 'Sara', cv }))
    expect((input as HTMLInputElement).files?.[0]).toBe(second)
  })

  test('a marked form submitted before it is set up is sent all the same', async () => {
    const it = open({ body: '<div id="here"></div>' })
    await flush()
    // A form the controller has not seen yet: the browser reports added
    // nodes only after the task that added them, and a submit can come first.
    const holder = it.doc.createElement('div')
    holder.innerHTML = PERSON_FORM
    const form = holder.querySelector('form') as HTMLFormElement
    ;(form.querySelector('[name=name]') as HTMLInputElement).value = 'Now'
    it.installed.forms()!.submitted(form, null, 'method')
    await flush()
    expect(sendsOf(it)).toHaveLength(1)
    expect(sendsOf(it)[0]!.entries).toContainEqual(['name', 'Now'])
  })
})
