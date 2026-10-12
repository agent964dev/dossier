import { describe, expect, it } from 'vitest'
import {
  type FieldEntry,
  type FieldRule,
  type FormSchema,
  type SendCheck,
  analyze,
  closesAt,
  closingTime,
  formKind,
  formSchema,
  resolveFormAction,
  validateSend,
} from '../src/index.ts'
import { fixture } from './helpers.ts'

describe('resolveFormAction', () => {
  it('resolves a folder or a .json file beside the page', () => {
    expect(resolveFormAction('plan.html', 'decisions/')).toEqual({
      target: 'decisions',
      kind: 'folder',
    })
    expect(resolveFormAction('team/plan.html', 'decisions.json')).toEqual({
      target: 'team/decisions.json',
      kind: 'json',
    })
    expect(resolveFormAction('team/q3/plan.html', '../votes/')).toEqual({
      target: 'team/votes',
      kind: 'folder',
    })
    expect(resolveFormAction('team/plan.html', './a/./b/../c/')).toEqual({
      target: 'team/a/c',
      kind: 'folder',
    })
  })

  it('reads `.` and `..` at the end as folders', () => {
    expect(resolveFormAction('team/q3/plan.html', '..')).toEqual({
      target: 'team',
      kind: 'folder',
    })
    expect(resolveFormAction('team/plan.html', '.')).toEqual({
      target: 'team',
      kind: 'folder',
    })
  })

  it('percent-decodes names and drops a query or fragment after the path', () => {
    expect(resolveFormAction('plan.html', 'my%20answers/')).toEqual({
      target: 'my answers',
      kind: 'folder',
    })
    expect(resolveFormAction('plan.html', 'ideas.JSON#top')).toEqual({
      target: 'ideas.JSON',
      kind: 'json',
    })
    expect(resolveFormAction('plan.html', ' answers/?x=1 ')).toEqual({
      target: 'answers',
      kind: 'folder',
    })
  })

  it('refuses actions outside the tree', () => {
    for (const action of [
      'https://example.com/answers/',
      'mailto:sara@acme.com',
      '//example.com/answers/',
      '/answers/',
      '\\answers/',
      '?answer=1',
      '#form',
      '../answers/',
      'a/../../answers.json',
      '%2E%2E/answers/',
    ]) {
      expect(resolveFormAction('plan.html', action)).toEqual({
        problem: 'form_action_outside',
      })
    }
  })

  it('refuses `_` paths and the tree root as authored', () => {
    expect(resolveFormAction('plan.html', '_answers/')).toEqual({
      problem: 'form_action_authored',
    })
    expect(resolveFormAction('plan.html', 'a/%5Fkit/x.json')).toEqual({
      problem: 'form_action_authored',
    })
    expect(resolveFormAction('plan.html', './')).toEqual({
      problem: 'form_action_authored',
    })
    expect(resolveFormAction('team/plan.html', '../')).toEqual({
      problem: 'form_action_authored',
    })
  })

  it('refuses anything that is neither a folder nor a .json file', () => {
    for (const action of ['answers', 'answers.html', 'data.csv']) {
      expect(resolveFormAction('plan.html', action)).toEqual({
        problem: 'form_action_kind',
      })
    }
  })

  it('refuses names no file or folder can have', () => {
    expect(resolveFormAction('plan.html', 'a%2Fb/')).toEqual({
      problem: 'bad_name',
    })
    expect(resolveFormAction('plan.html', 'a%0Ab.json')).toEqual({
      problem: 'bad_name',
    })
  })

  it('leaves an empty action to the caller', () => {
    expect(resolveFormAction('plan.html', '  ')).toEqual({
      problem: 'form_without_action',
    })
  })
})

describe('closingTime', () => {
  it('reads a date and time with Z or an offset', () => {
    expect(closingTime('2026-10-20T18:00+03:00')).toBe(
      Date.UTC(2026, 9, 20, 15, 0),
    )
    expect(closingTime('2026-10-20T18:00:30Z')).toBe(
      Date.UTC(2026, 9, 20, 18, 0, 30),
    )
    expect(closingTime('2026-10-20T18:00-0430')).toBe(
      Date.UTC(2026, 9, 20, 22, 30),
    )
    expect(closingTime('2026-10-20 18:00:00.250z')).toBe(
      Date.UTC(2026, 9, 20, 18, 0, 0, 250),
    )
  })

  it('tells a missing offset from something that is not a date and time', () => {
    expect(closingTime('2026-10-20T18:00')).toBe('no_offset')
    expect(closingTime('2026-10-20')).toBeNull()
    expect(closingTime('next Friday')).toBeNull()
    expect(closingTime('2026-02-30T18:00Z')).toBeNull()
    expect(closingTime('2026-10-20T24:00Z')).toBeNull()
    expect(closingTime('')).toBeNull()
  })
})

