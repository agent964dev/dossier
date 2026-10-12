import { describe, expect, it } from 'vitest'
import { analyze, type MoveRewrite, rewriteForMove } from '../src/index.ts'
import { fixture } from './helpers.ts'

type Kind = 'page' | 'file' | 'folder' | 'data'

/** The tree before every move here. */
const TREE: Readonly<Record<string, Kind>> = {
  'index.html': 'page',
  'plan.html': 'page',
  'notes.html': 'page',
  about: 'folder',
  'about/index.html': 'page',
  img: 'folder',
  'img/logo.png': 'file',
  'img/logo@2x.png': 'file',
  'img/logo@3x.png': 'file',
  answers: 'folder',
  'answers/ada.json': 'data',
  archive: 'folder',
  docs: 'folder',
  'docs/index.html': 'page',
  'docs/guide.html': 'page',
  'docs/guide.md': 'file',
  'docs/my file.html': 'page',
  'docs/img': 'folder',
  'docs/img/diagram.png': 'file',
  'docs/img/diagram@2x.png': 'file',
  'docs/media': 'folder',
  'docs/media/clip.mp4': 'file',
  'docs/media/poster.jpg': 'file',
  'docs/answers': 'folder',
  team: 'folder',
  'team/index.html': 'page',
  'team/plan.html': 'page',
  'team/roster.html': 'page',
  'team/photos': 'folder',
  'team/photos/a.jpg': 'file',
  'team/photos/a@2x.jpg': 'file',
  'team/q3': 'folder',
  'team/answers.json': 'data',
  'team/_x.png': 'file',
  '_theme.css': 'file',
  _kit: 'folder',
  '_kit/note.js': 'file',
}

const kindAt = (path: string): Kind | null => TREE[path] ?? null

/** The file at `before` (`after` once moved) when `from` moves to `to`. */
const moving = (
  file: string | readonly [before: string, after: string],
  from: string,
  to: string,
): MoveRewrite => {
  const [filePathBefore, filePathAfter] =
    typeof file === 'string' ? [file, file] : file
  return { filePathBefore, filePathAfter, from, to, kindAt }
}

const rewrite = (source: string, move: MoveRewrite): string | null =>
  rewriteForMove(source, analyze(source), move)

/** A page with each URL attribute's value blanked, so the rest compares. */
const withoutUrls = (source: string): string => {
  let out = ''
  let pos = 0
  for (const { range } of analyze(source).urls) {
    out += `${source.slice(pos, range.start)}\u0000`
    pos = range.end
  }
  return out + source.slice(pos)
}

/** What a path names in the tree once `move` is made. */
const afterMove =
  (move: MoveRewrite) =>
  (path: string): Kind | null => {
    const under = (node: string): boolean =>
      path === node || path.startsWith(`${node}/`)
    if (under(move.to)) return kindAt(move.from + path.slice(move.to.length))
    return under(move.from) ? null : kindAt(path)
  }

const goldens: readonly {
  readonly name: string
  readonly says: string
  readonly move: MoveRewrite
}[] = [
  {
    name: 'folder-from-outside',
    says: 'a page outside a moved folder follows every URL into it',
    move: moving('index.html', 'docs', 'archive/docs'),
  },
  {
    name: 'folder-from-inside',
    says: 'a page inside a moved folder follows every URL out of it',
    move: moving(
      ['docs/guide.html', 'archive/docs/guide.html'],
      'docs',
      'archive/docs',
    ),
  },
  {
    name: 'page-into-subfolder',
    says: 'a page moved into a subfolder rewrites its own relative URLs',
    move: moving(
      ['team/plan.html', 'team/q3/plan.html'],
      'team/plan.html',
      'team/q3/plan.html',
    ),
  },
  {
    name: 'page-linked-from-outside',
    says: 'a page outside follows a moved page in the form it was linked',
    move: moving('index.html', 'team/plan.html', 'team/q3/plan.html'),
  },
]

