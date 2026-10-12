// Planning a page exported as one file. Pure: the composed page, what each
// of its references became, and the import map's files arrive as plain
// data, and the plan is a list of pieces, text or a file's bytes as a data:
// URL, with its size counted before anything is read. Only stylesheets and
// modules are held as text; every other file's bytes are streamed into the
// file where the plan names them.
//
// Opened from disk, a page has no base a module's relative import could
// resolve against, so every module is named by a bare name and one import
// map maps each name to its module's data: URL.
import type { HtmlAnalysis, Range } from './analyze.ts'
import { analyzeJs, type JsImport } from './js.ts'
import { HTML_NS, isElement, isTemplate, parseDocument } from './parse.ts'
import type { Element, Node } from './parse.ts'
import { srcsetUrls } from './urls.ts'

/** The most an exported file may hold: 50 MiB. */
export const EXPORT_LIMIT_BYTES = 52_428_800

/** What a URL in the composed page is for, as an export treats it. */
export type ExportRefKind =
  | 'stylesheet'
  | 'image'
  | 'media'
  | 'font'
  | 'module'
  | 'script'
  | 'component'
  | 'page-link'
  | 'frame'
  | 'copy'
  | 'diff'
  /** A link loading something ahead, which an export leaves out. */
  | 'preload'

/** Where a reference is written, which decides how its value is escaped. */
export type ExportContext =
  /** An attribute's value. */
  | 'attribute'
  /** CSS inside a style attribute. */
  | 'style-attribute'
  /** CSS inside a <style> element. */
  | 'style'
  /** JavaScript inside an inline module script. */
  | 'script'
  /** Nowhere in the page: a component of the kit map. */
  | 'kit'

export interface ExportRef {
  /** As the browser requests it: character references and escapes decoded. */
  readonly url: string
  /**
   * The URL as written; an empty range where a missing attribute goes (a
   * `<dossier-copy>` without `src`). Null for a component of the kit map.
   */
  readonly range: Range | null
  readonly kind: ExportRefKind
  /** The element it is on, lower-cased: 'img', 'link', 'style', 'script'. */
  readonly element: string
  readonly in: ExportContext
  /** A stylesheet or preload link's whole element, which the export replaces. */
  readonly outer?: Range
  /** A stylesheet link's media attribute, kept on the <style> it becomes. */
  readonly media?: string | null
  /** The attribute an empty range adds. */
  readonly attr?: string
  /** An attribute value written inside quotes. */
  readonly quoted?: boolean
  /**
   * A srcset whose separators are written as character references, as one
   * reference over its whole value: each candidate's URL and where it is in
   * `url`, the decoded value.
   */
  readonly candidates?: readonly {
    readonly url: string
    readonly start: number
    readonly end: number
  }[]
}

/** A file whose bytes are streamed into the export as a data: URL. */
export interface ExportAsset {
  readonly sha256: string
  readonly size: number
  /** Its media type. */
  readonly type: string
  /** Video, audio or an image: may become a link when the file is too large. */
  readonly media: boolean
  /** Its canonical link. */
  readonly link: string
  /** A name the data: URL carries as a parameter, such as 'v1/plan.md'. */
  readonly name?: string
}

/** A stylesheet's text with what each of its URLs became. */
export interface ExportSheet {
  readonly text: string
  readonly refs: readonly {
    readonly range: Range
    readonly kind: 'import' | 'url'
    readonly target: ExportTarget
  }[]
}

