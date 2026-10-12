// The one Shiki every base piece shares: highlighted code and <dossier-diff>
// load grammars from the base layer's grammar files and colour tokens with
// the CSS-variables theme, whose --dossier-code- variables default to
// light-dark() pairs from GitHub's light and dark themes. Code then follows
// the page's color-scheme, and any page or kit CSS can set the variables.
import {
  createCssVariablesTheme,
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

import type { BaseGrammar } from '@dossier/contracts/base'

/** Language or alias → its grammar file; written in by the build. */
declare const __SHIKI_GRAMMARS__: Readonly<Record<string, BaseGrammar>>

const GRAMMARS: Readonly<Record<string, BaseGrammar>> =
  typeof __SHIKI_GRAMMARS__ === 'undefined' ? {} : __SHIKI_GRAMMARS__

export const THEME_NAME = 'dossier'

/** GitHub light, then GitHub dark, for each variable. */
const DEFAULTS: Readonly<Record<string, readonly [string, string]>> = {
  foreground: ['#1f2328', '#e6edf3'],
  background: ['#f6f8fa', '#161b22'],
  'token-constant': ['#0550ae', '#79c0ff'],
  'token-string': ['#0a3069', '#a5d6ff'],
  'token-comment': ['#59636e', '#8b949e'],
  'token-keyword': ['#cf222e', '#ff7b72'],
  'token-parameter': ['#953800', '#ffa657'],
  'token-function': ['#8250df', '#d2a8ff'],
  'token-string-expression': ['#116329', '#7ee787'],
  'token-punctuation': ['#1f2328', '#e6edf3'],
  'token-link': ['#0a3069', '#a5d6ff'],
  // Also the colours of a diff's added, removed and changed lines.
  'token-inserted': ['#1a7f37', '#3fb950'],
  'token-deleted': ['#cf222e', '#f85149'],
  'token-changed': ['#0969da', '#58a6ff'],
}

export const VARIABLE_PREFIX = '--dossier-code-'

/** `light-dark(<light>, <dark>)` for each variable Shiki's theme reads. */
export const variableDefaults: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(DEFAULTS).map(([name, [light, dark]]) => [
      name,
      `light-dark(${light}, ${dark})`,
    ]),
  )

export const theme = createCssVariablesTheme({
  name: THEME_NAME,
  variablePrefix: VARIABLE_PREFIX,
  variableDefaults,
  fontStyle: true,
})

let highlighter: Promise<HighlighterCore> | null = null

export const getHighlighter = (): Promise<HighlighterCore> => {
  highlighter ??= createHighlighterCore({
    themes: [theme],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  return highlighter
}

/** The grammar file and canonical language a name or alias stands for. */
export const grammarOf = (
  language: string,
): { readonly language: string; readonly file: string } | null => {
  const found = GRAMMARS[language.toLowerCase()]
  if (found === undefined) return null
  const name = found.file.slice(
    found.file.lastIndexOf('/') + 1,
    -'.json'.length,
  )
  return { language: name, file: found.file }
}

let grammarBase: string | null = null

/**
 * Where grammar files are fetched from: '/_/base/<version>' on the page's
 * own host. The first caller sets it; the base layer has one version.
 */
export const useGrammarBase = (base: string): void => {
  grammarBase ??= base
}

const files = new Map<string, Promise<LanguageRegistration[] | null>>()
let reportFailure: (url: string) => void = () => {}

/** Where a grammar file that fails to load is reported. */
export const useFailureReport = (report: (url: string) => void): void => {
  reportFailure = report
}

/**
 * A language's grammar file, fetched once: the language and every grammar
 * it embeds, or null when the base layer has none or the file failed.
 */
export const loadGrammarFile = (
  language: string,
): Promise<LanguageRegistration[] | null> => {
  const grammar = grammarOf(language)
  if (grammar === null) return Promise.resolve(null)
  let file = files.get(grammar.file)
  if (file === undefined) {
    const url = `${grammarBase ?? ''}/${grammar.file}`
    file = fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status}`)
        return (await response.json()) as LanguageRegistration[]
      })
      .catch(() => {
        reportFailure(url)
        return null
      })
    files.set(grammar.file, file)
  }
  return file
}

const loaded = new Map<string, Promise<boolean>>()

/**
 * Loads a language and the grammars it embeds into the shared Shiki once;
 * the canonical name, or null when there is no grammar for it.
 */
export const loadLanguage = async (
  language: string,
): Promise<string | null> => {
  const grammar = grammarOf(language)
  if (grammar === null) return null
  let done = loaded.get(grammar.file)
  if (done === undefined) {
    done = (async () => {
      const langs = await loadGrammarFile(language)
      if (langs === null) return false
      await (await getHighlighter()).loadLanguage(...langs)
      return true
    })()
    loaded.set(grammar.file, done)
  }
  return (await done) ? grammar.language : null
}
