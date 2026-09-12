import { describe, expect, it } from 'vitest'
import { CliError, ExitCode } from './errors.js'
import { parseRef } from './ref.js'

const apiUrl = 'https://dossier.agent964.com'

describe('parseRef', () => {
  it('accepts IDs and pinned IDs', () => {
    expect(parseRef('7k2m9x1qz3ab', apiUrl)).toEqual({
      id: '7k2m9x1qz3ab',
      source: 'id',
    })
    expect(parseRef('7k2m9x1qz3ab@4', apiUrl)).toEqual({
      id: '7k2m9x1qz3ab',
      version: 4,
      source: 'id',
    })
  })

  it.each([
    [
      'https://dossier.agent964.com/d/7k2m9x1qz3ab',
      { id: '7k2m9x1qz3ab', source: 'url' },
    ],
    [
      'https://dossier.agent964.com/d/7k2m9x1qz3ab/v/3/raw',
      { id: '7k2m9x1qz3ab', version: 3, suffix: 'raw', source: 'url' },
    ],
    [
      'https://dossier.agent964.com/d/7k2m9x1qz3ab/tree/',
      { id: '7k2m9x1qz3ab', suffix: 'tree', source: 'url' },
    ],
  ])('accepts configured-origin URL %s', (input, expected) => {
    expect(parseRef(input, apiUrl)).toEqual(expected)
  })

  it.each([
    '7k2m9x1qz3a',
    '7K2M9X1QZ3AB',
    '7k2m9x1qz3ab@0',
    'https://evil.example/d/7k2m9x1qz3ab',
    'https://dossier.agent964.com/d/7k2m9x1qz3ab?secret=1',
    'https://dossier.agent964.com/not-a-document',
  ])('rejects invalid or foreign reference %s as usage', (input) => {
    try {
      parseRef(input, apiUrl)
      throw new Error('expected parseRef to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exitCode).toBe(ExitCode.Usage)
    }
  })
})
