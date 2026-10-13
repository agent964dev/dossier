import { describe, expect, it } from 'vitest'
import {
  isComponentFile,
  isCustomElementName,
  isRewritable,
  relativeFrom,
  resolveFrom,
  rewriteLayoutUrl,
  tagOf,
} from '../src/index.ts'

describe('isRewritable', () => {
  it('takes relative URLs that do not lead into a `_` name', () => {
    for (const url of [
      'logo.svg',
      './',
      '../a/b.png',
      'feedback/',
      ' x.html ',
    ]) {
      expect(isRewritable(url), url).toBe(true)
    }
  })

  it('leaves `_`, absolute, root-relative, query-only and fragment-only URLs', () => {
    for (const url of [
      '_theme.css',
      './_components/a-b.js',
      '../_logo.svg',
      'https://example.com/a',
      '//cdn.example.com/a.js',
      '/x',
      '#top',
      '?q=1',
      'mailto:a@example.com',
      'data:image/png;base64,AAAA',
      '',
    ]) {
      expect(isRewritable(url), url).toBe(false)
    }
  })
})

describe('resolveFrom and relativeFrom', () => {
  it('resolve a URL to the tree path it names, or null above the root', () => {
    expect(resolveFrom('guides/setup', 'install.md')).toBe(
      'guides/setup/install.md',
    )
    expect(resolveFrom('guides/setup', '../_theme.css')).toBe(
      'guides/_theme.css',
    )
    expect(resolveFrom('guides', './')).toBe('guides/')
    expect(resolveFrom('guides', '..')).toBe('')
    expect(resolveFrom('', 'a%20b/c.png?x#y')).toBe('a b/c.png')
    expect(resolveFrom('guides', '../../x.png')).toBeNull()
  })

  it('write the relative URL from a folder to a tree path', () => {
    expect(relativeFrom('guides/setup', 'logo.svg')).toBe('../../logo.svg')
    expect(relativeFrom('guides/setup', '')).toBe('../../')
    expect(
      relativeFrom('guides/setup', 'guides/_components/acme-card.js'),
    ).toBe('../_components/acme-card.js')
    expect(relativeFrom('', '_components/acme-card.js')).toBe(
      '_components/acme-card.js',
    )
    expect(relativeFrom('a', 'a/')).toBe('./')
    expect(relativeFrom('', 'a b/c.js')).toBe('a%20b/c.js')
  })
})

describe('rewriteLayoutUrl', () => {
  // A layout at the root, a page at guides/setup/install.html.
  const rewrite = (
    value: string,
    attr: Parameters<typeof rewriteLayoutUrl>[1] = 'href',
  ) => rewriteLayoutUrl(value, attr, '', 'guides/setup')

  it('reads the layout’s URLs from its own folder', () => {
    expect(rewrite('logo.svg', 'src')).toBe('../../logo.svg')
    expect(rewrite('./')).toBe('../../')
    expect(rewrite('feedback/', 'action')).toBe('../../feedback/')
    expect(rewrite('poster.jpg', 'poster')).toBe('../../poster.jpg')
    expect(rewrite('guides/setup/other.html')).toBe('other.html')
    expect(rewrite('guides/')).toBe('../')
  })

  it('rewrites each srcset candidate and keeps its descriptor', () => {
    expect(rewrite('a.png 1x, b.png 2x', 'srcset')).toBe(
      '../../a.png 1x, ../../b.png 2x',
    )
    expect(
      rewrite('a.png 480w,https://cdn.example.com/b.png 2x', 'srcset'),
    ).toBe('../../a.png 480w,https://cdn.example.com/b.png 2x')
  })

  it('keeps the query and fragment', () => {
    expect(rewrite('notes.html?tab=1#top')).toBe('../../notes.html?tab=1#top')
  })

  it('leaves what it may not rewrite unchanged', () => {
    for (const url of [
      '_theme.css',
      'https://example.com/',
      '//cdn.example.com/a.js',
      '/x',
      '#top',
      '?q=1',
      'mailto:a@example.com',
      'data:image/png;base64,AAAA',
    ]) {
      expect(rewrite(url), url).toBe(url)
    }
    // It would leave the tree root.
    expect(rewriteLayoutUrl('../up.png', 'src', 'a', 'b/c')).toBe(
      '../../up.png',
    )
    expect(rewriteLayoutUrl('../../up.png', 'src', 'a', 'b/c')).toBe(
      '../../up.png',
    )
  })

  it('changes nothing between a layout and a page in one folder', () => {
    expect(rewriteLayoutUrl('./logo.svg', 'src', 'a', 'a')).toBe('./logo.svg')
  })
})

describe('the kit’s names', () => {
  it('follow the HTML rule for custom element names', () => {
    expect(isCustomElementName('acme-card')).toBe(true)
    expect(isCustomElementName('acme')).toBe(false)
    expect(isCustomElementName('Acme-card')).toBe(false)
    expect(isCustomElementName('font-face')).toBe(false)
    expect(isCustomElementName('annotation-xml')).toBe(false)
  })

  it('read the tag a component file defines', () => {
    expect(tagOf('_components/acme-card.js')).toBe('acme-card')
    expect(tagOf('guides/_components/acme-card.js')).toBe('acme-card')
    expect(tagOf('guides/_components/shared.js')).toBeNull()
    expect(tagOf('guides/_components/sub/acme-card.js')).toBeNull()
    expect(tagOf('_old/_components/acme-card.js')).toBeNull()
    expect(tagOf('_components/acme-card.md')).toBeNull()
    expect(isComponentFile('_components/acme-card.js')).toBe(true)
    expect(isComponentFile('components/acme-card.js')).toBe(false)
  })
})
