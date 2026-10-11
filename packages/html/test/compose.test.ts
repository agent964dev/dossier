import { type DefaultTreeAdapterTypes, parse } from 'parse5'
import { describe, expect, it } from 'vitest'
import {
  COMPOSER_VERSION,
  analyze,
  bootstrapTags,
  compose,
} from '../src/index.ts'
import { crlf, fixture } from './helpers.ts'

type Element = DefaultTreeAdapterTypes.Element
type Node = DefaultTreeAdapterTypes.Node

const BOM = String.fromCharCode(0xfeff)
const CLIENT = '/_/base/1/client.js'
const inject = bootstrapTags('{"tree":"acme","title":"Q3 <draft>"}', CLIENT)

const composed = (source: string): string =>
  compose({
    page: { source, analysis: analyze(source), folder: '' },
    layouts: [],
    inject,
  })

const golden = (name: string) => ({
  input: fixture(`compose/${name}.html`),
  expected: fixture(`compose/${name}.expected.html`),
})

const isElement = (node: Node): node is Element => 'tagName' in node

const elements = (node: Node): Element[] => {
  const found: Element[] = []
  const walk = (at: Node): void => {
    if (isElement(at)) found.push(at)
    if ('childNodes' in at) for (const child of at.childNodes) walk(child)
  }
  walk(node)
  return found
}

const attrsOf = (element: Element): Record<string, string> =>
  Object.fromEntries(element.attrs.map((attr) => [attr.name, attr.value]))

const textOf = (element: Element): string =>
  element.childNodes.map((node) => ('value' in node ? node.value : '')).join('')

/** The elements a browser puts in the composed document's head. */
const headOf = (html: string): Element[] => {
  const document = parse(html)
  const head = elements(document).find((element) => element.tagName === 'head')
  return head?.childNodes.filter(isElement) ?? []
}

/** Checks every composed document makes, whatever the page. */
const expectServedShape = (html: string): void => {
  const [charset, data, client] = headOf(html)
  expect(charset?.tagName).toBe('meta')
  expect(attrsOf(charset!)).toEqual({ charset: 'utf-8' })
  expect(data?.tagName).toBe('script')
  expect(attrsOf(data!)).toEqual({
    type: 'application/json',
    id: 'dossier-bootstrap',
  })
  expect(JSON.parse(textOf(data!))).toEqual({
    tree: 'acme',
    title: 'Q3 <draft>',
  })
  expect(client?.tagName).toBe('script')
  expect(attrsOf(client!)).toEqual({ src: CLIENT })
  const read = analyze(html)
  expect(read.charsetMetas.map((r) => html.slice(r.start, r.end))).toEqual([
    '<meta charset="utf-8">',
  ])
}

it('is the first version of the composer', () => {
  expect(COMPOSER_VERSION).toBe(1)
})

describe('a complete document', () => {
  it('keeps its bytes, loses every charset meta and gets the client first in its head', () => {
    const { input, expected } = golden('complete')
    const html = composed(input)
    expect(html).toBe(expected)
    expectServedShape(html)
  })

  it('puts the client after <html> when the head tag is implicit', () => {
    const { input, expected } = golden('implicit-head')
    const html = composed(input)
    expect(html).toBe(expected)
    expectServedShape(html)
  })

  it('puts the client after the doctype when <html> and <head> are implicit', () => {
    const { input, expected } = golden('doctype-only')
    const html = composed(input)
    expect(html).toBe(expected)
    expectServedShape(html)
  })

  it('keeps non-ASCII text before the head as written', () => {
    const { input, expected } = golden('unicode-before-head')
    const html = composed(input)
    expect(html).toBe(expected)
    expectServedShape(html)
  })

  it('keeps Windows line endings as written', () => {
    for (const name of ['complete', 'implicit-head', 'unicode-before-head']) {
      const { input, expected } = golden(name)
      const html = composed(crlf(input))
      expect(html).toBe(crlf(expected))
      expect(html).toContain('\r\n')
      expectServedShape(html)
    }
  })

  it('keeps a leading byte order mark', () => {
    const { input, expected } = golden('complete')
    expect(composed(`${BOM}${input}`)).toBe(`${BOM}${expected}`)
  })
})

