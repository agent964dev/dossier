import { describe, expect, it } from 'vitest'
import { ANALYZER_VERSION, analyze } from '../src/index.ts'
import { crlf, fixture, slicer } from './helpers.ts'

describe('a complete document', () => {
  const source = fixture('complete.html')
  const page = analyze(source)
  const text = slicer(source)

  it('is complete, with its doctype and the version of the analysis', () => {
    expect(page.v).toBe(ANALYZER_VERSION)
    expect(page.v).toBe(7)
    expect(page.complete).toBe(true)
    expect(text(page.doctype)).toBe('<!DOCTYPE html>')
  })

  it('finds the <html> start tag and its attributes', () => {
    expect(text(page.html.startTag)).toBe('<html lang="en" class="light">')
    expect(page.html.attrs).toEqual([
      { name: 'lang', value: 'en' },
      { name: 'class', value: 'light' },
    ])
  })

  it('finds the head between its start and end tags', () => {
    expect(text(page.head.startTag)).toBe('<head>')
    const head = text(page.head.content) ?? ''
    expect(head.startsWith('\n    <meta charset="utf-8">')).toBe(true)
    expect(head.endsWith('</noscript>\n  ')).toBe(true)
  })

  it('lists each head element with its kind, key, rel, URL and whole markup', () => {
    expect(
      page.head.items.map((item) => [
        item.kind,
        item.key,
        item.rel,
        item.url,
        text(item.range),
      ]),
    ).toEqual([
      ['meta', null, null, null, '<meta charset="utf-8">'],
      [
        'meta',
        'name:viewport',
        null,
        null,
        '<meta name="Viewport" content="width=device-width">',
      ],
      [
        'meta',
        'property:og:title',
        null,
        null,
        '<meta property="og:title" content="Plan">',
      ],
      [
        'meta',
        'http-equiv:content-type',
        null,
        null,
        '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
      ],
      ['title', 'title', null, null, '<title>  Quarterly plan  </title>'],
      [
        'link',
        null,
        'stylesheet',
        '_theme.css',
        '<link rel="stylesheet" href="_theme.css">',
      ],
      [
        'link',
        null,
        'alternate',
        'plan.md',
        '<link rel="alternate" type="text/markdown" href="plan.md">',
      ],
      [
        'script-src',
        null,
        null,
        'https://cdn.example.com/chart.js',
        '<script src="https://cdn.example.com/chart.js"></script>',
      ],
      [
        'script',
        null,
        null,
        null,
        `<script type="module">import './_kit/app.js'</script>`,
      ],
      ['style', null, null, null, '<style>body { margin: 0 }</style>'],
      [
        'other',
        null,
        null,
        null,
        '<noscript><p>Turn on scripts.</p></noscript>',
      ],
    ])
  })

  it('finds the body start tag, its attributes and its content', () => {
    expect(text(page.body.startTag)).toBe(
      '<body class="page" data-theme="dark">',
    )
    expect(page.body.attrs).toEqual([
      { name: 'class', value: 'page' },
      { name: 'data-theme', value: 'dark' },
    ])
    expect(text(page.body.content)).toBe(
      '\n    <h1>Quarterly plan</h1>\n' +
        '    <p>See <a href="notes/q3.html">the notes</a>.</p>\n  ',
    )
  })

  it('finds every charset meta, the trimmed title and the alternate link', () => {
    expect(page.charsetMetas.map(text)).toEqual([
      '<meta charset="utf-8">',
      '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
    ])
    expect(page.title).toBe('Quarterly plan')
    expect(page.alternate).toBe('plan.md')
    expect(page.base).toBeNull()
    expect(page.slot).toBeNull()
    expect(page.repaired).toEqual([])
  })

  it('marks URLs in the head', () => {
    expect(
      page.urls.map((url) => [url.attr, text(url.range), url.inHead]),
    ).toEqual([
      ['href', '_theme.css', true],
      ['href', 'plan.md', true],
      ['src', 'https://cdn.example.com/chart.js', true],
      ['href', 'notes/q3.html', false],
    ])
  })

  it('reads a leading byte order mark as whitespace', () => {
    const marked = `\uFEFF${source}`
    const read = analyze(marked)
    expect(read.complete).toBe(true)
    expect(slicer(marked)(read.doctype)).toBe('<!DOCTYPE html>')
  })
})

