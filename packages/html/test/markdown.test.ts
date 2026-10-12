import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MARKDOWN_VERSION, compose, toMarkdown } from '../src/index.ts'
import { analyze } from '../src/index.ts'
import { fixture } from './helpers.ts'

const PAIRS = readdirSync(new URL('./fixtures/markdown/', import.meta.url))
  .filter((name) => name.endsWith('.html'))
  .map((name) => name.slice(0, -'.html'.length))
  .sort()

/** A golden pair: the page and the Markdown it becomes, with a final newline. */
const pair = (name: string) => ({
  page: fixture(`markdown/${name}.html`),
  markdown: fixture(`markdown/${name}.md`),
})

describe('toMarkdown', () => {
  it('has a version that stored conversions are keyed by', () => {
    expect(MARKDOWN_VERSION).toBe(1)
  })

  it('holds a golden pair for every rule', () => {
    expect(PAIRS).toEqual([
      'code',
      'forms',
      'fragment',
      'own-heading',
      'parts',
      'prose',
      'svg',
    ])
  })

  it.each(PAIRS)('converts %s.html into its golden Markdown', (name) => {
    const { page, markdown } = pair(name)
    expect(`${toMarkdown(page)}\n`).toBe(markdown)
  })

  it.each(PAIRS)('gives the same bytes for %s.html every time', (name) => {
    const { page } = pair(name)
    expect(toMarkdown(page)).toBe(toMarkdown(page))
  })

  it('writes headings, prose, lists, quotes, tables, rules, links and images in their GFM forms', () => {
    const md = toMarkdown(pair('prose').page)
    expect(md).toContain('## Where the trucks go')
    expect(md).toContain('**12 trucks**')
    expect(md).toContain('[regions page](../regions/)')
    expect(md).toContain('[the notes](notes.md)')
    expect(md).toContain('![Map of the routes](map.png)')
    expect(md).toContain('- Basra, on Wednesday\n  - with a second stop')
    expect(md).toContain('1. Load\n2. Drive')
    expect(md).toContain('> Every truck leaves by six.')
    expect(md).toContain('| Region | Trucks |')
    expect(md).toContain('\n---\n')
  })

  it('starts with the title only when the body has no <h1>', () => {
    expect(toMarkdown(pair('prose').page).startsWith('# Delivery plan\n')).toBe(
      true,
    )
    const own = toMarkdown(pair('own-heading').page)
    expect(own.startsWith("# The page's own heading\n")).toBe(true)
    expect(own).not.toContain('Shown in the tab')
  })

  it('names an inline SVG by its title and description, and drops one with neither', () => {
    const md = toMarkdown(pair('svg').page)
    expect(md).toContain(
      '[SVG: Truck routes. Lines from Erbil to Basra, one per truck.]',
    )
    expect(md).toContain('The legend [SVG: Red dot.] marks a stop.')
    expect(md).not.toContain('Erbil\n')
  })

  it('fences Mermaid source and highlighted code, and keeps TeX as written', () => {
    const md = toMarkdown(pair('code').page)
    expect(md).toContain(
      '```mermaid\ngraph TD\n  Plan --> Build\n  Build --> Ship\n```',
    )
    expect(md).toContain('```ts\nconst trucks = 12 * 2\n')
    expect(md).toContain('Inline math $x_1^2 + y^2$ sits in the line.')
    expect(md).toContain('\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$')
  })

  it('gives each form its questions with labels, types, required and every option, and never a value', () => {
    const md = toMarkdown(pair('forms').page)
    expect(md).toContain(
      [
        '### Form: Delivery needs',
        '',
        '- Region (select, required): Erbil, Basra, Mosul',
        '- How many trucks? (number, required)',
        '- Priority (radio): High, Low',
        '- Days (checkbox): Monday, Wednesday',
        '- I agree to the terms (checkbox, required)',
        '- Anything else (textarea)',
        '- Your email (email)',
      ].join('\n'),
    )
    expect(md).toContain('### Form: Sign off\n\n- Name (text)')
    expect(md).toContain('### Form: vote')
    for (const value of [
      '12',
      'A value someone typed',
      'never shown',
      'Sara',
      'yes',
      'loose value',
      'Choose one',
      'Send',
    ]) {
      expect(md).not.toContain(value)
    }
  })

  it('names parts drawn only by script by their title or aria-label, and drops what no one reads', () => {
    const md = toMarkdown(pair('parts').page)
    expect(md).toContain('[Chart: Trucks per region]')
    expect(md).toContain('[Chart: Fuel use]')
    expect(md).toContain('[acme-chart: Weekly loads]')
    expect(md).toContain('A card with its own text')
    expect(md).toContain('[Image: Map of the depots]')
    expect(md).toContain('[Embed: Walkthrough video]')
    for (const dropped of [
      'drawn',
      'canvas {',
      'Template content',
      'Turn on JavaScript',
      'dossier-copy',
    ]) {
      expect(md).not.toContain(dropped)
    }
  })

  it('never includes the layouts a page is composed into', () => {
    const page = pair('fragment').page
    const layout =
      '<!doctype html><html><head><title>Acme</title></head><body><header>Acme header</header><slot></slot><footer>Acme footer</footer></body></html>'
    const composed = compose({
      page: { source: page, analysis: analyze(page), folder: '' },
      layouts: [{ source: layout, analysis: analyze(layout), folder: '' }],
      inject: () => '',
    })
    expect(composed).toContain('Acme header')
    const md = toMarkdown(page)
    expect(md).toBe(
      '# Install\n\nRun the installer, then sign in.\n\nTakes two minutes',
    )
    expect(md).not.toContain('Acme')
  })
})
