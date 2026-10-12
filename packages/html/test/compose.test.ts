import { type DefaultTreeAdapterTypes, parse } from 'parse5'
import { describe, expect, it } from 'vitest'
import {
  COMPOSER_VERSION,
  analyze,
  bootstrapTags,
  compose,
  layoutsOf,
  type Source,
} from '../src/index.ts'
import { baseLayout, crlf, fixture } from './helpers.ts'

type Element = DefaultTreeAdapterTypes.Element
type Node = DefaultTreeAdapterTypes.Node

const BOM = String.fromCharCode(0xfeff)
const CLIENT = '/_/base/1/client.js'
const inject = () =>
  bootstrapTags('{"tree":"acme","title":"Q3 <draft>"}', CLIENT, [])

const base = baseLayout()

/** A page with no layout in its tree. */
const composed = (source: string): string => {
  const page = { source, analysis: analyze(source), folder: '' }
  return compose({ page, layouts: layoutsOf(page, [], base), inject })
}

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

it('is the fourth version of the composer', () => {
  expect(COMPOSER_VERSION).toBe(4)
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
  it('puts a page that is only a body into the base layer’s layout', () => {
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
    const windows = { ...base, source: crlf(base.source) }
    const layout = { ...windows, analysis: analyze(windows.source) }
    for (const name of ['body-only', 'head-and-body', 'head-tag-and-body']) {
      const { input, expected } = golden(name)
      const source = crlf(input)
      const page = { source, analysis: analyze(source), folder: '' }
      const html = compose({ page, layouts: [layout], inject })
      expect(html).toBe(crlf(expected))
      expectServedShape(html)
    }
  })

  it('drops a leading byte order mark', () => {
    const { input, expected } = golden('body-only')
    expect(composed(`${BOM}${input}`)).toBe(expected)
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
    const tags = bootstrapTags(json, CLIENT, [])
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
    const tags = bootstrapTags('{}', CLIENT, [])
    expect(tags.endsWith(`<script src="${CLIENT}"></script>`)).toBe(true)
    for (const word of ['crossorigin', 'async', 'defer', 'module']) {
      expect(tags).not.toContain(word)
    }
  })

  it('escape the client address as an attribute value', () => {
    const src = '/_/base/1/client.js?a=1&b="2"'
    const tags = bootstrapTags('{}', src, [])
    expect(tags).toContain(
      '<script src="/_/base/1/client.js?a=1&amp;b=&quot;2&quot;"></script>',
    )
    const client = elements(parse(tags)).filter((e) => e.tagName === 'script')
    expect(attrsOf(client[1]!)).toEqual({ src })
  })
})

describe('the bootstrap tags’ preloads', () => {
  it('add one modulepreload per entry after the client, without crossorigin', () => {
    const tags = bootstrapTags('{}', CLIENT, [
      '../_components/acme-card.js',
      '/_/base/1/_components/dossier-copy.js?a&b',
    ])
    expect(tags).toBe(
      '<script type="application/json" id="dossier-bootstrap">{}</script>' +
        `<script src="${CLIENT}"></script>` +
        '<link rel="modulepreload" href="../_components/acme-card.js">' +
        '<link rel="modulepreload" href="/_/base/1/_components/dossier-copy.js?a&amp;b">',
    )
    expect(tags).not.toContain('crossorigin')
    const links = elements(parse(tags)).filter((e) => e.tagName === 'link')
    expect(links.map(attrsOf)).toEqual([
      { rel: 'modulepreload', href: '../_components/acme-card.js' },
      {
        rel: 'modulepreload',
        href: '/_/base/1/_components/dossier-copy.js?a&b',
      },
    ])
  })
})

const source = (path: string, folder: string): Source => {
  const text = fixture(`compose/${path}`)
  return { source: text, analysis: analyze(text), folder }
}

/** The nested fixture: a root layout and three fragment layouts below it. */
const nested = () => {
  const page = source('nested/a/b/c/install.html', 'a/b/c')
  const closest = [
    source('nested/a/b/c/_layout.html', 'a/b/c'),
    source('nested/a/b/_layout.html', 'a/b'),
    source('nested/a/_layout.html', 'a'),
    source('nested/_layout.html', ''),
  ]
  return { page, closest, layouts: layoutsOf(page, closest, base) }
}

