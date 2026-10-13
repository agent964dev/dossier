// What a link to a page shows before it opens: its title, description and
// image, read from the heads of the page and its layouts.

import { parseFragment } from 'parse5'
import type { HeadItem, HtmlAnalysis } from './analyze.ts'
import type { Element } from './parse.ts'
import { trimUrl } from './urls.ts'

export interface PreviewSource {
  readonly source: string
  readonly analysis: HtmlAnalysis
}

export interface RawPreview {
  readonly title: string | null
  readonly description: string | null
  /** As written, character references decoded: not yet resolved. */
  readonly image: string | null
}

/** The head item's element, parsed on its own. */
const elementOf = (source: string, item: HeadItem): Element | null => {
  const fragment = parseFragment(source.slice(item.range.start, item.range.end))
  for (const node of fragment.childNodes) {
    if ('tagName' in node) return node
  }
  return null
}

const titleText = (element: Element): string => {
  let text = ''
  for (const node of element.childNodes) {
    if (node.nodeName === '#text' && 'value' in node) text += node.value
  }
  return text
}

const contentOf = (element: Element): string =>
  element.attrs.find((attr) => attr.name === 'content' && !attr.prefix)
    ?.value ?? ''

const collapse = (text: string): string =>
  text.replace(/[\t\n\f\r ]+/g, ' ').trim()

const orNull = (text: string): string | null => (text === '' ? null : text)

/**
 * A source's value for one of `keys`: its last head item with one, as the
 * head rules keep the last; null when it has none or that one is empty.
 */
const valueIn = (
  owner: PreviewSource,
  keys: readonly string[],
  read: (element: Element) => string,
): string | null => {
  const items = owner.analysis.head.items
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.key === null || !keys.includes(item.key)) continue
    const element = elementOf(owner.source, item)
    return element === null ? null : orNull(read(element))
  }
  return null
}

const title = (element: Element): string => collapse(titleText(element))
const text = (element: Element): string => collapse(contentOf(element))
const url = (element: Element): string => trimUrl(contentOf(element))

/**
 * A page's preview, innermost first: the page, then its layouts closest
 * first, and the first of them with a value gives each field. Within one
 * source the field reads its own tag before its fallback, and the last of
 * a tag written twice, as the head rules keep it:
 *
 * - title: `<title>`, else `og:title`;
 * - description: `<meta name="description">`, else `og:description`;
 * - image: `og:image`, else `twitter:image` (named by name or property).
 *
 * Character references are decoded; the title and description have their
 * whitespace collapsed and trimmed, the image is trimmed; empty is none.
 */
export const previewOf = (
  page: PreviewSource,
  layouts: readonly PreviewSource[],
): RawPreview => {
  const chain = [page, ...layouts]
  const first = (
    own: readonly string[],
    fallback: readonly string[],
    read: (element: Element) => string,
  ): string | null => {
    for (const owner of chain) {
      const value = valueIn(owner, own, read) ?? valueIn(owner, fallback, read)
      if (value !== null) return value
    }
    return null
  }
  return {
    title: first(['title'], ['property:og:title'], (element) =>
      element.tagName === 'title' ? title(element) : text(element),
    ),
    description: first(['name:description'], ['property:og:description'], text),
    image: first(
      ['property:og:image'],
      ['name:twitter:image', 'property:twitter:image'],
      url,
    ),
  }
}