/** What a reference becomes in the exported file. */
export type ExportTarget =
  /**
   * A file's bytes as a data: URL; its canonical link once media are
   * linked. A fragment the URL named (`#tick`, `#t=10,20`) follows it.
   */
  | {
      readonly kind: 'asset'
      readonly asset: ExportAsset
      readonly fragment?: string
    }
  /** A URL written in its place: a canonical link. */
  | { readonly kind: 'link'; readonly href: string }
  /**
   * A stylesheet: a stylesheet link becomes a <style> holding it, an
   * `@import` a data: URL of it.
   */
  | { readonly kind: 'sheet'; readonly sheet: ExportSheet }
  /** Text as a data: URL, such as an agent version. */
  | {
      readonly kind: 'text'
      readonly text: string
      readonly type: string
      readonly name?: string
    }
  /** A module by its name in the import map. */
  | { readonly kind: 'module'; readonly name: string }
  /** A classic script's source as a data: URL. */
  | { readonly kind: 'script'; readonly source: string }
  /** The element goes. */
  | { readonly kind: 'drop' }
  /**
   * A srcset written whole (its separators as character references): what
   * each of its candidates becomes, in order; null keeps one as written.
   */
  | {
      readonly kind: 'candidates'
      readonly targets: readonly (ExportTarget | null)[]
    }

export interface ExportInput {
  /** The composed page. */
  readonly html: string
  /** exportRefs of it. */
  readonly refs: readonly ExportRef[]
  /** What each reference becomes; a reference without one stays as written. */
  readonly targets: ReadonlyMap<ExportRef, ExportTarget>
  /** The import map: each bare name and its module, or a file read by name. */
  readonly imports: ReadonlyMap<
    string,
    { readonly text: string; readonly type: string }
  >
  /** Where the export's own head tags go: the live page's injected tags. */
  readonly injected: Range
  /** PageBootstrap as JSON, with export: true and the export kit map. */
  readonly bootstrap: string
  /** ExportData as JSON, given the canonical links kept instead of inlined. */
  readonly data: (linked: readonly string[]) => string
  /** client.js. */
  readonly client: string
  readonly header: {
    readonly link: string
    readonly by: string
    readonly at: string
  }
  /** EXPORT_LIMIT_BYTES unless a test says otherwise. */
  readonly limit?: number
}

export type ExportPiece =
  | { readonly kind: 'text'; readonly text: string }
  /** `data:<type>;base64,` and the file's bytes as base64, streamed. */
  | {
      readonly kind: 'data-url'
      readonly type: string
      readonly sha256: string
      readonly size: number
    }

export interface ExportPlan {
  readonly pieces: readonly ExportPiece[]
  /** The file's size in bytes. */
  readonly bytes: number
  /** Canonical links kept instead of inlined, largest file first. */
  readonly linked: readonly string[]
}

// References -------------------------------------------------------------

/** The live page's bootstrap and client tags, which the export replaces. */
export interface InjectedTags {
  readonly range: Range
  /** The bootstrap's JSON as written. */
  readonly bootstrap: string
}

const BOOTSTRAP_OPEN = '<script type="application/json" id="dossier-bootstrap">'

/**
 * Where the composed page holds the tags composing put in: the bootstrap
 * block, the client script and the modulepreload links written right after
 * them, first in the head. Null for a page that holds none.
 */
export const injectedTags = (
  html: string,
  analysis: HtmlAnalysis,
): InjectedTags | null => {
  const items = analysis.head.items
  const at = items.findIndex(
    (item) =>
      item.kind === 'script' &&
      html.startsWith(BOOTSTRAP_OPEN, item.range.start),
  )
  const first = items[at]
  const client = items[at + 1]
  if (first === undefined || client?.kind !== 'script-src') return null
  if (client.range.start !== first.range.end) return null
  let end = client.range.end
  for (const item of items.slice(at + 2)) {
    if (
      item.kind !== 'link' ||
      item.rel !== 'modulepreload' ||
      item.range.start !== end
    ) {
      break
    }
    end = item.range.end
  }
  const json = html.slice(
    first.range.start + BOOTSTRAP_OPEN.length,
    first.range.end - '</script>'.length,
  )
  return { range: { start: first.range.start, end }, bootstrap: json }
}

const attrOf = (element: Element, name: string): string | null => {
  for (const attr of element.attrs) {
    if (attr.name === name && !attr.prefix) return attr.value
  }
  return null
}