const preloadingInject = ({ tags }: { readonly tags: readonly string[] }) =>
  bootstrapTags(
    JSON.stringify({ tags }),
    CLIENT,
    tags.map((tag) => `_components/${tag}.js`),
  )

describe('layouts', () => {
  it('nest three fragment layouts outermost first into the root’s complete document', () => {
    const { page, closest, layouts } = nested()
    expect(layouts.map((layout) => layout.folder)).toEqual([
      '',
      'a',
      'a/b',
      'a/b/c',
    ])
    expect(layouts[0]).toBe(closest[3])
    const html = compose({ page, layouts, inject: preloadingInject })
    expect(html).toBe(fixture('compose/nested/a/b/c/install.expected.html'))
    const order = [
      'site-header',
      'sidebar',
      '<aside>',
      'class="c"',
      '<h1>Install',
    ]
    const at = order.map((text) => html.indexOf(text))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(html).not.toContain('<slot')
    expect(html).not.toContain('Fallback')
  })

  it('hand the composer’s inject the tags the page and its layouts use', () => {
    const { page, layouts } = nested()
    const seen: (readonly string[])[] = []
    compose({
      page,
      layouts,
      inject: ({ tags }) => {
        seen.push(tags)
        return ''
      },
    })
    expect(seen).toEqual([['acme-card']])
  })

  it('hand the composer’s inject each library the page and its layouts use, once', () => {
    const read = (name: string) => ({
      source: fixture(`libraries/${name}`),
      analysis: analyze(fixture(`libraries/${name}`)),
      folder: '',
    })
    const layout = read('_layout.html')
    const found = (page: Source) => {
      const seen: (readonly string[])[] = []
      compose({
        page,
        layouts: layoutsOf(page, [layout], base),
        inject: (given) => {
          seen.push(given.libraries)
          return ''
        },
      })
      return seen
    }
    // The page holds all three, the layout two of them: each is listed once.
    expect(found(read('page.html'))).toEqual([['katex', 'mermaid', 'shiki']])
    // Mermaid from the page, math and code from the layout.
    expect(found(read('diagram.html'))).toEqual([['katex', 'mermaid', 'shiki']])
    // A page with none of them still gets the layout's.
    expect(found(read('plain.html'))).toEqual([['katex', 'shiki']])
  })

  it('stop at a complete-document layout in a subfolder', () => {
    const page = source('mockups/one.html', 'mockups')
    const mockups = source('mockups/_layout.html', 'mockups')
    const layouts = layoutsOf(
      page,
      [mockups, source('nested/_layout.html', '')],
      base,
    )
    expect(layouts).toEqual([mockups])
    const html = compose({ page, layouts, inject: preloadingInject })
    expect(html).toBe(fixture('compose/mockups/one.expected.html'))
    expect(html).not.toContain('site-header')
  })

  it('never wrap a complete page', () => {
    const page = source('../complete.html', '')
    expect(layoutsOf(page, nested().closest, base)).toEqual([])
  })

  it('close with the base layer’s layout when no tree layout is complete', () => {
    const page = source('body-only.html', '')
    expect(layoutsOf(page, [], base)).toEqual([base])
    const fragment = source('nested/a/_layout.html', 'a')
    expect(layoutsOf(page, [fragment], base)).toEqual([base, fragment])
    const html = compose({ page, layouts: [base], inject })
    expect(html).toBe(fixture('compose/body-only.expected.html'))
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    )
  })

  it('merge <html> and <body> attributes, innermost winning and classes joined', () => {
    const { page, layouts } = nested()
    const document = parse(compose({ page, layouts, inject }))
    const all = elements(document)
    expect(attrsOf(all.find((e) => e.tagName === 'html')!)).toEqual({
      lang: 'en',
      class: 'site',
    })
    expect(attrsOf(all.find((e) => e.tagName === 'body')!)).toEqual({
      class: 'root b',
      'data-theme': 'dark',
    })
  })

  it('keep every byte outside the edited ranges', () => {
    const { page, layouts } = nested()
    const html = compose({ page, layouts, inject })
    const pieces = (owner: Source): string[] => {
      const { analysis } = owner
      const cuts = [
        ...analysis.urls
          .filter((u) => u.relative && !u.underscore)
          .map((u) => u.range),
        ...(analysis.slot === null ? [] : [analysis.slot]),
      ].sort((a, b) => a.start - b.start)
      const out: string[] = []
      let pos = analysis.body.content.start
      for (const cut of cuts) {
        if (cut.start < pos || cut.end > analysis.body.content.end) continue
        out.push(owner.source.slice(pos, cut.start))
        pos = cut.end
      }
      out.push(owner.source.slice(pos, analysis.body.content.end))
      return out.filter((piece) => piece !== '')
    }
    for (const owner of layouts) {
      for (const piece of pieces(owner)) expect(html).toContain(piece)
    }
    const body = page.source.slice(
      page.analysis.body.content.start,
      page.analysis.body.content.end,
    )
    expect(html).toContain(body)
  })
})

