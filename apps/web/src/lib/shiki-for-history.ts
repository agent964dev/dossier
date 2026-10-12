// What @pierre/diffs imports as 'shiki' in the history screen's diff: the
// core highlighter with the JavaScript engine, and only the grammars a
// history diff highlights. vite.config.ts points @pierre/diffs here, so none
// of Shiki's other grammars, its themes or its WebAssembly engine is built.
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

export * from 'shiki/core'
export { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

/** Never used: the diff highlights with the JavaScript engine. */
export const createOnigurumaEngine = (): never => {
  throw new Error('The history diff highlights with the JavaScript engine.')
}

/** Never used by the renderers the diff calls. */
export const codeToHtml = (): never => {
  throw new Error('The history diff has no bundled highlighter.')
}

/** The core highlighter, whatever is asked: grammars load as needed. */
export const createHighlighter = (): Promise<HighlighterCore> =>
  createHighlighterCore({
    themes: [],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })

type Loader = () => Promise<{ default: LanguageRegistration[] }>

/** The grammars a history diff loads; anything else shows as plain text. */
export const bundledLanguages: Readonly<Record<string, Loader>> = {
  html: () => import('shiki/dist/langs/html.mjs'),
  css: () => import('shiki/dist/langs/css.mjs'),
  javascript: () => import('shiki/dist/langs/javascript.mjs'),
  jsx: () => import('shiki/dist/langs/jsx.mjs'),
  typescript: () => import('shiki/dist/langs/typescript.mjs'),
  tsx: () => import('shiki/dist/langs/tsx.mjs'),
  json: () => import('shiki/dist/langs/json.mjs'),
  markdown: () => import('shiki/dist/langs/markdown.mjs'),
}
