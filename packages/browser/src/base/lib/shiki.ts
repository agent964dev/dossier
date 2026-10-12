// Code written as `<pre><code class="language-…">`, highlighted with the
// shared Shiki. The tokens go into the page's own <code> element, each
// coloured with a --dossier-code- variable, so code follows the page's
// color-scheme and needs no stylesheet. Code reads left to right unless the
// author set dir on the <pre>.
import { codeLanguageOf } from '@dossier/html/libraries'

import type { LibraryContext } from '../../page-client/libraries.ts'
import {
  getHighlighter,
  loadLanguage,
  THEME_NAME,
  useFailureReport,
  useGrammarBase,
} from './highlighter.ts'

/** Shiki's font style flags. */
const ITALIC = 1
const BOLD = 2
const UNDERLINE = 4
const STRIKETHROUGH = 8

export const render = async (
  elements: readonly Element[],
  context: LibraryContext,
): Promise<void> => {
  useGrammarBase(context.base)
  useFailureReport(context.reportFailure)
  const shiki = await getHighlighter()
  const doc = context.window.document
  for (const code of elements) {
    const language = codeLanguageOf(code.getAttribute('class') ?? '')
    if (language === null) continue
    const loaded = await loadLanguage(language)
    if (loaded === null) continue
    const source = code.textContent ?? ''
    const { tokens } = shiki.codeToTokens(source, {
      lang: loaded,
      theme: THEME_NAME,
    })
    const out = doc.createDocumentFragment()
    tokens.forEach((line, index) => {
      if (index > 0) out.append('\n')
      for (const token of line) {
        const span = doc.createElement('span')
        span.textContent = token.content
        if (token.color !== undefined) span.style.color = token.color
        const style = token.fontStyle ?? 0
        if (style & ITALIC) span.style.fontStyle = 'italic'
        if (style & BOLD) span.style.fontWeight = 'bold'
        const lines = [
          ...(style & UNDERLINE ? ['underline'] : []),
          ...(style & STRIKETHROUGH ? ['line-through'] : []),
        ]
        if (lines.length > 0) span.style.textDecoration = lines.join(' ')
        out.append(span)
      }
    })
    code.replaceChildren(out)
    code.setAttribute('data-processed', '')
    const pre = code.parentElement
    if (pre !== null && !pre.hasAttribute('dir')) pre.setAttribute('dir', 'ltr')
  }
}