describe('a layout', () => {
  const source = fixture('layout.html')
  const page = analyze(source)
  const text = slicer(source)

  it('finds the first slot in the body', () => {
    expect(page.complete).toBe(true)
    expect(text(page.slot)).toBe('<slot></slot>')
  })

  it('takes the body content between <body> and </body>', () => {
    const content = text(page.body.content) ?? ''
    expect(content.startsWith('\n<header>')).toBe(true)
    expect(content.endsWith('<slot name="second"></slot>\n')).toBe(true)
  })
})

describe('a page that is only a body', () => {
  const source = fixture('body-only.html')
  const page = analyze(source)
  const text = slicer(source)

  it('is not complete and has no written html, head or body', () => {
    expect(page.complete).toBe(false)
    expect(page.doctype).toBeNull()
    expect(page.html.startTag).toBeNull()
    expect(page.head.startTag).toBeNull()
    expect(page.head.content).toBeNull()
    expect(page.head.items).toEqual([])
    expect(page.body.startTag).toBeNull()
  })

  it('takes the whole source as the body content', () => {
    expect(text(page.body.content)).toBe(source)
    expect(page.tags).toEqual(['team-picker'])
    expect(page.title).toBeNull()
  })
})

describe('a page with head elements and body content', () => {
  const source = fixture('head-and-body.html')
  const page = analyze(source)
  const text = slicer(source)

  it('puts the leading head elements in the head', () => {
    expect(page.complete).toBe(false)
    expect(page.head.startTag).toBeNull()
    expect(page.head.content).toBeNull()
    expect(
      page.head.items.map((item) => [item.kind, item.key, text(item.range)]),
    ).toEqual([
      ['title', 'title', '<title>Retro</title>'],
      ['link', null, '<link rel="stylesheet" href="_retro.css">'],
      [
        'meta',
        'name:description',
        '<meta name="description" content="Team retro">',
      ],
    ])
    expect(page.title).toBe('Retro')
  })

  it('starts the body content after the last head element', () => {
    expect(text(page.body.content)).toBe(
      '\n\n<article>\n  <h1>Retro</h1>\n' +
        '  <retro-board columns="3"></retro-board>\n</article>\n',
    )
  })

  it('starts the body content after a written </head>', () => {
    const written = fixture('head-tags-and-body.html')
    const read = analyze(written)
    const cut = slicer(written)
    expect(read.complete).toBe(false)
    expect(cut(read.head.startTag)).toBe('<head>')
    expect(cut(read.head.content)).toBe('\n  <title>Hiring</title>\n')
    expect(cut(read.body.content)).toBe(
      '\n<main>\n  <p>Open roles</p>\n</main>\n',
    )
  })

  it('leaves a written </body> and </html> out of the body content', () => {
    const written = '<title>T</title>\n<p>Hi</p>\n</body>\n</html>\n'
    const read = analyze(written)
    expect(slicer(written)(read.body.content)).toBe('\n<p>Hi</p>\n')
    expect(read.repaired).toEqual([])
  })

  it('ends a complete page without </body> at its </html>', () => {
    const written = '<!doctype html><body><p>Hi</p></html>'
    expect(slicer(written)(analyze(written).body.content)).toBe('<p>Hi</p>')
  })

  it('keeps content written after </body>, which the body still shows', () => {
    const written = '<p>x</p></body>\n<script>go()</script>\n</html>\n'
    const read = analyze(written)
    expect(slicer(written)(read.body.content)).toBe(
      '<p>x</p></body>\n<script>go()</script>',
    )
    expect(read.repaired).toEqual([
      {
        line: 2,
        message: 'the <script> on line 2 after </body> was moved into the body',
      },
    ])
  })
})

