// Where the parser had to repair a page's structure, in plain words.
//
// parse5 reports few of the tree-building errors the HTML standard names
// (a stray </div> in the body, an unclosed <div>, content moved out of a
// table all pass silently), so most repairs are found by comparing the tags
// the source wrote with the tree parse5 built:
//
// - a start tag that made no element: ignored, or its attributes merged into
//   the page's <html> or <body>;
// - an end tag that closed no element written in the source, except one that
//   closes an element the parser implied (</body> after an implied <body>,
//   </tbody> after rows written straight into a <table>);
// - an element whose end tag is required but missing, so the parser closed
//   it early or at the end of the page; elements whose end tag HTML lets you
//   leave out (<p>, <li>, <td>, <option>, …), void elements and
//   self-closed SVG or MathML elements are not repairs;
// - a node the parser moved: out of a table (it then sits before a sibling
//   written after it), or after </body> into the body;
// - from parse5's own reports, those that change what the page holds: a
//   comment or CDATA section that hides markup, a tag cut off by the end of
//   the page, a duplicate attribute dropped, `<div/>` left open, a misplaced
//   doctype, a head element after </head> moved into the head.
//
// Syntax slips that change nothing are not repairs: a missing doctype, a
// missing semicolon after a character reference, a stray solidus in a tag,
// an end tag with attributes, a malformed comment ending, and the like.

import type { ParserError } from 'parse5'
import type { Repair } from './analyze.ts'
import {
  type Element,
  type Node,
  type Parsed,
  HTML_NS,
  isElement,
  isTemplate,
} from './parse.ts'

