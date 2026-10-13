// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest'
import { addBaseStyles, addBaseStylesheet } from '../src/base/styles.ts'

afterEach(() => {
  document.head.replaceChildren()
})

describe('base styles', () => {
  test('import a library’s own stylesheet into the base layer, declared before the page’s styles', () => {
    const author = document.createElement('style')
    author.textContent = '.katex { font-size: 31px }'
    document.head.append(author)
    addBaseStylesheet(document, 'katex', '/_/base/b1/lib/katex/katex.css')
    addBaseStylesheet(document, 'katex', '/_/base/b1/lib/katex/katex.css')
    const order = document.head.firstElementChild!
    expect(order.getAttribute('data-dossier-base-order')).toBe('')
    expect(order.textContent).toBe('@layer dossier;')
    const sheets = document.querySelectorAll('style[data-dossier-base="katex"]')
    expect(sheets).toHaveLength(1)
    expect(sheets[0]!.textContent).toBe(
      '@import url("/_/base/b1/lib/katex/katex.css") layer(dossier);',
    )
    expect(document.querySelector('link[rel="stylesheet"]')).toBeNull()
  })

  test('declare the base layer once, however many sheets are added', () => {
    addBaseStyles(document, 'dossier-copy', ':where(.a){color:red}')
    addBaseStylesheet(document, 'katex', '/k.css')
    expect(
      document.querySelectorAll('style[data-dossier-base-order]'),
    ).toHaveLength(1)
    expect(
      document.querySelector('style[data-dossier-base="dossier-copy"]')!
        .textContent,
    ).toBe('@layer dossier{:where(.a){color:red}}')
  })
})