describe('Windows line endings', () => {
  const source = crlf(fixture('complete.html'))
  const page = analyze(source)
  const text = slicer(source)

  it('keeps every range on the original text', () => {
    expect(source.includes('\r\n')).toBe(true)
    expect(text(page.doctype)).toBe('<!DOCTYPE html>')
    expect(text(page.html.startTag)).toBe('<html lang="en" class="light">')
    expect(text(page.head.items[4]?.range ?? null)).toBe(
      '<title>  Quarterly plan  </title>',
    )
    expect(text(page.body.content)).toBe(
      '\r\n    <h1>Quarterly plan</h1>\r\n' +
        '    <p>See <a href="notes/q3.html">the notes</a>.</p>\r\n  ',
    )
    expect(page.urls.map((url) => text(url.range))).toEqual([
      '_theme.css',
      'plan.md',
      'https://cdn.example.com/chart.js',
      'notes/q3.html',
    ])
  })

  it('counts lines the same as with LF', () => {
    const forms = crlf(fixture('forms.html'))
    expect(analyze(forms).forms.map((form) => form.line)).toEqual([2, 5, 8, 11])
    const read = analyze(forms)
    expect(slicer(forms)(read.forms[0]?.range ?? null)).toBe(
      '<form action="decisions/" method="POST" id="main">\r\n' +
        '  <input name="choice">\r\n</form>',
    )
  })

  it('keeps a page with head elements exact', () => {
    const fragment = crlf(fixture('head-and-body.html'))
    const read = analyze(fragment)
    expect(slicer(fragment)(read.body.content)).toBe(
      '\r\n\r\n<article>\r\n  <h1>Retro</h1>\r\n' +
        '  <retro-board columns="3"></retro-board>\r\n</article>\r\n',
    )
  })

  it('reports repairs on the right lines', () => {
    const broken = crlf(fixture('repairs.html'))
    expect(analyze(broken).repaired.map((repair) => repair.line)).toEqual(
      analyze(fixture('repairs.html')).repaired.map((repair) => repair.line),
    )
  })
})

describe('Unicode', () => {
  const source = fixture('unicode.html')
  const page = analyze(source)
  const text = slicer(source)

  it('measures ranges in UTF-16 code units, as string slicing does', () => {
    expect(page.title).toBe('خطة الربع 🚀')
    expect(text(page.head.content)).toBe('<title>خطة الربع 🚀</title>')
    expect(text(page.body.content)).toBe(
      '\n<p>مرحبا 😀 بالفريق</p>\n' +
        '<a href="ملاحظات/ربع.html">ملاحظات</a>\n' +
        '<img src="_صور/شعار.png" alt="𝒜">\n',
    )
    expect(page.html.attrs).toEqual([
      { name: 'lang', value: 'ar' },
      { name: 'dir', value: 'rtl' },
    ])
  })

  it('reads Arabic URLs and their `_` folders', () => {
    expect(
      page.urls.map((url) => [text(url.range), url.relative, url.underscore]),
    ).toEqual([
      ['ملاحظات/ربع.html', true, false],
      ['_صور/شعار.png', true, true],
    ])
  })
})

describe('inline SVG', () => {
  const source = fixture('svg.html')
  const page = analyze(source)
  const text = slicer(source)

  it('counts xlink:href and href on SVG elements as links', () => {
    expect(
      page.urls.map((url) => [url.attr, text(url.range), url.underscore]),
    ).toEqual([
      ['href', '_icons.svg#star', true],
      ['href', 'photo.png', false],
    ])
  })

  it('finds custom elements inside foreignObject, and not SVG titles', () => {
    expect(page.tags).toEqual(['data-chip'])
    expect(page.title).toBeNull()
    expect(page.repaired).toEqual([])
  })
})

describe('<template>', () => {
  const source = fixture('template.html')
  const page = analyze(source)
  const text = slicer(source)

  it('reads tags, URLs and forms inside template content', () => {
    expect(page.tags).toEqual(['user-badge'])
    expect(page.urls.map((url) => [url.attr, text(url.range)])).toEqual([
      ['href', '_people/x.html'],
      ['action', 'answers/'],
    ])
    expect(page.forms.map((form) => [form.line, form.action])).toEqual([
      [5, 'answers/'],
    ])
  })

  it('takes the layout slot from outside template content', () => {
    expect(text(page.slot)).toBe('<slot></slot>')
    expect(page.slot?.start).toBe(source.lastIndexOf('<slot></slot>'))
    expect(page.repaired).toEqual([])
  })
})