describe('the layout URL rewrite', () => {
  const { page, layouts } = nested()
  const html = compose({ page, layouts, inject })

  it('reads a layout’s relative URLs from its own folder', () => {
    for (const written of [
      '<a href="../../../">',
      '<img src="../../../logo.svg"',
      'srcset="../../../logo.svg 1x, ../../../logo@2x.png 2x"',
      '<form action="../../../feedback/">',
      '<link rel="icon" href="../../../favicon.svg">',
      '<script src="../../../vendor/site.js">',
      '<link rel="stylesheet" href="../../../vendor/a.css">',
      '<a href="../../index.html">',
      '<video poster="../poster.jpg"',
    ]) {
      expect(html).toContain(written)
    }
  })

  it('leaves _, absolute, root-relative, query-only, fragment-only and tree-leaving URLs alone', () => {
    for (const written of [
      '<link rel="stylesheet" href="_theme.css">',
      'src="_clip.mp4"',
      '<a href="https://acme.example/">',
      '<a href="/elsewhere">',
      '<a href="?q=1">',
      '<a href="#top">',
      '<a href="../../../outside.html">',
    ]) {
      expect(html).toContain(written)
    }
  })

  it('never rewrites the page’s own markup', () => {
    expect(html).toContain('<img src="shot.png">')
    expect(html).toContain('<a href="../../../logo.svg">Logo</a>')
  })

  it('changes nothing when the layout sits in the page’s folder', () => {
    const own = source('nested/a/_layout.html', 'a')
    const here = { ...source('body-only.html', ''), folder: 'a' }
    const out = compose({ page: here, layouts: [base, own], inject })
    expect(out).toContain('<a href="index.html">Section A</a>')
    expect(out).toContain('<link rel="stylesheet" href="../vendor/a.css">')
  })
})

