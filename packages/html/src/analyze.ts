import {
  type Element,
  type Node,
  type ParentNode,
  HTML_NS,
  isElement,
  isTemplate,
  parseDocument,
} from './parse.ts'
import { type BodyClose, findRepairs } from './repairs.ts'
import { isRelativeUrl, isUnderscoreUrl, srcsetUrls, trimUrl } from './urls.ts'

/** Bumped whenever the analysis changes shape or meaning. */
export const ANALYZER_VERSION: number = 1

/** UTF-16 offsets into the decoded source, as string slicing uses them. */
export interface Range {
  readonly start: number
  readonly end: number
}
export interface Attr {
  readonly name: string
  readonly value: string
}
export type HeadItemKind =
  | 'title'
  | 'meta'
  | 'link'
  | 'script-src'
  | 'script'
  | 'style'
  | 'base'
  | 'other'
export interface HeadItem {
  readonly kind: HeadItemKind
  /**
   * meta: its name, property or http-equiv · link: rel + href · script-src:
   * src · title: 'title' · otherwise null.
   */
  readonly key: string | null
  readonly range: Range
}
export interface UrlRef {
  readonly attr: 'href' | 'src' | 'srcset' | 'poster' | 'action'
  /** As written. */
  readonly value: string
  /** The attribute value. */
  readonly range: Range
  /** No scheme, not protocol-relative, not root-relative, not a fragment. */
  readonly relative: boolean
  /** Its first segment that names a folder or file starts with '_'. */
  readonly underscore: boolean
  readonly inHead: boolean
}
export interface FormSummary {
  readonly line: number
  readonly id: string | null
  /** As written; null when absent. */
  readonly action: string | null
  /** Lower-cased. */
  readonly method: string
  /** data-entries="many". */
  readonly entries: 'one' | 'many'
  /** data-closes as written. */
  readonly closes: string | null
  /** data-closed present. */
  readonly closed: boolean
  readonly range: Range
}
export interface Repair {
  readonly line: number
  readonly message: string
}
export interface HtmlAnalysis {
  /** ANALYZER_VERSION. */
  readonly v: number
  /** A doctype or its own <html> element. */
  readonly complete: boolean
  readonly doctype: Range | null
  readonly html: {
    readonly startTag: Range | null
    readonly attrs: readonly Attr[]
  }
  readonly head: {
    readonly startTag: Range | null
    readonly content: Range | null
    readonly items: readonly HeadItem[]
  }
  readonly body: {
    readonly startTag: Range | null
    readonly attrs: readonly Attr[]
    readonly content: Range
  }
  /** Dropped when composing. */
  readonly charsetMetas: readonly Range[]
  /** The first <slot> in the body, for layouts. */
  readonly slot: Range | null
  readonly title: string | null
  /** Refused at push. */
  readonly base: Range | null
  /** The 1-based line of that <base>, for the push's message. */
  readonly baseLine: number | null
  /** <link rel="alternate"> href, for companions. */
  readonly alternate: string | null
  /** Custom element names used, sorted, once each. */
  readonly tags: readonly string[]
  readonly urls: readonly UrlRef[]
  readonly forms: readonly FormSummary[]
  /** Where parse5 had to repair the structure. */
  readonly repaired: readonly Repair[]
}

const URL_ATTRS = new Set(['href', 'src', 'srcset', 'poster', 'action'])

/** Hyphenated names the HTML standard keeps for SVG and MathML. */
const RESERVED_NAMES = new Set([
  'annotation-xml',
  'color-profile',
  'font-face',
  'font-face-src',
  'font-face-uri',
  'font-face-format',
  'font-face-name',
  'missing-glyph',
])
const CUSTOM_NAME =
  /^[a-z][-.0-9_a-z\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C-\u200D\u203F\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]*$/u

/** A valid custom element name: lower case, a hyphen, not reserved. */
export const isCustomElementName = (name: string): boolean =>
  name.includes('-') && CUSTOM_NAME.test(name) && !RESERVED_NAMES.has(name)

const at = (start: number, end: number): Range => ({ start, end })

/**
 * A node's whole markup. An element the end of the page cut off ends with
 * the source: parse5 leaves a script, style, title or textarea that never
 * closes ending where it started.
 */