describe('forms', () => {
  const source = fixture('forms.html')
  const page = analyze(source)
  const text = slicer(source)

  it('summarises each form in order', () => {
    expect(page.forms.map(({ range: _range, ...form }) => form)).toEqual([
      {
        line: 2,
        id: 'main',
        action: 'decisions/',
        method: 'post',
        entries: 'one',
        closes: null,
        closed: false,
      },
      {
        line: 5,
        id: null,
        action: 'votes.json',
        method: 'get',
        entries: 'many',
        closes: '2026-10-20T18:00+03:00',
        closed: false,
      },
      {
        line: 8,
        id: null,
        action: '',
        method: 'get',
        entries: 'one',
        closes: null,
        closed: true,
      },
      {
        line: 11,
        id: null,
        action: null,
        method: 'get',
        entries: 'one',
        closes: null,
        closed: false,
      },
    ])
  })

  it('covers each whole form', () => {
    expect(text(page.forms[3]?.range ?? null)).toBe(
      '<form>\n  <button>No action</button>\n</form>',
    )
  })
})

describe('<base>', () => {
  it('finds a base element anywhere', () => {
    const source = fixture('base.html')
    const page = analyze(source)
    expect(slicer(source)(page.base)).toBe('<base href="https://example.com/">')
    expect(page.head.items[0]?.kind).toBe('base')
  })

  it('finds one in the body too', () => {
    const source = '<p>x</p><base href="/">'
    expect(slicer(source)(analyze(source).base)).toBe('<base href="/">')
  })
})

describe('custom elements', () => {
  it('lists valid custom element names once each, sorted', () => {
    const page = analyze(
      '<x-b></x-b><x-a></x-a><x-b></x-b><font-face></font-face>' +
        '<plain></plain><my-élan></my-élan><svg><font-face></font-face></svg>',
    )
    expect(page.tags).toEqual(['my-élan', 'x-a', 'x-b'])
  })
})

describe('URLs', () => {
  const source = fixture('urls.html')
  const page = analyze(source)
  const text = slicer(source)

  it('reads every href, src, srcset candidate, poster and action', () => {
    expect(
      page.urls.map((url) => [
        url.attr,
        text(url.range),
        url.relative,
        url.underscore,
        url.inHead,
      ]),
    ).toEqual([
      ['href', './_favicon.png', true, true, true],
      ['href', 'https://example.com/', false, false, false],
      ['href', '//cdn.example.com/x.js', false, false, false],
      ['href', '/root.html', false, false, false],
      ['href', '#top', false, false, false],
      ['href', '', false, false, false],
      ['href', 'mailto:sara@acme.com', false, false, false],
      ['href', 'team/_theme.css', true, false, false],
      ['href', '../_kit/a.js', true, true, false],
      ['href', '%5Fescaped.css', true, true, false],
      ['href', '?page=2', true, false, false],
      ['src', 'photo.jpg', true, false, false],
      ['srcset', '_small.jpg', true, true, false],
      ['srcset', 'large.jpg', true, false, false],
      ['srcset', '_x.jpg', true, true, false],
      ['poster', '_poster.png', true, true, false],
      ['src', 'clip.mp4', true, false, false],
      ['action', 'answers/', true, false, false],
      ['src', 'bare.png', true, false, false],
      ['src', 'single.png', true, false, false],
    ])
  })

  it('keeps each value as written', () => {
    for (const url of page.urls) expect(text(url.range)).toBe(url.value)
  })

  it('decodes character references in what is requested, keeping the written value', () => {
    const written =
      '<img src="lo&#103;o.svg" srcset="a&amp;b.png 1x, sm&#97;ll.png 2x"><video poster="p&#x6f;ster.png"></video>'
    const urls = analyze(written).urls
    expect(urls.map((url) => [url.attr, url.value, url.decoded])).toEqual([
      ['src', 'lo&#103;o.svg', 'logo.svg'],
      ['srcset', 'a&amp;b.png', 'a&b.png'],
      ['srcset', 'sm&#97;ll.png', 'small.png'],
      ['poster', 'p&#x6f;ster.png', 'poster.png'],
    ])
    for (const url of urls) {
      expect(written.slice(url.range.start, url.range.end)).toBe(url.value)
    }
  })

  it('reads srcset candidates with commas inside the URL', () => {
    const written =
      '<img srcset="data:image/png;base64,AAA= 1x,  b.png 2x , c.png">'
    const read = analyze(written)
    expect(read.urls.map((url) => slicer(written)(url.range))).toEqual([
      'data:image/png;base64,AAA=',
      'b.png',
      'c.png',
    ])
  })
})