const page = analyze(fixture('forms/fields.html'))
const [signup, feedback, other, later] = page.forms
const byName = (fields: readonly FieldRule[]) =>
  Object.fromEntries(fields.map((field) => [field.name, field]))
const signupFields = byName(signup?.fields ?? [])

describe('the fields of a form', () => {
  it('match the golden fields of every form on the page', () => {
    expect(
      page.forms.map(({ line, action, title, fields }) => ({
        line,
        action,
        title,
        fields,
      })),
    ).toEqual(JSON.parse(fixture('forms/fields.json')))
  })

  it('read each control as its field type', () => {
    expect(
      Object.fromEntries(
        signup!.fields.map((field) => [field.name, field.type]),
      ),
    ).toEqual({
      name: 'text',
      secret: 'text',
      email: 'email',
      site: 'url',
      phone: 'tel',
      query: 'search',
      colour: 'color',
      source: 'hidden',
      mystery: 'text',
      guests: 'number',
      budget: 'number',
      amount: 'number',
      volume: 'range',
      seats: 'number',
      day: 'date',
      start: 'time',
      meeting: 'datetime-local',
      month: 'month',
      week: 'week',
      meal: 'radio',
      workshops: 'checkboxes',
      agree: 'checkbox',
      size: 'select',
      topics: 'select-multiple',
      notes: 'textarea',
      photo: 'file',
      papers: 'file',
      decision: 'submit',
      referral: 'text',
    })
  })

  it('take the form’s title from its first legend, else its aria-label', () => {
    expect(page.forms.map((form) => form.title)).toEqual([
      'Your details',
      'Quick feedback',
      null,
      null,
    ])
  })

  it('label a field by its label, the label around it, or its aria-label', () => {
    expect(signupFields.name?.label).toBe('Full name')
    expect(signupFields.secret?.label).toBe('Password')
    expect(signupFields.site?.label).toBe('Your website')
    expect(signupFields.agree?.label).toBe('I agree to the terms')
    expect(signupFields.notes?.label).toBe('Notes')
    expect(signupFields.topics?.label).toBe('Topics')
    expect(signupFields.source?.label).toBeNull()
  })

  it('label a group of radios or checkboxes by its fieldset’s legend', () => {
    expect(signupFields.meal?.label).toBe('Meal')
    expect(signupFields.workshops?.label).toBe('Workshops')
    expect(byName(feedback!.fields).pick?.label).toBeNull()
  })

  it('offer each radio, checkbox, button and option with its own label', () => {
    expect(signupFields.meal?.options).toEqual([
      { value: 'veg', label: 'Vegetarian' },
      { value: 'fish', label: 'Fish' },
      { value: 'on', label: 'No meal' },
    ])
    expect(signupFields.workshops?.options).toEqual([
      { value: 'html', label: 'HTML' },
      { value: 'css', label: 'CSS' },
    ])
    expect(signupFields.size?.options).toEqual([
      { value: '', label: 'Choose one' },
      { value: 'XS', label: 'XS' },
      { value: 's', label: 'Small size' },
      { value: 'l', label: 'Large' },
    ])
    expect(signupFields.topics?.options).toEqual([
      { value: 'Design', label: 'Design' },
      { value: 'code', label: 'Code' },
    ])
    expect(signupFields.decision?.options).toEqual([
      { value: 'yes', label: 'Count me in' },
      { value: 'maybe', label: 'Maybe' },
      { value: 'no', label: 'no' },
    ])
    expect(signupFields.agree?.options).toEqual([])
  })

  it('keep the rules as written', () => {
    expect(signupFields.name).toMatchObject({
      required: true,
      minLength: 2,
      maxLength: 80,
    })
    expect(signupFields.guests).toMatchObject({
      required: true,
      min: '1',
      max: '10',
      step: null,
    })
    expect(signupFields.budget).toMatchObject({ min: '0', step: '0.5' })
    expect(signupFields.amount?.step).toBe('any')
    expect(signupFields.seats).toMatchObject({
      minLength: null,
      maxLength: null,
    })
    expect(signupFields.phone?.pattern).toBe('\\+?[0-9 ]{7,15}')
    expect(signupFields.day).toMatchObject({
      min: '2026-10-01',
      max: '2026-12-31',
    })
    expect(signupFields.photo).toMatchObject({
      accept: 'image/*,.heic',
      multiple: false,
    })
    expect(signupFields.papers?.multiple).toBe(true)
    expect(signupFields.email?.multiple).toBe(true)
    expect(signupFields.topics?.multiple).toBe(true)
    expect(signupFields.mystery?.multiple).toBe(false)
    expect(signupFields.meal?.required).toBe(true)
  })

  it('follow the form attribute to the form it names, as browsers do', () => {
    expect(signup!.fields.at(-1)?.name).toBe('referral')
    expect(feedback!.fields.map((field) => field.name)).toEqual([
      'rating',
      'mixed',
      'pick',
      'go',
    ])
    expect(other!.fields.map((field) => field.name)).toEqual(['comment'])
    const names = page.forms.flatMap((form) => form.fields.map((f) => f.name))
    expect(names).not.toContain('stray')
  })

  it('leave out controls without a name, reset buttons and plain buttons', () => {
    expect(Object.keys(signupFields)).not.toContain('')
    for (const name of ['clear', 'helper', 'reset']) {
      expect(Object.keys(signupFields)).not.toContain(name)
    }
  })

  it('let the first control of a name decide its type', () => {
    const fields = byName(feedback!.fields)
    expect(fields.mixed).toMatchObject({ type: 'checkbox', options: [] })
    expect(fields.pick).toMatchObject({
      type: 'radio',
      options: [
        { value: 'a', label: 'a' },
        { value: 'b', label: 'b' },
      ],
    })
    expect(fields.go?.options).toEqual([{ value: '', label: 'Go' }])
  })

  it('read a form inside a template the same way', () => {
    expect(later?.action).toBe('later/')
    expect(later?.fields).toMatchObject([
      { name: 'later', type: 'text', label: 'Later', required: true },
    ])
  })
})

