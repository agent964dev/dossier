import {
  type Element,
  type Node,
  type Parsed,
  type ParentNode,
  HTML_NS,
  isElement,
  isTemplate,
  parseDocument,
} from './parse.ts'
import { formFields } from './fields.ts'
import type { FieldRule } from './forms.ts'
import { isCustomElementName } from './kit.ts'
import { codeLanguageOf, type LibraryName } from './libraries.ts'
import { type BodyClose, findRepairs } from './repairs.ts'
import {
  cssRefs,
  decodeCharacterReferences,
  type FoundRef,
  type Mapped,
  moduleImports,
  unmapped,
  writtenRange,
} from './inline-refs.ts'
import { isRelativeUrl, isUnderscoreUrl, srcsetUrls } from './urls.ts'

/** Bumped whenever the analysis changes shape or meaning. */
export const ANALYZER_VERSION: number = 10

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
   * meta: 'name:<v>', 'property:<v>' or 'http-equiv:<v>', lower-cased ·
   * title: 'title' · otherwise null.
   */
  readonly key: string | null
  /** link: its rel tokens, lower-cased and space-separated. */
  readonly rel: string | null
  /** A link's href or a script's src, as written. */
  readonly url: string | null
  readonly range: Range
}
/**
 * What a URL in an attribute is for.
 *
 * - render: the browser loads it to show the page: every `src`, `srcset` and
 *   `poster` (an iframe's `src` too), a `<link>` whose rel holds the token
 *   stylesheet, icon, preload or modulepreload, and an SVG `<image>` or
 *   `<use>` href. Only those exact rel tokens count: `apple-touch-icon` is
 *   fetched only when someone saves the page to a home screen, so it is
 *   other. A fragment-only `<use href="#x">` is render but never relative,
 *   so it names no file.
 * - navigate: an `<a>` (HTML or SVG) or `<area>` href, followed on a click.
 * - form: a `<form>` action, followed when the form is sent.
 * - other: every other URL attribute, such as an alternate or canonical
 *   link's href.
 */
export type UrlUse = 'render' | 'navigate' | 'form' | 'other'

export interface UrlRef {
  readonly attr: 'href' | 'src' | 'srcset' | 'poster' | 'action'
  readonly use: UrlUse
  /** As written, for rewriting the source at `range`. */
  readonly value: string
  /** With character references decoded, for rewriting. */
  readonly decoded: string
  /**
   * The URLs the browser requests for it: [decoded], or for a srcset whose
   * written candidates do not match its decoded ones (a separator written as
   * a character reference), every decoded candidate on its first ref.
   */
  readonly requests: readonly string[]
  /** The attribute value. */
  readonly range: Range
  /** No scheme, not protocol-relative, not root-relative, not a fragment. */
  readonly relative: boolean
  /** Its first segment that names a folder or file starts with '_'. */
  readonly underscore: boolean
  readonly inHead: boolean
}

/**
 * A URL the page's own markup loads without an attribute naming it:
 * `url()` in a `<style>` element or a `style` attribute (css-url), the
 * string or `url()` of an `@import` there (css-import), and the module a
 * static import or re-export of an inline module script names
 * (module-import).
 */
export interface InlineRef {
  readonly kind: 'css-url' | 'css-import' | 'module-import'
  /**
   * As the browser requests it: character references decoded (in a style
   * attribute, or a style inside SVG), then CSS or JavaScript escapes.
   */
  readonly url: string
  /** The URL as written, inside any quotes. */
  readonly range: Range
  /**
   * As for an attribute's URL; an import's bare specifier (`a.js`, `lib`)
   * is not, as the browser resolves it only through an import map.
   */
  readonly relative: boolean
  readonly underscore: boolean
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
  /**
   * The legend of the form's first <fieldset>, else its aria-label, with
   * whitespace collapsed; null when it has neither.
   */
  readonly title: string | null
  /** One rule per field name, in the order the names first appear. */
  readonly fields: readonly FieldRule[]
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
  /**
   * The whole first <slot> element in the body without a name attribute,
   * outside any <template>: where a layout takes in the page below it.
   */
  readonly slot: Range | null
  readonly title: string | null
  /** Refused at push. */
  readonly base: Range | null
  /** The 1-based line of that <base>, for the push's message. */
  readonly baseLine: number | null
  /**
   * The href of the first <link rel="alternate"> in the head that names a
   * companion: a relative href, no hreflang and no media, and a type that is
   * absent, text/markdown, text/plain or application/json. Feeds and
   * translations are not companions.
   */
  readonly alternate: string | null
  /** Custom element names used, sorted, once each. */
  readonly tags: readonly string[]
  /**
   * The base layer's libraries whose markup the page holds outside any
   * <template>, sorted, once each.
   */
  readonly libraries: readonly LibraryName[]
  /** The languages of `pre > code.language-<lang>`, lower-cased, sorted, once each. */
  readonly codeLanguages: readonly string[]
  readonly urls: readonly UrlRef[]
  /** In source order. */
  readonly inlineRefs: readonly InlineRef[]
  readonly forms: readonly FormSummary[]
  /** Where parse5 had to repair the structure. */
  readonly repaired: readonly Repair[]
  /** What keeps this source's markup inside the slot it is placed in. */
  readonly seal: Seal
}

