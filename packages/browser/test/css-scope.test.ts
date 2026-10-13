import { describe, expect, test } from 'vitest'
import { scopeCss, specificityOf } from '../src/base/css-scope.ts'

describe('specificity', () => {
  test.each([
    ['pre', [0, 0, 1]],
    ['[data-a] [data-b]', [0, 2, 0]],
    [':where(.x) pre', [0, 0, 1]],
    [':is(.a, #b) p::before', [1, 0, 2]],
    ['a:hover', [0, 1, 1]],
    ['[data-x="a b"]:before', [0, 1, 1]],
    ['::-webkit-scrollbar-thumb:hover', [0, 1, 1]],
    ['*', [0, 0, 0]],
  ] as const)('of %s is %j', (selector, expected) => {
    expect(specificityOf(selector)).toEqual(expected)
  })
})

describe('a shadow-root sheet scoped into the page', () => {
  const sheet =
    '@layer base,theme;' +
    '@layer base{:host{color:red;--x:1}pre,code{margin:0}' +
    '[data-line]{color:blue;& [data-number]{color:green}}' +
    '@media (pointer:fine){[data-line][data-hovered]{color:purple}}}' +
    '@layer theme{[data-line]::before{content:""}}' +
    '[data-loose]{color:black}'
  const css = scopeCss(sheet, '.scope', 'diff')

  /** Every rule's selector and the sublayer path it sits in. */
  const rules = (text: string) => {
    const found: { readonly layers: string; readonly selector: string }[] = []
    const walk = (body: string, layers: string[]) => {
      let depth = 0
      let start = 0
      let open = -1
      for (let at = 0; at < body.length; at += 1) {
        const char = body[at]
        if (char === '"') at = body.indexOf('"', at + 1)
        else if (char === '{') {
          if (depth === 0) open = at
          depth += 1
        } else if (char === '}') {
          depth -= 1
          if (depth === 0) {
            const prelude = body.slice(start, open).trim()
            const inner = body.slice(open + 1, at)
            if (prelude.startsWith('@layer')) {
              walk(inner, [...layers, prelude.slice(7).trim()])
            } else if (prelude.startsWith('@')) walk(inner, layers)
            else found.push({ layers: layers.join('.'), selector: prelude })
            start = at + 1
          }
        } else if (char === ';' && depth === 0) start = at + 1
      }
    }
    walk(text, [])
    return found
  }

  test('starts every selector, nested ones included, with :where(', () => {
    const list = rules(css)
    expect(list.length).toBeGreaterThan(5)
    for (const { selector } of list)
      expect(selector.startsWith(':where(')).toBe(true)
    expect(css).not.toContain(':host')
    expect(css).not.toContain('&')
  })

  test('scopes every rule, :host included, to the scope', () => {
    for (const { selector } of rules(css)) {
      expect(selector).toContain(':where(.scope)')
    }
  })

  test('keeps the sheet’s layers in order, inside its own layer, with loose rules last', () => {
    expect(css.startsWith('@layer diff{@layer base,theme,direct;')).toBe(true)
    const layerOf = (selector: string) =>
      rules(css).find((rule) => rule.selector.includes(selector))!.layers
    expect(layerOf('[data-loose]')).toBe('diff.direct.s0-1-0')
    expect(layerOf('::before')).toMatch(/^diff\.theme\./)
  })

  test('puts a more specific rule in a later sublayer, so it still wins', () => {
    const layerOf = (selector: string) =>
      rules(css).find((rule) => rule.selector.includes(selector))!.layers
    // [data-line] [data-number] (0,2,0) beats [data-line] (0,1,0), which
    // beats pre (0,0,1); the hovered line inside @media is (0,2,0) too.
    expect(layerOf('[data-number]')).toBe('diff.base.s0-2-0')
    expect(layerOf('[data-hovered]')).toBe('diff.base.s0-2-0')
    expect(rules(css).find((r) => r.selector.endsWith(' pre)'))!.layers).toBe(
      'diff.base.s0-0-1',
    )
    const order = /@layer base\{@layer ([^;]+);/.exec(css)![1]!.split(',')
    expect(order).toEqual(['s0-0-0', 's0-0-1', 's0-1-0', 's0-2-0'])
  })

  test('leaves a pseudo-element after :where(), where it must be', () => {
    const before = rules(css).find((r) => r.selector.includes('::before'))!
    expect(before.selector).toMatch(/^:where\([^]*\)::before$/)
  })
})
