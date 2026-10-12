// Composing a page into the document a tree's host serves. Pure: the page
// and its layouts arrive with their analyses, and the result is a string.
//
// The chain is the layouts, outermost first, then the page. The outermost is
// a complete document; each layout's slot takes in the body of the one below
// it. Each source's bytes pass through except where a rule edits them: every
// charset meta goes, a layout's relative URLs are rewritten to read from the
// page's folder, and the head rules drop repeated head items. A complete page
// with no layout keeps all of its own bytes around those edits.

import type { Attr, HeadItem, HtmlAnalysis, Range } from './analyze.ts'
import {
  isRelativeUrl,
  isRewritable,
  resolveFrom,
  rewriteLayoutUrl,
  trimUrl,
} from './urls.ts'

/** Bumped whenever composing changes what it makes of the same input. */
export const COMPOSER_VERSION: number = 2

export interface Source {
  readonly source: string
  readonly analysis: HtmlAnalysis
  /** The tree path of its folder. */
  readonly folder: string
}

/** What the composer found in the page and its layouts. */
export interface Found {
  /** Custom element tags the page and its layouts use, sorted, once each. */
  readonly tags: readonly string[]
}

export interface ComposeInput {
  readonly page: Source
  /**
   * Outermost first; layouts[0] is a complete document. Empty when the page
   * is one.
   */
  readonly layouts: readonly Source[]
  /** Emitted right after <meta charset="utf-8">. */
  readonly inject: (found: Found) => string
}

const CHARSET = '<meta charset="utf-8">'

/** An attribute value for a double-quoted attribute. */
const attrValue = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

const isInsert = (edit: Edit): boolean => edit.start === edit.end

/**
 * The source between `from` and `to` with the edits inside it applied in one
 * pass. An insert goes before a removal at the same place; an edit inside an
 * earlier edit's range is part of what that one replaced, so it is skipped.
 */
const applyEdits = (
  source: string,
  from: number,
  to: number,
  edits: readonly Edit[],
): string => {
  const inside = edits
    .filter((edit) => edit.start >= from && edit.end <= to)
    .sort(
      (a, b) =>
        a.start - b.start ||
        Number(isInsert(b)) - Number(isInsert(a)) ||
        b.end - a.end,
    )
  let out = ''
  let pos = from
  for (const edit of inside) {
    if (edit.start < pos) continue
    out += source.slice(pos, edit.start) + edit.text
    pos = edit.end
  }
  return out + source.slice(pos, to)
}

const DEDUPED_RELS = new Set(['stylesheet', 'preload', 'modulepreload', 'icon'])

/** How the head rules treat one head item. */
type Rule =
  | { readonly kind: 'last'; readonly key: string }
  | { readonly kind: 'first'; readonly key: string }
  | { readonly kind: 'page-only' }
  | { readonly kind: 'keep' }

/**
 * The tree path a head item's URL names after the layout rewrite, resolved
 * from the page's folder, or the URL itself when it is not relative.
 */
const resolvedUrl = (
  url: string,
  owner: Source,
  page: Source,
  isLayout: boolean,
): string => {
  const trimmed = trimUrl(url)
  if (!isRelativeUrl(trimmed)) return trimmed
  const folder = isLayout && isRewritable(trimmed) ? owner.folder : page.folder
  return resolveFrom(folder, trimmed) ?? trimmed
}

const ruleOf = (
  item: HeadItem,
  owner: Source,
  page: Source,
  isLayout: boolean,
): Rule => {
  switch (item.kind) {
    case 'title':
      return { kind: 'last', key: 'title' }
    case 'meta':
      return item.key === null
        ? { kind: 'keep' }
        : { kind: 'last', key: `meta ${item.key}` }
    case 'script-src':
      return item.url === null
        ? { kind: 'keep' }
        : {
            kind: 'first',
            key: `script ${resolvedUrl(item.url, owner, page, isLayout)}`,
          }
    case 'link': {
      const rels = (item.rel ?? '').split(' ')
      if (item.url !== null && rels.some((rel) => DEDUPED_RELS.has(rel))) {
        return {
          kind: 'first',
          key: `link ${item.rel} ${resolvedUrl(item.url, owner, page, isLayout)}`,
        }
      }
      return rels.includes('alternate')
        ? { kind: 'page-only' }
        : { kind: 'keep' }
    }
    default:
      return { kind: 'keep' }
  }
}

