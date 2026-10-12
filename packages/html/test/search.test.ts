import { describe, expect, it } from 'vitest'
import {
  normalizeSearchText,
  SEARCH_TEXT_MAX_BYTES,
  searchEntries,
  searchNameOf,
  searchText,
  type TreeView,
} from '../src/index.ts'
import { fixture } from './helpers.ts'

const golden = (name: string) =>
  JSON.parse(fixture(`search/${name}.json`)) as unknown

describe('search text', () => {
  it.each(['arabic', 'accented', 'hidden', 'body-only'])(
    'keeps what a reader of %s.html sees, as the golden file holds it',
    (name) => {
      expect(searchText(fixture(`search/${name}.html`), 'html')).toEqual(
        golden(name),
      )
    },
  )

  it('keeps body text, alt text and the titles of drawings, and drops script, style and template content', () => {
    const { title, body } = searchText(fixture('search/hidden.html'), 'html')
    expect(title).toBe('Delivery plan')
    expect(body).toContain('Erbil and Basra start on 3 November.')
    expect(body).toContain('Map of the Erbil depot')
    expect(body).toContain('Route diagram')
    expect(body).toContain('Trucks from Basra to Erbil')
    for (const hidden of [
      'secretInScript',
      'scripted words',
      'styled words',
      'templated words',
      'noscripted words',
      'fill: red',
      'color: red',
    ]) {
      expect(body).not.toContain(hidden)
    }
  })

  it('keeps markup written as text as its characters', () => {
    expect(searchText(fixture('search/hidden.html'), 'html').body).toContain(
      'Literal <b>budget</b> text.',
    )
  })

  it('keeps a word split by inline markup whole, and puts a space between blocks', () => {
    const { body } = searchText(fixture('search/accented.html'), 'html')
    expect(body).toContain('Naïve budget, déjà vu.')
    expect(searchText('<p>one</p><p>two</p>', 'html').body).toBe('one two')
  })

  it('has no title when the page has none, or an empty one', () => {
    expect(searchText('<p>Body</p>', 'html').title).toBeNull()
    expect(searchText('<title>  </title><p>Body</p>', 'html')).toEqual({
      title: null,
      titleSearch: null,
      body: 'Body',
    })
  })

  it('takes a text file whole, without a title', () => {
    expect(
      searchText('# Plan\n\nThe  Erbil   depot\nopens.\n', 'text'),
    ).toEqual({
      title: null,
      titleSearch: null,
      body: '# Plan The Erbil depot opens.',
    })
  })

  it('caps the body at 256 KiB of UTF-8 without cutting a character', () => {
    const arabic = 'ب'.repeat(200_000)
    const { body } = searchText(arabic, 'text')
    const bytes = new TextEncoder().encode(body).byteLength
    expect(SEARCH_TEXT_MAX_BYTES).toBe(262_144)
    expect(bytes).toBe(SEARCH_TEXT_MAX_BYTES)
    expect(body).toBe('ب'.repeat(131_072))
    // A three-byte character that would pass the cap is left out whole.
    const cut = searchText(`a${'€'.repeat(100_000)}`, 'text').body
    expect(cut).toBe(`a${'€'.repeat(87_381)}`)
    const html = searchText(`<p>${'word '.repeat(80_000)}</p>`, 'html')
    expect(new TextEncoder().encode(html.body).byteLength).toBe(
      SEARCH_TEXT_MAX_BYTES,
    )
  })
})