/**
 * A fragment composed into a layout's slot parses inside the layout's open
 * elements, so markup its own parse ignored or left open would act on the
 * layout. These edits make it act as it does on its own.
 */
export interface Seal {
  /**
   * Each end tag in the body content whose own parse closed nothing of the
   * source's, as what it made there: '' (ignored), '<p></p>' or '<br>'.
   */
  readonly edits: readonly {
    readonly start: number
    readonly end: number
    readonly text: string
  }[]
  /** End tags for head elements the source left open, inserted at `at`. */
  readonly head: readonly { readonly at: number; readonly text: string }[]
  /** What closes the comment and elements the body content left open. */
  readonly body: string
}

const URL_ATTRS = new Set(['href', 'src', 'srcset', 'poster', 'action'])

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

const SVG_NS = 'http://www.w3.org/2000/svg'

const RENDER_RELS: ReadonlySet<string> = new Set([
  'stylesheet',
  'icon',
  'preload',
  'modulepreload',
])

const useOf = (element: Element, attr: UrlRef['attr']): UrlUse => {
  if (attr === 'src' || attr === 'srcset' || attr === 'poster') return 'render'
  const { namespaceURI, tagName } = element
  if (attr === 'action') {
    return namespaceURI === HTML_NS && tagName === 'form' ? 'form' : 'other'
  }
  if (namespaceURI === HTML_NS) {
    if (tagName === 'a' || tagName === 'area') return 'navigate'
    if (tagName === 'link') {
      return relTokens(element).some((rel) => RENDER_RELS.has(rel))
        ? 'render'
        : 'other'
    }
  } else if (namespaceURI === SVG_NS) {
    if (tagName === 'a') return 'navigate'
    if (tagName === 'image' || tagName === 'use') return 'render'
  }
  return 'other'
}

/** An inline module script: no src, and a type of module. */
const isInlineModule = (element: Element): boolean =>
  element.namespaceURI === HTML_NS &&
  element.tagName === 'script' &&
  attrOf(element, 'src') === null &&
  attrOf(element, 'type')?.trim().toLowerCase() === 'module'

/**
 * Bare specifiers resolve only through an import map; everything else reads
 * as an attribute's URL does.
 */
const isRelativeImport = (url: string): boolean =>
  url.startsWith('./') || url.startsWith('../')

/** A meta's key: which of name, property or http-equiv it sets, and to what. */
const metaKey = (element: Element): string | null => {
  for (const name of ['name', 'property', 'http-equiv']) {
    const value = attrOf(element, name)
    if (value !== null) return `${name}:${value.trim().toLowerCase()}`
  }
  return null
}

const headItem = (element: Element, length: number): HeadItem | null => {
  const range = outerRange(element, length)
  if (range === null) return null
  const item = (
    kind: HeadItemKind,
    key: string | null = null,
    rel: string | null = null,
    url: string | null = null,
  ): HeadItem => ({ kind, key, rel, url, range })
  switch (element.namespaceURI === HTML_NS ? element.tagName : '') {
    case 'title':
      return item('title', 'title')
    case 'meta':
      return item('meta', metaKey(element))
    case 'link':
      return item(
        'link',
        null,
        relTokens(element).join(' '),
        attrOf(element, 'href'),
      )
    case 'script': {
      const src = attrOf(element, 'src')
      return src === null ? item('script') : item('script-src', null, null, src)
    }
    case 'style':
      return item('style')
    case 'base':
      return item('base')
    default:
      return item('other')
  }
}

const COMPANION_TYPES: ReadonlySet<string> = new Set([
  'text/markdown',
  'text/plain',
  'application/json',
])