describe('formSchema, formKind and closesAt', () => {
  it('give the form as the person saw it', () => {
    expect(formSchema(signup!)).toEqual({
      title: 'Your details',
      fields: signup!.fields,
    })
  })

  it('tell a person’s answer, entries and a shared file apart', () => {
    const one = analyze('<form action="a/"></form>').forms[0]!
    const many = analyze('<form action="a/" data-entries="many"></form>')
      .forms[0]!
    expect(formKind(one, { kind: 'folder' })).toBe('person')
    expect(formKind(many, { kind: 'folder' })).toBe('entries')
    expect(formKind(one, { kind: 'json' })).toBe('shared')
    expect(formKind(many, { kind: 'json' })).toBe('shared')
  })

  it('give the closing time, or null when there is none to keep', () => {
    expect(closesAt('2026-10-20T18:00+03:00')).toBe(
      Date.UTC(2026, 9, 20, 15, 0),
    )
    expect(closesAt('2026-10-20T18:00')).toBeNull()
    expect(closesAt('Friday')).toBeNull()
  })
})

interface GoldenSend {
  readonly send: string
  readonly form: number
  readonly entries: readonly FieldEntry[]
  readonly submitter: { readonly name: string; readonly value: string } | null
  readonly expect: SendCheck
}

const SENDS: readonly GoldenSend[] = JSON.parse(fixture('forms/sends.json'))
const schemaOf = (index: number): FormSchema => formSchema(page.forms[index]!)

/** A one-field form, for the rules one at a time. */
const one = (field: Partial<FieldRule> & Pick<FieldRule, 'type'>) => {
  const rule: FieldRule = {
    name: 'f',
    label: null,
    required: false,
    min: null,
    max: null,
    step: null,
    minLength: null,
    maxLength: null,
    pattern: null,
    accept: null,
    multiple: false,
    options: [],
    ...field,
  }
  const schema: FormSchema = { title: null, fields: [rule] }
  return (...values: FieldEntry[1][]): SendCheck =>
    validateSend(
      schema,
      values.map((value) => [rule.name, value]),
      null,
    )
}

const problem = (check: SendCheck): string | null =>
  check.ok ? null : (check.problems[0]?.message ?? null)
