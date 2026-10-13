// The imports of a JavaScript module, for exporting a page as one file: each
// module the page loads is inlined, and the specifiers that name other
// modules are rewritten to the names the file's import map gives them.
// es-module-lexer's JavaScript build reads modules as a browser does, so
// the word "import" in a string or a comment is never taken for one.
import { parse } from 'es-module-lexer/js'

import type { Range } from './analyze.ts'

/** Bumped whenever the analysis changes shape or meaning. */
export const JS_ANALYZER_VERSION: number = 1

export interface JsImport {
  /** As the module names it, escapes decoded. */
  readonly specifier: string
  /** The specifier's text inside its quotes. */
  readonly range: Range
  /** `import('…')` with a string literal. */
  readonly dynamic: boolean
}

export interface JsAnalysis {
  /** JS_ANALYZER_VERSION. */
  readonly v: number
  /**
   * Static imports and re-exports, side-effect imports, and dynamic imports
   * whose argument is one string literal, in source order.
   */
  readonly imports: readonly JsImport[]
}

const STATIC = 1
const DYNAMIC = 2
const QUOTES = new Set(['"', "'", '`'])

/** The modules a module imports; none for a source that does not parse. */
export const analyzeJs = (source: string): JsAnalysis => {
  let found: ReturnType<typeof parse>[0]
  try {
    ;[found] = parse(source)
  } catch {
    return { v: JS_ANALYZER_VERSION, imports: [] }
  }
  const imports: JsImport[] = []
  for (const item of found) {
    if (item.n === undefined) continue
    if (item.t === STATIC) {
      imports.push({
        specifier: item.n,
        range: { start: item.s, end: item.e },
        dynamic: false,
      })
      continue
    }
    if (item.t !== DYNAMIC) continue
    // The argument is exactly one string literal: a template with no
    // substitution counts, anything computed does not.
    const text = source.slice(item.s, item.e)
    const quote = text[0] ?? ''
    if (
      text.length < 2 ||
      !QUOTES.has(quote) ||
      text[text.length - 1] !== quote ||
      (quote === '`' && text.includes('${'))
    ) {
      continue
    }
    imports.push({
      specifier: item.n,
      range: { start: item.s + 1, end: item.e - 1 },
      dynamic: true,
    })
  }
  return { v: JS_ANALYZER_VERSION, imports }
}