describe('rewriteForMove goldens', () => {
  for (const { name, says, move } of goldens) {
    it(`${says} (${name})`, () => {
      const input = fixture(`move/${name}.html`)
      const expected = fixture(`move/${name}.expected.html`)
      const output = rewrite(input, move)
      expect(output).toBe(expected)
      // Only the URL ranges changed.
      expect(withoutUrls(output ?? '')).toBe(withoutUrls(input))
      // Moving it back writes the URLs back as they were.
      const back = rewrite(expected, {
        filePathBefore: move.filePathAfter,
        filePathAfter: move.filePathBefore,
        from: move.to,
        to: move.from,
        kindAt: afterMove(move),
      })
      expect(back).toBe(input)
    })
  }

  it('returns null for a page outside a moved folder that does not link into it', () => {
    const move = moving('notes.html', 'docs', 'archive/docs')
    expect(rewrite(fixture('move/unrelated.html'), move)).toBeNull()
  })

  it('returns null for a page inside a moved folder whose URLs stay inside it', () => {
    const move = moving(
      ['docs/index.html', 'archive/docs/index.html'],
      'docs',
      'archive/docs',
    )
    expect(rewrite(fixture('move/inside-only.html'), move)).toBeNull()
  })
})

describe('rewriteForMove', () => {
  const outside = moving('index.html', 'docs', 'archive/docs')
  const ownPage = moving(
    ['plan.html', 'plans/plan.html'],
    'plan.html',
    'plans/plan.html',
  )

  it('returns null for a page without URLs', () => {
    expect(rewrite('<p>docs/guide</p>', outside)).toBeNull()
  })

  it('leaves `_` URLs to lookup', () => {
    const source =
      '<link rel=stylesheet href="_theme.css"><script src="./_kit/note.js"></script>' +
      '<img src="../_logo.svg" alt="">'
    expect(rewrite(source, ownPage)).toBeNull()
  })

  it('leaves absolute, root-relative, query-only and fragment-only URLs', () => {
    const source = [
      'https://example.com/docs/a',
      '//cdn.example.com/docs/a',
      '/docs/guide',
      'mailto:a@example.com',
      'data:text/plain,docs/a',
      '#docs',
      '?docs=1',
    ]
      .map((url) => `<a href="${url}">x</a>`)
      .join('')
    expect(rewrite(source, outside)).toBeNull()
    expect(rewrite(source, ownPage)).toBeNull()
  })

  it('writes a page moved into a folder from its extensionless link', () => {
    expect(
      rewrite(
        '<a href="plan">Plan</a>',
        moving('index.html', 'plan.html', 'plans/plan.html'),
      ),
    ).toBe('<a href="plans/plan">Plan</a>')
  })

  it('writes a renamed page by its new extensionless link', () => {
    expect(
      rewrite(
        '<a href="plan#goals">Plan</a>',
        moving('index.html', 'plan.html', 'plans/overview.html'),
      ),
    ).toBe('<a href="plans/overview#goals">Plan</a>')
  })

  it('follows a moved index page from its folder link', () => {
    const move = moving('index.html', 'about/index.html', 'info/index.html')
    expect(rewrite('<a href="about/">About</a>', move)).toBe(
      '<a href="info/">About</a>',
    )
  })

  it('keeps a page link that still reads the same from the new folder', () => {
    expect(rewrite('<a href="plan.html#top">Top</a>', ownPage)).toBeNull()
  })

  it('names a URL to a node missing from the tree by its path', () => {
    expect(rewrite('<img src="docs/later.png" alt="">', outside)).toBe(
      '<img src="archive/docs/later.png" alt="">',
    )
    expect(rewrite('<img src="later.png" alt="">', ownPage)).toBe(
      '<img src="../later.png" alt="">',
    )
  })

  it('keeps the spelling of the steps below the moved node', () => {
    expect(rewrite('<img src="docs/img/dia%67ram.png" alt="">', outside)).toBe(
      '<img src="archive/docs/img/dia%67ram.png" alt="">',
    )
  })

  it('writes the moved node’s new names percent-encoded', () => {
    const move = moving('index.html', 'docs', 'old docs/2026')
    expect(rewrite('<a href="docs/guide">Guide</a>', move)).toBe(
      '<a href="old%20docs/2026/guide">Guide</a>',
    )
  })

  it('reads a character reference in the path and writes it back as one', () => {
    expect(rewrite('<a href="docs/a&amp;b.html">A and B</a>', outside)).toBe(
      '<a href="archive/docs/a&amp;b.html">A and B</a>',
    )
  })

  it('keeps a query and fragment written with character references as written', () => {
    expect(
      rewrite('<a href="docs/guide?a=1&amp;b=2&#38;c=3#x">x</a>', outside),
    ).toBe('<a href="archive/docs/guide?a=1&amp;b=2&#38;c=3#x">x</a>')
  })

  it('keeps the whitespace around a URL as written', () => {
    expect(rewrite('<a href="  docs/guide\n">x</a>', outside)).toBe(
      '<a href="  archive/docs/guide\n">x</a>',
    )
  })

  it('reads a backslash as a slash', () => {
    expect(rewrite('<a href="docs\\guide">x</a>', outside)).toBe(
      '<a href="archive/docs/guide">x</a>',
    )
  })

  it('rewrites each candidate of a srcset and keeps its descriptor', () => {
    const source =
      '<img srcset="docs/img/diagram.png 1x,\n  docs/img/diagram@2x.png 2x, img/logo@3x.png 3x" alt="">'
    expect(rewrite(source, outside)).toBe(
      '<img srcset="archive/docs/img/diagram.png 1x,\n  archive/docs/img/diagram@2x.png 2x, img/logo@3x.png 3x" alt="">',
    )
  })

  it('rewrites a srcset whose separators are character references', () => {
    const source =
      '<img srcset="docs/img/diagram.png&#32;1x&#44; img/logo@2x.png 2x" alt="">'
    expect(rewrite(source, outside)).toBe(
      '<img srcset="archive/docs/img/diagram.png 1x, img/logo@2x.png 2x" alt="">',
    )
  })

  it('writes the rewritten part of an unquoted value with its escapes', () => {
    const move = moving('index.html', 'docs', "it's docs")
    expect(rewrite('<a href=docs/guide>x</a>', move)).toBe(
      '<a href=it&#39;s%20docs/guide>x</a>',
    )
  })

  it('rewrites a form action and a video poster', () => {
    const source =
      '<form action="answers/" method="post"></form><video poster="img/logo.png"></video>'
    expect(rewrite(source, ownPage)).toBe(
      '<form action="../answers/" method="post"></form><video poster="../img/logo.png"></video>',
    )
  })

  it('rewrites URLs inside a template', () => {
    expect(
      rewrite('<template><img src="docs/img/diagram.png"></template>', outside),
    ).toBe('<template><img src="archive/docs/img/diagram.png"></template>')
  })

  it('keeps a written path from starting with a `_` name, which lookup would read', () => {
    const move = moving(
      ['a/b/p.html', 'team/p.html'],
      'a/b/p.html',
      'team/p.html',
    )
    expect(rewrite('<img src="../../team/_x.png" alt="">', move)).toBe(
      '<img src="../team/_x.png" alt="">',
    )
  })

  it('keeps a written path from reading as a scheme', () => {
    const move = moving(['x.html', 'sub/x.html'], 'x.html', 'sub/x.html')
    expect(rewrite('<a href="./sub/a:b.html">x</a>', move)).toBe(
      '<a href="./a:b.html">x</a>',
    )
  })

  it('leaves a URL that climbs above the tree', () => {
    expect(rewrite('<a href="../../x">x</a>', ownPage)).toBeNull()
  })
})
