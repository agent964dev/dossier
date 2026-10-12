// The libraries the base layer loads on pages that use their markup. No
// imports, so the page client can read the selectors without parse5.

export type LibraryName = 'mermaid' | 'shiki' | 'katex'

/** In the order the loader looks for them. */
export const LIBRARY_NAMES: readonly LibraryName[] = [
  'mermaid',
  'shiki',
  'katex',
]

/**
 * The markup each library renders: a Mermaid diagram's source in
 * `<pre class="mermaid">`, code in `<pre><code class="language-…">`, and TeX
 * in Pandoc's math markup.
 */
export const LIBRARY_SELECTORS: Readonly<Record<LibraryName, string>> = {
  mermaid: 'pre.mermaid',
  shiki: 'pre > code[class*="language-"]',
  katex: '.math.inline, .math.display',
}

/** The language a code element's class names: `language-ts` → `ts`. */
export const codeLanguageOf = (className: string): string | null => {
  for (const token of className.split(/[\t\n\f\r ]+/)) {
    if (token.startsWith('language-') && token.length > 'language-'.length) {
      return token.slice('language-'.length).toLowerCase()
    }
  }
  return null
}

/** The TeX inside Pandoc's math markup, without its \( \) or \[ \] delimiters. */
export const texOf = (text: string): string => {
  const tex = text.trim()
  for (const [open, close] of [
    ['\\(', '\\)'],
    ['\\[', '\\]'],
  ] as const) {
    if (tex.startsWith(open) && tex.endsWith(close)) {
      return tex.slice(open.length, tex.length - close.length).trim()
    }
  }
  return tex
}
