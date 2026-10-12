// Math in Pandoc's markup, rendered with KaTeX: `.math.inline` and
// `.math.display` hold TeX, optionally inside \( \) or \[ \]. KaTeX adds its
// own stylesheet once; its fonts sit beside it.
import { texOf } from '@dossier/html/libraries'
import { render as renderTex } from 'katex'

import type { LibraryContext } from '../../page-client/libraries.ts'

const addStylesheet = (document: Document, href: string): void => {
  if (document.querySelector('link[data-dossier-base="katex"]') !== null) {
    return
  }
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  link.setAttribute('data-dossier-base', 'katex')
  ;(document.head ?? document.documentElement).appendChild(link)
}

export const render = async (
  elements: readonly Element[],
  context: LibraryContext,
): Promise<void> => {
  addStylesheet(context.window.document, `${context.base}/lib/katex/katex.css`)
  for (const element of elements) {
    const tex = texOf(element.textContent ?? '')
    const displayMode = element.classList.contains('display')
    // Math reads left to right inside a right-to-left page.
    if (!element.hasAttribute('dir')) element.setAttribute('dir', 'ltr')
    renderTex(tex, element as HTMLElement, {
      displayMode,
      throwOnError: false,
      output: 'htmlAndMathml',
    })
    element.setAttribute('data-processed', '')
  }
}
