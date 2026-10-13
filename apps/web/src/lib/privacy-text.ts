// The privacy page's text is plain text; this is how the page lays it out.

export type Block =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'text'; readonly text: string }

/**
 * Plain text read as blocks apart by blank lines: a short line on its own
 * with no closing punctuation is a heading, lines that all start with "- "
 * are a list, anything else is a paragraph that keeps its line breaks.
 * Nothing in the text is read as markup.
 */
export const blocksOf = (text: string): readonly Block[] =>
  text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part): Block => {
      const lines = part.split('\n')
      if (lines.every((line) => line.startsWith('- '))) {
        return { kind: 'list', items: lines.map((line) => line.slice(2)) }
      }
      if (lines.length === 1 && part.length <= 60 && !/[.:;,!?]$/.test(part)) {
        return { kind: 'heading', text: part }
      }
      return { kind: 'text', text: part }
    })
