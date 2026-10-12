import { describe, expect, it } from 'vitest'
import { THEME_VARIABLES, themeVariables } from '../src/index.ts'
import { fixture } from './helpers.ts'

describe('themeVariables', () => {
  it('lists the custom properties a _theme.css declares, sorted, once each', () => {
    expect(themeVariables(fixture('theme.css'))).toEqual([
      '--accent',
      '--background',
      '--card-gap',
      '--font-body',
      '--font-display',
      '--primary',
      '--primary-foreground',
    ])
  })

  it('reads no declaration out of a comment, a string or a var() use', () => {
    expect(
      themeVariables(
        '/* --hidden: 1; */ a::after { content: "--quoted: 2"; color: var(--used); }',
      ),
    ).toEqual([])
  })

  it('names the roles base components read, with the three font roles', () => {
    for (const name of [
      '--background',
      '--foreground',
      '--primary',
      '--primary-foreground',
      '--muted',
      '--border',
      '--ring',
      '--font-display',
      '--font-body',
      '--font-mono',
    ]) {
      expect(THEME_VARIABLES).toContain(name)
    }
    expect(new Set(THEME_VARIABLES).size).toBe(THEME_VARIABLES.length)
  })
})