const relsOf = (element: Element): readonly string[] =>
  (attrOf(element, 'rel') ?? '')
    .toLowerCase()
    .split(/[\t\n\f\r ]+/)
    .filter((token) => token !== '')

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
  if (equals < 0) return { start: attr.end, end: attr.end }
  let from = equals + 1
  while (from < text.length && isSpace(text[from])) from++
  const quote = text[from]
  if (quote === '"' || quote === "'") {
    const closed = text.length > from + 1 && text.endsWith(quote)
    return {
      start: attr.start + from + 1,
      end: attr.start + (closed ? text.length - 1 : text.length),
    }
  }
  return { start: attr.start + from, end: attr.end }
}

const JS_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'text/ecmascript',
  'module',
])

const scriptType = (element: Element): string =>
  (attrOf(element, 'type') ?? '').trim().toLowerCase()

const MEDIA_ELEMENTS = new Set(['video', 'audio'])

interface Seen {
  readonly element: Element
  readonly tag: Range
}

/**
 * What the export does with each URL attribute of an element; null to
 * leave it as written.
 */
const kindOf = (
  element: Element,
  attr: string,
  parent: Element | null,
): ExportRefKind | null => {
  const name = element.tagName
  if (element.namespaceURI !== HTML_NS) {
    if (attr !== 'href') return null
    if (name === 'a') return 'page-link'
    if (name === 'image' || name === 'use' || name === 'feImage') {
      return 'image'
    }
    return null
  }
  switch (name) {
    case 'a':
    case 'area':
      return attr === 'href' ? 'page-link' : null
    case 'link': {
      if (attr !== 'href') return null
      const rels = relsOf(element)
      if (rels.includes('stylesheet')) return 'stylesheet'
      if (rels.includes('icon')) return 'image'
      if (rels.includes('modulepreload')) return 'module'
      if (
        rels.includes('preload') ||
        rels.includes('prefetch') ||
        rels.includes('prerender')
      ) {
        return 'preload'
      }
      return 'page-link'
    }
    case 'img':
      return attr === 'src' || attr === 'srcset' ? 'image' : null
    case 'input':
      return attr === 'src' ? 'image' : null
    case 'source':
      if (attr === 'srcset') return 'image'
      if (attr !== 'src') return null
      return parent !== null && MEDIA_ELEMENTS.has(parent.tagName)
        ? 'media'
        : 'image'
    case 'video':
      return attr === 'poster' ? 'image' : attr === 'src' ? 'media' : null
    case 'audio':
    case 'track':
      return attr === 'src' ? 'media' : null
    case 'iframe':
    case 'frame':
    case 'embed':
      return attr === 'src' ? 'frame' : null
    case 'script': {
      if (attr !== 'src') return null
      const type = scriptType(element)
      if (type === 'module') return 'module'
      return JS_TYPES.has(type) ? 'script' : null
    }
    case 'dossier-copy':
      return attr === 'src' ? 'copy' : null
    default:
      return null
  }
}

const DIFF_ATTRS = ['src', 'before', 'after'] as const

/**
 * Every URL in the composed page an export inlines, links or leaves out, in
 * source order: from attributes (with srcset candidates one by one), CSS in
 * style attributes and <style> elements, the imports of inline module
 * scripts (static, and dynamic ones naming a string literal),
 * `<dossier-copy>` (its `src`, or the page itself) and `<dossier-diff>`'s
 * `src`, `before` and `after`, then the components of the kit map in the
 * bootstrap. Nothing inside the live page's own injected tags counts.
 */