const outerRange = (node: Node, length: number): Range | null => {
  const loc = node.sourceCodeLocation
  if (!loc) return null
  const opened =
    'startTag' in loc && loc.startTag ? loc.startTag.endOffset : loc.startOffset
  return at(loc.startOffset, loc.endOffset < opened ? length : loc.endOffset)
}

const attrOf = (element: Element, name: string): string | null => {
  for (const attr of element.attrs) {
    if (attr.name === name && !attr.prefix) return attr.value
  }
  return null
}

const attrsOf = (element: Element | null): readonly Attr[] =>
  element === null
    ? []
    : element.attrs.map((attr) => ({
        name: attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name,
        value: attr.value,
      }))

const childElement = (
  parent: ParentNode | null,
  name: string,
): Element | null => {
  if (parent === null) return null
  for (const node of parent.childNodes) {
    if (isElement(node) && node.tagName === name) return node
  }
  return null
}

const isSpace = (char: string | undefined): boolean =>
  char === ' ' ||
  char === '\t' ||
  char === '\n' ||
  char === '\r' ||
  char === '\f'

/** The value inside an attribute written `name="value"`, without quotes. */
const valueRange = (source: string, attr: Range): Range => {
  const text = source.slice(attr.start, attr.end)
  const equals = text.indexOf('=', 1)
  if (equals < 0) return at(attr.end, attr.end)
  let from = equals + 1
  while (from < text.length && isSpace(text[from])) from++
  const quote = text[from]
  if (quote === '"' || quote === "'") {
    const closed = text.length > from + 1 && text.endsWith(quote)
    return at(
      attr.start + from + 1,
      attr.start + (closed ? text.length - 1 : text.length),
    )
  }
  return at(attr.start + from, attr.end)
}

const textOf = (element: Element): string => {
  let text = ''
  for (const node of element.childNodes) {
    if ('value' in node && node.nodeName === '#text') text += node.value
  }
  return text
}

const relTokens = (element: Element): readonly string[] =>
  (attrOf(element, 'rel') ?? '')
    .toLowerCase()
    .split(/[\t\n\f\r ]+/)
    .filter((token) => token !== '')

const headItem = (element: Element, length: number): HeadItem | null => {
  const range = outerRange(element, length)
  if (range === null) return null
  switch (element.namespaceURI === HTML_NS ? element.tagName : '') {
    case 'title':
      return { kind: 'title', key: 'title', range }
    case 'meta': {
      const key =
        attrOf(element, 'name') ??
        attrOf(element, 'property') ??
        attrOf(element, 'http-equiv')
      return { kind: 'meta', key: key?.trim().toLowerCase() ?? null, range }
    }
    case 'link': {
      const href = trimUrl(attrOf(element, 'href') ?? '')
      return {
        kind: 'link',
        key: `${relTokens(element).join(' ')} ${href}`,
        range,
      }
    }
    case 'script': {
      const src = attrOf(element, 'src')
      return src === null
        ? { kind: 'script', key: null, range }
        : { kind: 'script-src', key: trimUrl(src), range }
    }
    case 'style':
      return { kind: 'style', key: null, range }
    case 'base':
      return { kind: 'base', key: null, range }
    default:
      return { kind: 'other', key: null, range }
  }
}

const isCharsetMeta = (element: Element): boolean =>
  attrOf(element, 'charset') !== null ||
  attrOf(element, 'http-equiv')?.trim().toLowerCase() === 'content-type'

interface Place {
  readonly inHead: boolean
  readonly inBody: boolean
  readonly inTemplate: boolean
}

/**
 * Reads a page once. A leading byte order mark is read as the whitespace it
 * stands for, so a page that starts with one is still a complete document.
 */
