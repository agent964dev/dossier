import { describe, expect, it } from 'vitest'

import { defaultPrivacyText } from '../src/core/privacy.ts'
import { blocksOf } from '../src/lib/privacy-text.ts'

describe('the privacy page’s layout of plain text', () => {
  it('reads short lines as headings, "- " lines as lists, the rest as paragraphs', () => {
    expect(
      blocksOf(
        'What we keep\n\n- one\n- two\n\nA paragraph.\nIts second line.\n\nNot a heading:\n\n<b>Kept as text</b>',
      ),
    ).toEqual([
      { kind: 'heading', text: 'What we keep' },
      { kind: 'list', items: ['one', 'two'] },
      { kind: 'text', text: 'A paragraph.\nIts second line.' },
      { kind: 'text', text: 'Not a heading:' },
      { kind: 'heading', text: '<b>Kept as text</b>' },
    ])
  })

  it('gives the generated text its sections as headings', () => {
    const [, ...rest] = defaultPrivacyText('dossier.test').split('\n')
    const headings = blocksOf(rest.join('\n'))
      .filter((block) => block.kind === 'heading')
      .map((block) => (block.kind === 'heading' ? block.text : ''))
    expect(headings).toEqual([
      'What Dossier keeps',
      'Cookies',
      'No trackers',
      'Who sees what',
      'How long it is kept',
      'Where it is kept',
      'Questions',
    ])
  })
})