export const exportRefs = (
  html: string,
  analysis: HtmlAnalysis,
): readonly ExportRef[] => {
  const injected = injectedTags(html, analysis)
  const outside = (at: number) =>
    injected === null || at < injected.range.start || at >= injected.range.end
  const { document } = parseDocument(html)
  const seen: Seen[] = []
  const parents = new Map<Element, Element | null>()
  const styles: Range[] = []
  const refs: ExportRef[] = []

  const visit = (nodes: readonly Node[], parent: Element | null): void => {
    for (const node of nodes) {
      if (!isElement(node)) continue
      parents.set(node, parent)
      const loc = node.sourceCodeLocation
      const tag = loc?.startTag
      if (tag && outside(tag.startOffset)) {
        seen.push({
          element: node,
          tag: { start: tag.startOffset, end: tag.endOffset },
        })
        visitOwn(node, loc)
      }
      visit(isTemplate(node) ? node.content.childNodes : node.childNodes, node)
    }
  }

  const visitOwn = (
    element: Element,
    loc: NonNullable<Element['sourceCodeLocation']>,
  ): void => {
    const name = element.tagName
    const isHtml = element.namespaceURI === HTML_NS
    if (isHtml && name === 'style') {
      for (const child of element.childNodes) {
        const at = child.sourceCodeLocation
        if (child.nodeName === '#text' && at) {
          styles.push({ start: at.startOffset, end: at.endOffset })
        }
      }
    }
    if (isHtml && name === 'script' && scriptType(element) === 'module') {
      if (attrOf(element, 'src') === null) {
        for (const child of element.childNodes) {
          const at = child.sourceCodeLocation
          if (child.nodeName !== '#text' || !at) continue
          const text = html.slice(at.startOffset, at.endOffset)
          for (const found of analyzeJs(text).imports) {
            refs.push({
              url: found.specifier,
              range: {
                start: at.startOffset + found.range.start,
                end: at.startOffset + found.range.end,
              },
              kind: 'module',
              element: 'script',
              in: 'script',
            })
          }
        }
      }
    }
    if (isHtml && name === 'dossier-copy' && attrOf(element, 'src') === null) {
      const at = (loc.startTag?.startOffset ?? 0) + '<dossier-copy'.length
      refs.push({
        url: '',
        range: { start: at, end: at },
        kind: 'copy',
        element: name,
        in: 'attribute',
        attr: 'src',
      })
    }
    if (isHtml && name === 'dossier-diff') {
      for (const attr of DIFF_ATTRS) {
        const value = attrOf(element, attr)
        const written = loc.attrs?.[attr]
        if (value === null || value.trim() === '' || !written) continue
        const range = valueRange(html, {
          start: written.startOffset,
          end: written.endOffset,
        })
        const quote = html[range.start - 1]
        refs.push({
          url: value.trim(),
          range,
          kind: 'diff',
          element: name,
          in: 'attribute',
          quoted: quote === '"' || quote === "'",
        })
      }
    }
  }
  visit(document.childNodes, null)

  // The element whose start tag holds a position.
  const starts = seen.map((s) => s.tag.start)
  const elementAt = (at: number): Seen | null => {
    let low = 0
    let high = starts.length - 1
    let found = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (starts[mid]! <= at) {
        found = mid
        low = mid + 1
      } else high = mid - 1
    }
    const hit = seen[found]
    return hit !== undefined && at < hit.tag.end ? hit : null
  }

  for (const url of analysis.urls) {
    if (!outside(url.range.start)) continue
    // A srcset whose separators are written as character references is one
    // reference over the whole value, with its candidates.
    const whole = url.requests.length !== 1
    const owner = elementAt(url.range.start)
    if (owner === null) continue
    const { element } = owner
    if (element.tagName === 'dossier-diff') continue
    const kind = kindOf(element, url.attr, parents.get(element) ?? null)
    if (kind === null) continue
    const outer =
      kind === 'stylesheet' || kind === 'preload'
        ? element.sourceCodeLocation
        : undefined
    // Whether the attribute holding it is written inside quotes.
    const written = Object.values(element.sourceCodeLocation?.attrs ?? {}).find(
      (attr) =>
        attr.startOffset <= url.range.start && url.range.end <= attr.endOffset,
    )
    const value =
      written === undefined
        ? null
        : valueRange(html, {
            start: written.startOffset,
            end: written.endOffset,
          })
    const quote = value === null ? undefined : html[value.start - 1]
    refs.push({
      url: whole ? url.decoded : url.decoded.trim(),
      ...(whole
        ? {
            candidates: srcsetUrls(url.decoded).map((c) => ({
              url: url.decoded.slice(c.start, c.end),
              start: c.start,
              end: c.end,
            })),
          }
        : {}),
      range: url.range,
      kind,
      element: element.tagName,
      in: 'attribute',
      quoted: quote === '"' || quote === "'",
      ...(outer
        ? { outer: { start: outer.startOffset, end: outer.endOffset } }
        : {}),
      ...(kind === 'stylesheet' ? { media: attrOf(element, 'media') } : {}),
    })
  }

  for (const ref of analysis.inlineRefs) {
    if (ref.kind === 'module-import' || !outside(ref.range.start)) continue
    const inStyle = styles.some(
      (s) => ref.range.start >= s.start && ref.range.end <= s.end,
    )
    refs.push({
      url: ref.url,
      range: ref.range,
      kind: ref.kind === 'css-import' ? 'stylesheet' : 'image',
      element: inStyle
        ? 'style'
        : (elementAt(ref.range.start)?.element.tagName ?? ''),
      in: inStyle ? 'style' : 'style-attribute',
    })
  }

  if (injected !== null) {
    let kit: Record<string, unknown> = {}
    try {
      const bootstrap = JSON.parse(injected.bootstrap) as { kit?: unknown }
      if (typeof bootstrap.kit === 'object' && bootstrap.kit !== null) {
        kit = bootstrap.kit as Record<string, unknown>
      }
    } catch {
      kit = {}
    }
    for (const [tag, value] of Object.entries(kit)) {
      if (typeof value !== 'string') continue
      refs.push({
        url: value,
        range: null,
        kind: 'component',
        element: tag,
        in: 'kit',
      })
    }
  }

  return refs.sort(
    (a, b) =>
      (a.range?.start ?? Infinity) - (b.range?.start ?? Infinity) ||
      (a.range?.end ?? Infinity) - (b.range?.end ?? Infinity),
  )
}

