import { describe, expect, it } from 'vitest'

import { decide, hasMarkers, mergeText, textOf, theirsPath } from './merge.ts'

describe('decide', () => {
  it.each([
    // base, ours, theirs → step
    ['a', 'a', 'a', 'nothing'],
    ['a', 'b', 'a', 'keep'],
    ['a', null, 'a', 'keep'],
    [null, 'b', null, 'keep'],
    ['a', 'a', 'b', 'take'],
    [null, null, 'b', 'take'],
    ['a', 'a', null, 'delete'],
    ['a', 'b', 'b', 'nothing'],
    ['a', null, null, 'nothing'],
    ['a', 'b', 'c', 'merge'],
    [null, 'b', 'c', 'merge'],
    ['a', null, 'c', 'restore'],
    ['a', 'b', null, 'hold'],
  ] as const)('base %s, ours %s, theirs %s: %s', (base, ours, theirs, step) => {
    expect(decide(base, ours, theirs)).toBe(step)
  })

  it.each([
    ['a', 'a', 'nothing'],
    [null, 'b', 'take'],
    ['a', null, 'keep'],
    ['a', 'b', 'merge'],
  ] as const)(
    'without a base: ours %s, theirs %s: %s',
    (ours, theirs, step) => {
      expect(decide(undefined, ours, theirs)).toBe(step)
    },
  )
})

describe('mergeText', () => {
  const base = 'title\nstart: March\nteam: 4\nstatus: draft\n'

  it('keeps changes to different lines from both sides', () => {
    expect(
      mergeText(
        base,
        'title\nstart: March\nteam: 4\nstatus: review\n',
        'title\nstart: April\nteam: 4\nstatus: draft\n',
        'push 14',
      ),
    ).toEqual({
      text: 'title\nstart: April\nteam: 4\nstatus: review\n',
      conflicts: 0,
    })
  })

  it('takes the same change on both sides once', () => {
    const both = 'title\nstart: May\nteam: 4\nstatus: draft\n'
    expect(mergeText(base, both, both, 'push 14')).toEqual({
      text: both,
      conflicts: 0,
    })
  })

  it('writes both versions between markers where the same lines changed', () => {
    const result = mergeText(
      base,
      'title\nstart: March\nteam: 4\nstatus: review\n',
      'title\nstart: March\nteam: 4\nstatus: approved\n',
      'push 14',
    )
    expect(result.conflicts).toBe(1)
    expect(result.text).toBe(
      'title\nstart: March\nteam: 4\n' +
        '<<<<<<< local\nstatus: review\n=======\nstatus: approved\n' +
        '>>>>>>> push 14\n',
    )
    expect(hasMarkers(result.text)).toBe(true)
  })

  it('ends a last line without a newline before the marker after it', () => {
    const result = mergeText('a\nb', 'a\nours', 'a\ntheirs', 'push 2')
    expect(result.text).toBe(
      'a\n<<<<<<< local\nours\n=======\ntheirs\n>>>>>>> push 2\n',
    )
  })

  it('writes markers with CRLF in a CRLF file', () => {
    const result = mergeText('x\r\n', 'ours\r\n', 'theirs\r\n', 'push 2')
    expect(result.text).toBe(
      '<<<<<<< local\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> push 2\r\n',
    )
    expect(hasMarkers(result.text)).toBe(true)
  })

  it('makes one conflict of two different files with an empty base', () => {
    const result = mergeText('', 'one\n', 'two\n', 'push 3')
    expect(result.conflicts).toBe(1)
    expect(result.text).toBe(
      '<<<<<<< local\none\n=======\ntwo\n>>>>>>> push 3\n',
    )
  })
})

describe('hasMarkers', () => {
  it('finds only the markers a merge writes', () => {
    expect(hasMarkers('a\n=======\nb\n')).toBe(false)
    expect(hasMarkers('a\n<<<<<<< HEAD\nb\n')).toBe(false)
    expect(hasMarkers('a\n<<<<<<< local\nb\n')).toBe(true)
    expect(hasMarkers('a\n>>>>>>> push 9\n')).toBe(true)
  })
})

describe('textOf', () => {
  it('reads UTF-8 byte for byte, the byte order mark included', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])
    expect(textOf(bytes)).toBe('﻿hi')
    expect(new TextEncoder().encode(textOf(bytes)!)).toEqual(bytes)
  })

  it('answers null for bytes that are not text', () => {
    expect(textOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBeNull()
    expect(textOf(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull()
  })
})

describe('theirsPath', () => {
  it('puts .theirs before the extension, and a number when taken', () => {
    const none = () => false
    expect(theirsPath('img/logo.png', none)).toBe('img/logo.theirs.png')
    expect(theirsPath('LICENSE', none)).toBe('LICENSE.theirs')
    expect(theirsPath('.env', none)).toBe('.env.theirs')
    expect(theirsPath('logo.png', (path) => path === 'logo.theirs.png')).toBe(
      'logo.theirs-2.png',
    )
  })
})