/** The head items the head rules drop, per source in chain order. */
const droppedItems = (chain: readonly Source[]): Range[][] => {
  const page = chain[chain.length - 1]!
  const rules = chain.map((owner, index) =>
    owner.analysis.head.items.map((item) =>
      ruleOf(item, owner, page, index < chain.length - 1),
    ),
  )
  const last = new Map<string, string>()
  const first = new Map<string, string>()
  rules.forEach((list, s) =>
    list.forEach((rule, i) => {
      const at = `${s}:${i}`
      if (rule.kind === 'last') last.set(rule.key, at)
      if (rule.kind === 'first' && !first.has(rule.key)) first.set(rule.key, at)
    }),
  )
  return rules.map((list, s) =>
    list.flatMap((rule, i) => {
      const at = `${s}:${i}`
      const drop =
        (rule.kind === 'last' && last.get(rule.key) !== at) ||
        (rule.kind === 'first' && first.get(rule.key) !== at) ||
        (rule.kind === 'page-only' && s < chain.length - 1)
      return drop ? [chain[s]!.analysis.head.items[i]!.range] : []
    }),
  )
}

/** Every edit of one source: charset metas, dropped items, layout URLs. */
const editsOf = (
  owner: Source,
  page: Source,
  isLayout: boolean,
  dropped: readonly Range[],
): Edit[] => {
  const { analysis } = owner
  const edits: Edit[] = [
    ...analysis.charsetMetas.map((r) => ({ ...r, text: '' })),
    ...dropped.map((r) => ({ ...r, text: '' })),
  ]
  if (isLayout && owner.folder !== page.folder) {
    for (const url of analysis.urls) {
      if (!url.relative || url.underscore) continue
      const value = owner.source.slice(url.range.start, url.range.end)
      // A srcset's candidates arrive one at a time, each its own URL.
      const attr = url.attr === 'srcset' ? 'src' : url.attr
      const text = rewriteLayoutUrl(value, attr, owner.folder, page.folder)
      if (text !== value) edits.push({ ...url.range, text })
    }
  }
  return edits
}

/**
 * The ranges a source's head content is made of. After a written <head>
 * start tag it is the head's content as written, then any head element
 * written after it (the parser adds an element written between </head> and
 * the body to the head). Without a <head> start tag it is the head's
 * elements, in order.
 */
const headRanges = (analysis: HtmlAnalysis): Range[] => {
  const { head } = analysis
  if (head.startTag === null) return head.items.map((item) => item.range)
  const start = head.startTag.end
  let end = head.content?.end ?? start
  const after: Range[] = []
  for (const { range } of head.items) {
    if (range.end <= end) continue
    if (range.start < end) end = range.end
    else after.push(range)
  }
  return [{ start, end }, ...after]
}

const headOf = (owner: Source, edits: readonly Edit[]): string =>
  headRanges(owner.analysis)
    .map((range) => applyEdits(owner.source, range.start, range.end, edits))
    .join('')

/** Attributes over the chain: innermost wins, class lists joined in order. */
const mergeAttrs = (lists: readonly (readonly Attr[])[]): string => {
  const values = new Map<string, string>()
  const classes: string[] = []
  for (const list of lists) {
    for (const attr of list) {
      if (attr.name === 'class') {
        for (const token of attr.value.split(/[\t\n\f\r ]+/)) {
          if (token !== '' && !classes.includes(token)) classes.push(token)
        }
        if (!values.has('class')) values.set('class', '')
      } else {
        values.set(attr.name, attr.value)
      }
    }
  }
  if (values.has('class')) values.set('class', classes.join(' '))
  return [...values]
    .map(([name, value]) => ` ${name}="${attrValue(value)}"`)
    .join('')
}