// Escaping ---------------------------------------------------------------

/** JavaScript string text for a string written between `quote`s. */
const jsText = (value: string, quote: string): string =>
  value.replace(/[\\\n\r\u2028\u2029'"`$<]/g, (char) => {
    if (char === '<') return '\\u003c'
    if (char === '$') return quote === '`' ? '\\$' : '$'
    if ((char === '"' || char === "'" || char === '`') && char !== quote) {
      return char
    }
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })

/**
 * Specifiers of a module rewritten: each import `rename` gives a name for
 * is written as that name inside its own quotes; the rest of the source is
 * kept byte for byte.
 */
export const rewriteImports = (
  source: string,
  imports: readonly JsImport[],
  rename: (specifier: string) => string | null,
): string => {
  const sorted = [...imports].sort((a, b) => a.range.start - b.range.start)
  let out = ''
  let pos = 0
  for (const item of sorted) {
    if (item.range.start < pos) continue
    const name = rename(item.specifier)
    if (name === null) continue
    const quote = source[item.range.start - 1] ?? "'"
    out += source.slice(pos, item.range.start) + jsText(name, quote)
    pos = item.range.end
  }
  return out + source.slice(pos)
}

/**
 * A URL as CSS text that reads the same inside a quoted string or a bare
 * url(): every quote, bracket, backslash, white space and `<` escaped.
 */
const cssText = (value: string): string =>
  value.replace(
    /[\\"'()\s<]/g,
    (char) => `\\${char.charCodeAt(0).toString(16)} `,
  )

/** Text for an attribute value inside quotes. */
const attributeText = (value: string): string =>
  value.replace(/[&"'<>`]/g, (char) =>
    char === '&' ? '&amp;' : `&#${char.charCodeAt(0)};`,
  )

/** Text inside a data: URL that is not base64: anything else escaped. */
const urlText = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*!~]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )

/** A safe media type for a data: URL; anything odd is plain bytes. */
const mediaType = (type: string, name?: string): string => {
  const essence = (type.split(';')[0] ?? '').trim().toLowerCase()
  const plain = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(essence)
    ? essence
    : 'application/octet-stream'
  return name === undefined ? plain : `${plain};name=${urlText(name)}`
}

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Bytes as base64. */
export const base64Of = (bytes: Uint8Array): string => {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out +=
      BASE64[(n >> 18) & 63]! +
      BASE64[(n >> 12) & 63]! +
      BASE64[(n >> 6) & 63]! +
      BASE64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += `${BASE64[(n >> 18) & 63]!}${BASE64[(n >> 12) & 63]!}==`
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += `${BASE64[(n >> 18) & 63]!}${BASE64[(n >> 12) & 63]!}${BASE64[(n >> 6) & 63]!}=`
  }
  return out
}

const encoder = new TextEncoder()

const utf8Length = (text: string): number => encoder.encode(text).length

/** The length of a data: URL of `size` bytes in base64. */
const dataUrlLength = (type: string, size: number): number =>
  `data:${type};base64,`.length + 4 * Math.ceil(size / 3)

// Planning ---------------------------------------------------------------

/** Pieces being written, with adjacent text joined. */
class Out {
  readonly pieces: ExportPiece[] = []
  #parts: string[] = []
  text(text: string): void {
    if (text !== '') this.#parts.push(text)
  }
  data(asset: ExportAsset): void {
    this.#flush()
    this.pieces.push({
      kind: 'data-url',
      type: mediaType(asset.type, asset.name),
      sha256: asset.sha256,
      size: asset.size,
    })
  }
  done(): readonly ExportPiece[] {
    this.#flush()
    return this.pieces
  }
  #flush(): void {
    if (this.#parts.length === 0) return
    this.pieces.push({ kind: 'text', text: this.#parts.join('') })
    this.#parts = []
  }
}

/** How a piece of text is written where it goes. */
type Escape = (text: string) => string

const ESCAPES: Readonly<Record<ExportContext, Escape>> = {
  attribute: attributeText,
  'style-attribute': (text) => attributeText(cssText(text)),
  style: cssText,
  script: (text) => text,
  kit: (text) => text,
}

const commentText = (text: string): string =>
  text.replaceAll('--', '- -').replaceAll('>', '&gt;')

const scriptJson = (json: string): string => json.replaceAll('<', '\\u003c')

/** A classic script's text inside <script>…</script>. */
const inlineScript = (source: string): string =>
  source.replace(/<(\/script|!--)/gi, '<\\$1')

interface Render {
  readonly out: Out
  readonly linked: ReadonlySet<string>
  /** Text targets as data: URLs, built once. */
  readonly cache: Map<unknown, string>
}

const textDataUrl = (r: Render, target: object, text: string, type: string) => {
  let url = r.cache.get(target)
  if (url === undefined) {
    url = `data:${type};base64,${base64Of(encoder.encode(text))}`
    r.cache.set(target, url)
  }
  return url
}

/** Writes a URL target where an escape says, as a data: URL or a link. */
const writeUrl = (r: Render, target: ExportTarget, escape: Escape): void => {
  switch (target.kind) {
    case 'asset':
      // Base64 and the media type need no escaping anywhere.
      if (target.asset.media && r.linked.has(target.asset.sha256)) {
        r.out.text(escape(target.asset.link))
      } else r.out.data(target.asset)
      r.out.text(escape(target.fragment ?? ''))
      return
    case 'link':
      r.out.text(escape(target.href))
      return
    case 'text':
      r.out.text(
        escape(
          textDataUrl(
            r,
            target,
            target.text,
            mediaType(target.type, target.name),
          ),
        ),
      )
      return
    case 'script':
      r.out.text(
        escape(textDataUrl(r, target, target.source, 'text/javascript')),
      )
      return
    case 'module':
      // A module script or preload loads a stub importing the module by its
      // name, so the import map's one copy is the module that runs.
      r.out.text(
        escape(
          textDataUrl(
            r,
            target,
            `import ${JSON.stringify(target.name)}`,
            'text/javascript',
          ),
        ),
      )
      return
    case 'sheet':
      // An @import of it: the sheet's own text, its files inside it, each
      // level escaped for the data: URL it sits in and for every one around.
      r.out.text(escape('data:text/css,'))
      writeSheet(r, target.sheet, (text) => escape(urlText(text)))
      return
    case 'drop':
    case 'candidates':
      return
  }
}

/** A stylesheet's text, each of its URLs replaced; `outer` escapes the text. */
const writeSheet = (r: Render, sheet: ExportSheet, outer: Escape): void => {
  const refs = [...sheet.refs].sort((a, b) => a.range.start - b.range.start)
  let pos = 0
  for (const ref of refs) {
    if (ref.range.start < pos) continue
    r.out.text(outer(sheet.text.slice(pos, ref.range.start)))
    writeUrl(r, ref.target, (text) => outer(cssText(text)))
    pos = ref.range.end
  }
  r.out.text(outer(sheet.text.slice(pos)))
}

/** A stylesheet inside a <style> element: no `</style` can end it early. */
const styleText: Escape = (text) => text.replace(/<\/style/gi, '<\\/style')

const render = (
  input: ExportInput,
  linked: ReadonlySet<string>,
  cache: Map<unknown, string>,
): readonly ExportPiece[] => {
  const r: Render = { out: new Out(), linked, cache }
  const { html, injected } = input
  const order = [...linked]
  const links: string[] = []
  const assets = new Map<string, ExportAsset>()
  collectAssets(input, assets)
  for (const sha of order) {
    const asset = assets.get(sha)
    if (asset !== undefined && !links.includes(asset.link)) {
      links.push(asset.link)
    }
  }
  const header = input.header
  r.out.text(
    `<!-- Exported from ${commentText(header.link)} by ${commentText(header.by)} on ${commentText(header.at)}.` +
      (links.length === 0
        ? ''
        : `\n     Linked, not included: ${links.map(commentText).join('\n       ')}`) +
      ' -->\n',
  )

  const edits = input.refs
    .flatMap((ref) => {
      const target = input.targets.get(ref)
      if (target === undefined || ref.range === null) return []
      const range =
        ref.outer !== undefined &&
        (target.kind === 'drop' ||
          (ref.kind === 'stylesheet' &&
            ref.in === 'attribute' &&
            target.kind === 'sheet'))
          ? ref.outer
          : ref.range
      return [{ ref, target, range }]
    })
    .filter(
      ({ range }) => range.end <= injected.start || range.start >= injected.end,
    )
    .sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end)

  let pos = 0
  const upTo = (at: number): void => {
    if (at > pos) r.out.text(html.slice(pos, at))
    pos = Math.max(pos, at)
  }
  const head = (): void => {
    upTo(injected.start)
    writeHead(r, input, links)
    pos = injected.end
  }
  let headDone = false
  for (const { ref, target, range } of edits) {
    if (!headDone && range.start >= injected.end) {
      head()
      headDone = true
    }
    if (range.start < pos) continue
    upTo(range.start)
    writeRef(r, input, ref, target)
    pos = range.end
  }
  if (!headDone) head()
  upTo(html.length)
  return r.out.done()
}

/** The export's own head tags, where the live page's injected tags were. */
const writeHead = (
  r: Render,
  input: ExportInput,
  links: readonly string[],
): void => {
  r.out.text(
    `<script type="application/json" id="dossier-bootstrap">${scriptJson(input.bootstrap)}</script>` +
      `<script type="application/json" id="dossier-export">${scriptJson(input.data(links))}</script>` +
      '<script type="importmap">{"imports":{',
  )
  let first = true
  for (const [name, file] of input.imports) {
    r.out.text(
      `${first ? '' : ','}${scriptJson(JSON.stringify(name))}:"${textDataUrl(r, file, file.text, mediaType(file.type))}"`,
    )
    first = false
  }
  r.out.text(`}}</script><script>${inlineScript(input.client)}</script>`)
}

const writeRef = (
  r: Render,
  input: ExportInput,
  ref: ExportRef,
  target: ExportTarget,
): void => {
  const escape = ESCAPES[ref.in]
  if (ref.in === 'script') {
    if (target.kind === 'module') {
      const quote = input.html[(ref.range?.start ?? 1) - 1] ?? "'"
      r.out.text(inlineScript(jsText(target.name, quote)))
    } else {
      r.out.text(input.html.slice(ref.range!.start, ref.range!.end))
    }
    return
  }
  if (
    ref.kind === 'stylesheet' &&
    ref.in === 'attribute' &&
    target.kind === 'sheet' &&
    ref.outer !== undefined
  ) {
    // A stylesheet link becomes a <style> holding the sheet.
    const media =
      ref.media === null || ref.media === undefined
        ? ''
        : ` media="${attributeText(ref.media)}"`
    r.out.text(`<style${media}>`)
    writeSheet(r, target.sheet, styleText)
    r.out.text('</style>')
    return
  }
  if (target.kind === 'drop') return
  const range = ref.range!
  if (target.kind === 'candidates' && ref.candidates !== undefined) {
    // The value rewritten whole, its separators as plain commas now.
    const quotedValue = ref.quoted === true
    if (!quotedValue) r.out.text('"')
    let at = 0
    ref.candidates.forEach((candidate, index) => {
      r.out.text(escape(ref.url.slice(at, candidate.start)))
      const each = target.targets[index]
      if (each === null || each === undefined) r.out.text(escape(candidate.url))
      else writeUrl(r, each, escape)
      at = candidate.end
    })
    r.out.text(escape(ref.url.slice(at)))
    if (!quotedValue) r.out.text('"')
    return
  }
  // An attribute written without quotes gets them, and so does a new one.
  const quoted = ref.in !== 'attribute' || ref.quoted === true
  const empty = range.start === range.end && ref.attr !== undefined
  if (empty) r.out.text(` ${ref.attr}=`)
  if (!quoted) r.out.text('"')
  writeUrl(r, target, escape)
  if (!quoted) r.out.text('"')
}

/** Every asset the input can inline, by hash. */
const collectAssets = (
  input: ExportInput,
  into: Map<string, ExportAsset>,
): void => {
  const fromTarget = (target: ExportTarget | null): void => {
    if (target === null) return
    if (target.kind === 'asset') into.set(target.asset.sha256, target.asset)
    if (target.kind === 'sheet') {
      for (const ref of target.sheet.refs) fromTarget(ref.target)
    }
    if (target.kind === 'candidates') target.targets.forEach(fromTarget)
  }
  for (const target of input.targets.values()) fromTarget(target)
}

const sizeOf = (pieces: readonly ExportPiece[]): number => {
  let bytes = 0
  for (const piece of pieces) {
    bytes +=
      piece.kind === 'text'
        ? utf8Length(piece.text)
        : dataUrlLength(piece.type, piece.size)
  }
  return bytes
}

/**
 * The export's pieces. Under the limit everything is inlined. Past it, media
 * files (video, audio and images) become their canonical links, the largest
 * first whatever their kind, until the file fits; when even every media file
 * linked leaves it past the limit, `tooLarge` is the size it would have.
 */
export const planExport = (
  input: ExportInput,
): ExportPlan | { readonly tooLarge: number } => {
  const limit = input.limit ?? EXPORT_LIMIT_BYTES
  const assets = new Map<string, ExportAsset>()
  collectAssets(input, assets)
  const media = [...assets.values()]
    .filter((asset) => asset.media)
    .sort((a, b) => b.size - a.size || (a.sha256 < b.sha256 ? -1 : 1))
  const linked = new Set<string>()
  const cache = new Map<unknown, string>()
  for (;;) {
    const pieces = render(input, linked, cache)
    const bytes = sizeOf(pieces)
    if (bytes <= limit) {
      const links: string[] = []
      for (const sha of linked) {
        const link = assets.get(sha)!.link
        if (!links.includes(link)) links.push(link)
      }
      return { pieces, bytes, linked: links }
    }
    const next = media.find((asset) => !linked.has(asset.sha256))
    if (next === undefined) return { tooLarge: bytes }
    linked.add(next.sha256)
  }
}