/** A <link rel="alternate"> that names a companion beside the page. */
const namesCompanion = (element: Element): boolean => {
  const href = attrOf(element, 'href')
  if (href === null || href.trim() === '' || !isRelativeUrl(href)) return false
  if (attrOf(element, 'hreflang') !== null) return false
  if (attrOf(element, 'media') !== null) return false
  const type = attrOf(element, 'type')
  if (type === null) return true
  const essence = (type.split(';')[0] ?? '').trim().toLowerCase()
  return COMPANION_TYPES.has(essence)
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

  const fieldsByForm = formFields(document)
  const charsetMetas: Range[] = []
  const tags = new Set<string>()
  const libraries = new Set<LibraryName>()
  const codeLanguages = new Set<string>()
  const urls: UrlRef[] = []
  const inlineRefs: InlineRef[] = []
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
      const use = useOf(element, name)
      if (name === 'srcset') {
        // Candidates of the written value, for their ranges, paired with the
        // candidates of the decoded value, for what is requested.
        const candidates = srcsetUrls(raw)
        const decoded = srcsetUrls(attr.value).map((c) =>
          attr.value.slice(c.start, c.end),
        )
        if (decoded.length !== candidates.length) {
          // A separator written as a character reference: the written
          // candidates are not the browser's. One ref covers the whole value,
          // so a rewrite works on the decoded candidates.
          if (decoded.length > 0) {
            urls.push({
              attr: name,
              use,
              value: raw,
              decoded: attr.value,
              requests: decoded,
              range: value,
              relative: decoded.some((url) => isRelativeUrl(url)),
              underscore: decoded.every((url) => isUnderscoreUrl(url)),
              inHead: place.inHead,
            })
          }
          continue
        }
        candidates.forEach((candidate, index) => {
          const url = raw.slice(candidate.start, candidate.end)
          const plain = decoded[index] ?? url
          urls.push({
            attr: name,
            use,
            value: url,
            decoded: plain,
            requests: [plain],
            range: at(
              value.start + candidate.start,
              value.start + candidate.end,
            ),
            relative: isRelativeUrl(plain),
            underscore: isUnderscoreUrl(plain),
            inHead: place.inHead,
          })
        })
      } else {
        urls.push({
          attr: name,
          use,
          value: raw,
          decoded: attr.value,
          requests: [attr.value],
          range: value,
          relative: isRelativeUrl(attr.value),
          underscore: isUnderscoreUrl(attr.value),
          inHead: place.inHead,
        })
      }
    }
  }

  const pushInlineRefs = (mapped: Mapped, found: readonly FoundRef[]): void => {
    for (const ref of found) {
      const relative =
        ref.kind === 'module-import'
          ? isRelativeImport(ref.url)
          : isRelativeUrl(ref.url)
      inlineRefs.push({
        kind: ref.kind,
        url: ref.url,
        range: writtenRange(mapped, ref.start, ref.end),
        relative,
        underscore: relative && isUnderscoreUrl(ref.url),
      })
    }
  }

  /**
   * A style attribute's CSS, a style element's, and an inline module
   * script's imports. A style attribute, and text inside SVG, have their
   * character references decoded first, as the parser does; a style or
   * script element's text in HTML is read as written.
   */
  const addInlineRefs = (element: Element): void => {
    const loc = element.sourceCodeLocation
    const style = loc?.attrs?.['style']
    if (style && attrOf(element, 'style') !== null) {
      const value = valueRange(source, at(style.startOffset, style.endOffset))
      const mapped = decodeCharacterReferences(
        source.slice(value.start, value.end),
        value.start,
        true,
      )
      pushInlineRefs(mapped, cssRefs(mapped.text))
    }
    const { namespaceURI, tagName } = element
    const isModule = isInlineModule(element)
    const isStyle =
      tagName === 'style' &&
      (namespaceURI === HTML_NS || namespaceURI === SVG_NS)
    if (!isModule && !isStyle) return
    for (const child of element.childNodes) {
      const written = child.sourceCodeLocation
      if (child.nodeName !== '#text' || !written) continue
      const text = source.slice(written.startOffset, written.endOffset)
      const mapped =
        namespaceURI === HTML_NS
          ? unmapped(text, written.startOffset)
          : decodeCharacterReferences(text, written.startOffset, false)
      pushInlineRefs(
        mapped,
        isModule ? moduleImports(mapped.text) : cssRefs(mapped.text),
      )
    }
  }

  const addForm = (element: Element): void => {
    const loc = element.sourceCodeLocation
    if (!loc) return
    const method = attrOf(element, 'method')?.trim().toLowerCase() ?? ''
    const own = fieldsByForm.get(element)
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
      title: own?.title ?? null,
      fields: own?.fields ?? [],
      range:
        outerRange(element, source.length) ??
        at(loc.startOffset, loc.endOffset),
    })
  }

  /** The markup LIBRARY_SELECTORS names, as a browser would match it. */
  const addLibraries = (element: Element): void => {
    const className = attrOf(element, 'class')
    if (className === null) return
    const classes = className.split(/[\t\n\f\r ]+/)
    const inHtml = element.namespaceURI === HTML_NS
    if (inHtml && element.tagName === 'pre' && classes.includes('mermaid')) {
      libraries.add('mermaid')
    }
    const parent = element.parentNode
    if (
      inHtml &&
      element.tagName === 'code' &&
      className.includes('language-') &&
      parent !== null &&
      isElement(parent) &&
      parent.namespaceURI === HTML_NS &&
      parent.tagName === 'pre'
    ) {
      libraries.add('shiki')
      const language = codeLanguageOf(className)
      if (language !== null) codeLanguages.add(language)
    }
    if (
      classes.includes('math') &&
      (classes.includes('inline') || classes.includes('display'))
    ) {
      libraries.add('katex')
    }
  }

  const visit = (nodes: readonly Node[], place: Place): void => {
    for (const node of nodes) {
      if (!isElement(node)) continue
      const name = node.tagName
      const isHtml = node.namespaceURI === HTML_NS
      if (isHtml && isCustomElementName(name)) tags.add(name)
      if (!place.inTemplate) addLibraries(node)
      addUrls(node, place)
      addInlineRefs(node)
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
          !place.inTemplate &&
          attrOf(node, 'name') === null
        ) {
          slot = outerRange(node, source.length)
        } else if (name === 'title' && title === null && !place.inTemplate) {
          title = textOf(node).trim()
        } else if (
          name === 'link' &&
          alternate === null &&
          place.inHead &&
          !place.inTemplate &&
          relTokens(node).includes('alternate') &&
          namesCompanion(node)
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

  // A head whose </head> was never written ends after its last element:
  // parse5 ends such a head where the token that closed it began, which can
  // be inside that element.
  let headContentEnd = headLoc?.startTag?.endOffset ?? 0
  if (headLoc?.endTag) {
    headContentEnd = headLoc.endTag.startOffset
  } else {
    for (const node of head?.childNodes ?? []) {
      if (node.nodeName === '#text') continue
      const end = outerRange(node, source.length)?.end
      if (end !== undefined) headContentEnd = Math.max(headContentEnd, end)
    }
  }

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

  const seal = sealOf(parsed, source, { html, head, body }, at(start, end))

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
        ? at(headLoc.startTag.endOffset, headContentEnd)
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
    libraries: [...libraries].sort(),
    codeLanguages: [...codeLanguages].sort(),
    urls,
    inlineRefs,
    forms,
    repaired: findRepairs(parsed, source, body, bodyClose),
    seal,
  }
}