describe('the head rules', () => {
  const page = source('rules/page.html', '')
  const layout = source('rules/_layout.html', '')
  const html = compose({ page, layouts: [layout], inject: preloadingInject })
  const head = headOf(html)
  const tagged = head.map((e) => {
    const a = attrsOf(e)
    return `${e.tagName} ${a.rel ?? a.name ?? a.property ?? a['http-equiv'] ?? ''} ${a.href ?? a.src ?? a.content ?? textOf(e)}`.trim()
  })

  it('composes the golden document', () => {
    expect(html).toBe(fixture('compose/rules/page.expected.html'))
  })

  it('drop every charset meta and write one first', () => {
    expect(attrsOf(head[0]!)).toEqual({ charset: 'utf-8' })
    const read = analyze(html)
    expect(read.charsetMetas.map((r) => html.slice(r.start, r.end))).toEqual([
      '<meta charset="utf-8">',
    ])
    expect(html).not.toContain('windows-1252')
  })

  it('keep the last <title> and the last meta of each key', () => {
    expect(head.filter((e) => e.tagName === 'title').map(textOf)).toEqual([
      'Page title',
    ])
    expect(tagged).toContain('meta description page')
    expect(tagged).toContain('meta og:title page')
    expect(tagged).not.toContain('meta description layout')
    expect(tagged).not.toContain('meta og:title layout')
    expect(tagged).toContain('meta refresh 60')
  })

  it('keep the first link and script of each resolved URL', () => {
    const count = (text: string) => tagged.filter((t) => t === text).length
    expect(count('link stylesheet _theme.css')).toBe(1)
    expect(count('link preload fonts/a.woff2')).toBe(1)
    expect(count('link modulepreload lib/x.js')).toBe(1)
    expect(count('link icon icon.svg')).toBe(1)
    expect(count('link stylesheet https://cdn.example.com/a.css')).toBe(1)
    expect(count('script  lib/app.js')).toBe(1)
    // Another rel at the same URL is another resource.
    expect(count('link stylesheet lib/x.js')).toBe(1)
  })

  it('keep every inline style and script, in chain order', () => {
    const inline = head
      .filter(
        (e) =>
          (e.tagName === 'style' || e.tagName === 'script') &&
          !attrsOf(e).src &&
          !attrsOf(e).type,
      )
      .map(textOf)
    expect(inline).toEqual([
      '.layout { color: red }',
      'window.layout = 1',
      '.page { color: blue }',
      'window.page = 1',
    ])
  })

  it('keep the alternate link only from the page, and everything else where it stands', () => {
    expect(tagged.filter((t) => t.startsWith('link alternate'))).toEqual([
      'link alternate page.md',
    ])
    expect(tagged).toContain('link manifest app.webmanifest')
    expect(html).toContain('<noscript><p>Layout noscript</p></noscript>')
    expect(html).toContain('<noscript><p>Page noscript</p></noscript>')
    expect(html).toContain('<!-- a layout comment -->')
  })

  it('dedupe two layouts linking _theme.css from different folders, as both resolve from the page', () => {
    const { page: install, layouts } = nested()
    const out = compose({ page: install, layouts, inject })
    expect(out.split('href="_theme.css"')).toHaveLength(2)
  })
})

describe('a fragment inside a slot', () => {
  const layout = (body: string) => {
    const text = `<!doctype html><html><head></head><body>${body}</body></html>`
    return { source: text, analysis: analyze(text), folder: '' }
  }
  const MAIN = layout('<main><slot></slot><footer>Foot</footer></main>')
  const inMain = (page: string, outer = MAIN): Element => {
    const html = compose({
      page: { source: page, analysis: analyze(page), folder: '' },
      layouts: [outer],
      inject,
    })
    const main = elements(parse(html)).find((e) => e.tagName === 'main')
    if (main === undefined) throw new Error(`no <main> in ${html}`)
    return main
  }
  const names = (element: Element) => elements(element).map((e) => e.tagName)

  it('never closes the layout’s elements with an end tag its own parse ignored', () => {
    const main = inMain('</main><p>Page</p></div></footer>')
    expect(names(main)).toEqual(['main', 'p', 'footer'])
  })

  it('keeps what an end tag with nothing to close made on its own', () => {
    expect(names(inMain('<p>a</p></p></br>'))).toEqual([
      'main',
      'p',
      'p',
      'br',
      'footer',
    ])
  })

  it('closes what the page left open, so the layout’s markup stays outside it', () => {
    const main = inMain('<div class="open"><section><p>Page')
    const div = elements(main).find((e) => e.tagName === 'div')!
    expect(names(div)).toEqual(['div', 'section', 'p'])
    expect(names(main).at(-1)).toBe('footer')
    expect(elements(div).some((e) => e.tagName === 'footer')).toBe(false)
  })

  it('closes raw text a page left open, in its head or body', () => {
    for (const page of [
      '<head><style>p{color:red}',
      '<p>Page</p><style>p{color:red}',
      '<p>Page</p><textarea>draft',
      '<p>Page</p><script>let a = 1',
      '<p>Page</p><!-- an open comment',
    ]) {
      const html = compose({
        page: { source: page, analysis: analyze(page), folder: '' },
        layouts: [MAIN],
        inject,
      })
      const footer = elements(parse(html)).find((e) => e.tagName === 'footer')
      expect(footer, page).toBeDefined()
      expect(textOf(footer!), page).toBe('Foot')
    }
  })

  it('seals each fragment layout below the outermost too', () => {
    const middle = '</main><nav>Nav</nav><div><slot></slot>'
    const mid = { source: middle, analysis: analyze(middle), folder: '' }
    const page = '<p>Page</p>'
    const html = compose({
      page: { source: page, analysis: analyze(page), folder: '' },
      layouts: [MAIN, mid],
      inject,
    })
    const main = elements(parse(html)).find((e) => e.tagName === 'main')!
    expect(names(main)).toEqual(['main', 'nav', 'div', 'p', 'footer'])
  })
})

