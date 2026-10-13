import { describe, expect, it } from 'vitest'

import {
  fuzzyScore,
  loadGoogleFamilies,
  searchFamilies,
  type GoogleFamily,
} from '../src/lib/font-search.ts'

const names = (list: readonly GoogleFamily[]) => list.map((entry) => entry[0])

const FAMILIES: readonly GoogleFamily[] = [
  ['Roboto', 'Sans Serif', false],
  ['Open Sans', 'Sans Serif', false],
  ['Roboto Mono', 'Monospace', false],
  ['Cairo', 'Sans Serif', true],
  ['Sansita', 'Display', false],
  ['Noto Sans Arabic', 'Sans Serif', true],
  ['Merriweather', 'Serif', false],
  ['Fira Code', 'Monospace', false],
]

describe('fuzzy matching of a family name', () => {
  it('matches the letters in order, ignoring case, spaces and accents', () => {
    expect(fuzzyScore('opn sns', 'Open Sans')).not.toBeNull()
    expect(fuzzyScore('OPENSANS', 'Open Sans')).not.toBeNull()
    expect(fuzzyScore('mérri', 'Merriweather')).not.toBeNull()
    expect(fuzzyScore('snas', 'Open Sans')).toBeNull()
    expect(fuzzyScore('robotoz', 'Roboto')).toBeNull()
  })

  it('ranks the whole name, then a word start, then inside a word, then scattered letters', () => {
    const exact = fuzzyScore('roboto', 'Roboto')!
    const wordStart = fuzzyScore('sans', 'Open Sans')!
    const prefix = fuzzyScore('robo', 'Roboto Mono')!
    const inside = fuzzyScore('boto', 'Roboto')!
    const scattered = fuzzyScore('rbt', 'Roboto')!
    expect(exact).toBeGreaterThan(wordStart)
    expect(prefix).toBe(wordStart)
    expect(wordStart).toBeGreaterThan(inside)
    expect(inside).toBeGreaterThan(scattered)
    // Letters closer together score higher.
    expect(fuzzyScore('mw', 'Merriweather')!).toBeLessThan(
      fuzzyScore('me', 'Merriweather')!,
    )
    expect(fuzzyScore('ope', 'Open Sans')!).toBeGreaterThan(
      fuzzyScore('osn', 'Open Sans')!,
    )
  })

  it('matches everything when nothing is typed', () => {
    expect(fuzzyScore('', 'Roboto')).toBe(0)
    expect(fuzzyScore('   ', 'Roboto')).toBe(0)
  })
})

describe('searching the families for a role', () => {
  it('keeps the catalogue’s order when nothing is typed', () => {
    expect(names(searchFamilies(FAMILIES, '', 'body'))).toEqual(names(FAMILIES))
  })

  it('narrows as the person types, best match first', () => {
    expect(names(searchFamilies(FAMILIES, 'sans', 'body'))).toEqual([
      'Open Sans',
      'Sansita',
      'Noto Sans Arabic',
    ])
    expect(names(searchFamilies(FAMILIES, 'rob', 'display'))).toEqual([
      'Roboto',
      'Roboto Mono',
    ])
    expect(searchFamilies(FAMILIES, 'zzz', 'body')).toEqual([])
  })

  it('puts families that suit the role first, but never above the exact name', () => {
    expect(names(searchFamilies(FAMILIES, '', 'mono')).slice(0, 2)).toEqual([
      'Roboto Mono',
      'Fira Code',
    ])
    expect(names(searchFamilies(FAMILIES, 'o', 'arabic')).slice(0, 2)).toEqual([
      'Cairo',
      'Noto Sans Arabic',
    ])
    expect(names(searchFamilies(FAMILIES, 'roboto', 'mono'))).toEqual([
      'Roboto',
      'Roboto Mono',
    ])
  })
})

describe('the checked-in catalogue', () => {
  it('lists Google Fonts families the deployment can copy, most used first', async () => {
    const families = await loadGoogleFamilies()
    expect(families.length).toBeGreaterThan(1500)
    const seen = new Set<string>()
    for (const [family, category, arabic] of families) {
      // The names the copy accepts.
      expect(family).toMatch(/^[A-Za-z0-9 ]{1,64}$/)
      expect(category).toMatch(
        /^(Sans Serif|Serif|Display|Handwriting|Monospace)$/,
      )
      expect(typeof arabic).toBe('boolean')
      expect(seen.has(family)).toBe(false)
      seen.add(family)
    }
    for (const family of ['Inter', 'Roboto', 'JetBrains Mono', 'Cairo']) {
      expect(seen.has(family)).toBe(true)
    }
    expect(names(searchFamilies(families, 'inter', 'body'))[0]).toBe('Inter')
    expect(
      searchFamilies(families, '', 'arabic')
        .slice(0, 5)
        .every((entry) => entry[2]),
    ).toBe(true)
  })
})
