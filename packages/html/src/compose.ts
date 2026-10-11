// Composing a page into the document a tree's host serves. Pure: the page
// arrives with its analysis, and the result is a string.
//
// A complete document keeps its own bytes; only its charset metas go, and
// the page client's tags go first in its head. Anything else (a body only,
// or head and body content without <html> or a doctype) goes into the base
// layer's minimal document.

import type { HtmlAnalysis, Range } from './analyze.ts'

/** Bumped whenever composing changes what it makes of the same input. */
export const COMPOSER_VERSION: number = 1

export interface Source {
  readonly source: string
  readonly analysis: HtmlAnalysis
  /** The tree path of its folder. */
  readonly folder: string
}

export interface ComposeInput {
  readonly page: Source
  /** Outermost first. Not composed yet: must be empty. */
  readonly layouts: readonly Source[]
  /** Emitted right after <meta charset="utf-8">. */
  readonly inject: string
}

const CHARSET = '<meta charset="utf-8">'
const VIEWPORT =
  '<meta name="viewport" content="width=device-width, initial-scale=1">'

/** An attribute value for a double-quoted attribute. */
const attrValue = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

/**
 * The source between `from` and `to`, without the removed ranges inside it,
 * and with `insert` placed at `at` when given.
 */
const cut = (
  source: string,
  from: number,
  to: number,
  removed: readonly Range[],
  insert?: { readonly at: number; readonly text: string },
): string => {
  const inside = removed
    .filter((range) => range.start >= from && range.end <= to)
    .sort((a, b) => a.start - b.start)
  let out = ''
  let pos = from
  let pending = insert
  const place = (until: number): void => {
    if (pending === undefined || pending.at > until) return
    const at = Math.max(pos, pending.at)
    out += source.slice(pos, at) + pending.text
    pos = at
    pending = undefined
  }
  for (const range of inside) {
    place(range.start)
    if (range.start > pos) out += source.slice(pos, range.start)
    pos = Math.max(pos, range.end)
  }
  place(to)
  out += source.slice(pos, to)
  return out
}

/** Where the head begins: after <head>, else <html>, else the doctype. */
const headStart = (analysis: HtmlAnalysis): number =>
  analysis.head.startTag?.end ??
  analysis.html.startTag?.end ??
  analysis.doctype?.end ??
  0

const composeComplete = (page: Source, inject: string): string => {
  const { source, analysis } = page
  return cut(source, 0, source.length, analysis.charsetMetas, {
    at: headStart(analysis),
    text: CHARSET + inject,
  })
}

/**
 * The head's written content, without charset metas. After a written <head>
 * start tag it is the head's content as written, up to the body's content,
 * then any head element written after it: the parser adds an element written
 * between </head> and the body to the head, and a head whose </head> was
 * never written can end inside its last element. Without a <head> start tag
 * it is the head's elements, in order.
 */
const headContent = (page: Source): string => {
  const { source, analysis } = page
  const { head, body, charsetMetas } = analysis
  const element = (range: Range): string =>
    cut(source, range.start, range.end, charsetMetas)
  if (head.startTag === null)
    return head.items.map((i) => element(i.range)).join('')
  const start = head.startTag.end
  let end = Math.min(head.content?.end ?? start, body.content.start)
  const after: string[] = []
  for (const { range } of head.items) {
    if (range.end <= end) continue
    if (range.start < end) end = range.end
    else after.push(element(range))
  }
  return cut(source, start, end, charsetMetas) + after.join('')
}

const composeFragment = (page: Source, inject: string): string => {
  const { source, analysis } = page
  const attrs = analysis.body.attrs
    .map((attr) => ` ${attr.name}="${attrValue(attr.value)}"`)
    .join('')
  const content = source.slice(
    analysis.body.content.start,
    analysis.body.content.end,
  )
  return (
    `<!doctype html><html><head>${CHARSET}${inject}${VIEWPORT}` +
    `${headContent(page)}</head><body${attrs}>${content}</body></html>`
  )
}

/**
 * The document a page is served as. Throws when given layouts, which a later
 * version of the composer takes in.
 */
export const compose = (input: ComposeInput): string => {
  if (input.layouts.length > 0) {
    throw new Error('Layouts are not composed yet: pass an empty list.')
  }
  return input.page.analysis.complete
    ? composeComplete(input.page, input.inject)
    : composeFragment(input.page, input.inject)
}

/**
 * The page client's tags: its bootstrap data in a JSON block whose every '<'
 * is written as its JSON escape (backslash, u003c), so no text inside it can
 * end the block early, then the classic, blocking client script, served from
 * the page's own origin.
 */
export const bootstrapTags = (
  bootstrapJson: string,
  clientSrc: string,
): string =>
  '<script type="application/json" id="dossier-bootstrap">' +
  bootstrapJson.replaceAll('<', '\\u003c') +
  '</script>' +
  `<script src="${attrValue(clientSrc)}"></script>`