describe('repairs', () => {
  it('reports where the parser changed the structure', () => {
    expect(analyze(fixture('repairs.html')).repaired).toEqual([
      {
        line: 2,
        message:
          'the <span> on line 2 has no end tag where it should, so it was closed early',
      },
      {
        line: 4,
        message: 'an end tag </section> with no open <section> was ignored',
      },
      {
        line: 6,
        message:
          'the <p> on line 6 sat inside a table where it is not allowed, and was moved before the table',
      },
      {
        line: 14,
        message:
          '<div/> does not close itself in HTML, so the <div> stays open until an end tag closes it',
      },
    ])
  })

  it('leaves end tags HTML lets you omit alone', () => {
    expect(analyze(fixture('clean-fragments.html')).repaired).toEqual([])
    expect(analyze(fixture('complete.html')).repaired).toEqual([])
  })

  it('does not report syntax slips that change nothing', () => {
    expect(
      analyze('<p class=a/b>Fish &amp chips</p></p >').repaired.map(
        (repair) => repair.message,
      ),
    ).toEqual(['an end tag </p> with no open <p> became an empty paragraph'])
    expect(analyze('<p>a &nbsp b</p><!-- ok --!>').repaired).toEqual([])
  })

  it('reports ignored and merged tags', () => {
    const messages = (source: string): readonly string[] =>
      analyze(source).repaired.map((repair) => repair.message)
    expect(messages('<form><form></form>')).toEqual([
      'a <form> inside another form was ignored',
    ])
    expect(messages('<p>x</p><body class="late">')).toEqual([
      'a <body> start tag after the body had begun was ignored, and its attributes were added to the body',
    ])
    expect(messages('<p>x</p></br>')).toEqual([
      'an end tag </br> was read as a line break <br>',
    ])
    expect(messages('<div><b><i>x</b></i></div>')).toEqual([
      'the <i> on line 1 has no end tag where it should, so it was closed early',
      'an end tag </i> with no open <i> was ignored',
    ])
  })

  it('reports content the end of the page cut off', () => {
    const messages = (source: string): readonly string[] =>
      analyze(source).repaired.map((repair) => repair.message)
    expect(messages('<div>open')).toEqual([
      'the <div> on line 1 is never closed',
    ])
    expect(messages('<p>x</p>\n<script>let a = 1')).toEqual([
      'the <script> on line 2 is never closed, so the rest of the page became part of it',
    ])
    expect(messages('<p>x</p><!-- note')).toEqual([
      'a comment is never closed, so everything after it was hidden',
    ])
    expect(messages('<p>x</p><img src="a.png"')).toEqual([
      'the page ends inside a tag, so that tag was dropped',
    ])
  })

  it('reports dropped attributes, hidden markup and stray doctypes', () => {
    const messages = (source: string): readonly string[] =>
      analyze(source).repaired.map((repair) => repair.message)
    expect(messages('<p class="a" class="b">x</p>')).toEqual([
      'an attribute written twice on one tag kept only its first value',
    ])
    expect(messages('<?xml version="1.0"?><p>x</p>')).toEqual([
      'markup starting with <? was read as a comment',
    ])
    expect(messages('<p>x</p><!doctype html>')).toEqual([
      'a doctype after the start of the page was ignored',
    ])
    expect(
      messages('<head><title>T</title></head>\n<meta name="a">\n<p>x</p>'),
    ).toEqual(['a <meta> after </head> was moved into the head'])
  })
})

describe('a head whose </head> was never written', () => {
  const source = fixture('head-unclosed-title.html')
  const page = analyze(source)
  const text = slicer(source)

  it('ends its content after its last element, not inside it', () => {
    expect(text(page.head.content)).toBe(
      '\n<link rel="stylesheet" href="_theme.css">\n<title>Draft</title>',
    )
    expect(page.head.content!.end).toBeLessThanOrEqual(page.body.content.start)
    expect(text(page.body.content)).toBe('\nDraft notes\n')
    expect(page.title).toBe('Draft')
  })
})