/** Raw text a source ends inside of: a comment that never closed. */
const openComment = (node: ParentNode, source: string): Node | null => {
  let found: Node | null = null
  const walk = (parent: ParentNode): void => {
    for (const child of parent.childNodes) {
      if (child.nodeName === '#comment') {
        const loc = child.sourceCodeLocation
        if (
          loc &&
          loc.endOffset >= source.length &&
          !/--!?>$/.test(source.slice(loc.startOffset, loc.endOffset))
        ) {
          found = child
        }
      }
      if (isElement(child)) {
        walk(isTemplate(child) ? child.content : child)
      }
    }
  }
  walk(node)
  return found
}

const closersOf = (elements: readonly Element[]): string =>
  [...elements]
    .reverse()
    .map((element) => `</${element.tagName}>`)
    .join('')

const sealOf = (
  parsed: Parsed,
  source: string,
  own: {
    readonly html: Element | null
    readonly head: Element | null
    readonly body: Element | null
  },
  content: Range,
): Seal => {
  const document = new Set<Element | null>([own.html, own.head, own.body])
  const edits: { start: number; end: number; text: string }[] = []
  for (const tag of parsed.endTags) {
    if (tag.inTemplate || tag.start < content.start || tag.end > content.end) {
      continue
    }
    if (tag.open !== null && !document.has(tag.open)) continue
    const text = tag.name === 'p' ? '<p></p>' : tag.name === 'br' ? '<br>' : ''
    edits.push({ start: tag.start, end: tag.end, text })
  }

  const open = parsed.openAtEnd.filter((element) => !document.has(element))
  const inHead = own.head !== null && parsed.openAtEnd.includes(own.head)
  const head: { at: number; text: string }[] = []
  let body = ''
  if (inHead) {
    // Each open head element closes at the end of the head item holding it.
    const first = open[0]
    const range = first === undefined ? null : outerRange(first, source.length)
    if (range !== null) head.push({ at: range.end, text: closersOf(open) })
  } else {
    const comment = own.body === null ? null : openComment(own.body, source)
    body = (comment === null ? '' : '-->') + closersOf(open)
  }
  return { edits, head, body }
}