/** Where the head begins: after <head>, else <html>, else the doctype. */
const headStart = (analysis: HtmlAnalysis): number =>
  analysis.head.startTag?.end ??
  analysis.html.startTag?.end ??
  analysis.doctype?.end ??
  0

const tagsOf = (chain: readonly Source[]): string[] =>
  [...new Set(chain.flatMap((s) => s.analysis.tags))].sort()

/**
 * The layouts a page composes into, outermost first: none for a complete
 * page; otherwise the tree's layouts closest first up to the first complete
 * one, reversed, with the base layer's layout outside them when none is
 * complete.
 */
export const layoutsOf = <S extends { readonly analysis: HtmlAnalysis }>(
  page: { readonly analysis: HtmlAnalysis },
  closestFirst: readonly S[],
  base: S,
): S[] => {
  if (page.analysis.complete) return []
  const chain: S[] = []
  for (const layout of closestFirst) {
    chain.push(layout)
    if (layout.analysis.complete) break
  }
  chain.reverse()
  return chain[0]?.analysis.complete === true ? chain : [base, ...chain]
}

/** The document a page is served as. */
export const compose = (input: ComposeInput): string => {
  const { page, layouts } = input
  const chain = [...layouts, page]
  const dropped = droppedItems(chain)
  const edits = chain.map((owner, index) =>
    editsOf(owner, page, index < chain.length - 1, dropped[index] ?? []),
  )
  const inject = CHARSET + input.inject({ tags: tagsOf(chain) })

  if (layouts.length === 0) {
    if (!page.analysis.complete) {
      throw new Error('A page that is not a complete document needs a layout.')
    }
    // A complete page alone keeps its own bytes around the edits.
    const at = headStart(page.analysis)
    return applyEdits(page.source, 0, page.source.length, [
      ...(edits[0] ?? []),
      { start: at, end: at, text: inject },
    ])
  }

  const outer = layouts[0]!
  if (!outer.analysis.complete) {
    throw new Error('The outermost layout must be a complete document.')
  }

  // Bodies from the page outwards: each layout's slot takes in the one below.
  let body = applyEdits(
    page.source,
    page.analysis.body.content.start,
    page.analysis.body.content.end,
    edits[chain.length - 1] ?? [],
  )
  for (let index = layouts.length - 1; index >= 0; index--) {
    const layout = layouts[index]!
    const { content } = layout.analysis.body
    const slot = layout.analysis.slot
    const own = edits[index] ?? []
    body =
      slot !== null && slot.start >= content.start && slot.end <= content.end
        ? applyEdits(layout.source, content.start, content.end, [
            ...own,
            { ...slot, text: body },
          ])
        : applyEdits(layout.source, content.start, content.end, own) + body
  }

  const head = chain
    .map((owner, index) => headOf(owner, edits[index] ?? []))
    .join('')
  const doctype =
    outer.analysis.doctype === null
      ? ''
      : outer.source.slice(
          outer.analysis.doctype.start,
          outer.analysis.doctype.end,
        )
  const htmlAttrs = mergeAttrs(chain.map((s) => s.analysis.html.attrs))
  const bodyAttrs = mergeAttrs(chain.map((s) => s.analysis.body.attrs))
  return (
    `${doctype}<html${htmlAttrs}><head>${inject}${head}</head>` +
    `<body${bodyAttrs}>${body}</body></html>`
  )
}

/**
 * The page client's tags: its bootstrap data in a JSON block whose every '<'
 * is written as its JSON escape (backslash, u003c), so no text inside it can
 * end the block early, then the classic, blocking client script, served from
 * the page's own origin, then one modulepreload link per component the page
 * uses, so their fetches start before the client imports them.
 */
export const bootstrapTags = (
  bootstrapJson: string,
  clientSrc: string,
  preload: readonly string[],
): string =>
  '<script type="application/json" id="dossier-bootstrap">' +
  bootstrapJson.replaceAll('<', '\\u003c') +
  '</script>' +
  `<script src="${attrValue(clientSrc)}"></script>` +
  preload
    .map((href) => `<link rel="modulepreload" href="${attrValue(href)}">`)
    .join('')