describe('the head rules on queries and fragments', () => {
  it('keep two scripts of one file with different queries', () => {
    const outer = `<!doctype html><html><head><script type="module" src="app.js?mode=layout"></script></head><body><slot></slot></body></html>`
    const page =
      '<script type="module" src="../app.js?mode=page"></script><p>x</p>'
    const html = compose({
      page: { source: page, analysis: analyze(page), folder: 'a' },
      layouts: [{ source: outer, analysis: analyze(outer), folder: '' }],
      inject,
    })
    expect(html).toContain('app.js?mode=layout')
    expect(html).toContain('../app.js?mode=page')
  })

  it('keep two stylesheets that differ only in their fragment', () => {
    const outer = `<!doctype html><html><head><link rel="stylesheet" href="s.css#a"></head><body><slot></slot></body></html>`
    const page = '<link rel="stylesheet" href="s.css#b"><p>x</p>'
    const html = compose({
      page: { source: page, analysis: analyze(page), folder: '' },
      layouts: [{ source: outer, analysis: analyze(outer), folder: '' }],
      inject,
    })
    expect(html).toContain('s.css#a')
    expect(html).toContain('s.css#b')
  })
})

describe('the layout rewrite on character references', () => {
  const rewritten = (body: string) => {
    const outer = `<!doctype html><html><head></head><body>${body}<slot></slot></body></html>`
    const page = '<p>x</p>'
    return compose({
      page: { source: page, analysis: analyze(page), folder: 'a/b' },
      layouts: [{ source: outer, analysis: analyze(outer), folder: '' }],
      inject,
    })
  }

  it('reads a URL as the browser does before deciding to rewrite it', () => {
    expect(rewritten('<a href="&#63;print">P</a>')).toContain(
      '<a href="&#63;print">',
    )
    expect(rewritten('<a href="&#x23;top">T</a>')).toContain(
      '<a href="&#x23;top">',
    )
    expect(
      rewritten('<img srcset="https&#58;//cdn.example.com/a.png 1x">'),
    ).toContain('srcset="https&#58;//cdn.example.com/a.png 1x"')
    expect(rewritten('<a href="&#95;theme.css">U</a>')).toContain(
      '<a href="&#95;theme.css">',
    )
  })

  it('writes a rewritten URL back with its references escaped', () => {
    const html = rewritten(
      `<a href="a&amp;b.html?x=1&amp;y=2">A</a><a href='q&#39;s.html'>Q</a>`,
    )
    expect(html).toContain('<a href="../../a&amp;b.html?x=1&amp;y=2">')
    expect(html).toContain(`<a href='../../q&#39;s.html'>`)
    const links = elements(parse(html)).filter((e) => e.tagName === 'a')
    expect(links.map((a) => attrsOf(a).href)).toEqual([
      '../../a&b.html?x=1&y=2',
      "../../q's.html",
    ])
  })
})

describe('a layout srcset with a separator written as a reference', () => {
  it('rewrites every candidate the browser reads', () => {
    const outer = `<!doctype html><html><head></head><body><img srcset="logo.svg&#44; brief.pdf 2x" alt=""><slot></slot></body></html>`
    const page = '<p>x</p>'
    const html = compose({
      page: { source: page, analysis: analyze(page), folder: 'a/b' },
      layouts: [{ source: outer, analysis: analyze(outer), folder: '' }],
      inject,
    })
    const img = elements(parse(html)).find((e) => e.tagName === 'img')!
    expect(attrsOf(img).srcset).toBe('../../logo.svg, ../../brief.pdf 2x')
  })

  it('lists every decoded candidate as requested', () => {
    const read = analyze('<img srcset="logo.svg&#44; brief.pdf 2x">')
    expect(read.urls.flatMap((url) => url.requests)).toEqual([
      'logo.svg',
      'brief.pdf',
    ])
  })
})
