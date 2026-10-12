import { describe, expect, it } from 'vitest'

import { verbs } from './commands/index.ts'
import { guide, guideMarkdown, sectionOf } from './guide.ts'
import { harness, stubFetch } from './test-support.ts'

const TITLES = [
  'Dossier',
  'Kits',
  'Layouts',
  'Themes',
  'Components',
  'Base layer',
  'Embedding',
  'Forms',
  'Agent versions',
  'Reading',
]

describe('the agent guide', () => {
  it('holds every convention, in order, each with its own text', () => {
    const { conventions } = guide()
    expect(conventions.map((c) => c.title)).toEqual(TITLES)
    for (const section of conventions) {
      expect(section.markdown).not.toBe('')
      expect(section.markdown.startsWith('## ')).toBe(false)
    }
  })

  it('says what the conventions promise', () => {
    const text = guide()
      .conventions.map((c) => c.markdown)
      .join('\n')
    for (const phrase of [
      'One push is one change',
      "tree's own origin",
      'the closest one wins',
      '`<slot></slot>`',
      'innermost wins',
      'not rewritten',
      '--font-display',
      '`_components/<tag>.js`',
      '`_components/<tag>.md`',
      'html[data-dossier-embedded] .site-header { display: none }',
      '`<link rel="alternate"',
      'Data: answers/ (3 files) · Comments: 2',
      'dossier read <workspace>/<tree>/<folder>/',
      'DOSSIER_JSON=1',
    ]) {
      expect(text).toContain(phrase)
    }
  })

  it('prints the Dossier section, the generated verbs and exit codes, then the other conventions', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }))
    const cli = await harness({ fetch: fetch.fetch })
    try {
      expect(await cli.run(['--agent-info'])).toBe(0)
      const markdown = cli.stdout()
      expect(markdown).toBe(guideMarkdown(guide()))
      const at = (heading: string) => markdown.indexOf(`\n## ${heading}\n`)
      const order = [
        at('Dossier'),
        at('Verbs'),
        at('Exit codes'),
        ...TITLES.slice(1).map(at),
      ]
      expect(order.every((index) => index > 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
      for (const verb of guide().verbs) {
        expect(markdown).toContain(`### ${verb.name}\n`)
        expect(markdown).toContain(verb.usage)
      }
      expect(guide().verbs.map((verb) => verb.name)).toHaveLength(verbs.length)
      expect(markdown).toContain('dossier read [--json] <target>')
      expect(markdown).toContain('| 3 | not found or no access |')

      expect(await cli.run(['--agent-info', '--json'])).toBe(0)
      const data = JSON.parse(cli.stdout())
      expect(data.conventions.map((c: { title: string }) => c.title)).toEqual(
        TITLES,
      )
      expect(data).toEqual(guide())
    } finally {
      await cli.cleanup()
    }
  })

  it('refuses a convention file without its title line', () => {
    expect(sectionOf('## Kits\n\nText.\n')).toEqual({
      title: 'Kits',
      markdown: 'Text.',
    })
    expect(() => sectionOf('Kits\n\nText.')).toThrow('## <title>')
  })
})
