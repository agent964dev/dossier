import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { guide } from '../src/guide.ts'

const reference = readFileSync(
  new URL('../../../docs/CLI.md', import.meta.url),
  'utf8',
)

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `### `dossier push`` (any heading level from 2 to 4). */
const sectionOf = (verb: string) =>
  new RegExp(`^#{2,4} \`dossier ${escape(verb)}\`\\s*$`, 'm')

describe('docs/CLI.md', () => {
  const verbs = guide().verbs.map((verb) => verb.name)

  it('has a section for every verb the guide lists', () => {
    expect(verbs.length).toBeGreaterThan(10)
    const missing = verbs.filter((verb) => !sectionOf(verb).test(reference))
    expect(missing).toEqual([])
  })

  it('has no section for a verb the CLI does not have', () => {
    const documented = [
      ...reference.matchAll(/^#{2,4} `dossier ([a-z-]+)`\s*$/gm),
    ].map((match) => match[1])
    expect(documented.filter((verb) => !verbs.includes(verb!))).toEqual([])
  })
})
