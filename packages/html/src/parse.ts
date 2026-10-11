// One parse5 pass over a whole document, keeping what the tree alone loses:
// every start and end tag as written, what was open when each end tag
// arrived, and parse5's own error reports. The repair rules and the body's
// content range read these logs.
//
// parse5 is pinned to an exact version: watching the tags as they arrive
// needs its parser's token handlers and open-element stack, which it exports
// but does not promise to keep.

import {
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
  Parser,
  type ParserError,
  type Token,
} from 'parse5'

export type Node = DefaultTreeAdapterTypes.Node
export type ParentNode = DefaultTreeAdapterTypes.ParentNode
export type Element = DefaultTreeAdapterTypes.Element
export type Template = DefaultTreeAdapterTypes.Template
export type TextNode = DefaultTreeAdapterTypes.TextNode
export type Document = DefaultTreeAdapterTypes.Document

export const HTML_NS = 'http://www.w3.org/1999/xhtml'

/** A tag as the source wrote it. */
export interface TagSeen {
  /** Lower-cased, as the tokenizer reads it. */
  readonly name: string
  readonly start: number
  readonly end: number
  readonly line: number
}

export interface StartTagSeen extends TagSeen {
  /** A <form> was open, or the page's form had not ended. */
  readonly inForm: boolean
}

export interface EndTagSeen extends TagSeen {
  /** The innermost open element of the same name when the tag arrived. */
  readonly open: Element | null
  /** A <template> was open, so the tag sat inside template content. */
  readonly inTemplate: boolean
}

export interface Parsed {
  readonly document: Document
  readonly startTags: readonly StartTagSeen[]
  readonly endTags: readonly EndTagSeen[]
  /** Where each doctype was written, kept or not. */
  readonly doctypes: readonly TagSeen[]
  readonly errors: readonly ParserError[]
}

export const isElement = (node: Node): node is Element => 'tagName' in node

export const isTemplate = (node: Node): node is Template =>
  isElement(node) && node.tagName === 'template' && 'content' in node

/** Lower-cased: foreign elements keep their camelCase (foreignObject). */
const nameOf = (node: ParentNode): string | null =>
  'tagName' in node ? node.tagName.toLowerCase() : null

export const parseDocument = (source: string): Parsed => {
  const startTags: StartTagSeen[] = []
  const endTags: EndTagSeen[] = []
  const doctypes: TagSeen[] = []
  const errors: ParserError[] = []
  const seen = new WeakSet<Token.TagToken>()

  const parser = new Parser<DefaultTreeAdapterMap>({
    sourceCodeLocationInfo: true,
    onParseError: (error) => {
      errors.push(error)
    },
  })

  const tagSeen = (token: Token.TagToken): TagSeen | null => {
    const loc = token.location
    if (loc === null) return null
    return {
      name: token.tagName.toLowerCase(),
      start: loc.startOffset,
      end: loc.endOffset,
      line: loc.startLine,
    }
  }

  // The parser hands some tokens back to itself; each is logged once, as the
  // tokenizer first delivered it.
  const onStartTag = parser.onStartTag.bind(parser)
  parser.onStartTag = (token) => {
    if (!seen.has(token)) {
      seen.add(token)
      const tag = tagSeen(token)
      if (tag !== null) {
        const stack = parser.openElements
        let inForm = parser.formElement !== null
        for (let i = stack.stackTop; i >= 0 && !inForm; i--) {
          const item = stack.items[i]
          if (item !== undefined && nameOf(item) === 'form') inForm = true
        }
        startTags.push({ ...tag, inForm })
      }
    }
    onStartTag(token)
  }

  const onEndTag = parser.onEndTag.bind(parser)
  parser.onEndTag = (token) => {
    if (!seen.has(token)) {
      seen.add(token)
      const tag = tagSeen(token)
      if (tag !== null) {
        const stack = parser.openElements
        let open: Element | null = null
        let inTemplate = false
        for (let i = stack.stackTop; i >= 0; i--) {
          const item = stack.items[i]
          if (item === undefined) continue
          const name = nameOf(item)
          if (open === null && name === tag.name) open = item as Element
          if (name === 'template') inTemplate = true
        }
        endTags.push({ ...tag, open, inTemplate })
      }
    }
    onEndTag(token)
  }

  const onDoctype = parser.onDoctype.bind(parser)
  parser.onDoctype = (token) => {
    const loc = token.location
    if (loc !== null) {
      doctypes.push({
        name: '!doctype',
        start: loc.startOffset,
        end: loc.endOffset,
        line: loc.startLine,
      })
    }
    onDoctype(token)
  }

  parser.tokenizer.write(source, true)
  return { document: parser.document, startTags, endTags, doctypes, errors }
}
