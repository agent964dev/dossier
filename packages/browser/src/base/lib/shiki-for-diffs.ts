// What @pierre/diffs imports as 'shiki', pointed at the base layer's one
// shared Shiki: its highlighter is the shared core, and its languages are the
// base layer's grammar files. The build resolves 'shiki' to this module for
// @pierre/diffs only, so none of Shiki's bundled grammars or themes is built.
import type { HighlighterCore, LanguageRegistration } from 'shiki/core'

import { getHighlighter, grammarOf, loadGrammarFile } from './highlighter.ts'

export * from 'shiki/core'
export { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

/** Never used: the diff renders with the JavaScript regex engine. */
export const createOnigurumaEngine = (): never => {
  throw new Error('The base layer highlights with the JavaScript engine.')
}

/** Never used by the renderers the diff component calls. */
export const codeToHtml = (): never => {
  throw new Error('The base layer has no bundled highlighter.')
}

/** The shared core, whatever the caller asks for; themes load later. */
export const createHighlighter = (): Promise<HighlighterCore> =>
  getHighlighter()

type Loader = () => Promise<{ default: LanguageRegistration[] }>

const known = (name: string | symbol): name is string =>
  typeof name === 'string' && grammarOf(name) !== null

/** Every language and alias the base layer has a grammar file for. */
export const bundledLanguages: Readonly<Record<string, Loader>> = new Proxy(
  {},
  {
    get: (_, name) => {
      if (!known(name)) return undefined
      return () =>
        loadGrammarFile(name).then((langs) => {
          if (langs === null) throw new Error(`No grammar for ${name}`)
          return { default: langs }
        })
    },
    has: (_, name) => known(name),
    getOwnPropertyDescriptor: (_, name) =>
      known(name)
        ? { configurable: true, enumerable: true, writable: false }
        : undefined,
  },
)