describe('a page that is not a complete document', () => {
  it('puts a page that is only a body into the base layer document', () => {
    const { input, expected } = golden('body-only')
    const html = composed(input)
    expect(html).toBe(expected)
    expectServedShape(html)
  })

  it('takes head elements written without <head> in order, and keeps the body attributes', () => {
    const { input, expected } = golden('head-and-body')
    const html = composed(input)
    expect(html).toBe(expected)
    expectServedShape(html)
    const body = elements(parse(html)).find((e) => e.tagName === 'body')
    expect(attrsOf(body!)).toEqual({
      class: 'retro',
      'data-note': 'say "hi" & go',
    })
  })

  it('takes the head content after a written <head>, without charset metas', () => {
    const { input, expected } = golden('head-tag-and-body')
    const html = composed(input)
    expect(html).toBe(expected)
    expectServedShape(html)
  })

  it('takes a head whose </head> was never written up to the body', () => {
    const { input, expected } = golden('head-unclosed')
    const html = composed(input)
    expect(html).toBe(expected)
    expectServedShape(html)
    expect(analyze(html).title).toBe('Draft')
  })

  it('keeps a head element written between </head> and the body', () => {
    const { input, expected } = golden('head-after-close')
    const html = composed(input)
    expect(html).toBe(expected)
    expectServedShape(html)
  })

  it('keeps Windows line endings in the head and body content', () => {
    for (const name of ['body-only', 'head-and-body', 'head-tag-and-body']) {
      const { input, expected } = golden(name)
      const html = composed(crlf(input))
      expect(html).toBe(crlf(expected))
      expectServedShape(html)
    }
  })

  it('drops a leading byte order mark', () => {
    const { input, expected } = golden('body-only')
    expect(composed(`${BOM}${input}`)).toBe(expected)
  })
})

describe('layouts', () => {
  it('are refused until the composer takes them in', () => {
    const source = fixture('compose/body-only.html')
    const layout = { source, analysis: analyze(source), folder: '' }
    expect(() =>
      compose({ page: layout, layouts: [layout], inject }),
    ).toThrowError(/Layouts are not composed yet/)
  })
})

describe('the bootstrap tags', () => {
  it('escape every < so no text in the data can end its block', () => {
    const data = {
      title: '</script><script>alert(1)</script>',
      note: '<!-- <script> -->',
      path: 'a<b>c',
    }
    const json = JSON.stringify(data)
    const tags = bootstrapTags(json, CLIENT)
    expect(tags).toBe(
      '<script type="application/json" id="dossier-bootstrap">' +
        json.replaceAll('<', '\\u003c') +
        '</script><script src="/_/base/1/client.js"></script>',
    )
    expect(tags.split('<').length - 1).toBe(4)

    const scripts = elements(parse(`<!doctype html><head>${tags}`)).filter(
      (element) => element.tagName === 'script',
    )
    expect(scripts).toHaveLength(2)
    const [block, client] = scripts
    expect(attrsOf(block!)).toEqual({
      type: 'application/json',
      id: 'dossier-bootstrap',
    })
    expect(block!.childNodes).toHaveLength(1)
    expect(JSON.parse(textOf(block!))).toEqual(data)
    expect(attrsOf(client!)).toEqual({ src: CLIENT })
  })

  it('load the client as a classic, blocking script with no crossorigin', () => {
    const tags = bootstrapTags('{}', CLIENT)
    expect(tags.endsWith(`<script src="${CLIENT}"></script>`)).toBe(true)
    for (const word of ['crossorigin', 'async', 'defer', 'module']) {
      expect(tags).not.toContain(word)
    }
  })

  it('escape the client address as an attribute value', () => {
    const src = '/_/base/1/client.js?a=1&b="2"'
    const tags = bootstrapTags('{}', src)
    expect(tags).toContain(
      '<script src="/_/base/1/client.js?a=1&amp;b=&quot;2&quot;"></script>',
    )
    const client = elements(parse(tags)).filter((e) => e.tagName === 'script')
    expect(attrsOf(client[1]!)).toEqual({ src })
  })
})
