// Moves a stylesheet written for a shadow root into the page's own DOM: every
// rule is nested inside `:where(<scope>)`, `:host` becomes the scope itself,
// and the whole sheet sits in a cascade layer of its own, so its rules never
// reach outside the scope and any page or kit CSS beats them, whatever their
// specificity.

/** The top-level parts of a stylesheet: `@x …;` statements and `prelude{body}` blocks. */
const topLevel = (
  css: string,
): { readonly prelude: string; readonly body: string | null }[] => {
  const parts: { prelude: string; body: string | null }[] = []
  let at = 0
  let start = 0
  let depth = 0
  let open = -1
  let quote: string | null = null
  while (at < css.length) {
    const char = css[at]!
    if (quote !== null) {
      if (char === '\\') at += 1
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '{') {
      if (depth === 0) open = at
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        parts.push({
          prelude: css.slice(start, open).trim(),
          body: css.slice(open + 1, at),
        })
        start = at + 1
      }
    } else if (char === ';' && depth === 0) {
      parts.push({ prelude: css.slice(start, at).trim(), body: null })
      start = at + 1
    }
    at += 1
  }
  return parts.filter((part) => part.prelude !== '' || part.body !== null)
}

const withoutComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * `css` nested inside `:where(scope)` in the layer `layer`. A top-level
 * `@layer name{…}` keeps its name inside `layer`, so the sheet's own layer
 * order holds and never mixes with the page's layers.
 */
export const scopeCss = (css: string, scope: string, layer: string): string => {
  const outer = `:where(${scope})`
  const nest = (body: string) =>
    `${outer}{${body.replace(/:host(?![\w-])/g, '&')}}`
  const out: string[] = []
  for (const { prelude, body } of topLevel(withoutComments(css))) {
    if (body === null) {
      // Only the layer order may stand outside a rule.
      if (/^@layer\s/.test(prelude)) out.push(`${prelude};`)
      continue
    }
    if (/^@layer\s/.test(prelude)) out.push(`${prelude}{${nest(body)}}`)
    else out.push(nest(`${prelude}{${body}}`))
  }
  return `@layer ${layer}{${out.join('')}}`
}