export const analyze = (source: string): HtmlAnalysis => {
  const bom = source.startsWith('\uFEFF')
  const parsed = parseDocument(bom ? ` ${source.slice(1)}` : source)
  const { document } = parsed

  let doctype: Range | null = null
  for (const node of document.childNodes) {
    if (node.nodeName === '#documentType')
      doctype = outerRange(node, source.length)
  }
  const html = childElement(document, 'html')
  const head = childElement(html, 'head')
  const body = childElement(html, 'body')
  const htmlLoc = html?.sourceCodeLocation ?? null
  const headLoc = head?.sourceCodeLocation ?? null
  const bodyLoc = body?.sourceCodeLocation ?? null

  const charsetMetas: Range[] = []
  const tags = new Set<string>()
  const urls: UrlRef[] = []
  const forms: FormSummary[] = []
  let slot: Range | null = null
  let title: string | null = null
  let base: Range | null = null
  let baseLine: number | null = null
  let alternate: string | null = null

  const addUrls = (element: Element, place: Place): void => {
    const attrLocs = element.sourceCodeLocation?.attrs
    if (!attrLocs) return
    for (const attr of element.attrs) {
      if (!URL_ATTRS.has(attr.name)) continue
      if (attr.prefix && attr.prefix !== 'xlink') continue
      const written =
        attrLocs[
          (attr.prefix
            ? `${attr.prefix}:${attr.name}`
            : attr.name
          ).toLowerCase()
        ]
      if (!written) continue
      const value = valueRange(
        source,
        at(written.startOffset, written.endOffset),
      )
      const raw = source.slice(value.start, value.end)
      const name = attr.name as UrlRef['attr']
      if (name === 'srcset') {
        for (const candidate of srcsetUrls(raw)) {
          const url = raw.slice(candidate.start, candidate.end)
          urls.push({
            attr: name,
            value: url,
            range: at(
              value.start + candidate.start,
              value.start + candidate.end,
            ),
            relative: isRelativeUrl(url),
            underscore: isUnderscoreUrl(url),
            inHead: place.inHead,
          })
        }
      } else {
        urls.push({
          attr: name,
          value: raw,
          range: value,
          relative: isRelativeUrl(attr.value),
          underscore: isUnderscoreUrl(attr.value),
          inHead: place.inHead,
        })
      }
    }
  }

  const addForm = (element: Element): void => {
    const loc = element.sourceCodeLocation
    if (!loc) return
    const method = attrOf(element, 'method')?.trim().toLowerCase() ?? ''
    forms.push({
      line: loc.startLine,
      id: attrOf(element, 'id'),
      action: attrOf(element, 'action'),
      method: method === '' ? 'get' : method,
      entries:
        attrOf(element, 'data-entries')?.trim().toLowerCase() === 'many'
          ? 'many'
          : 'one',
      closes: attrOf(element, 'data-closes'),
      closed: attrOf(element, 'data-closed') !== null,
      range:
        outerRange(element, source.length) ??
        at(loc.startOffset, loc.endOffset),
    })
  }

  const visit = (nodes: readonly Node[], place: Place): void => {
    for (const node of nodes) {
      if (!isElement(node)) continue
      const name = node.tagName
      const isHtml = node.namespaceURI === HTML_NS
      if (isHtml && isCustomElementName(name)) tags.add(name)
      addUrls(node, place)
      if (isHtml) {
        if (name === 'form') addForm(node)
        else if (name === 'meta' && isCharsetMeta(node)) {
          const range = outerRange(node, source.length)
          if (range !== null) charsetMetas.push(range)
        } else if (name === 'base' && base === null) {
          base = outerRange(node, source.length)
          baseLine = node.sourceCodeLocation?.startLine ?? null
        } else if (
          name === 'slot' &&
          slot === null &&
          place.inBody &&
          !place.inTemplate
        ) {
          slot = outerRange(node, source.length)
        } else if (name === 'title' && title === null && !place.inTemplate) {
          title = textOf(node).trim()
        } else if (
          name === 'link' &&
          alternate === null &&
          place.inHead &&
          !place.inTemplate &&
          relTokens(node).includes('alternate')
        ) {
          alternate = attrOf(node, 'href')
        }
      }
      const inner: Place = {
        inHead: place.inHead || node === head,
        inBody: place.inBody || node === body,
        inTemplate: place.inTemplate || isTemplate(node),
      }
      visit(isTemplate(node) ? node.content.childNodes : node.childNodes, inner)
    }
  }
  visit(document.childNodes, {
    inHead: false,
    inBody: false,
    inTemplate: false,
  })

  const items: HeadItem[] = []
  for (const node of head?.childNodes ?? []) {
    if (!isElement(node)) continue
    const item = headItem(node, source.length)
    if (item !== null) items.push(item)
  }

  // The </head> that ends the head, written even when <head> was not.
  const headClose =
    headLoc?.endTag ??
    parsed.endTags.find((tag) => tag.name === 'head' && tag.open === head) ??
    null
  const headCloseEnd =
    headClose === null
      ? null
      : 'endOffset' in headClose
        ? headClose.endOffset
        : headClose.end

  // The body's content, as an exact slice of the source that a layout's slot
  // or a complete document can take in.
  //
  // Start: after a written <body> start tag. Without one (a page that is only
  // a body, or a head and body content) the content starts after the last
  // head material written before the first body node: the doctype, the
  // <html> and <head> start tags, the </head> end tag, and every element or
  // comment the head holds. With none of these it is the whole source (after
  // a leading byte order mark).
  //
  // End: where the written </body> starts, or else the first </html> (or
  // </body>, for an implied body) outside template content after the start,
  // or else the end of the source. Content the parser moved into the body
  // from after that end tag (text or elements written after </body>) extends
  // the end to the last of it, so composing loses nothing the browser shows;
  // the move is also reported as a repair.
  let start = bom ? 1 : 0
  if (bodyLoc?.startTag) {
    start = bodyLoc.startTag.endOffset
  } else {
    let firstBody = Infinity
    for (const node of body?.childNodes ?? []) {
      const loc = node.sourceCodeLocation
      if (loc) firstBody = Math.min(firstBody, loc.startOffset)
    }
    const ends: (number | null | undefined)[] = [
      doctype?.end,
      htmlLoc?.startTag?.endOffset,
      headLoc?.startTag?.endOffset,
      headCloseEnd,
    ]
    for (const node of head?.childNodes ?? []) {
      if (node.nodeName !== '#text') {
        ends.push(outerRange(node, source.length)?.end)
      }
    }
    for (const end of ends) {
      if (typeof end === 'number' && end <= firstBody) {
        start = Math.max(start, end)
      }
    }
  }

  let bodyClose: BodyClose | null = null
  if (bodyLoc?.endTag) {
    bodyClose = { start: bodyLoc.endTag.startOffset, name: 'body' }
  } else {
    const close = parsed.endTags.find(
      (tag) =>
        (tag.name === 'body' || tag.name === 'html') &&
        !tag.inTemplate &&
        tag.start >= start,
    )
    if (close !== undefined)
      bodyClose = { start: close.start, name: close.name }
  }
  let end = bodyClose?.start ?? source.length
  if (bodyClose !== null) {
    for (const node of body?.childNodes ?? []) {
      const loc = node.sourceCodeLocation
      if (!loc || loc.startOffset < bodyClose.start) continue
      if (!isElement(node) && !('value' in node && node.value.trim() !== '')) {
        continue
      }
      end = Math.max(end, loc.endOffset)
    }
  }
  end = Math.max(start, end)

  return {
    v: ANALYZER_VERSION,
    complete: doctype !== null || Boolean(htmlLoc?.startTag),
    doctype,
    html: {
      startTag: htmlLoc?.startTag
        ? at(htmlLoc.startTag.startOffset, htmlLoc.startTag.endOffset)
        : null,
      attrs: attrsOf(html),
    },
    head: {
      startTag: headLoc?.startTag
        ? at(headLoc.startTag.startOffset, headLoc.startTag.endOffset)
        : null,
      content: headLoc?.startTag
        ? at(
            headLoc.startTag.endOffset,
            headLoc.endTag ? headLoc.endTag.startOffset : headLoc.endOffset,
          )
        : null,
      items,
    },
    body: {
      startTag: bodyLoc?.startTag
        ? at(bodyLoc.startTag.startOffset, bodyLoc.startTag.endOffset)
        : null,
      attrs: attrsOf(body),
      content: at(start, end),
    },
    charsetMetas,
    slot,
    title,
    base,
    baseLine,
    alternate,
    tags: [...tags].sort(),
    urls,
    forms,
    repaired: findRepairs(parsed, source, body, bodyClose),
  }
}
