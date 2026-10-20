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
    const [, ...rest] = defaultPrivacyText('dossier.test', ['google']).split(
      '\n',
    )
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

  it('names each sign-in provider turned on and what Dossier keeps from it', () => {
    const google = defaultPrivacyText('dossier.test', ['google'])
    expect(google).toContain("your Google account's identifier")
    expect(google).toContain('Google handles sign-in.')
    expect(google).not.toContain('Microsoft')

    const microsoft = defaultPrivacyText('dossier.test', ['microsoft'])
    expect(microsoft).toContain("your Microsoft account's identifier")
    expect(microsoft).toContain('a 48×48 copy of your profile photo')
    expect(microsoft).toContain('Microsoft handles sign-in.')
    expect(microsoft).not.toContain('Google')

    const both = defaultPrivacyText('dossier.test', ['google', 'microsoft'])
    expect(both.indexOf('Your Google sign-in')).toBeLessThan(
      both.indexOf('Your Microsoft sign-in'),
    )
    expect(both).toContain('Google and Microsoft handle sign-in.')

    const none = defaultPrivacyText('dossier.test', [])
    expect(none).not.toMatch(/Google|Microsoft|handles? sign-in/)
    expect(none).toContain('- Your email: it is how Dossier knows you.')
  })
})