const value = (check: SendCheck): unknown =>
  check.ok ? check.values.f : 'refused'

describe('validateSend', () => {
  it('holds a golden send for each case', () => {
    expect(SENDS.map((send) => send.send)).toHaveLength(8)
  })

  it.each(SENDS)('checks the send with $send', (send) => {
    expect(
      validateSend(schemaOf(send.form), send.entries, send.submitter),
    ).toEqual(send.expect)
  })

  it('types every input kind', () => {
    const golden = SENDS[0]!
    const check = validateSend(
      schemaOf(golden.form),
      golden.entries,
      golden.submitter,
    )
    expect(check.ok).toBe(true)
    if (!check.ok) return
    const kinds = Object.fromEntries(
      Object.entries(check.values).map(([name, typed]) => [
        name,
        Array.isArray(typed) ? 'list' : typed === null ? 'null' : typeof typed,
      ]),
    )
    expect(kinds).toMatchObject({
      name: 'string',
      guests: 'number',
      volume: 'number',
      seats: 'null',
      agree: 'boolean',
      workshops: 'list',
      topics: 'list',
      meal: 'string',
      photo: 'object',
      papers: 'list',
      decision: 'string',
    })
  })

  it('refuses names the form does not have, buttons included', () => {
    const check = validateSend(
      schemaOf(0),
      [
        ['decision', 'yes'],
        ['__proto__', 'x'],
      ],
      null,
    )
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.problems.slice(0, 2)).toEqual([
      { field: 'decision', message: 'This form has no field named decision.' },
      {
        field: '__proto__',
        message: 'This form has no field named __proto__.',
      },
    ])
  })

  it('keeps a field named like an object property as its own value', () => {
    const send = one({ type: 'text', name: '__proto__' })
    const check = send('x')
    expect(check.ok && Object.keys(check.values)).toEqual(['__proto__'])
  })

  it('reads a lone checkbox as true or false and empty lists as none chosen', () => {
    const box = one({ type: 'checkbox' })
    expect(value(box('on'))).toBe(true)
    expect(value(box(''))).toBe(true)
    expect(value(box())).toBe(false)
    const boxes = one({
      type: 'checkboxes',
      options: [{ value: 'a', label: 'A' }],
    })
    expect(value(boxes())).toEqual([])
    expect(problem(boxes('a', 'b'))).toBe('Choose one of the options offered.')
    const required = one({ type: 'checkboxes', required: true })
    expect(problem(required())).toBe('Choose at least one option.')
  })

  it('leaves out a text or file field that was not sent', () => {
    expect(value(one({ type: 'text' })())).toBeUndefined()
    expect(value(one({ type: 'file' })())).toBeUndefined()
    expect(value(one({ type: 'radio' })())).toBeNull()
    expect(value(one({ type: 'select-multiple' })())).toEqual([])
    expect(problem(one({ type: 'file', required: true })())).toBe(
      'Choose a file.',
    )
  })

  it('reads numbers as HTML writes them, with min, max and step', () => {
    const number = one({ type: 'number', min: '-1', max: '1e2', step: '0.1' })
    expect(value(number('0.3'))).toBe(0.3)
    expect(value(number('-1'))).toBe(-1)
    expect(value(number('1E2'))).toBe(100)
    expect(value(number(''))).toBeNull()
    for (const text of ['+1', '1.', ' 1', '0x10', 'Infinity', '1,5']) {
      expect(problem(number(text))).toBe('Enter a number.')
    }
    expect(problem(number('-2'))).toBe('Enter a value of -1 or more.')
    expect(problem(number('101'))).toBe('Enter a value of 1e2 or less.')
    expect(problem(number('0.15'))).toBe('Enter a valid value.')
    expect(problem(one({ type: 'number' })('1.5'))).toBe('Enter a valid value.')
    expect(value(one({ type: 'number', step: 'ANY' })('1.5'))).toBe(1.5)
    expect(problem(one({ type: 'range' })('101'))).toBe(
      'Enter a value of 100 or less.',
    )
  })

  it('checks dates and times by their kind, with min and max', () => {
    const date = one({ type: 'date' })
    expect(value(date('2024-02-29'))).toBe('2024-02-29')
    expect(problem(date('2025-02-29'))).toBe('Enter a valid value.')
    expect(problem(date('2026-1-05'))).toBe('Enter a valid value.')
    const time = one({ type: 'time', min: '09:00', max: '17:30' })
    expect(value(time('17:30:00.000'))).toBe('17:30:00.000')
    expect(value(time('09:00:00'))).toBe('09:00:00')
    expect(problem(time('17:30:01'))).toBe('Enter 17:30 or earlier.')
    expect(problem(time('24:00'))).toBe('Enter a valid value.')
    const local = one({ type: 'datetime-local', min: '2026-10-01T08:00' })
    expect(value(local('2026-10-01T08:00'))).toBe('2026-10-01T08:00')
    expect(problem(local('2026-10-01 08:00'))).toBe('Enter a valid value.')
    expect(problem(local('2026-09-30T23:59'))).toBe(
      'Enter 2026-10-01T08:00 or later.',
    )
    expect(problem(one({ type: 'month' })('2026-13'))).toBe(
      'Enter a valid value.',
    )
    expect(value(one({ type: 'week' })('2026-W53'))).toBe('2026-W53')
    expect(problem(one({ type: 'week' })('2026-W00'))).toBe(
      'Enter a valid value.',
    )
    expect(value(date(''))).toBeNull()
  })

  it('matches a pattern against the whole value, and ignores one that does not compile', () => {
    const code = one({ type: 'text', pattern: 'ab|cd' })
    expect(value(code('ab'))).toBe('ab')
    expect(problem(code('abcd'))).toBe('Match the requested format.')
    expect(value(one({ type: 'text', pattern: '(' })('anything'))).toBe(
      'anything',
    )
    expect(value(one({ type: 'textarea', pattern: 'x' })('y'))).toBe('y')
    const emails = one({
      type: 'email',
      multiple: true,
      pattern: '.+@acme\\.com',
    })
    expect(value(emails('a@acme.com,b@acme.com'))).toBe('a@acme.com,b@acme.com')
    expect(problem(emails('a@acme.com, b@other.com'))).toBe(
      'Match the requested format.',
    )
  })

  it('checks lengths in UTF-16 code units, on text fields only', () => {
    const short = one({ type: 'textarea', minLength: 3, maxLength: 4 })
    expect(problem(short('ab'))).toBe('Use at least 3 characters.')
    expect(value(short('😀😀'))).toBe('😀😀')
    expect(problem(short('😀😀a'))).toBe('Use at most 4 characters.')
    expect(
      value(one({ type: 'hidden', maxLength: 1, required: true })('long')),
    ).toBe('long')
  })

  it('checks email addresses and URLs as HTML does', () => {
    const email = one({ type: 'email' })
    expect(value(email('sara@acme.com'))).toBe('sara@acme.com')
    for (const text of ['sara', 'sara@', 'a@b.c, d@e.f', 'sara@-acme.com']) {
      expect(problem(email(text))).toBe('Enter an email address.')
    }
    const url = one({ type: 'url' })
    expect(value(url('mailto:sara@acme.com'))).toBe('mailto:sara@acme.com')
    expect(problem(url('/relative'))).toBe('Enter a URL.')
  })

  it('checks a file against the types its field accepts', () => {
    const file = (name: string, type: string) => ({
      file: 'f',
      name,
      size: 1,
      type,
    })
    const image = one({ type: 'file', accept: 'IMAGE/*, .pdf, text/csv' })
    expect(value(image(file('a.png', 'image/png')))).toEqual(
      file('a.png', 'image/png'),
    )
    expect(value(image(file('a.PDF', '')))).toEqual(file('a.PDF', ''))
    expect(value(image(file('a', 'text/csv; charset=utf-8')))).toEqual(
      file('a', 'text/csv; charset=utf-8'),
    )
    expect(problem(image(file('a.txt', 'text/plain')))).toBe(
      'Choose a file of a type this field accepts.',
    )
    expect(
      problem(image(file('a.png', 'image/png'), file('b.png', 'image/png'))),
    ).toBe('Send only one value for this field.')
    const broken = { file: 'f', name: 'a', size: '1', type: '' }
    expect(problem(one({ type: 'file' })(broken as never))).toBe(
      'Send a file, not text.',
    )
  })

  it('accepts only colours written #rrggbb', () => {
    const colour = one({ type: 'color' })
    expect(value(colour('#A0b1C2'))).toBe('#A0b1C2')
    expect(problem(colour('#abc'))).toBe('Enter a valid value.')
  })
})
