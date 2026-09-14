import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  StateScan,
  scanStateFields,
  statefulHtmlErrors,
  validateHtml,
  validateHtmlStatic,
  type HtmlPolicyOptions,
} from './index'

const OPTIONS: HtmlPolicyOptions = {
  maxBytes: 1024 * 1024,
  styleHostAllowlist: [],
  embedHostAllowlist: [],
  scriptHostAllowlist: [],
  publicOrigin: 'https://dossier.agent964.com',
}

function document(body: string, head = '<title>State fixture</title>'): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
}

function fields(body: string) {
  const result = scanStateFields(document(body))
  expect(result.errors).toEqual([])
  return result.fields
}

describe('scanStateFields defaults', () => {
  it('keeps text input values untrimmed', () => {
    expect(fields('<input data-state="title" value="  Launch  ">')).toEqual([
      { name: 'title', type: 'text', default: '  Launch  ' },
    ])
    expect(fields('<input data-state="empty">')[0]?.default).toBe('')
  })

  it('uses textarea text after the parser strips one leading newline', () => {
    expect(
      fields('<textarea data-state="notes">\nfirst\nsecond</textarea>'),
    ).toEqual([{ name: 'notes', type: 'textarea', default: 'first\nsecond' }])
  })

  it('parses valid number values and maps empty or invalid values to null', () => {
    expect(
      fields(`
        <input type="number" data-state="zero" value="0">
        <input type="number" data-state="decimal" value="-.5e2">
        <input type="number" data-state="empty" value="">
        <input type="number" data-state="invalid" value="12px">
        <input type="number" data-state="overflow" value="1e999">
      `),
    ).toEqual([
      { name: 'zero', type: 'number', default: 0 },
      { name: 'decimal', type: 'number', default: -50 },
      { name: 'empty', type: 'number', default: null },
      { name: 'invalid', type: 'number', default: null },
      { name: 'overflow', type: 'number', default: null },
    ])
  })

  it('uses browser-valid date strings and clears invalid dates', () => {
    expect(
      fields(`
        <input type="date" data-state="valid" value="2028-02-29">
        <input type="date" data-state="invalid" value="2027-02-29">
      `),
    ).toEqual([
      { name: 'valid', type: 'date', default: '2028-02-29' },
      { name: 'invalid', type: 'date', default: '' },
    ])
  })

  it('uses checked presence for checkboxes', () => {
    expect(
      fields(`
        <input type="checkbox" data-state="approved" checked="false">
        <input type="checkbox" data-state="reviewed">
      `),
    ).toEqual([
      { name: 'approved', type: 'checkbox', default: true },
      { name: 'reviewed', type: 'checkbox', default: false },
    ])
  })

  it('groups radios by data-state and uses the checked value', () => {
    expect(
      fields(`
        <input type="radio" data-state="decision" value="no">
        <input type="radio" data-state="decision" value="yes" checked>
        <input type="radio" data-state="implicit" checked>
        <input type="radio" data-state="unselected" value="later">
      `),
    ).toEqual([
      { name: 'decision', type: 'radio', default: 'yes' },
      { name: 'implicit', type: 'radio', default: 'on' },
      { name: 'unselected', type: 'radio', default: null },
    ])
  })

  it('collects selected values for a multiple select', () => {
    expect(
      fields(`
        <select data-state="owners" multiple>
          <option value="one" selected>One</option>
          <option>  two\n words  </option>
          <option selected>  three\n words  </option>
        </select>
      `),
    ).toEqual([
      {
        name: 'owners',
        type: 'select-multiple',
        default: ['one', 'three words'],
      },
    ])
  })

  it('preserves non-ASCII whitespace in implicit option values', () => {
    expect(
      fields(
        '<select data-state="choice"><option>&nbsp;x&nbsp;</option></select>',
      ),
    ).toEqual([{ name: 'choice', type: 'select', default: ' x ' }])
  })

  it('uses the last selected option for a single select', () => {
    expect(
      fields(`
        <select data-state="priority">
          <option value="low" selected>Low</option>
          <option value="high" selected>High</option>
        </select>
      `),
    ).toEqual([{ name: 'priority', type: 'select', default: 'high' }])
  })

  it('skips a disabled first option for the single-select fallback', () => {
    expect(
      fields(`
        <select data-state="priority">
          <option value="placeholder" disabled>Choose</option>
          <option value="normal">Normal</option>
        </select>
      `),
    ).toEqual([{ name: 'priority', type: 'select', default: 'normal' }])
  })

  it('treats options in a disabled optgroup as disabled', () => {
    expect(
      fields(`
        <select data-state="priority">
          <optgroup label="Old" disabled>
            <option value="old">Old</option>
          </optgroup>
          <optgroup label="Current">
            <option value="current">Current</option>
          </optgroup>
        </select>
      `),
    ).toEqual([{ name: 'priority', type: 'select', default: 'current' }])
  })

  it('uses an empty string when every single-select option is disabled', () => {
    expect(
      fields(`
        <select data-state="priority">
          <option disabled value="one">One</option>
          <optgroup disabled><option value="two">Two</option></optgroup>
        </select>
      `),
    ).toEqual([{ name: 'priority', type: 'select', default: '' }])
  })

  it('uses null for a size greater than one with no selected option', () => {
    expect(
      fields(`
        <select data-state="priority" size="2">
          <option value="one">One</option>
          <option value="two">Two</option>
        </select>
      `),
    ).toEqual([{ name: 'priority', type: 'select', default: null }])
  })

  it('parses custom JSON defaults and defaults missing JSON to null', () => {
    expect(
      fields(`
        <section data-state="decisions"
          data-state-default='{"approved":true,"votes":[1,2]}'>
        </section>
        <div data-state="unset"></div>
      `),
    ).toEqual([
      {
        name: 'decisions',
        type: 'json',
        default: { approved: true, votes: [1, 2] },
      },
      { name: 'unset', type: 'json', default: null },
    ])
  })
})

