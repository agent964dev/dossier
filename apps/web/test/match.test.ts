import { describe, expect, it } from 'vitest'

import { matching } from '../src/hub/match.ts'

describe('matching', () => {
  const subs = [
    [0, 'questions/answers/'],
    [1, 'board.json'],
    [2, ''],
    [3, 'plan.comments/'],
    [4, 'questions/answers/'],
  ] as const

  it('matches a file below a watched folder, and the folder itself', () => {
    expect(matching(subs, ['questions/answers/sara@acme.com.json'])).toEqual([
      0, 2, 4,
    ])
    expect(matching(subs, ['questions/answers'])).toEqual([0, 2, 4])
  })

  it('matches a watched file only by its own path, never by a longer name', () => {
    expect(matching(subs, ['board.json'])).toEqual([1, 2])
    expect(matching(subs, ['board.json.files/sara/x.pdf'])).toEqual([2])
    expect(matching(subs, ['board'])).toEqual([2])
  })

  it('matches a change above a watched path: a push of a folder above it, or of the root', () => {
    expect(matching(subs, ['questions'])).toEqual([0, 2, 4])
    expect(matching(subs, [''])).toEqual([0, 1, 2, 3, 4])
  })

  it('lets the root watch everything, and names each subscription once', () => {
    expect(
      matching(
        [
          [7, ''],
          [7, 'x/'],
        ],
        ['a/b.json', 'x/y.json'],
      ),
    ).toEqual([7])
    expect(matching(subs, ['elsewhere/z.json'])).toEqual([2])
  })
})
