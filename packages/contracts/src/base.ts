// The base layer's libraries and components, as its build lists them in
// libraries.json. Plain TypeScript, so the page client and the Worker can both
// read it without Effect.

/** The base layer's own components; a folder's component of the same tag wins. */
export type BaseComponentTag =
  | 'dossier-diff'
  | 'dossier-copy'
  | 'dossier-comments'

/** A library's two builds: the one pages import, and one with no imports. */
export interface BaseBuilds {
  /** Imported by pages: `lib/mermaid.js`. */
  readonly live: string
  /** One file with no import statement, for a page exported as one file. */
  readonly export: string
}

/** One Shiki grammar file: the language and every grammar it embeds. */
export interface BaseGrammar {
  /** `lib/shiki-grammars/html.json`. */
  readonly file: string
  /** The languages the file holds besides its own, such as css, javascript. */
  readonly embedded: readonly string[]
}

/** libraries.json; every path is relative to `/_/base/<version>/`. */
export interface BaseLibraries {
  readonly libraries: {
    readonly mermaid: BaseBuilds
    readonly shiki: BaseBuilds & {
      /** By language name and by each alias: `js` and `javascript` alike. */
      readonly grammars: Readonly<Record<string, BaseGrammar>>
    }
    readonly katex: BaseBuilds & {
      /** `lib/katex/katex.css`, whose fonts sit beside it. */
      readonly css: string
      /** The stylesheet with its fonts as data: URLs. */
      readonly exportCss: string
    }
  }
  readonly components: Readonly<
    Record<BaseComponentTag, BaseBuilds & { readonly doc: string }>
  >
}
