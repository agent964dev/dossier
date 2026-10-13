import { describe, expect, it } from 'vitest'
import { analyze, previewOf } from '../src/index.ts'
import { fixture } from './helpers.ts'

const read = (name: string) => {
  const source = fixture(`preview/${name}`)
  return { source, analysis: analyze(source) }
}

describe('a page’s preview', () => {
  const root = read('_layout.html')
  const guide = read('guide/_layout.html')

  it('takes each field from the innermost source with one, falling back to Open Graph and Twitter tags', () => {
    expect(previewOf(read('guide/setup/index.html'), [guide, root])).toEqual({
      title: 'Setting up & signing in',
      description: 'How we work, step by step.',
      image: 'guide-card.png',
    })
  })

  it('prefers the title and description tags, and takes the last of a tag written twice', () => {
    expect(previewOf(read('guide/setup/titled.html'), [guide, root])).toEqual({
      title: 'Setting up your laptop',
      description: 'Tools & accounts, in order.',
      image: 'laptop.png',
    })
  })

  it('reads the outermost layout when nothing closer has a value', () => {
    expect(previewOf(read('guide/setup/index.html'), [root])).toEqual({
      title: 'Setting up & signing in',
      description: 'Everything about working at Acme.',
      image: '/_images/acme.png',
    })
    const bare = '<p>No head at all</p>'
    expect(
      previewOf({ source: bare, analysis: analyze(bare) }, [guide, root]),
    ).toEqual({
      title: 'Acme handbook',
      description: 'How we work, step by step.',
      image: 'guide-card.png',
    })
  })

  it('treats an empty value as none', () => {
    const empty =
      '<title> </title><meta name="description" content=""><p>Empty</p>'
    expect(
      previewOf({ source: empty, analysis: analyze(empty) }, [root]),
    ).toEqual({
      title: 'Acme handbook',
      description: 'Everything about working at Acme.',
      image: '/_images/acme.png',
    })
    expect(previewOf({ source: empty, analysis: analyze(empty) }, [])).toEqual({
      title: null,
      description: null,
      image: null,
    })
  })
})