describe('scanStateFields validation', () => {
  it('skips template content and complete SVG subtrees', () => {
    expect(
      fields(`
        <input data-state="first" value="one">
        <template><input data-state="template" value="hidden"></template>
        <svg>
          <foreignObject>
            <input data-state="foreign" value="hidden">
          </foreignObject>
        </svg>
        <input data-state="last" value="two">
      `),
    ).toEqual([
      { name: 'first', type: 'text', default: 'one' },
      { name: 'last', type: 'text', default: 'two' },
    ])
  })

  it('rejects duplicate names with both source positions', () => {
    const result = scanStateFields(`<head></head>
<body>
  <input data-state="notes">
  <textarea data-state="notes"></textarea>
</body>`)

    expect(result).toEqual({
      ok: false,
      errors: [
        'data-state "notes" is declared twice: line 3 col 3 and line 4 col 3',
      ],
      fields: [{ name: 'notes', type: 'text', default: '' }],
    })
  })

  it('rejects names outside the documented grammar', () => {
    const result = scanStateFields(
      document('<input data-state="two words" value="no">'),
    )

    expect(result.ok).toBe(false)
    expect(result.fields).toEqual([])
    expect(result.errors[0]).toContain('names must match')
  })

  it('reports invalid custom JSON without emitting the field', () => {
    const result = scanStateFields(
      document(
        '<section data-state="bad" data-state-default="{oops"></section>',
      ),
    )

    expect(result.ok).toBe(false)
    expect(result.fields).toEqual([])
    expect(result.errors).toEqual([
      expect.stringContaining('invalid data-state-default JSON'),
    ])
  })

  it('rejects non-finite numbers in custom JSON defaults', () => {
    const result = scanStateFields(
      document(
        `<section data-state="bad" data-state-default='{"values":[1e999]}'></section>`,
      ),
    )

    expect(result.ok).toBe(false)
    expect(result.fields).toEqual([])
    expect(result.errors).toEqual([
      expect.stringContaining('invalid data-state-default JSON'),
    ])
  })

  it('returns fields in first-appearance order and matches StateScan', () => {
    const result = scanStateFields(
      document(`
        <input type="radio" data-state="first" value="no">
        <input data-state="second" value="two">
        <input type="radio" data-state="first" value="yes" checked>
      `),
    )

    expect(result.fields.map((field) => field.name)).toEqual([
      'first',
      'second',
    ])
    expect(result.fields[0]?.default).toBe('yes')
    expect(() => Schema.decodeUnknownSync(StateScan)(result)).not.toThrow()
  })
})

describe('statefulHtmlErrors', () => {
  it('requires exactly one literal head start tag after a BOM', () => {
    expect(statefulHtmlErrors(`﻿${document('')}`)).toEqual([])

    expect(
      statefulHtmlErrors('<!doctype html><html><body></body></html>'),
    ).toContain(
      'Stateful HTML must contain exactly one literal <head> start tag.',
    )

    expect(
      statefulHtmlErrors(
        '<!doctype html><html><head></head><body><head></head></body></html>',
      ),
    ).toContain(
      'Stateful HTML must contain exactly one literal <head> start tag.',
    )
  })

  it('rejects a content-security-policy meta tag', () => {
    expect(
      statefulHtmlErrors(
        document(
          '',
          '<meta http-equiv="Content-Security-Policy" content="default-src none">',
        ),
      ),
    ).toEqual([
      'Stateful HTML must not contain a <meta http-equiv="content-security-policy"> tag.',
    ])
  })

  it('rejects a plaintext element', () => {
    expect(statefulHtmlErrors(document('<plaintext>rest of file'))).toEqual([
      'Stateful HTML must not contain a <plaintext> tag.',
    ])
  })

  it('is appended by both HTML validators only when stateful is set', () => {
    const fixture = '<!doctype html><html><body><p>no head</p></body></html>'

    expect(validateHtml(fixture, OPTIONS).ok).toBe(true)
    expect(
      validateHtml(fixture, { ...OPTIONS, stateful: true }).errors,
    ).toContain(
      'Stateful HTML must contain exactly one literal <head> start tag.',
    )
    expect(validateHtmlStatic(fixture).ok).toBe(true)
    expect(validateHtmlStatic(fixture, { stateful: true }).errors).toContain(
      'Stateful HTML must contain exactly one literal <head> start tag.',
    )
  })
})