const VOID = new Set([
  'area',
  'base',
  'basefont',
  'bgsound',
  'br',
  'col',
  'embed',
  'frame',
  'hr',
  'image',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** Elements whose end tag HTML lets an author leave out. */
const OPTIONAL_END = new Set([
  'html',
  'head',
  'body',
  'li',
  'dt',
  'dd',
  'p',
  'rb',
  'rt',
  'rtc',
  'rp',
  'optgroup',
  'option',
  'colgroup',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
])

/** Elements that read everything up to their own end tag as text. */
const TEXT_ONLY = new Set([
  'script',
  'style',
  'title',
  'textarea',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
])

const ROOT_TAGS = new Set(['html', 'head', 'body'])

const nodeStart = (node: Node): number | null =>
  node.sourceCodeLocation?.startOffset ?? null

const isBlankText = (node: Node): boolean =>
  node.nodeName === '#text' && 'value' in node && node.value.trim() === ''

/** Nodes whose place in the tree says something: elements and real text. */
const placed = (node: Node): boolean =>
  (isElement(node) || (node.nodeName === '#text' && !isBlankText(node))) &&
  nodeStart(node) !== null

const describe = (node: Node, line: number): string =>
  isElement(node)
    ? `the <${node.tagName}> on line ${line}`
    : `text on line ${line}`

const tagNameAt = (source: string, offset: number): string | null => {
  const match = /^<\/?([^\s/>]+)/.exec(source.slice(offset, offset + 200))
  return match?.[1]?.toLowerCase() ?? null
}

const fromParserError = (error: ParserError, source: string): string | null => {
  switch (error.code) {
    case 'eof-in-tag':
      return 'the page ends inside a tag, so that tag was dropped'
    case 'eof-in-comment':
      return 'a comment is never closed, so everything after it was hidden'
    case 'eof-in-cdata':
      return 'a CDATA section is never closed, so everything after it was hidden'
    case 'eof-in-doctype':
      return 'the page ends inside its doctype'
    case 'cdata-in-html-content':
      return 'a <![CDATA[ section outside SVG or MathML was read as a comment'
    case 'incorrectly-opened-comment':
      return 'markup starting with <! was read as a comment'
    case 'unexpected-question-mark-instead-of-tag-name':
      return 'markup starting with <? was read as a comment'
    case 'duplicate-attribute':
      return 'an attribute written twice on one tag kept only its first value'
    case 'misplaced-doctype':
      return 'a doctype after the start of the page was ignored'
    case 'non-void-html-element-start-tag-with-trailing-solidus': {
      const name = tagNameAt(source, error.startOffset) ?? 'element'
      return `<${name}/> does not close itself in HTML, so the <${name}> stays open until an end tag closes it`
    }
    case 'abandoned-head-element-child': {
      const name = tagNameAt(source, error.startOffset) ?? 'element'
      return `a <${name}> after </head> was moved into the head`
    }
    default:
      return null
  }
}

const ignoredStartTag = (name: string, inForm: boolean): string => {
  switch (name) {
    case 'html':
      return 'an <html> start tag after the page had begun was ignored, and its attributes were added to the page'
    case 'body':
      return 'a <body> start tag after the body had begun was ignored, and its attributes were added to the body'
    case 'head':
      return 'a <head> start tag after the head had ended was ignored'
    case 'form':
      if (inForm) return 'a <form> inside another form was ignored'
      return 'a <form> start tag was ignored because it cannot appear there'
    default:
      return `a <${name}> start tag was ignored because it cannot appear there`
  }
}

export interface BodyClose {
  /** Where the written </body> or </html> that ends the body starts. */
  readonly start: number
  readonly name: string
}

export const findRepairs = (
  parsed: Parsed,
  source: string,
  body: Element | null,
  bodyClose: BodyClose | null,
): readonly Repair[] => {
  const found: { line: number; offset: number; message: string }[] = []
  const add = (line: number, offset: number, message: string): void => {
    found.push({ line, offset, message })
  }

  // Every start and end tag the tree holds, by where it was written.
  const starts = new Set<number>()
  const ends = new Set<number>()
  const unclosed: Element[] = []
  const moved: { node: Node; before: Node }[] = []

  const visitChildren = (kids: readonly Node[]): void => {
    // A child written after a later sibling was moved before it.
    let earliest: Node | null = null
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i]
      if (kid === undefined || !placed(kid)) continue
      if (
        earliest !== null &&
        (nodeStart(kid) ?? 0) > (nodeStart(earliest) ?? 0)
      ) {
        moved.push({ node: kid, before: earliest })
      } else {
        earliest = kid
      }
    }
    for (const kid of kids) {
      if (isElement(kid)) visitElement(kid)
    }
  }

  const visitElement = (element: Element): void => {
    const loc = element.sourceCodeLocation
    if (loc?.startTag) {
      starts.add(loc.startTag.startOffset)
      const name = element.tagName.toLowerCase()
      const selfClosed = source
        .slice(loc.startTag.startOffset, loc.startTag.endOffset)
        .endsWith('/>')
      if (
        !loc.endTag &&
        !VOID.has(name) &&
        !OPTIONAL_END.has(name) &&
        !selfClosed
      ) {
        unclosed.push(element)
      }
    }
    if (loc?.endTag) ends.add(loc.endTag.startOffset)
    visitChildren(
      isTemplate(element) ? element.content.childNodes : element.childNodes,
    )
  }

  visitChildren(parsed.document.childNodes)

  const kept = new Set<number>()
  for (const node of parsed.document.childNodes) {
    const at = nodeStart(node)
    if (node.nodeName === '#documentType' && at !== null) kept.add(at)
  }
  for (const doctype of parsed.doctypes) {
    if (!kept.has(doctype.start)) {
      add(
        doctype.line,
        doctype.start,
        'a doctype after the start of the page was ignored',
      )
    }
  }

  for (const tag of parsed.startTags) {
    if (!starts.has(tag.start)) {
      add(tag.line, tag.start, ignoredStartTag(tag.name, tag.inForm))
    }
  }

  for (const tag of parsed.endTags) {
    if (ends.has(tag.start)) continue
    const open = tag.open
    // Closing an element the parser implied, such as the page's body.
    if (open !== null && !open.sourceCodeLocation) continue
    if (open !== null && ROOT_TAGS.has(tag.name)) continue
    if (tag.name === 'br') {
      add(tag.line, tag.start, 'an end tag </br> was read as a line break <br>')
    } else if (open === null && tag.name === 'p') {
      add(
        tag.line,
        tag.start,
        'an end tag </p> with no open <p> became an empty paragraph',
      )
    } else if (open === null) {
      add(
        tag.line,
        tag.start,
        `an end tag </${tag.name}> with no open <${tag.name}> was ignored`,
      )
    } else {
      add(
        tag.line,
        tag.start,
        `an end tag </${tag.name}> could not close its <${tag.name}> there and was ignored`,
      )
    }
  }

  for (const element of unclosed) {
    const loc = element.sourceCodeLocation
    if (!loc) continue
    const name = element.tagName
    const what = `the <${name}> on line ${loc.startLine}`
    if (TEXT_ONLY.has(name) && element.namespaceURI === HTML_NS) {
      // Its text runs to its own end tag, so without one it runs to the end.
      add(
        loc.startLine,
        loc.startOffset,
        `${what} is never closed, so the rest of the page became part of it`,
      )
    } else if (loc.endOffset >= source.length) {
      add(loc.startLine, loc.startOffset, `${what} is never closed`)
    } else {
      add(
        loc.startLine,
        loc.startOffset,
        `${what} has no end tag where it should, so it was closed early`,
      )
    }
  }

  for (const { node, before } of moved) {
    const loc = node.sourceCodeLocation
    if (!loc) continue
    const what = describe(node, loc.startLine)
    add(
      loc.startLine,
      loc.startOffset,
      isElement(before) && before.tagName === 'table'
        ? `${what} sat inside a table where it is not allowed, and was moved before the table`
        : `${what} was moved before content written ahead of it`,
    )
  }

  if (body !== null && bodyClose !== null) {
    for (const kid of body.childNodes) {
      const loc = kid.sourceCodeLocation
      if (!placed(kid) || !loc || loc.startOffset < bodyClose.start) continue
      add(
        loc.startLine,
        loc.startOffset,
        `${describe(kid, loc.startLine)} after </${bodyClose.name}> was moved into the body`,
      )
    }
  }

  for (const error of parsed.errors) {
    const message = fromParserError(error, source)
    if (message !== null) add(error.startLine, error.startOffset, message)
  }

  const once = new Set<string>()
  return found
    .sort((a, b) => a.line - b.line || a.offset - b.offset)
    .filter((repair) => {
      const key = `${repair.line} ${repair.message}`
      if (once.has(key)) return false
      once.add(key)
      return true
    })
    .map(({ line, message }) => ({ line, message }))
}