describe('normalizing search text', () => {
  it('removes Arabic marks and the tatweel and folds alef forms', () => {
    expect(normalizeSearchText('مَرْحَبًا')).toBe('مرحبا')
    expect(normalizeSearchText('أربيل')).toBe('اربيل')
    expect(normalizeSearchText('إربيل')).toBe('اربيل')
    expect(normalizeSearchText('آخر')).toBe('اخر')
    expect(normalizeSearchText('ٱلخميس')).toBe('الخميس')
    expect(normalizeSearchText('كـــتـــاب')).toBe('كتاب')
  })

  it('composes decomposed letters first, so a hamza written apart folds too', () => {
    expect(normalizeSearchText('\u0627\u0654ربيل')).toBe('اربيل')
  })

  it('leaves Latin accents to the tokenizer', () => {
    expect(normalizeSearchText('Café')).toBe('Café')
    expect(normalizeSearchText('Cafe\u0301')).toBe('Café')
  })

  it('leaves out NUL and the other control characters', () => {
    expect(normalizeSearchText('erbil\u0000')).toBe('erbil')
    expect(normalizeSearchText('a\u0007b\u001fc\u007f')).toBe('abc')
  })

  it('folds a name as search compares names: without marks or accents, in lower case', () => {
    expect(searchNameOf('مُسْتَوْدَعُ أَرْبِيل')).toBe('مستودع اربيل')
    expect(searchNameOf('Café-Menu.PDF')).toBe('cafe-menu.pdf')
    expect(searchNameOf('Cafe\u0301')).toBe('cafe')
  })

  it('makes each run of white space one space', () => {
    expect(normalizeSearchText('a \n\t\u00a0 b')).toBe('a b')
  })
})

describe('search entries', () => {
  const kinds: Record<string, ReturnType<TreeView['kindAt']>> = {
    'plan.html': 'page',
    'plan.md': 'file',
    'glossary.html': 'page',
    'glossary.json': 'file',
    'docs/intro.html': 'page',
    'docs/intro.md': 'file',
    '_layout.html': 'file',
    'guide/_kit/page.html': 'file',
    'answers.html': 'page',
    'form.html': 'page',
    'answers/sara.json': 'data',
  }
  const kindAt: TreeView['kindAt'] = (path) => kinds[path] ?? null
  const pages = [
    { path: 'plan.html', alternate: null },
    { path: 'glossary.html', alternate: 'glossary.json' },
    { path: 'docs/intro.html', alternate: null },
    { path: '_layout.html', alternate: null },
    { path: 'guide/_kit/page.html', alternate: null },
    { path: 'form.html', alternate: 'answers/sara.json' },
  ]

  it('indexes a page whose companion alone changed, with that companion', () => {
    expect(
      searchEntries({ changed: ['plan.md'], removed: [], pages, kindAt }),
    ).toEqual([
      {
        path: 'plan.html',
        pathSearch: 'plan',
        fallbackTitle: 'plan.html',
        fallbackTitleSearch: 'plan.html',
        companion: 'plan.md',
      },
    ])
    expect(
      searchEntries({ changed: ['glossary.json'], removed: [], pages, kindAt }),
    ).toEqual([
      expect.objectContaining({
        path: 'glossary.html',
        companion: 'glossary.json',
      }),
    ])
  })

  it('indexes a page again without the companion it lost', () => {
    const after: typeof kinds = { ...kinds, 'plan.md': null }
    expect(
      searchEntries({
        changed: [],
        removed: ['plan.md'],
        pages,
        kindAt: (path) => after[path] ?? null,
      }),
    ).toEqual([expect.objectContaining({ path: 'plan.html', companion: null })])
  })

  it('drops a deleted page and indexes one moved in under its new path', () => {
    expect(
      searchEntries({
        changed: ['docs/intro.html', 'docs/intro.md'],
        removed: ['intro.html', 'intro.md'],
        pages,
        kindAt,
      }),
    ).toEqual([
      expect.objectContaining({
        path: 'docs/intro.html',
        pathSearch: 'docs/intro',
        companion: 'docs/intro.md',
      }),
      { path: 'intro.html', drop: true },
    ])
  })

  it('never indexes `_` paths, and never takes people’s data as a companion', () => {
    expect(
      searchEntries({
        changed: ['_layout.html', 'guide/_kit/page.html'],
        removed: ['_old.html', 'guide/_kit/old.html'],
        pages,
        kindAt,
      }),
    ).toEqual([])
    // The answers its alternate link names are not its companion.
    expect(
      searchEntries({ changed: ['form.html'], removed: [], pages, kindAt }),
    ).toEqual([expect.objectContaining({ path: 'form.html', companion: null })])
    expect(
      searchEntries({
        changed: ['answers/sara.json'],
        removed: [],
        pages,
        kindAt,
      }),
    ).toEqual([expect.objectContaining({ path: 'form.html', companion: null })])
  })

  it('leaves pages the change did not reach alone', () => {
    expect(
      searchEntries({ changed: ['style.css'], removed: [], pages, kindAt }),
    ).toEqual([])
  })
})
