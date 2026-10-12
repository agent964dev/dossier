// The text search reads from a page or a companion, as stored beside its
// blob. Arabic marks are removed here, because SQLite's tokenizer keeps them
// as part of a word; Latin accents stay, and the tokenizer folds them.
import { parse } from 'parse5'

import { HTML_NS, isElement, type Element, type Node } from './parse.ts'

/** Bump when what searchText keeps changes; stored texts are by version. */
export const SEARCH_TEXT_VERSION = 1

/** The most of a body that is kept, in bytes of UTF-8. */
export const SEARCH_TEXT_MAX_BYTES = 262_144

export interface SearchText {
  /** The page's title as shown; null when it has none. */
  readonly title: string | null
  /** The title as searched. */
  readonly titleSearch: string | null
  /** The text as searched. */
  readonly body: string
}

/** Arabic harakat and Quranic marks, and the tatweel. */
// oxlint-disable-next-line no-misleading-character-class
const ARABIC_MARKS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g
/** Alef with hamza above or below, with madda, and alef wasla. */
const ALEF_FORMS = /[\u0623\u0625\u0622\u0671]/g

/**
 * The two private-use characters search marks matches with in a snippet;
 * text never holds them, so a page cannot mark its own words.
 */
const SNIPPET_MARKS = /[\uE000\uE001]/g

/**
 * Control characters other than white space: a NUL would end the query
 * where SQLite reads it, and none of them is ever a word.
 */
// oxlint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000E-\u001F\u007F]/g

/**
 * Text as both the index and every query see it: NFC, without Arabic marks
 * and tatweel, every alef form as a bare alef, and each run of white space
 * one space.
 */
export const normalizeSearchText = (text: string): string =>
  text
    .normalize('NFC')
    .replace(ARABIC_MARKS, '')
    .replace(ALEF_FORMS, '\u0627')
    .replace(SNIPPET_MARKS, '')
    .replace(CONTROLS, '')
    .replace(/\s+/g, ' ')

/**
 * A folder's or file's name as search compares names, which SQLite cannot
 * fold itself: normalized, then without any accent or mark, in lower case.
 * A query is folded the same way.
 */
export const searchNameOf = (name: string): string =>
  normalizeSearchText(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .toLowerCase()

/** At most SEARCH_TEXT_MAX_BYTES of UTF-8, never cutting a character. */
const capped = (text: string): string => {
  if (text.length * 3 <= SEARCH_TEXT_MAX_BYTES) return text
  let bytes = 0
  let at = 0
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
    if (bytes + size > SEARCH_TEXT_MAX_BYTES) break
    bytes += size
    at += char.length
  }
  return text.slice(0, at)
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Whose content a reader never sees as text. */
const SKIPPED: ReadonlySet<string> = new Set([
  'script',
  'style',
  'template',
  'noscript',
])

/**
 * Elements that flow inside a line of text: no space is put around them,
 * so `<b>bud</b>get` stays one word.
 */
const INLINE: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'label',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
])

const attrOf = (element: Element, name: string): string | null =>
  element.attrs.find((a) => a.name === name)?.value ?? null

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Every text node below an element, as written. */
const plainText = (element: Element): string => {
  let text = ''
  const walk = (node: Node): void => {
    if (node.nodeName === '#text' && 'value' in node) text += node.value
    else if (isElement(node)) for (const child of node.childNodes) walk(child)
  }
  walk(element)
  return text
}

/** The first HTML <title> outside a template, as shown. */
const titleOf = (root: Node): string | null => {
  let found: string | null = null
  const walk = (node: Node): void => {
    if (found !== null || !isElement(node)) {
      if (found === null && 'childNodes' in node) {
        for (const child of node.childNodes) walk(child)
      }
      return
    }
    if (node.tagName === 'template') return
    if (node.tagName === 'svg' || node.namespaceURI !== HTML_NS) return
    if (node.tagName === 'title') {
      found = collapse(plainText(node))
      return
    }
    for (const child of node.childNodes) walk(child)
  }
  walk(root)
  return found === '' ? null : found
}

/**
 * The text a reader of the body sees: its text without scripts, styles and
 * templates, the alt text of images, and the titles and descriptions of
 * drawings.
 */
const bodyTextOf = (body: Element): string => {
  const parts: string[] = []
  const walk = (node: Node): void => {
    if (node.nodeName === '#text' && 'value' in node) {
      parts.push(node.value)
      return
    }
    if (!isElement(node)) return
    if (node.namespaceURI === HTML_NS && SKIPPED.has(node.tagName)) return
    const inline = node.namespaceURI === HTML_NS && INLINE.has(node.tagName)
    if (!inline) parts.push(' ')
    if (node.namespaceURI === HTML_NS && node.tagName === 'img') {
      const alt = attrOf(node, 'alt')
      if (alt !== null && alt.trim() !== '') parts.push(' ', alt, ' ')
    }
    if (node.namespaceURI === SVG_NS && node.tagName === 'style') return
    for (const child of node.childNodes) walk(child)
    if (!inline) parts.push(' ')
  }
  walk(body)
  return parts.join('')
}

const bodyOf = (root: Node): Element | null => {
  if (!('childNodes' in root)) return null
  for (const child of root.childNodes) {
    if (!isElement(child)) continue
    if (child.tagName === 'body') return child
    const inner = bodyOf(child)
    if (inner !== null) return inner
  }
  return null
}

/**
 * What search keeps of a file: an HTML page's title and the text of its
 * body, or the whole of a text file (Markdown, plain text, JSON) with no
 * title. The body is normalized and at most SEARCH_TEXT_MAX_BYTES.
 */
export const searchText = (
  source: string,
  kind: 'html' | 'text',
): SearchText => {
  if (kind === 'text') {
    return {
      title: null,
      titleSearch: null,
      body: capped(normalizeSearchText(source).trim()),
    }
  }
  const document = parse(source)
  const title = titleOf(document)
  const body = bodyOf(document)
  return {
    title,
    titleSearch: title === null ? null : normalizeSearchText(title),
    body:
      body === null ? '' : capped(normalizeSearchText(bodyTextOf(body)).trim()),
  }
}
