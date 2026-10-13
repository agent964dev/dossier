import { describe, expect, test } from 'vitest'

import { cssRefs } from '../src/index.ts'
import { fixture, slicer } from './helpers.ts'

describe('cssRefs', () => {
  test('finds @import and url() in every quoting form, and nothing in comments or strings', () => {
    const css = fixture('export/sheet.css')
    const expected = JSON.parse(fixture('export/sheet.expected.json')) as {
      url: string
      text: string
      kind: string
    }[]
    const text = slicer(css)
    expect(
      cssRefs(css).map((ref) => ({
        url: ref.url,
        text: text(ref.range),
        kind: ref.kind,
      })),
    ).toEqual(expected)
  })

  test('finds a url() in a style attribute’s declarations', () => {
    expect(cssRefs("background: url('a b.png') , url(c.png)")).toEqual([
      { url: 'a b.png', range: { start: 17, end: 24 }, kind: 'url' },
      { url: 'c.png', range: { start: 33, end: 38 }, kind: 'url' },
    ])
  })
})
