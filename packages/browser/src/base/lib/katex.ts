// Math in Pandoc's markup, rendered with KaTeX: `.math.inline` and
// `.math.display` hold TeX, optionally inside \( \) or \[ \]. KaTeX adds its
// own stylesheet once, imported into the base layer so page and kit CSS win;
// its fonts sit beside it, or inside it in a page downloaded as one file.
import { texOf } from '@dossier/html/libraries'
import { render as renderTex } from 'katex'

import type { LibraryContext } from '../../page-client/libraries.ts'
import { baseFileUrl } from '../export-url.ts'
import { addBaseStylesheet } from '../styles.ts'

const STYLESHEET = 'lib/katex/katex.css'

export const render = async (
  elements: readonly Element[],
  context: LibraryContext,
): Promise<void> => {
  let stylesheet: string | null = null
  try {
    stylesheet = baseFileUrl(context.base, STYLESHEET)
  } catch {
    // The math still renders, unstyled.
    context.reportFailure(`${context.base}/${STYLESHEET}`)
  }
  if (stylesheet !== null) {
    addBaseStylesheet(context.window.document, 'katex', stylesheet)
  }
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