describe('the slot of a layout', () => {
  it('skips a named slot and takes the first one without a name', () => {
    const source =
      '<header><slot name="nav"></slot></header><main><slot>Fallback</slot></main>'
    const page = analyze(source)
    expect(slicer(source)(page.slot)).toBe('<slot>Fallback</slot>')
  })

  it('has none when every slot has a name', () => {
    expect(analyze('<main><slot name="a"></slot></main>').slot).toBeNull()
  })
})

describe('the companion a page names', () => {
  const alternateOf = (links: string) =>
    analyze(`<!doctype html><html><head>${links}</head><body></body></html>`)
      .alternate

  it('is the first <link rel="alternate"> with a companion type, or none', () => {
    expect(alternateOf('<link rel="alternate" href="glossary.json">')).toBe(
      'glossary.json',
    )
    expect(
      alternateOf(
        '<link rel="alternate" type="application/json" href="data/terms.json">',
      ),
    ).toBe('data/terms.json')
    expect(
      alternateOf(
        '<link rel="alternate" type="text/markdown; charset=utf-8" href="plan.md">',
      ),
    ).toBe('plan.md')
    expect(
      alternateOf('<link rel="alternate" type="text/plain" href="plan.txt">'),
    ).toBe('plan.txt')
  })

  it('ignores translations, media variants, feeds and other sites', () => {
    expect(
      alternateOf(
        [
          '<link rel="alternate" hreflang="ar" href="ar/plan.md">',
          '<link rel="alternate" media="print" href="print.md">',
          '<link rel="alternate" type="application/rss+xml" href="feed.xml">',
          '<link rel="alternate" type="application/atom+xml" href="atom.xml">',
          '<link rel="alternate" href="https://example.com/plan.md">',
          '<link rel="alternate" href="/plan.md">',
          '<link rel="alternate" href="">',
          '<link rel="alternate stylesheet" type="text/css" href="dark.css">',
        ].join(''),
      ),
    ).toBeNull()
    expect(
      alternateOf(
        '<link rel="alternate" type="application/rss+xml" href="feed.xml"><link rel="alternate" href="plan.json">',
      ),
    ).toBe('plan.json')
  })

  it('is read only from the head', () => {
    expect(
      analyze(
        '<!doctype html><html><head></head><body><link rel="alternate" href="x.md"></body></html>',
      ).alternate,
    ).toBeNull()
  })
})

describe('the base libraries a page uses', () => {
  it('finds Mermaid, highlighted code and math, and the languages of the code', () => {
    const page = analyze(fixture('libraries/page.html'))
    expect(page.libraries).toEqual(['katex', 'mermaid', 'shiki'])
    // Lower-cased and once each; code outside a <pre> and code inside a
    // <template> are not highlighted, so their languages do not count.
    expect(page.codeLanguages).toEqual(['py', 'typescript'])
  })

  it('counts .math only with inline or display, and nothing inside a <template>', () => {
    const page = analyze(fixture('libraries/plain.html'))
    expect(page.libraries).toEqual([])
    expect(page.codeLanguages).toEqual([])
  })

  it('finds them in a layout as in a page', () => {
    const layout = analyze(fixture('libraries/_layout.html'))
    expect(layout.libraries).toEqual(['katex', 'shiki'])
    expect(layout.codeLanguages).toEqual(['sh'])
  })

  it('lists a library once however often its markup appears', () => {
    const page = analyze(fixture('libraries/diagram.html'))
    expect(page.libraries).toEqual(['mermaid'])
    expect(page.codeLanguages).toEqual([])
  })

  it('reads .math.inline and .math.display in any order of the class names', () => {
    expect(analyze('<i class="inline math">x</i>').libraries).toEqual(['katex'])
    expect(analyze('<b class=" display  math ">x</b>').libraries).toEqual([
      'katex',
    ])
    expect(analyze('<b class="math-display">x</b>').libraries).toEqual([])
  })
})
