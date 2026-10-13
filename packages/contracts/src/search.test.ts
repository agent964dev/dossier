import { describe, expect, it } from 'vitest'

import * as bridge from './bridge.ts'
import { parseSearchInput } from './search.ts'

describe('a search field’s text', () => {
  it.each([
    ['in budget', { mode: 'content', query: 'budget' }],
    ['in', { mode: 'titles', query: 'in' }],
    ['in  ', { mode: 'content', query: '' }],
    ['in ', { mode: 'content', query: '' }],
    ['inbox', { mode: 'titles', query: 'inbox' }],
    ['in  two words ', { mode: 'content', query: 'two words' }],
    [' budget ', { mode: 'titles', query: 'budget' }],
    ['   in budget', { mode: 'content', query: 'budget' }],
    ['budget in plans', { mode: 'titles', query: 'budget in plans' }],
    ['', { mode: 'titles', query: '' }],
  ] as const)('"%s" asks for %o', (text, expected) => {
    expect(parseSearchInput(text)).toEqual(expected)
  })

  it('is what the bridge gives screens', () => {
    expect(bridge.parseSearchInput).toBe(parseSearchInput)
    expect(bridge.CONTENT_PREFIX).toBe('in ')
  })
})
